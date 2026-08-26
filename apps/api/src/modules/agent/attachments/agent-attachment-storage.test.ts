import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  AGENT_IMAGE_MAX_BYTES,
  AGENT_IMAGE_MAX_COUNT,
  AGENT_IMAGE_MAX_TOTAL_BYTES
} from "./agent-attachment-limits.js";
import {
  agentAttachmentFilePath,
  agentAttachmentTempFilePath,
  agentAttachmentTempDir,
  agentAttachmentsRoot
} from "./agent-attachment-paths.js";
import { detectAgentImageMediaType } from "./agent-attachment-signature.js";
import {
  assertAgentImageByteSize,
  cleanupAgedAgentAttachmentTempFiles,
  commitAgentAttachmentTempFile,
  createAgentAttachmentTempFile,
  removeAgentAttachmentWorkspaceDirectory,
  removeAgentAttachmentTempFile,
  sanitizeAgentImageFilename
} from "./agent-attachment-storage.js";

const dataDirs = new Set<string>();

async function createDataDir() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-agent-attachments-"));
  dataDirs.add(dataDir);
  return dataDir;
}

afterEach(async () => {
  await Promise.all([...dataDirs].map(async (dataDir) => {
    dataDirs.delete(dataDir);
    await fs.rm(dataDir, { recursive: true, force: true });
  }));
});

test("attachment paths remain under the data directory and reject unsafe path segments", () => {
  const dataDir = "/var/lib/awb";
  assert.equal(agentAttachmentsRoot(dataDir), "/var/lib/awb/agent/attachments");
  assert.equal(agentAttachmentTempDir(dataDir), "/var/lib/awb/agent/attachments/temp");
  assert.equal(agentAttachmentTempFilePath(dataDir, "tmp_abc-123"), "/var/lib/awb/agent/attachments/temp/tmp_abc-123.part");
  assert.equal(
    agentAttachmentFilePath(dataDir, "ws_abc-123", "att_abc-123"),
    "/var/lib/awb/agent/attachments/by_workspace/ws_abc-123/att_abc-123"
  );

  for (const invalid of ["", "../ws", "ws/a", "ws\\a", " ws"]) {
    assert.throws(() => agentAttachmentFilePath(dataDir, invalid, "att_abc"), /Invalid agent attachment workspace ID/);
  }
  for (const invalid of ["", "../att", "att/a", "att_../x", "attachment"]) {
    assert.throws(() => agentAttachmentFilePath(dataDir, "ws_a", invalid), /Invalid agent attachment ID/);
  }
});

test("attachment signature detection accepts only PNG, JPEG, and WebP signatures", () => {
  assert.equal(detectAgentImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(detectAgentImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(detectAgentImageMediaType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), "image/webp");
  assert.equal(detectAgentImageMediaType(new TextEncoder().encode("<svg></svg>")), null);
  assert.equal(detectAgentImageMediaType(Uint8Array.from([0x89, 0x50])), null);
});

test("attachment limits and filename normalization enforce V1 bounds", () => {
  assert.deepEqual(
    [AGENT_IMAGE_MAX_COUNT, AGENT_IMAGE_MAX_BYTES, AGENT_IMAGE_MAX_TOTAL_BYTES],
    [4, 10 * 1024 * 1024, 20 * 1024 * 1024]
  );
  assert.equal(assertAgentImageByteSize(1), 1);
  assert.equal(assertAgentImageByteSize(AGENT_IMAGE_MAX_BYTES), AGENT_IMAGE_MAX_BYTES);
  assert.throws(() => assertAgentImageByteSize(0), /Invalid agent image byte size/);
  assert.throws(() => assertAgentImageByteSize(AGENT_IMAGE_MAX_BYTES + 1), /Invalid agent image byte size/);
  assert.equal(sanitizeAgentImageFilename("../../ screenshot\n.png ", "png"), "screenshot.png");
  assert.equal(sanitizeAgentImageFilename("..\\screenshot.svg", "webp"), "screenshot.webp");
  assert.equal(sanitizeAgentImageFilename("\u0000", "webp"), "pasted-image.webp");
  const longName = sanitizeAgentImageFilename(`${"x".repeat(300)}.svg`, "jpg");
  assert.equal([...longName].length, 255);
  assert.equal(longName.endsWith(".jpg"), true);
});

test("attachment storage creates private temp files and commits final files without overwriting", async () => {
  const dataDir = await createDataDir();
  const workspaceId = "ws_a";
  const tempId = "tmp_a";
  const attachmentId = "att_a";
  const handle = await createAgentAttachmentTempFile({ dataDir, tempId });
  await handle.writeFile(Uint8Array.from([1, 2, 3]));
  await handle.close();

  const tempStat = await fs.stat(agentAttachmentTempFilePath(dataDir, tempId));
  assert.equal(tempStat.mode & 0o077, 0);
  const finalPath = await commitAgentAttachmentTempFile({ dataDir, workspaceId, attachmentId, tempId });
  assert.equal(await fs.readFile(finalPath, "utf8"), "\u0001\u0002\u0003");
  await assert.rejects(
    () => commitAgentAttachmentTempFile({ dataDir, workspaceId, attachmentId, tempId: "tmp_b" }),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT"
  );

  const duplicate = await createAgentAttachmentTempFile({ dataDir, tempId: "tmp_b" });
  await duplicate.close();
  await assert.rejects(
    () => commitAgentAttachmentTempFile({ dataDir, workspaceId, attachmentId, tempId: "tmp_b" }),
    (error: NodeJS.ErrnoException) => error.code === "EEXIST"
  );
  await removeAgentAttachmentTempFile({ dataDir, tempId: "tmp_b" });
});

test("aged temp cleanup removes only old ordinary temp files", async () => {
  const dataDir = await createDataDir();
  const tempDir = agentAttachmentTempDir(dataDir);
  await fs.mkdir(tempDir, { recursive: true });
  const oldFile = path.join(tempDir, "old.part");
  const thresholdFile = path.join(tempDir, "threshold.part");
  const freshFile = path.join(tempDir, "fresh.part");
  const nestedDir = path.join(tempDir, "nested");
  const symlink = path.join(tempDir, "old-link.part");
  await fs.writeFile(oldFile, "old");
  await fs.writeFile(thresholdFile, "threshold");
  await fs.writeFile(freshFile, "fresh");
  await fs.mkdir(nestedDir);
  await fs.writeFile(path.join(nestedDir, "keep"), "keep");
  await fs.symlink(oldFile, symlink);
  const now = 1_700_000_000_500;
  await fs.utimes(oldFile, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));
  await fs.utimes(thresholdFile, new Date(now - 24 * 60 * 60 * 1000), new Date(now - 24 * 60 * 60 * 1000));
  await cleanupAgedAgentAttachmentTempFiles({ dataDir, nowMs: now, maxAgeMs: 24 * 60 * 60 * 1000 });
  await assert.rejects(() => fs.access(oldFile));
  await assert.doesNotReject(() => fs.access(thresholdFile));
  await assert.doesNotReject(() => fs.access(freshFile));
  await assert.doesNotReject(() => fs.access(nestedDir));
  await assert.doesNotReject(() => fs.lstat(symlink));

  const finalPath = agentAttachmentFilePath(dataDir, "ws_a", "att_final");
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "final");
  await fs.utimes(finalPath, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));
  await cleanupAgedAgentAttachmentTempFiles({ dataDir, nowMs: now, maxAgeMs: 24 * 60 * 60 * 1000 });
  await assert.doesNotReject(() => fs.access(finalPath));
});

test("aged temp cleanup does not follow a symlinked temp directory", async () => {
  const dataDir = await createDataDir();
  const tempDir = agentAttachmentTempDir(dataDir);
  const outside = path.join(dataDir, "outside-temp");
  const outsideFile = path.join(outside, "old.part");
  await fs.mkdir(path.dirname(tempDir), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(outsideFile, "old");
  const now = Date.now();
  await fs.utimes(outsideFile, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));
  await fs.symlink(outside, tempDir);
  await cleanupAgedAgentAttachmentTempFiles({ dataDir, nowMs: now, maxAgeMs: 24 * 60 * 60 * 1000 });
  await assert.doesNotReject(() => fs.access(outsideFile));
});

test("workspace attachment cleanup never traverses symlinked ancestors", async () => {
  const dataDir = await createDataDir();
  const finalPath = agentAttachmentFilePath(dataDir, "ws_a", "att_a");
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "image");
  assert.equal(await removeAgentAttachmentWorkspaceDirectory({ dataDir, workspaceId: "ws_a" }), "removed");
  await assert.rejects(() => fs.access(path.dirname(finalPath)));

  const root = agentAttachmentsRoot(dataDir);
  const byWorkspace = path.join(root, "by_workspace");
  const outside = path.join(dataDir, "outside");
  await fs.mkdir(outside);
  await fs.rm(byWorkspace, { recursive: true, force: true });
  await fs.writeFile(path.join(outside, "keep"), "keep");
  await fs.symlink(outside, byWorkspace);
  assert.equal(await removeAgentAttachmentWorkspaceDirectory({ dataDir, workspaceId: "ws_a" }), "skipped_unsafe");
  await assert.doesNotReject(() => fs.access(path.join(outside, "keep")));
});
