import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  agentAttachmentFilePath,
  agentAttachmentTempDir,
  agentAttachmentWorkspaceDir,
  agentAttachmentsRoot,
} from "../attachments/agent-attachment-paths.js";
import { commitCompactionMessageForTest, getMessageSessionHead } from "../agent-message.store.js";
import { createIntegrationFixture, createSession } from "./context-writeback.helpers.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);
const PNG_SIGNATURE = PNG_BYTES.subarray(0, 8);

function pngBytes(byteLength: number) {
  return Buffer.concat([PNG_SIGNATURE, Buffer.alloc(Math.max(0, byteLength - PNG_SIGNATURE.byteLength))]);
}

type MultipartPart =
  | { type: "payload"; value: string }
  | { type: "field"; name: string; value: string }
  | { type: "image"; name?: string; filename: string; bytes: Buffer };
type MultipartImage = { name?: string; filename: string; bytes: Buffer };

function multipartMessage(input: {
  workspaceId: string;
  clientRequestId: string;
  text?: string;
  images?: MultipartImage[];
  parts?: MultipartPart[];
  boundary?: string;
}) {
  const boundary = input.boundary ?? "awb-message-boundary";
  const payload = JSON.stringify({
    workspaceId: input.workspaceId,
    clientRequestId: input.clientRequestId,
    text: input.text ?? "",
  });
  const parts = input.parts ?? [
    { type: "payload" as const, value: payload },
    ...(input.images ?? []).map((image) => ({ type: "image" as const, ...image })),
  ];
  const chunks: Buffer[] = [];
  const appendText = (value: string) => chunks.push(Buffer.from(value, "utf8"));
  for (const part of parts) {
    appendText(`--${boundary}\r\n`);
    if (part.type === "image") {
      appendText(`Content-Disposition: form-data; name="${part.name ?? "images"}"; filename="${part.filename}"\r\n`);
      appendText("Content-Type: application/octet-stream\r\n\r\n");
      chunks.push(part.bytes);
    } else {
      appendText(`Content-Disposition: form-data; name="${part.type === "payload" ? "payload" : part.name}"\r\n\r\n`);
      appendText(part.value);
    }
    appendText("\r\n");
  }
  appendText(`--${boundary}--\r\n`);
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) };
}

async function assertNoAttachmentTemps(dataDir: string) {
  try {
    assert.deepEqual(await fs.readdir(agentAttachmentTempDir(dataDir)), []);
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
  }
}

async function convergeCompletedRun(input: {
  app: Awaited<ReturnType<typeof createIntegrationFixture>>["app"];
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
}) {
  const updatedAt = Date.now();
  const intent = await input.app.inject({
    method: "POST",
    url: "/api/internal/agent/runs/terminal-intent",
    headers: { "x-awb-agent-internal-token": input.internalToken },
    payload: {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runId: input.runId,
      status: "completed",
      code: "run_completed",
      detail: null,
      updatedAt,
    },
  });
  assert.equal(intent.statusCode, 200, intent.body);
  const convergence = await input.app.inject({
    method: "POST",
    url: "/api/internal/agent/runs/converge-terminal",
    headers: { "x-awb-agent-internal-token": input.internalToken },
    payload: {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runId: input.runId,
      updatedAt,
    },
  });
  assert.equal(convergence.statusCode, 200, convergence.body);
}

async function sendText(input: {
  app: Awaited<ReturnType<typeof createIntegrationFixture>>["app"];
  workspaceId: string;
  sessionId: string;
  clientRequestId: string;
  text: string;
}) {
  const response = await input.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${input.sessionId}/messages`,
    payload: {
      workspaceId: input.workspaceId,
      text: input.text,
      clientRequestId: input.clientRequestId,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as { messageId: string; runId: string };
}

test("Message multipart route 接受恰好四张图片，拒绝第五张", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const request = (clientRequestId: string, count: number) => fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    ...multipartMessage({
      workspaceId: fixture.workspaceId,
      clientRequestId,
      images: Array.from({ length: count }, (_, index) => ({ filename: `image-${index}.png`, bytes: PNG_BYTES }))
    })
  });

  const accepted = await request("multipart-four-images", 4);
  assert.equal(accepted.statusCode, 201, accepted.body);
  const rejected = await request("multipart-five-images", 5);
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.match(rejected.json().message, /multipart image field|too many multipart parts/);
  await assertNoAttachmentTemps(fixture.dataDir);
});

test("Message multipart route 接受恰好 20 MiB，拒绝超过 20 MiB 的累计图片", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const tenMiB = 10 * 1024 * 1024;
  const request = (clientRequestId: string, imageSizes: number[]) => fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    ...multipartMessage({
      workspaceId: fixture.workspaceId,
      clientRequestId,
      images: imageSizes.map((byteLength, index) => ({ filename: `image-${index}.png`, bytes: pngBytes(byteLength) }))
    })
  });

  const accepted = await request("multipart-total-at-limit", [tenMiB, tenMiB]);
  assert.equal(accepted.statusCode, 201, accepted.body);
  // 每张均不超过 10 MiB；累计值严格为 20 MiB + 1，不能落入单图大小限制。
  const rejected = await request("multipart-total-over-limit", [tenMiB, tenMiB - 7, 8]);
  assert.equal(rejected.statusCode, 400, rejected.body);
  const error = rejected.json() as { code?: string; message?: string };
  assert.equal(error.code, "AGENT_IMAGE_TOTAL_BYTES_EXCEEDED");
  assert.equal(error.message, "agent images exceed total byte size limit");
  await assertNoAttachmentTemps(fixture.dataDir);
});

test("Message multipart 原子创建 attachment、ImagePart、Run、dedup 和 run-state", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    ...multipartMessage({
      workspaceId: fixture.workspaceId,
      clientRequestId: "multipart-atomic",
      text: "图片说明",
      images: [
        { filename: "first.PNG", bytes: PNG_BYTES },
        { filename: "second.png", bytes: PNG_BYTES },
      ],
    }),
  });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as { messageId: string; runId: string; deduplicated: boolean };
  assert.equal(body.deduplicated, false);

  const parts = fixture.db.prepare(
    `select id, position, attachment_id as attachmentId, media_type as mediaType, filename
     from agent_message_part where message_id = ? and type = 'image' order by position`,
  ).all(body.messageId) as Array<{
    id: string;
    position: number;
    attachmentId: string;
    mediaType: string;
    filename: string;
  }>;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((part) => part.position), [1, 2]);
  assert.deepEqual(parts.map((part) => part.mediaType), ["image/png", "image/png"]);
  assert.deepEqual(parts.map((part) => part.filename), ["first.png", "second.png"]);
  const attachmentCount = fixture.db.prepare(
    `select count(*) as count from agent_attachment
     where workspace_id = ? and id in (?, ?)`,
  ).get(fixture.workspaceId, parts[0]!.attachmentId, parts[1]!.attachmentId) as { count: number };
  assert.equal(attachmentCount.count, 2);
  assert.equal(
    (fixture.db.prepare("select trigger_message_id as triggerMessageId, status from agent_run where run_id = ?").get(body.runId) as { triggerMessageId: string; status: string }).triggerMessageId,
    body.messageId,
  );
  assert.equal(
    (fixture.db.prepare("select count(*) as count from agent_client_request where run_id = ?").get(body.runId) as { count: number }).count,
    1,
  );
  assert.equal(
    (fixture.db.prepare("select active_run_id as activeRunId from session_run_state where workspace_id = ? and session_id = ?").get(fixture.workspaceId, session.id) as { activeRunId: string }).activeRunId,
    body.runId,
  );

  await convergeCompletedRun({ ...fixture, sessionId: session.id, runId: body.runId });
  const content = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/attachments/${parts[0]!.attachmentId}/content?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
  });
  assert.equal(content.statusCode, 200, content.body);
  assert.equal(content.headers["content-type"], "image/png");
  assert.equal(content.headers["content-disposition"], "inline");
  assert.equal(content.headers["x-content-type-options"], "nosniff");
  assert.equal(content.headers["cache-control"], "private, no-store");
  assert.equal(content.headers["content-length"], String(PNG_BYTES.byteLength));
  assert.deepEqual(content.rawPayload, PNG_BYTES);
});

test("Session 绑定附件读取拒绝 detached branch、错误关系和不安全文件", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const seed = await sendText({
    app: fixture.app,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    clientRequestId: "attachment-seed",
    text: "seed",
  });
  await convergeCompletedRun({ ...fixture, sessionId: session.id, runId: seed.runId });

  const uploaded = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    ...multipartMessage({
      workspaceId: fixture.workspaceId,
      clientRequestId: "attachment-branch",
      images: [{ filename: "branch.png", bytes: PNG_BYTES }],
    }),
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const uploadedBody = uploaded.json() as { messageId: string; runId: string };
  const attachment = fixture.db.prepare(
    `select attachment_id as attachmentId from agent_message_part
     where message_id = ? and type = 'image'`,
  ).get(uploadedBody.messageId) as { attachmentId: string };
  await convergeCompletedRun({ ...fixture, sessionId: session.id, runId: uploadedBody.runId });

  const fork = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromMessageId: seed.messageId,
      title: "detached",
    },
  });
  assert.equal(fork.statusCode, 201, fork.body);
  const detached = fork.json() as { id: string };

  const currentHead = getMessageSessionHead(fixture.db, { workspaceId: fixture.workspaceId, sessionId: session.id })!;
  commitCompactionMessageForTest(fixture.db, {
    id: "attachment-compaction",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    expectedHeadMessageId: currentHead.headMessageId!,
    expectedRevision: currentHead.revision,
    textPartId: "attachment-compaction-text",
    text: "summary",
    createdAt: Date.now(),
  });
  const compactedCurrentRead = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/attachments/${attachment.attachmentId}/content?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
  });
  assert.equal(compactedCurrentRead.statusCode, 200, compactedCurrentRead.body);

  const detachedRead = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${detached.id}/attachments/${attachment.attachmentId}/content?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
  });
  assert.equal(detachedRead.statusCode, 404);

  fixture.db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws-other','ws-other','Other','/workspace/other',1,1)").run();
  const otherWorkspaceRead = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/attachments/${attachment.attachmentId}/content?workspaceId=ws-other`,
  });
  assert.equal(otherWorkspaceRead.statusCode, 404);

  const missingRelation = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/attachments/att_missing/content?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
  });
  assert.equal(missingRelation.statusCode, 404);

  fixture.db.prepare("update agent_attachment set storage_key = ? where id = ?").run("att_storage_mismatch", attachment.attachmentId);
  const storageMismatch = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/attachments/${attachment.attachmentId}/content?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
  });
  assert.equal(storageMismatch.statusCode, 404);
  fixture.db.prepare("update agent_attachment set storage_key = ? where id = ?").run(attachment.attachmentId, attachment.attachmentId);

  fixture.db.prepare("update agent_attachment set byte_size = byte_size + 1 where id = ?").run(attachment.attachmentId);
  const sizeMismatch = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/attachments/${attachment.attachmentId}/content?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
  });
  assert.equal(sizeMismatch.statusCode, 404);
  fixture.db.prepare("update agent_attachment set byte_size = byte_size - 1 where id = ?").run(attachment.attachmentId);

  const finalPath = agentAttachmentFilePath(fixture.dataDir, fixture.workspaceId, attachment.attachmentId);
  await fs.unlink(finalPath);
  await fs.symlink(path.join(fixture.dataDir, "attachment-symlink-target"), finalPath);
  const unsafeRead = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/attachments/${attachment.attachmentId}/content?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
  });
  assert.equal(unsafeRead.statusCode, 404);

  await fs.unlink(finalPath);
  const workspaceDir = path.dirname(finalPath);
  const parkedWorkspaceDir = `${workspaceDir}.safe`;
  await fs.rename(workspaceDir, parkedWorkspaceDir);
  await fs.symlink(parkedWorkspaceDir, workspaceDir);
  const unsafeParent = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/attachments/${attachment.attachmentId}/content?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
  });
  assert.equal(unsafeParent.statusCode, 404);
});

test("Message multipart 拒绝非法签名且不创建 attachment", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const invalidSignature = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    ...multipartMessage({
      workspaceId: fixture.workspaceId,
      clientRequestId: "invalid-image",
      images: [{ filename: "invalid.png", bytes: Buffer.from("not-an-image") }],
    }),
  });
  assert.equal(invalidSignature.statusCode, 400);
  const attachmentCount = fixture.db.prepare("select count(*) as count from agent_attachment").get() as { count: number };
  assert.equal(attachmentCount.count, 0);
});


test("Message multipart 接受 payload 位于图片前、中、后", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const payload = (request: string) => JSON.stringify({ workspaceId: fixture.workspaceId, clientRequestId: request, text: "排序" });
  for (const [name, parts] of [
    ["前", (request: string): MultipartPart[] => [{ type: "payload", value: payload(request) }, { type: "image", filename: "one.png", bytes: PNG_BYTES }]],
    ["中", (request: string): MultipartPart[] => [{ type: "image", filename: "one.png", bytes: PNG_BYTES }, { type: "payload", value: payload(request) }, { type: "image", filename: "two.png", bytes: PNG_BYTES }]],
    ["后", (request: string): MultipartPart[] => [{ type: "image", filename: "one.png", bytes: PNG_BYTES }, { type: "payload", value: payload(request) }]],
  ] as const) {
    const session = await createSession(fixture.app, fixture.workspaceId);
    const request = `multipart-order-${name}`;
    const response = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/messages`, ...multipartMessage({ workspaceId: fixture.workspaceId, clientRequestId: request, parts: parts(request) }) });
    assert.equal(response.statusCode, 201, response.body);
    await convergeCompletedRun({ ...fixture, sessionId: session.id, runId: (response.json() as { runId: string }).runId });
  }
});

test("Message multipart 拒绝非法输入且不残留暂存文件或数据记录", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const invalids: Array<{ name: string; request: ReturnType<typeof multipartMessage> | { headers: Record<string, string>; payload: string } }> = [
    { name: "非法 field", request: multipartMessage({ workspaceId: fixture.workspaceId, clientRequestId: "bad-field", parts: [{ type: "payload", value: JSON.stringify({ workspaceId: fixture.workspaceId, clientRequestId: "bad-field", text: "x" }) }, { type: "image", name: "file", filename: "one.png", bytes: PNG_BYTES }] }) },
    { name: "重复 payload", request: multipartMessage({ workspaceId: fixture.workspaceId, clientRequestId: "duplicate-payload", parts: [{ type: "payload", value: "{}" }, { type: "payload", value: "{}" }, { type: "image", filename: "one.png", bytes: PNG_BYTES }] }) },
    { name: "超 part count", request: multipartMessage({ workspaceId: fixture.workspaceId, clientRequestId: "too-many", parts: [{ type: "payload", value: JSON.stringify({ workspaceId: fixture.workspaceId, clientRequestId: "too-many", text: "x" }) }, ...Array.from({ length: 5 }, (_, index) => ({ type: "image" as const, filename: `${index}.png`, bytes: PNG_BYTES }))] }) },
    { name: "非法 JSON", request: multipartMessage({ workspaceId: fixture.workspaceId, clientRequestId: "bad-json", parts: [{ type: "payload", value: "{" }, { type: "image", filename: "one.png", bytes: PNG_BYTES }] }) },
    { name: "schema 非法", request: multipartMessage({ workspaceId: fixture.workspaceId, clientRequestId: "bad-schema", parts: [{ type: "payload", value: JSON.stringify({ workspaceId: fixture.workspaceId, text: "x" }) }, { type: "image", filename: "one.png", bytes: PNG_BYTES }] }) },
    { name: "缺 boundary", request: { headers: { "content-type": "multipart/form-data" }, payload: "not-a-multipart-body" } },
  ];
  for (const invalid of invalids) {
    const session = await createSession(fixture.app, fixture.workspaceId);
    const response = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/messages`, ...invalid.request });
    assert.equal(response.statusCode, 400, `${invalid.name}: ${response.body}`);
    assert.equal((fixture.db.prepare("select count(*) as count from agent_attachment").get() as { count: number }).count, 0);
    assert.equal((fixture.db.prepare("select count(*) as count from agent_run").get() as { count: number }).count, 0);
    await assertNoAttachmentTemps(fixture.dataDir);
  }
});

test("M6 multipart dedup 保留首次 final 并清理重复请求的新暂存文件", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const request = { workspaceId: fixture.workspaceId, clientRequestId: "m6-dedup", images: [{ filename: "first.png", bytes: PNG_BYTES }] };
  const first = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/messages`, ...multipartMessage(request) });
  assert.equal(first.statusCode, 201, first.body);
  const firstBody = first.json() as { messageId: string; runId: string; deduplicated: boolean };
  const attachment = fixture.db.prepare(
    "select attachment_id as attachmentId from agent_message_part where message_id = ? and type = 'image'",
  ).get(firstBody.messageId) as { attachmentId: string };
  const firstFinal = agentAttachmentFilePath(fixture.dataDir, fixture.workspaceId, attachment.attachmentId);
  const before = await fs.readdir(agentAttachmentWorkspaceDir(fixture.dataDir, fixture.workspaceId));

  const duplicate = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/messages`, ...multipartMessage(request) });
  assert.equal(duplicate.statusCode, 201, duplicate.body);
  const duplicateBody = duplicate.json() as { messageId: string; runId: string; deduplicated: boolean };
  assert.deepEqual(duplicateBody, { ...firstBody, deduplicated: true });
  assert.deepEqual(await fs.readdir(agentAttachmentWorkspaceDir(fixture.dataDir, fixture.workspaceId)), before);
  assert.deepEqual(await fs.readFile(firstFinal), PNG_BYTES);
  assert.equal((fixture.db.prepare("select count(*) as count from agent_attachment").get() as { count: number }).count, 1);
  await assertNoAttachmentTemps(fixture.dataDir);
  await convergeCompletedRun({ ...fixture, sessionId: session.id, runId: firstBody.runId });
});

test("Session 附件读取允许 compaction contextRoot 之前的当前分支图片", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const uploaded = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/messages`, ...multipartMessage({ workspaceId: fixture.workspaceId, clientRequestId: "before-compaction", images: [{ filename: "one.png", bytes: PNG_BYTES }] }) });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const body = uploaded.json() as { messageId: string; runId: string };
  await convergeCompletedRun({ ...fixture, sessionId: session.id, runId: body.runId });
  const attachment = fixture.db.prepare("select attachment_id as attachmentId from agent_message_part where message_id = ? and type = 'image'").get(body.messageId) as { attachmentId: string };
  const head = getMessageSessionHead(fixture.db, { workspaceId: fixture.workspaceId, sessionId: session.id });
  assert.ok(head);
  commitCompactionMessageForTest(fixture.db, { id: "msg_compacted", workspaceId: fixture.workspaceId, sessionId: session.id, expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision, textPartId: "part_compacted", text: "摘要", createdAt: Date.now() });
  const response = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${session.id}/attachments/${attachment.attachmentId}/content?workspaceId=${encodeURIComponent(fixture.workspaceId)}` });
  assert.equal(response.statusCode, 200, response.body);
});

test("Session 附件读取拒绝 root、by_workspace、工作区与目标层 symlink、缺失和目录", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const uploaded = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/messages`, ...multipartMessage({ workspaceId: fixture.workspaceId, clientRequestId: "unsafe-path", images: [{ filename: "one.png", bytes: PNG_BYTES }] }) });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const body = uploaded.json() as { messageId: string; runId: string };
  await convergeCompletedRun({ ...fixture, sessionId: session.id, runId: body.runId });
  const attachment = fixture.db.prepare("select attachment_id as attachmentId from agent_message_part where message_id = ? and type = 'image'").get(body.messageId) as { attachmentId: string };
  const finalPath = agentAttachmentFilePath(fixture.dataDir, fixture.workspaceId, attachment.attachmentId);
  const url = `/api/agent/sessions/${session.id}/attachments/${attachment.attachmentId}/content?workspaceId=${encodeURIComponent(fixture.workspaceId)}`;
  const assert404 = async () => assert.equal((await fixture.app.inject({ method: "GET", url })).statusCode, 404);
  await fs.unlink(finalPath);
  await assert404();
  await fs.mkdir(finalPath);
  await assert404();
  await fs.rm(finalPath, { recursive: true });
  await fs.symlink(path.join(fixture.dataDir, "outside-target"), finalPath);
  await assert404();
  await fs.unlink(finalPath);
  await fs.writeFile(finalPath, PNG_BYTES);
  const workspaceDir = agentAttachmentWorkspaceDir(fixture.dataDir, fixture.workspaceId);
  const parkedWorkspace = `${workspaceDir}.safe`;
  await fs.rename(workspaceDir, parkedWorkspace);
  await fs.symlink(parkedWorkspace, workspaceDir);
  await assert404();
  await fs.unlink(workspaceDir);
  await fs.rename(parkedWorkspace, workspaceDir);
  const byWorkspace = path.dirname(workspaceDir);
  const parkedByWorkspace = `${byWorkspace}.safe`;
  await fs.rename(byWorkspace, parkedByWorkspace);
  await fs.symlink(parkedByWorkspace, byWorkspace);
  await assert404();
  await fs.unlink(byWorkspace);
  await fs.rename(parkedByWorkspace, byWorkspace);
  const root = agentAttachmentsRoot(fixture.dataDir);
  const parkedRoot = `${root}.safe`;
  await fs.rename(root, parkedRoot);
  await fs.symlink(parkedRoot, root);
  await assert404();
});

test("未认证附件请求优先返回 401，不探测可见性或不安全文件", async (t: TestContext) => {
  const token = "attachment-auth-token";
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0, authToken: token });
  const login = await fixture.app.inject({ method: "POST", url: "/api/auth/login", payload: { token } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers["set-cookie"]);
  const sessionResponse = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions", headers: { cookie }, payload: { workspaceId: fixture.workspaceId, title: "authenticated" } });
  assert.equal(sessionResponse.statusCode, 201, sessionResponse.body);
  const session = sessionResponse.json() as { id: string };
  const multipart = multipartMessage({ workspaceId: fixture.workspaceId, clientRequestId: "auth-image", images: [{ filename: "one.png", bytes: PNG_BYTES }] });
  const uploaded = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/messages`, headers: { ...multipart.headers, cookie }, payload: multipart.payload });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const body = uploaded.json() as { messageId: string; runId: string };
  await convergeCompletedRun({ ...fixture, sessionId: session.id, runId: body.runId });
  const attachment = fixture.db.prepare("select attachment_id as attachmentId from agent_message_part where message_id = ? and type = 'image'").get(body.messageId) as { attachmentId: string };
  const finalPath = agentAttachmentFilePath(fixture.dataDir, fixture.workspaceId, attachment.attachmentId);
  await fs.unlink(finalPath);
  await fs.symlink(path.join(fixture.dataDir, "unsafe"), finalPath);
  for (const requestedSessionId of [session.id, "sess_missing"]) {
    const response = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${requestedSessionId}/attachments/${attachment.attachmentId}/content?workspaceId=${encodeURIComponent(fixture.workspaceId)}` });
    assert.equal(response.statusCode, 401);
  }
});
