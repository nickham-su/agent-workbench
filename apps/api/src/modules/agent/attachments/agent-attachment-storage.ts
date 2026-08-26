import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { AgentImageMediaType } from "@agent-workbench/shared";
import { AGENT_IMAGE_MAX_BYTES } from "./agent-attachment-limits.js";
import {
  agentAttachmentsRoot,
  agentAttachmentFilePath,
  agentAttachmentTempDir,
  agentAttachmentTempFilePath,
  agentAttachmentWorkspaceDir,
  assertAgentAttachmentWorkspaceId,
  assertAgentAttachmentId
} from "./agent-attachment-paths.js";
import { detectAgentImageMediaType } from "./agent-attachment-signature.js";

export function sanitizeAgentImageFilename(filename: string, extension: "png" | "jpg" | "webp") {
  const fallback = `pasted-image.${extension}`;
  const basename = path.basename(path.win32.basename(String(filename || "")));
  const cleaned = basename.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return fallback;

  const originalSuffix = path.extname(cleaned);
  const body = originalSuffix ? cleaned.slice(0, -originalSuffix.length) : cleaned;
  const suffix = `.${extension}`;
  const normalized = `${body || "pasted-image"}${suffix}`;
  const maxLength = 255;
  if ([...normalized].length <= maxLength) return normalized;
  const availableBodyLength = Math.max(1, maxLength - [...suffix].length);
  return `${[...body].slice(0, availableBodyLength).join("")}${suffix}`;
}

export function assertAgentImageByteSize(byteSize: number) {
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > AGENT_IMAGE_MAX_BYTES) {
    throw new Error("Invalid agent image byte size");
  }
  return byteSize;
}

export async function ensureAgentAttachmentStorageDirectories(dataDir: string, workspaceId: string) {
  await fs.mkdir(agentAttachmentTempDir(dataDir), { recursive: true, mode: 0o700 });
  await fs.mkdir(agentAttachmentWorkspaceDir(dataDir, workspaceId), { recursive: true, mode: 0o700 });
}

export async function createAgentAttachmentTempFile(input: { dataDir: string; tempId: string }) {
  await fs.mkdir(agentAttachmentTempDir(input.dataDir), { recursive: true, mode: 0o700 });
  const tempPath = agentAttachmentTempFilePath(input.dataDir, input.tempId);
  return fs.open(tempPath, "wx", 0o600);
}

export async function commitAgentAttachmentTempFile(input: {
  dataDir: string;
  workspaceId: string;
  attachmentId: string;
  tempId: string;
}) {
  assertAgentAttachmentId(input.attachmentId);
  await ensureAgentAttachmentStorageDirectories(input.dataDir, input.workspaceId);
  const tempPath = agentAttachmentTempFilePath(input.dataDir, input.tempId);
  const finalPath = agentAttachmentFilePath(input.dataDir, input.workspaceId, input.attachmentId);

  // link is exclusive and atomic on this shared dataDir filesystem; unlinking temp completes the move.
  await fs.link(tempPath, finalPath);
  await fs.unlink(tempPath);
  return finalPath;
}

export async function removeAgentAttachmentTempFile(input: { dataDir: string; tempId: string }) {
  await fs.rm(agentAttachmentTempFilePath(input.dataDir, input.tempId), { force: true });
}

function extensionForAgentImageMediaType(mediaType: AgentImageMediaType): "png" | "jpg" | "webp" {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  return "webp";
}

export async function stageAgentImageUpload(input: {
  dataDir: string;
  tempId: string;
  attachmentId: string;
  filename: string;
  stream: Readable;
  onBytes: (byteLength: number) => void;
}) {
  const handle = await createAgentAttachmentTempFile(input);
  let byteSize = 0;
  let signaturePrefix = Buffer.alloc(0);
  try {
    for await (const rawChunk of input.stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      byteSize += chunk.byteLength;
      assertAgentImageByteSize(byteSize);
      input.onBytes(chunk.byteLength);
      if (signaturePrefix.byteLength < 12) {
        signaturePrefix = Buffer.concat([signaturePrefix, chunk.subarray(0, 12 - signaturePrefix.byteLength)]);
      }
      await handle.write(chunk);
    }
    await handle.close();
  } catch (error) {
    input.stream.destroy(error instanceof Error ? error : undefined);
    await handle.close().catch(() => undefined);
    await removeAgentAttachmentTempFile({ dataDir: input.dataDir, tempId: input.tempId });
    throw error;
  }

  const mediaType = detectAgentImageMediaType(signaturePrefix);
  if (!mediaType) {
    await removeAgentAttachmentTempFile({ dataDir: input.dataDir, tempId: input.tempId });
    throw new Error("Unsupported agent image file signature");
  }
  return {
    attachmentId: assertAgentAttachmentId(input.attachmentId),
    storageKey: input.attachmentId,
    tempId: input.tempId,
    filename: sanitizeAgentImageFilename(input.filename, extensionForAgentImageMediaType(mediaType)),
    mediaType,
    byteSize
  };
}

/** Removes only aged ordinary files directly under the attachment temp directory. */
export async function cleanupAgedAgentAttachmentTempFiles(input: { dataDir: string; nowMs: number; maxAgeMs: number }) {
  const tempDir = agentAttachmentTempDir(input.dataDir);
  let entries: import("node:fs").Dirent[];
  try {
    const tempStat = await fs.lstat(tempDir);
    // Do not allow a tampered temp-directory symlink to redirect cleanup.
    if (!tempStat.isDirectory() || tempStat.isSymbolicLink()) return;
    entries = await fs.readdir(tempDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()) return;
    const filePath = path.join(tempDir, entry.name);
    try {
      const stat = await fs.lstat(filePath);
      // File systems can store mtime at second precision. Compare both values in
      // that same conservative precision domain so a file set to exactly the
      // threshold cannot become spuriously older through sub-second truncation.
      const ageMs = Math.floor(input.nowMs / 1_000) * 1_000 - Math.floor(stat.mtimeMs / 1_000) * 1_000;
      if (!stat.isFile() || stat.isSymbolicLink() || ageMs <= input.maxAgeMs) return;
      await fs.unlink(filePath);
    } catch {
      // Best effort: one stale/contended file must not block startup.
    }
  }));
}

/** Best-effort final-directory cleanup without traversing symlinked ancestors. */
export async function removeAgentAttachmentWorkspaceDirectory(input: { dataDir: string; workspaceId: string }): Promise<"removed" | "not_found" | "skipped_unsafe"> {
  const workspaceId = assertAgentAttachmentWorkspaceId(input.workspaceId);
  const root = agentAttachmentsRoot(input.dataDir);
  const byWorkspaceDir = path.join(root, "by_workspace");
  const workspaceDir = agentAttachmentWorkspaceDir(input.dataDir, workspaceId);
  let rootStat: import("node:fs").Stats;
  let byWorkspaceStat: import("node:fs").Stats;
  try {
    [rootStat, byWorkspaceStat] = await Promise.all([fs.lstat(root), fs.lstat(byWorkspaceDir)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not_found";
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !byWorkspaceStat.isDirectory() || byWorkspaceStat.isSymbolicLink()) {
    return "skipped_unsafe";
  }
  let workspaceStat: import("node:fs").Stats;
  try {
    workspaceStat = await fs.lstat(workspaceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not_found";
    throw error;
  }
  if (workspaceStat.isSymbolicLink()) await fs.unlink(workspaceDir);
  else if (workspaceStat.isDirectory()) await fs.rm(workspaceDir, { recursive: true, force: true });
  else return "skipped_unsafe";
  return "removed";
}
