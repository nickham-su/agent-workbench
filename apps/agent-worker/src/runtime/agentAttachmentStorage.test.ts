import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentAttachmentStorage } from "./agentAttachmentStorage.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function createFixture(t: test.TestContext) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-agent-attachment-storage-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const workspaceId = "ws_test";
  const attachmentId = "att_test-image";
  const directory = path.join(dataDir, "agent", "attachments", "by_workspace", workspaceId);
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, attachmentId);
  await fs.writeFile(filePath, PNG_BYTES);
  return { dataDir, workspaceId, attachmentId, filePath };
}

test("AgentAttachmentStorage reads a validated image from the scoped data directory", async (t) => {
  const fixture = await createFixture(t);
  const storage = createAgentAttachmentStorage(fixture.dataDir);

  const result = await storage.read({
    workspaceId: fixture.workspaceId,
    attachmentId: fixture.attachmentId,
    mediaType: "image/png"
  });

  assert.equal(result.mediaType, "image/png");
  assert.deepEqual(result.bytes, PNG_BYTES);
});

test("AgentAttachmentStorage rejects invalid identifiers, media mismatches, and symbolic links", async (t) => {
  const fixture = await createFixture(t);
  const storage = createAgentAttachmentStorage(fixture.dataDir);

  await assert.rejects(
    () => storage.read({ workspaceId: "../outside", attachmentId: fixture.attachmentId, mediaType: "image/png" }),
    /invalid attachment workspace ID/
  );
  await assert.rejects(
    () => storage.read({ workspaceId: fixture.workspaceId, attachmentId: fixture.attachmentId, mediaType: "image/jpeg" }),
    /media type does not match/
  );

  const linkId = "att_link-image";
  await fs.symlink(fixture.filePath, path.join(path.dirname(fixture.filePath), linkId));
  await assert.rejects(
    () => storage.read({ workspaceId: fixture.workspaceId, attachmentId: linkId, mediaType: "image/png" }),
    /not a regular file/
  );

  const emptyId = "att_empty-image";
  await fs.writeFile(path.join(path.dirname(fixture.filePath), emptyId), Buffer.alloc(0));
  await assert.rejects(
    () => storage.read({ workspaceId: fixture.workspaceId, attachmentId: emptyId, mediaType: "image/png" }),
    /size is invalid/
  );

  const directoryId = "att_directory-image";
  await fs.mkdir(path.join(path.dirname(fixture.filePath), directoryId));
  await assert.rejects(
    () => storage.read({ workspaceId: fixture.workspaceId, attachmentId: directoryId, mediaType: "image/png" }),
    /not a regular file/
  );
});
