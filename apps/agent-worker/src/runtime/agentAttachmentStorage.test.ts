import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentAttachmentStorage } from "./agentAttachmentStorage.js";
import { readWorkspaceImage } from "./workspaceImageReader.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function createFixture(t: test.TestContext) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "awb-agent-attachment-storage-"));
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }));
  const workspaceId = "ws_test";
  const attachmentId = "att_test-image";
  const relativePath = `.awb/agent/attachments/${attachmentId}.png`;
  const filePath = path.join(workspacePath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, PNG_BYTES);
  return { workspacePath, workspaceId, attachmentId, filePath, relativePath };
}

test("AgentAttachmentStorage reads a validated image from the current Run Workspace path", async (t) => {
  const fixture = await createFixture(t);
  const result = await createAgentAttachmentStorage().read({
    ...fixture, path: fixture.relativePath, runWorkspaceId: fixture.workspaceId, mediaType: "image/png"
  });
  assert.equal(result.mediaType, "image/png");
  assert.deepEqual(result.bytes, PNG_BYTES);
});

test("Workspace image reader accepts JPEG and WebP signatures only with matching extensions", async (t) => {
  const fixture = await createFixture(t);
  const directory = path.dirname(fixture.filePath);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  await fs.writeFile(path.join(directory, "att_jpeg.jpg"), jpeg);
  await fs.writeFile(path.join(directory, "att_webp.webp"), webp);
  const storage = createAgentAttachmentStorage();
  for (const [attachmentId, mediaType, bytes] of [["att_jpeg", "image/jpeg", jpeg], ["att_webp", "image/webp", webp]] as const) {
    const result = await storage.read({ workspaceId: fixture.workspaceId, runWorkspaceId: fixture.workspaceId,
      workspacePath: fixture.workspacePath, attachmentId, path: `.awb/agent/attachments/${attachmentId}.${mediaType === "image/jpeg" ? "jpg" : "webp"}`, mediaType });
    assert.equal(result.mediaType, mediaType);
    assert.deepEqual(result.bytes, bytes);
  }
  await assert.rejects(() => readWorkspaceImage({ workspacePath: fixture.workspacePath, path: ".awb/agent/attachments/att_webp.jpg" }));
});

test("AgentAttachmentStorage rejects forged path, cross-Workspace identity and changed image", async (t) => {
  const fixture = await createFixture(t);
  const storage = createAgentAttachmentStorage();
  const input = { ...fixture, path: fixture.relativePath, runWorkspaceId: fixture.workspaceId, mediaType: "image/png" as const };
  await assert.rejects(() => storage.read({ ...input, workspaceId: "../outside" }), /different Workspace/);
  await assert.rejects(() => storage.read({ ...input, runWorkspaceId: "ws_other" }), /different Workspace/);
  await assert.rejects(() => storage.read({ ...input, path: "../other.png" }), /does not match/);
  await assert.rejects(() => storage.read({ ...input, path: ".awb/agent/attachments/att_other.png" }), /does not match/);
  await assert.rejects(() => storage.read({ ...input, mediaType: "image/jpeg" }), /does not match/);
  await fs.writeFile(fixture.filePath, Buffer.from([0xff, 0xd8, 0xff]));
  await assert.rejects(() => storage.read(input), /signature/);
});

test("Workspace image reader refuses symlink parents, symlink files, empty and oversized files", async (t) => {
  const fixture = await createFixture(t);
  const fileDir = path.dirname(fixture.filePath);
  await fs.symlink(fixture.filePath, path.join(fileDir, "linked.png"));
  await assert.rejects(() => readWorkspaceImage({ workspacePath: fixture.workspacePath, path: ".awb/agent/attachments/linked.png" }));
  await fs.symlink(fileDir, path.join(fixture.workspacePath, "linked"));
  await assert.rejects(() => readWorkspaceImage({ workspacePath: fixture.workspacePath, path: "linked/test.png" }));
  await fs.writeFile(path.join(fileDir, "empty.png"), Buffer.alloc(0));
  await assert.rejects(() => readWorkspaceImage({ workspacePath: fixture.workspacePath, path: ".awb/agent/attachments/empty.png" }));
  await fs.writeFile(path.join(fileDir, "big.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(() => readWorkspaceImage({ workspacePath: fixture.workspacePath, path: ".awb/agent/attachments/big.png" }));
  await assert.rejects(() => readWorkspaceImage({ workspacePath: fixture.workspacePath, path: "../../outside.png" }));
});
