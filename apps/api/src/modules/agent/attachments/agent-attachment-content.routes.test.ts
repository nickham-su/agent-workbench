import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { agentAttachmentFilePath, agentAttachmentsRoot, agentAttachmentWorkspaceDir } from "./agent-attachment-paths.js";
import { getContextItemById } from "../agent.store.js";
import { createAgentIntegrationFixture, createPrimarySession } from "../testkit/agent-integration-testkit.js";
import { createAgentTestFixture } from "../testkit/agent-testkit.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function multipart(boundary: string, workspaceId: string) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify({ workspaceId, clientRequestId: "content-read" })}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.from(PNG),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

async function createAttachment() {
  const fixture = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  const session = await createPrimarySession(fixture);
  const boundary = "content-boundary";
  const response = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/messages`, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: multipart(boundary, fixture.workspaceId) });
  assert.equal(response.statusCode, 201, response.body);
  const item = getContextItemById(fixture.db, (response.json() as { messageItemId: number }).messageItemId);
  assert.ok(item && item.output.type === "user_message");
  return { fixture, attachmentId: item.output.attachments[0]!.attachmentId };
}

async function getContent(fixture: Awaited<ReturnType<typeof createAgentIntegrationFixture>>, attachmentId: string) {
  return fixture.app.inject({ method: "GET", url: `/api/agent/attachments/${attachmentId}/content` });
}

test("attachment content returns 401 before route handling when unauthenticated", async (t) => {
  const fixture = await createAgentTestFixture({ withApp: true, authToken: "test-auth-token", agentWorkerConcurrency: 0 });
  t.after(() => fixture.dispose());
  assert.ok(fixture.app);
  assert.equal((await fixture.app.inject({ method: "GET", url: "/api/agent/attachments/att_missing/content" })).statusCode, 401);
});

test("attachment content is relation-authorized and has strict inline headers", async (t) => {
  const { fixture, attachmentId } = await createAttachment();
  t.after(() => fixture.dispose());
  const response = await getContent(fixture, attachmentId);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["content-type"], "image/png");
  assert.equal(response.headers["content-disposition"], "inline");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers["content-length"], String(PNG.byteLength));
  assert.deepEqual(response.rawPayload, Buffer.from(PNG));
});

test("attachment content route streams the validated file instead of buffering it", async () => {
  const routeSource = await fs.readFile(new URL("../routes/agent-public.routes.ts", import.meta.url), "utf8");
  const compositionSource = await fs.readFile(new URL("../agent.composition.ts", import.meta.url), "utf8");
  assert.match(routeSource, /createReadStream\(content\.filePath\)/);
  assert.doesNotMatch(compositionSource, /fs\.readFile\(realFilePath\)/);
});

test("attachment content hides absent relation, storage key mismatch, absent files and size mismatch as 404", async (t) => {
  const { fixture, attachmentId } = await createAttachment();
  t.after(() => fixture.dispose());
  fixture.db.prepare("delete from agent_context_item_attachment where attachment_id = ?").run(attachmentId);
  assert.equal((await getContent(fixture, attachmentId)).statusCode, 404);
  fixture.db.prepare("insert into agent_context_item_attachment (context_item_id, attachment_id, position) select id, ?, 0 from agent_context_item limit 1").run(attachmentId);
  fixture.db.prepare("update agent_attachment set storage_key = ? where id = ?").run("att_other", attachmentId);
  assert.equal((await getContent(fixture, attachmentId)).statusCode, 404);
  fixture.db.prepare("update agent_attachment set storage_key = ? where id = ?").run(attachmentId, attachmentId);
  const filePath = agentAttachmentFilePath(fixture.dataDir, fixture.workspaceId, attachmentId);
  await fs.rm(filePath);
  assert.equal((await getContent(fixture, attachmentId)).statusCode, 404);
  await fs.writeFile(filePath, Buffer.concat([Buffer.from(PNG), Buffer.from([0])]), { mode: 0o600 });
  assert.equal((await getContent(fixture, attachmentId)).statusCode, 404);
  assert.equal((await getContent(fixture, "att_missing")).statusCode, 404);
});

test("attachment content rejects files and workspace directories that are symlinks or directories", async (t) => {
  const { fixture, attachmentId } = await createAttachment();
  t.after(() => fixture.dispose());
  const filePath = agentAttachmentFilePath(fixture.dataDir, fixture.workspaceId, attachmentId);
  const outsideFile = path.join(fixture.dataDir, "outside-file");
  await fs.rename(filePath, outsideFile);
  await fs.symlink(outsideFile, filePath);
  assert.equal((await getContent(fixture, attachmentId)).statusCode, 404);
  await fs.rm(filePath);
  await fs.rename(outsideFile, filePath);
  await fs.rm(filePath);
  await fs.mkdir(filePath);
  assert.equal((await getContent(fixture, attachmentId)).statusCode, 404);

  const { fixture: workspaceFixture, attachmentId: workspaceAttachmentId } = await createAttachment();
  t.after(() => workspaceFixture.dispose());
  const workspaceDir = agentAttachmentWorkspaceDir(workspaceFixture.dataDir, workspaceFixture.workspaceId);
  const outsideWorkspace = path.join(workspaceFixture.dataDir, "outside-workspace");
  await fs.rename(workspaceDir, outsideWorkspace);
  await fs.symlink(outsideWorkspace, workspaceDir);
  assert.equal((await getContent(workspaceFixture, workspaceAttachmentId)).statusCode, 404);
});

test("attachment content rejects a realpath escape through the by_workspace ancestor", async (t) => {
  const { fixture, attachmentId } = await createAttachment();
  t.after(() => fixture.dispose());
  const attachmentsRoot = agentAttachmentsRoot(fixture.dataDir);
  const byWorkspaceDir = path.join(attachmentsRoot, "by_workspace");
  const outside = path.join(fixture.dataDir, "outside-by-workspace");
  await fs.rename(byWorkspaceDir, outside);
  await fs.symlink(outside, byWorkspaceDir);
  assert.equal((await getContent(fixture, attachmentId)).statusCode, 404);
});
