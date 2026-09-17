import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
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
  agentAttachmentsRoot,
  agentAttachmentWorkspaceDir
} from "./agent-attachment-paths.js";
import { detectAgentImageMediaType } from "./agent-attachment-signature.js";
import {
  AgentAttachmentCommitError,
  assertAgentImageByteSize,
  cleanupAgedAgentAttachmentTempFiles,
  commitAgentAttachmentTempFile,
  createAgentAttachmentTempFile,
  removeAgentAttachmentWorkspaceDirectory,
  removeAgentAttachmentTempFile,
  removeAgentAttachmentFinalFile,
  resolveSafeAgentAttachmentContentPath,
  sanitizeAgentImageFilename
} from "./agent-attachment-storage.js";
import { openSecureRootDirectory, removeSecureDirectoryTree } from "../../../infra/fs/secure-directory.js";

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
    (error: unknown) => error instanceof AgentAttachmentCommitError
      && !error.finalCreated
      && (error.cause as NodeJS.ErrnoException).code === "ENOENT",
  );

  const duplicate = await createAgentAttachmentTempFile({ dataDir, tempId: "tmp_b" });
  await duplicate.close();
  await assert.rejects(
    () => commitAgentAttachmentTempFile({ dataDir, workspaceId, attachmentId, tempId: "tmp_b" }),
    (error: unknown) => error instanceof AgentAttachmentCommitError
      && !error.finalCreated
      && (error.cause as NodeJS.ErrnoException).code === "EEXIST",
  );
  await removeAgentAttachmentTempFile({ dataDir, tempId: "tmp_b" });
});

test("attachment content resolver rejects a symlink escape", async () => {
  const dataDir = await createDataDir();
  const workspaceId = "ws_a";
  const attachmentId = "att_escape";
  const finalPath = agentAttachmentFilePath(dataDir, workspaceId, attachmentId);
  const outside = path.join(dataDir, "outside");
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, attachmentId), "abc");
  await fs.symlink(path.join(outside, attachmentId), finalPath);
  const resolved = await resolveSafeAgentAttachmentContentPath({
    dataDir,
    workspaceId,
    storageKey: attachmentId,
    expectedByteSize: 3,
  });

  assert.equal(resolved, null);
});

test("attachment temp 与发布目录的预置 symlink 不会写入 dataDir 外", async () => {
  const dataDir = await createDataDir();
  const outside = path.join(dataDir, "outside");
  await fs.mkdir(outside);
  const attachments = agentAttachmentsRoot(dataDir);
  await fs.mkdir(attachments, { recursive: true });
  await fs.symlink(outside, path.join(attachments, "temp"));
  await assert.rejects(() => createAgentAttachmentTempFile({ dataDir, tempId: "tmp_escape" }));
  await assert.deepEqual(await fs.readdir(outside), []);

  await fs.unlink(path.join(attachments, "temp"));
  const temp = await createAgentAttachmentTempFile({ dataDir, tempId: "tmp_commit" });
  await temp.writeFile("safe");
  await temp.close();
  await fs.symlink(outside, path.join(attachments, "by_workspace"));
  await assert.rejects(() => commitAgentAttachmentTempFile({ dataDir, workspaceId: "ws_escape", attachmentId: "att_escape", tempId: "tmp_commit" }));
  await assert.deepEqual(await fs.readdir(outside), []);
  await assert.doesNotReject(() => fs.access(agentAttachmentTempFilePath(dataDir, "tmp_commit")));
});

test("固定目录 fd 在 inode 固定后拒绝删除替换到 quarantine 名称的 victim", async () => {
  const dataDir = await createDataDir();
  const target = path.join(dataDir, "target");
  const moved = path.join(dataDir, "moved");
  const victim = path.join(dataDir, "victim");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "secret"), "original");
  await fs.mkdir(victim);
  await fs.writeFile(path.join(victim, "keep"), "victim");
  const root = await openSecureRootDirectory(dataDir);
  try {
    await assert.rejects(() => removeSecureDirectoryTree({
      root,
      relativeSegments: ["target"],
      quarantineDirectory: ".quarantine",
      afterPinnedForTest: async ({ parentFdPath, name }) => {
        if (!name.startsWith(".delete-")) return;
        await fs.rename(path.join(parentFdPath, name), moved);
        await fs.rename(victim, path.join(parentFdPath, name));
      }
    }), /replacement (retained|pending)/);
  } finally {
    await root.handle.close();
  }
  // 固定的原 inode 被清空，但终止时绝不 rmdir 已被替换的 quarantine entry。
  await assert.deepEqual(await fs.readdir(moved), []);
  const quarantineEntries = await fs.readdir(path.join(dataDir, ".quarantine"));
  const replacedName = quarantineEntries.find((entry) => entry.startsWith(".delete-"));
  assert.ok(replacedName);
  assert.equal(await fs.readFile(path.join(dataDir, ".quarantine", replacedName, "keep"), "utf8"), "victim");
});

test("递归 private file slot 在可检测 replacement 时保留 victim 并标记 pending", async () => {
  const dataDir = await createDataDir();
  const target = path.join(dataDir, "target-file-slot");
  const movedOriginal = path.join(dataDir, "moved-original-file");
  const victim = path.join(dataDir, "victim-file");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "payload"), "original");
  await fs.writeFile(victim, "victim");
  const root = await openSecureRootDirectory(dataDir);
  try {
    await assert.rejects(() => removeSecureDirectoryTree({
      root,
      relativeSegments: ["target-file-slot"],
      quarantineDirectory: ".quarantine",
      afterRetireForTest: async ({ parentFdPath, name, kind }) => {
        if (kind !== "file") return;
        await fs.rename(path.join(parentFdPath, name), movedOriginal);
        await fs.rename(victim, path.join(parentFdPath, name));
      },
    }), /replacement (retained|pending)/);
  } finally {
    await root.handle.close();
  }
  assert.equal(await fs.readFile(movedOriginal, "utf8"), "original");
  const quarantineRoot = path.join(dataDir, ".quarantine");
  const roots = await fs.readdir(quarantineRoot);
  const retainedRoot = roots.find((name) => name.startsWith(".delete-"));
  assert.ok(retainedRoot);
  const retainedEntries = await fs.readdir(path.join(quarantineRoot, retainedRoot));
  const pending = retainedEntries.find((name) => name.startsWith(".delete-replacement-pending-"));
  assert.ok(pending);
  assert.equal(await fs.readFile(path.join(quarantineRoot, retainedRoot, pending), "utf8"), "victim");
});

test("递归已有 v1 directory slot identity mismatch 时不再 retire victim，重试仍为 pending", async () => {
  const dataDir = await createDataDir();
  const quarantine = path.join(dataDir, ".quarantine");
  const source = path.join(dataDir, "retired-directory");
  const victim = path.join(dataDir, "victim-directory");
  await fs.mkdir(quarantine, { recursive: true });
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "original"), "original");
  const sourceStat = await fs.lstat(source);
  const privateName = `.delete-v1-tree-d-${sourceStat.dev.toString(36)}-${sourceStat.ino.toString(36)}-0123456789abcdef0123456789abcdef`;
  await fs.rename(source, path.join(quarantine, privateName));
  await fs.mkdir(victim);
  await fs.writeFile(path.join(victim, "keep"), "victim");
  await fs.rename(path.join(quarantine, privateName), path.join(dataDir, "moved-directory"));
  await fs.rename(victim, path.join(quarantine, privateName));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const root = await openSecureRootDirectory(dataDir);
    try {
      assert.equal(await removeSecureDirectoryTree({
        root,
        relativeSegments: ["missing-target"],
        quarantineDirectory: ".quarantine",
      }), "replacement_pending");
    } finally {
      await root.handle.close();
    }
    const retainedName = (await fs.readdir(quarantine)).find((name) => name === privateName || name.startsWith(".delete-replacement-pending-"));
    assert.ok(retainedName);
    assert.equal(await fs.readFile(path.join(quarantine, retainedName, "keep"), "utf8"), "victim");
  }
});

test("stale 非 replacement quarantine 私有槽会在后续重试时收敛", async () => {
  const dataDir = await createDataDir();
  const quarantine = path.join(dataDir, ".quarantine");
  const source = path.join(dataDir, "stale-source");
  await fs.mkdir(quarantine, { recursive: true });
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "payload"), "stale");
  const root = await openSecureRootDirectory(dataDir);
  try {
    const sourceStat = await fs.lstat(source);
    const stale = `.delete-v1-tree-d-${sourceStat.dev.toString(36)}-${sourceStat.ino.toString(36)}-0123456789abcdef0123456789abcdef`;
    await fs.rename(source, path.join(quarantine, stale));
    assert.equal(await removeSecureDirectoryTree({
      root,
      relativeSegments: ["does-not-exist"],
      quarantineDirectory: ".quarantine",
    }), "not_found");
    await assert.rejects(() => fs.access(path.join(quarantine, stale)));
  } finally {
    await root.handle.close();
  }
});

test("replacement marker 在第二次 secure 删除时仍传播 pending，而非报告 not_found", async () => {
  const dataDir = await createDataDir();
  const marker = path.join(dataDir, ".quarantine", ".delete-replacement-pending-marker");
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, "victim");
  const root = await openSecureRootDirectory(dataDir);
  try {
    assert.equal(await removeSecureDirectoryTree({
      root,
      relativeSegments: ["does-not-exist"],
      quarantineDirectory: ".quarantine",
    }), "replacement_pending");
  } finally {
    await root.handle.close();
  }
  assert.equal(await fs.readFile(marker, "utf8"), "victim");
});

test("attachment temp 创建后父目录替换时仅清理固定 inode 中的本次文件", async () => {
  const dataDir = await createDataDir();
  const tempDir = agentAttachmentTempDir(dataDir);
  const movedTempDir = path.join(dataDir, "moved-temp");
  await assert.rejects(
    () => createAgentAttachmentTempFile({
      dataDir,
      tempId: "tmp_race",
      afterCreateForTest: async () => {
        await fs.rename(tempDir, movedTempDir);
        await fs.mkdir(tempDir);
      }
    }),
    /secure directory changed or escaped its trusted root/,
  );
  await assert.deepEqual(await fs.readdir(movedTempDir), []);
  await assert.deepEqual(await fs.readdir(tempDir), []);
});

test("attachment final 目录晚替换时只从固定 workspace fd 撤回本请求 inode", async () => {
  const dataDir = await createDataDir();
  const workspaceId = "ws_race";
  const attachmentId = "att_race";
  const tempId = "tmp_race";
  const temp = await createAgentAttachmentTempFile({ dataDir, tempId });
  await temp.writeFile("secret");
  await temp.close();
  const workspaceDir = agentAttachmentWorkspaceDir(dataDir, workspaceId);
  const movedWorkspaceDir = path.join(dataDir, "moved-workspace");
  await assert.rejects(
    () => commitAgentAttachmentTempFile({
      dataDir,
      workspaceId,
      attachmentId,
      tempId,
      afterLinkForTest: async () => {
        await fs.rename(workspaceDir, movedWorkspaceDir);
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, attachmentId), "victim");
      }
    }),
    (error: unknown) => error instanceof AgentAttachmentCommitError && !error.finalCreated && error.sourceCleanupPending,
  );
  await assert.deepEqual(await fs.readdir(movedWorkspaceDir), []);
  await assert.equal(await fs.readFile(path.join(workspaceDir, attachmentId), "utf8"), "victim");
});

test("attachment final link 后 temp 父目录移动时明确标记 source cleanup pending", async () => {
  const dataDir = await createDataDir();
  const workspaceId = "ws_source_pending";
  const attachmentId = "att_source-pending";
  const tempId = "tmp_source-pending";
  const temp = await createAgentAttachmentTempFile({ dataDir, tempId });
  await temp.writeFile("source");
  await temp.close();
  const tempDir = agentAttachmentTempDir(dataDir);
  const movedTempDir = path.join(dataDir, "moved-temp-after-link");

  await assert.rejects(
    () => commitAgentAttachmentTempFile({
      dataDir,
      workspaceId,
      attachmentId,
      tempId,
      afterLinkForTest: async () => {
        await fs.rename(tempDir, movedTempDir);
        await fs.mkdir(tempDir);
      },
    }),
    (error: unknown) => error instanceof AgentAttachmentCommitError && !error.finalCreated && error.sourceCleanupPending,
  );
  // final link 后 topology 复验失败时，source 会从旧 temp fd 转移到稳定 cleanup root。
  await assert.rejects(() => fs.access(path.join(movedTempDir, `${tempId}.part`)));
  const cleanup = path.join(agentAttachmentsRoot(dataDir), ".attachment-cleanup");
  assert.equal((await fs.readdir(cleanup)).filter((name) => name.startsWith(".delete-v1-")).length, 1);
});

test("attachment source 已 retire 后 unlink EIO 会迁入稳定 root，并由后续 janitor 收敛", async () => {
  const dataDir = await createDataDir();
  const workspaceId = "ws_retired_source";
  const attachmentId = "att_retired-source";
  const tempId = "tmp_retired-source";
  const temp = await createAgentAttachmentTempFile({ dataDir, tempId });
  await temp.writeFile("source");
  await temp.close();
  const tempDir = agentAttachmentTempDir(dataDir);
  const movedTempDir = path.join(dataDir, "moved-temp-retired-source");
  let unlinkAttempts = 0;
  await assert.rejects(
    () => commitAgentAttachmentTempFile({
      dataDir,
      workspaceId,
      attachmentId,
      tempId,
      afterSourceRetireForTest: async () => {
        await fs.rename(tempDir, movedTempDir);
        await fs.mkdir(tempDir);
      },
      removeSourceRetiredForTest: () => ++unlinkAttempts > 2,
    }),
    (error: unknown) => error instanceof AgentAttachmentCommitError && !error.finalCreated && error.sourceCleanupPending,
  );
  assert.ok(unlinkAttempts >= 2);
  await assert.rejects(() => fs.access(path.join(movedTempDir, `${tempId}.part`)));
  const cleanup = path.join(agentAttachmentsRoot(dataDir), ".attachment-cleanup");
  assert.equal((await fs.readdir(cleanup)).filter((name) => name.startsWith(".delete-v1-")).length, 1);
  await cleanupAgedAgentAttachmentTempFiles({ dataDir, nowMs: Date.now(), maxAgeMs: 0 });
  assert.deepEqual(await fs.readdir(cleanup), []);
});

test("attachment resolver returns an already-open inode after pathname replacement", async () => {
  const dataDir = await createDataDir();
  const workspaceId = "ws_a";
  const attachmentId = "att_a";
  const handle = await createAgentAttachmentTempFile({ dataDir, tempId: "tmp_a" });
  await handle.writeFile("authorized");
  await handle.close();
  const finalPath = await commitAgentAttachmentTempFile({ dataDir, workspaceId, attachmentId, tempId: "tmp_a" });
  const resolved = await resolveSafeAgentAttachmentContentPath({ dataDir, workspaceId, storageKey: attachmentId, expectedByteSize: 10 });
  assert.ok(resolved);
  const replacement = path.join(dataDir, "other-workspace-file");
  await fs.writeFile(replacement, "forbidden");
  await fs.unlink(finalPath);
  await fs.symlink(replacement, finalPath);
  const stream = createReadStream(resolved.filePath, { fd: resolved.handle.fd, autoClose: false });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once("end", resolve);
    stream.once("error", reject);
  });
  await resolved.handle.close();
  assert.equal(Buffer.concat(chunks).toString("utf8"), "authorized");
});

test("attachment commit reports a request-owned final when temp unlink fails", async () => {
  const dataDir = await createDataDir();
  const workspaceId = "ws_a";
  const attachmentId = "att_linked";
  const tempId = "tmp_linked";
  const handle = await createAgentAttachmentTempFile({ dataDir, tempId });
  await handle.writeFile(Uint8Array.from([1, 2, 3]));
  await handle.close();

  await commitAgentAttachmentTempFile({ dataDir, workspaceId, attachmentId, tempId });
  await assert.doesNotReject(() => fs.access(agentAttachmentFilePath(dataDir, workspaceId, attachmentId)));
  await assert.rejects(() => fs.access(agentAttachmentTempFilePath(dataDir, tempId)));
});

test("aged temp cleanup removes only old ordinary temp files", async () => {
  const dataDir = await createDataDir();
  const tempDir = agentAttachmentTempDir(dataDir);
  await fs.mkdir(tempDir, { recursive: true });
  const oldFile = path.join(tempDir, "tmp_old.part");
  const thresholdFile = path.join(tempDir, "tmp_threshold.part");
  const freshFile = path.join(tempDir, "tmp_fresh.part");
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

test("aged temp janitor 保留 replacement marker，并收敛普通 attachment 私有槽", async () => {
  const dataDir = await createDataDir();
  const tempDir = agentAttachmentTempDir(dataDir);
  await fs.mkdir(tempDir, { recursive: true });
  const marker = path.join(tempDir, ".delete-replacement-pending-victim");
  const stale = path.join(tempDir, ".delete-stale");
  await fs.writeFile(marker, "victim");
  await fs.writeFile(stale, "stale");
  const now = 1_700_000_000_500;
  await fs.utimes(marker, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));
  await cleanupAgedAgentAttachmentTempFiles({ dataDir, nowMs: now, maxAgeMs: 24 * 60 * 60 * 1000 });
  assert.equal(await fs.readFile(marker, "utf8"), "victim");
  await assert.doesNotReject(() => fs.access(stale));
});

test("aged temp janitor 仅处理业务 temp 名，并保留旧或 identity mismatch 的 .delete 槽", async () => {
  const dataDir = await createDataDir();
  const tempDir = agentAttachmentTempDir(dataDir);
  await fs.mkdir(tempDir, { recursive: true });
  const valid = path.join(tempDir, "tmp_aged.part");
  const oldSlot = path.join(tempDir, ".delete-old-format");
  const source = path.join(tempDir, "source");
  const mismatch = path.join(tempDir, ".delete-v1-attmismatch-f-1-1-0123456789abcdef0123456789abcdef");
  await fs.writeFile(valid, "old business temp");
  await fs.writeFile(oldSlot, "old private name");
  await fs.writeFile(source, "original");
  await fs.rename(source, mismatch);
  const now = 1_700_000_000_500;
  for (const file of [valid, oldSlot, mismatch]) await fs.utimes(file, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));
  await cleanupAgedAgentAttachmentTempFiles({ dataDir, nowMs: now, maxAgeMs: 24 * 60 * 60 * 1000 });
  await assert.rejects(() => fs.access(valid));
  assert.equal(await fs.readFile(oldSlot, "utf8"), "old private name");
  assert.equal(await fs.readFile(mismatch, "utf8"), "original");
});

test("附件业务名缺失时显式 remove 收敛关联普通私有槽，但 replacement 仍为 pending", async () => {
  const dataDir = await createDataDir();
  const tempDir = agentAttachmentTempDir(dataDir);
  await fs.mkdir(tempDir, { recursive: true });
  const tempName = "tmp_retry.part";
  const source = path.join(tempDir, "stale-source");
  await fs.writeFile(source, "stale");
  const sourceStat = await fs.lstat(source);
  const scope = `att${createHash("sha256").update(tempName).digest("hex").slice(0, 24)}`;
  const stale = path.join(tempDir, `.delete-v1-${scope}-f-${sourceStat.dev.toString(36)}-${sourceStat.ino.toString(36)}-0123456789abcdef0123456789abcdef`);
  await fs.rename(source, stale);
  await removeAgentAttachmentTempFile({ dataDir, tempId: "tmp_retry" });
  await assert.rejects(() => fs.access(stale));

  const finalDir = agentAttachmentWorkspaceDir(dataDir, "ws_retry");
  await fs.mkdir(finalDir, { recursive: true });
  const marker = path.join(finalDir, ".delete-replacement-pending-victim");
  await fs.writeFile(marker, "victim");
  await assert.rejects(
    () => removeAgentAttachmentFinalFile({ dataDir, workspaceId: "ws_retry", attachmentId: "att_retry" }),
    /replacement pending/,
  );
  assert.equal(await fs.readFile(marker, "utf8"), "victim");
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
