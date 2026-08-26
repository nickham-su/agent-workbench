import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { agentAttachmentFilePath, agentAttachmentTempDir, agentAttachmentWorkspaceDir } from "./attachments/agent-attachment-paths.js";
import { getContextItemById, getSessionTranscriptItems } from "./agent.store.js";
import { createAgentIntegrationFixture, createPrimarySession } from "./testkit/agent-integration-testkit.js";

function multipart(boundary: string, parts: ReadonlyArray<{ name: string; value?: string; filename?: string; contentType?: string; bytes?: Uint8Array }>) {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`));
      chunks.push(Buffer.from(`Content-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`));
      chunks.push(Buffer.from(part.bytes ?? []));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value ?? ""}`));
    }
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function payload(workspaceId: string, clientRequestId: string) {
  return JSON.stringify({ workspaceId, clientRequestId });
}

async function assertNoTempFiles(dataDir: string) {
  try {
    assert.deepEqual(await fs.readdir(agentAttachmentTempDir(dataDir)), []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

test("image message route accepts image-before-payload and persists relation-backed public projection", async (t) => {
  const fixture = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(() => fixture.dispose());
  const session = await createPrimarySession(fixture);
  const boundary = "agent-image-boundary";
  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: multipart(boundary, [
      { name: "images", filename: "clipboard.svg", contentType: "image/svg+xml", bytes: PNG },
      { name: "payload", value: payload(fixture.workspaceId, "image-before-payload") }
    ])
  });
  assert.equal(response.statusCode, 201, response.body);
  const sent = response.json() as { messageItemId: number };
  const item = getContextItemById(fixture.db, sent.messageItemId);
  assert.ok(item);
  if (item.output.type !== "user_message") assert.fail("expected user_message projection");
  assert.deepEqual(item.output, {
    type: "user_message",
    text: "",
    attachments: [{ attachmentId: item.output.attachments[0]?.attachmentId, kind: "image", filename: "clipboard.png", mediaType: "image/png", size: 8 }]
  });
  assert.equal(getSessionTranscriptItems(fixture.db, fixture.workspaceId, session.id)[0]?.output.type, "user_message");
  await assert.doesNotReject(fs.access(agentAttachmentFilePath(fixture.dataDir, fixture.workspaceId, item.output.attachments[0]!.attachmentId)));
  await assertNoTempFiles(fixture.dataDir);

  const retry = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: multipart(boundary, [
      { name: "payload", value: payload(fixture.workspaceId, "image-before-payload") },
      { name: "images", filename: "retry.png", bytes: PNG }
    ])
  });
  assert.equal(retry.statusCode, 201, retry.body);
  assert.equal((retry.json() as { deduplicated: boolean }).deduplicated, true);
  assert.equal((await fs.readdir(agentAttachmentWorkspaceDir(fixture.dataDir, fixture.workspaceId))).length, 1);
  await assertNoTempFiles(fixture.dataDir);
});

test("fork preserves image attachment relations for visible_only and with_archive without duplicating files", async (t) => {
  const fixture = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(() => fixture.dispose());
  const session = await createPrimarySession(fixture);
  const boundary = "fork-image-boundary";
  const sent = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: multipart(boundary, [
      { name: "payload", value: payload(fixture.workspaceId, "fork-image") },
      { name: "images", filename: "fork.png", contentType: "image/png", bytes: PNG }
    ])
  });
  assert.equal(sent.statusCode, 201, sent.body);
  const sourceItemId = (sent.json() as { messageItemId: number }).messageItemId;
  const source = getContextItemById(fixture.db, sourceItemId);
  assert.ok(source && source.output.type === "user_message");
  const attachmentId = source.output.attachments[0]!.attachmentId;

  const assertForkHasSourceAttachment = async (mode: "visible_only" | "with_archive") => {
    const fork = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/sessions/fork",
      payload: { fromSessionId: session.id, fromItemId: sourceItemId, mode }
    });
    assert.equal(fork.statusCode, 201, fork.body);
    const forkedSessionId = (fork.json() as { id: string }).id;
    const copied = getSessionTranscriptItems(fixture.db, fixture.workspaceId, forkedSessionId)
      .find((item) => item.kind === "user");
    assert.ok(copied && copied.output.type === "user_message");
    assert.deepEqual(copied.output.attachments.map((attachment) => attachment.attachmentId), [attachmentId]);
    const relation = fixture.db.prepare(
      "select position from agent_context_item_attachment where context_item_id = ? and attachment_id = ?"
    ).get(copied.id, attachmentId) as { position: number } | undefined;
    assert.deepEqual(relation, { position: 0 });
  };

  await assertForkHasSourceAttachment("visible_only");
  fixture.db.prepare("update agent_context_item set archive_at = ? where id = ?").run(Date.now(), sourceItemId);
  await assertForkHasSourceAttachment("with_archive");

  const attachmentRows = fixture.db.prepare("select count(*) as count from agent_attachment where id = ?").get(attachmentId) as { count: number };
  assert.equal(attachmentRows.count, 1);
  await assert.doesNotReject(fs.access(agentAttachmentFilePath(fixture.dataDir, fixture.workspaceId, attachmentId)));
});

test("image message route rejects multipart without images and unsupported content types", async (t) => {
  const fixture = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(() => fixture.dispose());
  const session = await createPrimarySession(fixture);
  const boundary = "agent-no-image-boundary";
  const noImages = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: multipart(boundary, [{ name: "payload", value: JSON.stringify({ workspaceId: fixture.workspaceId, clientRequestId: "no-images" }) }])
  });
  assert.equal(noImages.statusCode, 400, noImages.body);
  const unsupported = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    headers: { "content-type": "text/plain" },
    payload: "not-json"
  });
  assert.equal(unsupported.statusCode, 415, unsupported.body);
});

test("image message route documents only the JSON body contract in OpenAPI", async (t) => {
  const fixture = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(() => fixture.dispose());
  const document = fixture.app.swagger() as unknown as {
    paths: Record<string, { post?: { description?: string; requestBody?: unknown } }>;
  };
  const operation = document.paths["/api/agent/sessions/{sessionId}/messages"]?.post;
  const requestBody = operation?.requestBody as
    | { description?: string; content?: Record<string, { schema?: { properties?: Record<string, { minLength?: number }>; required?: string[] } }> }
    | undefined;
  assert.deepEqual(Object.keys(requestBody?.content ?? {}), ["application/json"]);
  assert.equal(requestBody?.content?.["application/json"]?.schema?.properties?.text?.minLength, 1);
  assert.equal(requestBody?.content?.["application/json"]?.schema?.required?.includes("text"), true);
  assert.match(operation?.description ?? "", /multipart\/form-data/);
});

test("image message route accepts multipart payload in the middle and last", async (t) => {
  const fixture = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(() => fixture.dispose());
  const boundary = "agent-image-order-boundary";

  for (const [clientRequestId, parts] of [
    ["payload-middle", [
      { name: "images", filename: "first.png", bytes: PNG },
      { name: "payload", value: payload(fixture.workspaceId, "payload-middle") },
      { name: "images", filename: "second.png", bytes: PNG }
    ]],
    ["payload-last", [
      { name: "images", filename: "first.png", bytes: PNG },
      { name: "images", filename: "second.png", bytes: PNG },
      { name: "payload", value: payload(fixture.workspaceId, "payload-last") }
    ]]
  ] as const) {
    const session = await createPrimarySession(fixture);
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/agent/sessions/${session.id}/messages`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, parts)
    });
    assert.equal(response.statusCode, 201, `${clientRequestId}: ${response.body}`);
    await assertNoTempFiles(fixture.dataDir);
  }
});

test("image message route rejects invalid multipart fields, boundaries and part counts without temp residue", async (t) => {
  const fixture = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(() => fixture.dispose());
  const session = await createPrimarySession(fixture);
  const boundary = "agent-image-rejection-boundary";
  const request = async (clientRequestId: string, parts: Parameters<typeof multipart>[1], contentType = `multipart/form-data; boundary=${boundary}`) => {
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/agent/sessions/${session.id}/messages`,
      headers: { "content-type": contentType },
      payload: multipart(boundary, parts)
    });
    assert.equal(response.statusCode, 400, `${clientRequestId}: ${response.body}`);
    await assertNoTempFiles(fixture.dataDir);
  };

  await request("duplicate-payload", [
    { name: "images", filename: "first.png", bytes: PNG },
    { name: "payload", value: payload(fixture.workspaceId, "duplicate-payload") },
    { name: "payload", value: payload(fixture.workspaceId, "duplicate-payload-again") }
  ]);
  await request("unknown-field", [
    { name: "images", filename: "first.png", bytes: PNG },
    { name: "payload", value: payload(fixture.workspaceId, "unknown-field") },
    { name: "unexpected", value: "nope" }
  ]);
  await request("unknown-file", [
    { name: "images", filename: "first.png", bytes: PNG },
    { name: "payload", value: payload(fixture.workspaceId, "unknown-file") },
    { name: "attachment", filename: "unknown.png", bytes: PNG }
  ]);
  await request("too-many-parts", [
    { name: "payload", value: payload(fixture.workspaceId, "too-many-parts") },
    { name: "images", filename: "first.png", bytes: PNG },
    { name: "images", filename: "second.png", bytes: PNG },
    { name: "images", filename: "third.png", bytes: PNG },
    { name: "images", filename: "fourth.png", bytes: PNG },
    { name: "images", filename: "fifth.png", bytes: PNG }
  ]);
  await request("missing-boundary", [], "multipart/form-data");
  await request("invalid-boundary", [], "multipart/form-data; boundary=");
});
