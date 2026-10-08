import fs from "node:fs/promises";
import { fstatSync, lstatSync, linkSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { AgentImageMediaType } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import { AGENT_IMAGE_MAX_BYTES } from "./agent-attachment-limits.js";
import {
  agentAttachmentsRoot,
  agentAttachmentTempDir,
  agentAttachmentTempFilePath,
  assertAgentAttachmentId,
  assertAgentAttachmentTempId,
  assertAgentAttachmentWorkspaceDirectory,
  assertAgentAttachmentStorageKey,
  agentAttachmentRelativePath,
  agentAttachmentStorageKey,
} from "./agent-attachment-paths.js";
import { detectAgentImageMediaType } from "./agent-attachment-signature.js";
import {
  assertSecureDirectoryCurrent,
  assertSecureDirectoryCurrentSync,
  closeSecureDirectories,
  cleanupSecureRetiredFiles,
  openExistingSecureChildDirectory,
  openSecureChildDirectory,
  openSecureRootDirectory,
  removeRetiredSecureFile,
  retireSecureEntry,
  securePrivateDeleteName,
  isReplacementPendingName,
  type RetiredSecureEntry,
  type SecureEntryKind,
  type SecureDirectory,
} from "../../../infra/fs/secure-directory.js";

export type ResolvedAgentAttachmentContentPath = {
  /** 已授权、已打开且绑定到验证 inode；调用方必须在响应结束或中止时关闭。 */
  handle: fs.FileHandle;
  /** 仅用于可读日志/stream 构造；不得据此重新打开文件。 */
  filePath: string;
};

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

type AttachmentDirectories = {
  dataRoot: SecureDirectory;
  agent: SecureDirectory;
  attachments: SecureDirectory;
  temp: SecureDirectory;
};

async function ensurePrivateDeletionDirectory(directory: SecureDirectory) {
  // 临时目录为应用私有目录；创建和删除槽均要求 0700。
  await fs.chmod(directory.fdPath, 0o700);
  const stat = await directory.handle.stat();
  if ((stat.mode & 0o777) !== 0o700) throw new Error("attachment deletion directory must have mode 0700");
}

async function openAttachmentDirectories(input: { dataDir: string; create: boolean }): Promise<AttachmentDirectories> {
  const opened: SecureDirectory[] = [];
  try {
    const dataRoot = await openSecureRootDirectory(input.dataDir);
    opened.push(dataRoot);
    const next = input.create ? openSecureChildDirectory : openExistingSecureChildDirectory;
    const agent = await next(dataRoot, "agent");
    opened.push(agent);
    const attachments = await next(agent, "attachments");
    opened.push(attachments);
    const temp = await next(attachments, "temp");
    opened.push(temp);
    return { dataRoot, agent, attachments, temp };
  } catch (error) {
    await closeSecureDirectories(...opened.reverse());
    throw error;
  }
}

async function closeAttachmentDirectories(directories: AttachmentDirectories) {
  await closeSecureDirectories(directories.temp, directories.attachments, directories.agent, directories.dataRoot);
}

async function assertAttachmentDirectoriesCurrent(directories: AttachmentDirectories) {
  await assertSecureDirectoryCurrent(directories.attachments, directories.dataRoot.realPath);
  await assertSecureDirectoryCurrent(directories.temp, directories.attachments.realPath);
}

function attachmentPrivateSlotScope(name: string) {
  return `att${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
}

function isAttachmentTempBusinessName(name: string) {
  return /^tmp_[A-Za-z0-9-]+\.part$/.test(name);
}

function attachmentRetiredEntry(name: string, stat: import("node:fs").Stats, kind: SecureEntryKind = "file"): RetiredSecureEntry {
  return { privateName: name, stat, kind };
}

async function cleanupAttachmentPrivateSlots(directory: SecureDirectory, name: string): Promise<"clean" | "replacement_pending"> {
  await ensurePrivateDeletionDirectory(directory);
  return cleanupSecureRetiredFiles(directory, attachmentPrivateSlotScope(name));
}

async function retireOwnedFile(params: { directory: SecureDirectory; name: string; expected: { dev: number; ino: number } }): Promise<RetiredSecureEntry | null> {
  await ensurePrivateDeletionDirectory(params.directory);
  try {
    return await retireSecureEntry({
      parent: params.directory,
      name: params.name,
      expected: params.expected,
      kind: "file",
      privateSlotScope: attachmentPrivateSlotScope(params.name),
    });
  } catch {
    return null;
  }
}

async function unlinkOwnedFile(params: { directory: SecureDirectory; name: string; expected: { dev: number; ino: number } }): Promise<boolean> {
  const retired = await retireOwnedFile(params);
  return retired ? removeRetiredSecureFile(params.directory, retired) : false;
}

async function verifyOwnedFile(params: { directory: SecureDirectory; name: string; expected: { dev: number; ino: number } }) {
  const current = await fs.lstat(path.join(params.directory.fdPath, params.name));
  if (current.isSymbolicLink() || !current.isFile() || current.dev !== params.expected.dev || current.ino !== params.expected.ino) {
    throw new Error("attachment file changed after creation");
  }
}

export async function createAgentAttachmentTempFile(input: { dataDir: string; tempId: string; afterCreateForTest?: () => Promise<void> | void }) {
  const tempId = assertAgentAttachmentTempId(input.tempId);
  const directories = await openAttachmentDirectories({ dataDir: input.dataDir, create: true });
  let handle: fs.FileHandle | null = null;
  try {
    await assertAttachmentDirectoriesCurrent(directories);
    const tempPath = path.join(directories.temp.fdPath, `${tempId}.part`);
    handle = await fs.open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const created = await handle.stat();
    await input.afterCreateForTest?.();
    try {
      await assertAttachmentDirectoriesCurrent(directories);
      if (!created.isFile()) throw new Error("attachment temp handle is not a file");
      await verifyOwnedFile({ directory: directories.temp, name: `${tempId}.part`, expected: created });
    } catch (error) {
      await unlinkOwnedFile({ directory: directories.temp, name: `${tempId}.part`, expected: created }).catch(() => false);
      await handle.close().catch(() => undefined);
      handle = null;
      throw error;
    }
    const result = handle;
    handle = null;
    return result;
  } finally {
    await handle?.close().catch(() => undefined);
    await closeAttachmentDirectories(directories);
  }
}

export class AgentAttachmentCommitError extends Error {
  constructor(
    readonly finalCreated: boolean,
    readonly finalCleanupPending: boolean,
    options: { cause: unknown },
    readonly sourceCleanupPending = false
  ) {
    super("Failed to commit agent attachment", options);
  }

  get cleanupPending() {
    return this.finalCleanupPending || this.sourceCleanupPending;
  }
}

/**
 * 以固定 temp/workspace 目录 fd 进行 hard-link 提交。所有 pathname 只在已验证
 * inode 的目录下解析；提交前后验证 inode，目录变化时 fail-closed。
 */
export async function removeAgentAttachmentTempFile(input: { dataDir: string; tempId: string }) {
  const tempId = assertAgentAttachmentTempId(input.tempId);
  const directories = await openAttachmentDirectories({ dataDir: input.dataDir, create: false });
  try {
    await assertAttachmentDirectoriesCurrent(directories);
    const name = `${tempId}.part`;
    const target = path.join(directories.temp.fdPath, name);
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!stat) {
      const pending = await cleanupAttachmentPrivateSlots(directories.temp, name);
      if (pending === "replacement_pending") throw new Error("attachment temp cleanup is replacement pending");
      return;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("attachment temp path is unsafe");
    if (!(await unlinkOwnedFile({ directory: directories.temp, name, expected: stat }))) throw new Error("attachment temp cleanup is pending");
  } finally {
    await closeAttachmentDirectories(directories);
  }
}

function extensionForAgentImageMediaType(mediaType: AgentImageMediaType): "png" | "jpg" | "webp" {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  return "webp";
}

type WorkspaceAttachmentDirectories = {
  data: SecureDirectory;
  workspaces: SecureDirectory;
  workspace: SecureDirectory;
  awb: SecureDirectory;
  agent: SecureDirectory;
  attachments: SecureDirectory;
};

/** Pin every directory from the trusted data root down to the Workspace attachment directory. */
async function openWorkspaceAttachmentDirectories(input: { dataDir: string; workspaceDirName: string; create: boolean }): Promise<WorkspaceAttachmentDirectories> {
  const opened: SecureDirectory[] = [];
  try {
    const data = await openSecureRootDirectory(input.dataDir);
    opened.push(data);
    const workspaces = await openExistingSecureChildDirectory(data, "workspaces");
    opened.push(workspaces);
    const workspace = await openExistingSecureChildDirectory(workspaces, assertAgentAttachmentWorkspaceDirectory(input.workspaceDirName));
    opened.push(workspace);
    const next = input.create ? openSecureChildDirectory : openExistingSecureChildDirectory;
    const awb = await next(workspace, ".awb");
    opened.push(awb);
    const agent = await next(awb, "agent");
    opened.push(agent);
    const attachments = await next(agent, "attachments");
    opened.push(attachments);
    return { data, workspaces, workspace, awb, agent, attachments };
  } catch (error) {
    await closeSecureDirectories(...opened.reverse());
    throw error;
  }
}

async function assertWorkspaceAttachmentDirectoriesCurrent(dirs: WorkspaceAttachmentDirectories) {
  await assertSecureDirectoryCurrent(dirs.data, dirs.data.realPath);
  await assertSecureDirectoryCurrent(dirs.workspaces, dirs.data.realPath);
  await assertSecureDirectoryCurrent(dirs.workspace, dirs.workspaces.realPath);
  await assertSecureDirectoryCurrent(dirs.awb, dirs.workspace.realPath);
  await assertSecureDirectoryCurrent(dirs.agent, dirs.awb.realPath);
  await assertSecureDirectoryCurrent(dirs.attachments, dirs.agent.realPath);
}

async function closeWorkspaceAttachmentDirectories(dirs: WorkspaceAttachmentDirectories) {
  await closeSecureDirectories(dirs.attachments, dirs.agent, dirs.awb, dirs.workspace, dirs.workspaces, dirs.data);
}

export type OwnedAgentAttachmentFile = { dev: number; ino: number };

/** Prepare outside SQLite; publish only after its authoritative conflict checks, without yielding. */
export async function prepareAgentWorkspaceAttachmentPublication(input: {
  dataDir: string;
  workspaceDirName: string;
  attachmentId: string;
  storageKey: string;
  mediaType: AgentImageMediaType;
  tempId: string;
  afterLinkForTest?: () => void;
}): Promise<{ checkAvailable(): void; publish(): OwnedAgentAttachmentFile; close(): Promise<void> }> {
  const storageKey = assertAgentAttachmentStorageKey(input.attachmentId, input.storageKey, input.mediaType);
  const sourceName = `${assertAgentAttachmentTempId(input.tempId)}.part`;
  const source = await openAttachmentDirectories({ dataDir: input.dataDir, create: false });
  let target: WorkspaceAttachmentDirectories | null = null;
  let handle: fs.FileHandle | null = null;
  try {
    await assertAttachmentDirectoriesCurrent(source);
    target = await openWorkspaceAttachmentDirectories({ dataDir: input.dataDir, workspaceDirName: input.workspaceDirName, create: true });
    await assertWorkspaceAttachmentDirectoriesCurrent(target);
    if (((await target.attachments.handle.stat()).mode & 0o777) !== 0o700) {
      throw new Error("Workspace attachment directory permissions changed");
    }
    const sourcePath = path.join(source.temp.fdPath, sourceName);
    handle = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const original = await handle.stat();
    if (!original.isFile() || original.size < 1 || original.size > AGENT_IMAGE_MAX_BYTES) throw new Error("Invalid attachment source");
    await verifyOwnedFile({ directory: source.temp, name: sourceName, expected: original });
    const pinnedSource = handle;
    const pinnedTarget = target;
    let attempted = false;
    let closed = false;
    return {
      checkAvailable() {
        if (closed) throw new Error("attachment publication is closed");
        const finalPath = path.join(pinnedTarget.attachments.fdPath, storageKey);
        try {
          lstatSync(finalPath);
          throw new Error("attachment final name is occupied");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
      publish() {
        if (closed || attempted) throw new Error("attachment publication is not reusable");
        attempted = true;
        let linked = false;
        try {
          const check = (directory: SecureDirectory, trustedRoot: string) => assertSecureDirectoryCurrentSync(directory, trustedRoot);
          check(source.dataRoot, source.dataRoot.realPath);
          check(source.agent, source.dataRoot.realPath);
          check(source.attachments, source.agent.realPath);
          check(source.temp, source.attachments.realPath);
          check(pinnedTarget.data, pinnedTarget.data.realPath);
          check(pinnedTarget.workspaces, pinnedTarget.data.realPath);
          check(pinnedTarget.workspace, pinnedTarget.workspaces.realPath);
          check(pinnedTarget.awb, pinnedTarget.workspace.realPath);
          check(pinnedTarget.agent, pinnedTarget.awb.realPath);
          check(pinnedTarget.attachments, pinnedTarget.agent.realPath);
          if ((fstatSync(pinnedTarget.attachments.handle.fd).mode & 0o777) !== 0o700) throw new Error("Workspace attachment directory permissions changed");
          const current = fstatSync(pinnedSource.fd);
          const sourceEntry = lstatSync(sourcePath);
          if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size
              || !sourceEntry.isFile() || sourceEntry.isSymbolicLink() || sourceEntry.dev !== original.dev || sourceEntry.ino !== original.ino) {
            throw new Error("attachment source changed before publication");
          }
          const finalPath = path.join(pinnedTarget.attachments.fdPath, storageKey);
          linkSync(sourcePath, finalPath); // EEXIST and EXDEV fail closed; never overwrite or copy.
          linked = true;
          input.afterLinkForTest?.();
          const final = lstatSync(finalPath);
          if (!final.isFile() || final.isSymbolicLink() || final.dev !== current.dev || final.ino !== current.ino) {
            throw new Error("attachment final changed after publication");
          }
          return { dev: current.dev, ino: current.ino };
        } catch (error) {
          // Never rename or unlink in the mutable Workspace, even when our link succeeded.
          throw new AgentAttachmentCommitError(linked, linked, { cause: error });
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        await pinnedSource.close().catch(() => undefined);
        await closeWorkspaceAttachmentDirectories(pinnedTarget);
        await closeAttachmentDirectories(source);
      },
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (target) await closeWorkspaceAttachmentDirectories(target);
    await closeAttachmentDirectories(source);
    throw error;
  }
}

async function closeWorkspaceAttachmentDirectoriesIfOpen(dirs: WorkspaceAttachmentDirectories | null) {
  if (dirs) await closeWorkspaceAttachmentDirectories(dirs);
}

/** A Workspace final cannot be removed safely while same-UID tools can change its directory entries. */
export async function removeAgentWorkspaceAttachmentFinalFile(input: {
  dataDir: string;
  workspaceDirName: string;
  attachmentId: string;
  storageKey: string;
  mediaType: AgentImageMediaType;
  owned: OwnedAgentAttachmentFile;
}) {
  assertAgentAttachmentStorageKey(input.attachmentId, input.storageKey, input.mediaType);
  // Even a matching inode in a private .delete-* slot can be replaced before unlink.
  // Do not move or unlink any Workspace entry; surface a pending orphan to the caller.
  throw new Error("Workspace attachment retained: atomic ownership-checked removal is unavailable");
}

/** Already authorized by the owning Session; return the pinned inode, not a pathname to reopen. */
export async function resolveSafeWorkspaceAgentAttachment(input: {
  dataDir: string;
  workspaceDirName: string;
  attachmentId: string;
  storageKey: string;
  mediaType: AgentImageMediaType;
  expectedByteSize: number;
}): Promise<ResolvedAgentAttachmentContentPath | null> {
  let dirs: WorkspaceAttachmentDirectories | null = null;
  try {
    const storageKey = assertAgentAttachmentStorageKey(input.attachmentId, input.storageKey, input.mediaType);
    dirs = await openWorkspaceAttachmentDirectories({ dataDir: input.dataDir, workspaceDirName: input.workspaceDirName, create: false });
    await assertWorkspaceAttachmentDirectoriesCurrent(dirs);
    const filePath = path.join(dirs.attachments.fdPath, storageKey);
    const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const [stat, pathStat] = await Promise.all([handle.stat(), fs.lstat(filePath)]);
      if (!stat.isFile() || stat.size !== input.expectedByteSize || stat.size < 1 || stat.size > AGENT_IMAGE_MAX_BYTES
        || pathStat.isSymbolicLink() || !pathStat.isFile() || stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) throw new Error("attachment changed");
      const prefix = Buffer.alloc(12);
      let read = 0;
      const headerLength = Math.min(prefix.length, stat.size);
      while (read < headerLength) {
        const { bytesRead } = await handle.read(prefix, read, headerLength - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      if (detectAgentImageMediaType(prefix.subarray(0, read)) !== input.mediaType) throw new Error("attachment media type changed");
      await assertWorkspaceAttachmentDirectoriesCurrent(dirs);
      return { handle, filePath: path.join(dirs.workspace.logicalPath, agentAttachmentRelativePath(input.attachmentId, storageKey, input.mediaType)) };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } catch {
    return null;
  } finally {
    await closeWorkspaceAttachmentDirectoriesIfOpen(dirs);
  }
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
    await handle.close().catch(() => undefined);
    await removeAgentAttachmentTempFile({ dataDir: input.dataDir, tempId: input.tempId }).catch(() => undefined);
    throw error;
  }
  const mediaType = detectAgentImageMediaType(signaturePrefix);
  if (!mediaType) {
    await removeAgentAttachmentTempFile({ dataDir: input.dataDir, tempId: input.tempId }).catch(() => undefined);
    throw new Error("Unsupported agent image file signature");
  }
  return {
    attachmentId: assertAgentAttachmentId(input.attachmentId),
    storageKey: agentAttachmentStorageKey(input.attachmentId, mediaType),
    tempId: input.tempId,
    filename: sanitizeAgentImageFilename(input.filename, extensionForAgentImageMediaType(mediaType)),
    mediaType,
    byteSize,
  };
}

/** Removes only aged ordinary files directly under the pinned attachment temp directory. */
export async function cleanupAgedAgentAttachmentTempFiles(input: { dataDir: string; nowMs: number; maxAgeMs: number }) {
  let directories: AttachmentDirectories;
  try {
    directories = await openAttachmentDirectories({ dataDir: input.dataDir, create: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof Error) return;
    throw error;
  }
  try {
    await assertAttachmentDirectoriesCurrent(directories);
    // 私有槽的 pending 是诊断状态；普通 aged 扫描没有删除它们的权限。
    const tempPrivateCleanup = await cleanupSecureRetiredFiles(directories.temp).catch(() => "replacement_pending" as const);
    let cleanup: SecureDirectory | null = null;
    try {
      cleanup = await openExistingSecureChildDirectory(directories.attachments, ".attachment-cleanup");
      await ensurePrivateDeletionDirectory(cleanup);
      const cleanupPrivateCleanup = await cleanupSecureRetiredFiles(cleanup).catch(() => "replacement_pending" as const);
      void cleanupPrivateCleanup;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await cleanup?.handle.close().catch(() => undefined);
    }
    const entries = await fs.readdir(directories.temp.fdPath, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      // cleanupSecureRetiredFiles 是所有 .delete-* 槽的唯一权威删除者。
      if (entry.name.startsWith(".delete-")) return;
      if (!isAttachmentTempBusinessName(entry.name)) return;
      if (!entry.isFile() || entry.isSymbolicLink()) return;
      const filePath = path.join(directories.temp.fdPath, entry.name);
      try {
        const stat = await fs.lstat(filePath);
        const ageMs = Math.floor(input.nowMs / 1_000) * 1_000 - Math.floor(stat.mtimeMs / 1_000) * 1_000;
        if (!stat.isFile() || stat.isSymbolicLink() || ageMs <= input.maxAgeMs) return;
        await unlinkOwnedFile({ directory: directories.temp, name: entry.name, expected: stat });
      } catch {
        // A contended temp file must not block startup; all operations remain inside the pinned dir fd.
      }
    }));
    // 明确保留该读取，避免 future refactor 将 private cleanup 的 pending 误认为普通扫描可处理。
    void tempPrivateCleanup;
  } finally {
    await closeAttachmentDirectories(directories);
  }
}
