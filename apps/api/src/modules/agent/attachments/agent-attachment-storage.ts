import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { AgentImageMediaType } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import { AGENT_IMAGE_MAX_BYTES } from "./agent-attachment-limits.js";
import {
  agentAttachmentsRoot,
  agentAttachmentFilePath,
  agentAttachmentTempDir,
  agentAttachmentTempFilePath,
  agentAttachmentWorkspaceDir,
  assertAgentAttachmentWorkspaceId,
  assertAgentAttachmentId,
  assertAgentAttachmentTempId,
} from "./agent-attachment-paths.js";
import { detectAgentImageMediaType } from "./agent-attachment-signature.js";
import {
  assertSecureDirectoryCurrent,
  closeSecureDirectories,
  cleanupSecureRetiredFiles,
  openExistingSecureChildDirectory,
  openSecureChildDirectory,
  openSecureRootDirectory,
  removeRetiredSecureFile,
  retireSecureEntry,
  retainSecureEntryReplacement,
  securePrivateDeleteName,
  securePrivateSlotIdentity,
  isReplacementPendingName,
  removeSecureDirectoryTree,
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
  byWorkspace: SecureDirectory | null;
  workspace: SecureDirectory | null;
};

async function ensurePrivateDeletionDirectory(directory: SecureDirectory) {
  // attachment temp/by_workspace 均为应用私有目录；创建和删除槽均要求 0700。
  await fs.chmod(directory.fdPath, 0o700);
  const stat = await directory.handle.stat();
  if ((stat.mode & 0o777) !== 0o700) throw new Error("attachment deletion directory must have mode 0700");
}

async function openAttachmentDirectories(input: { dataDir: string; workspaceId?: string; create: boolean }): Promise<AttachmentDirectories> {
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
    let byWorkspace: SecureDirectory | null = null;
    let workspace: SecureDirectory | null = null;
    if (input.workspaceId) {
      byWorkspace = await next(attachments, "by_workspace");
      opened.push(byWorkspace);
      workspace = await next(byWorkspace, assertAgentAttachmentWorkspaceId(input.workspaceId));
      opened.push(workspace);
    }
    return { dataRoot, agent, attachments, temp, byWorkspace, workspace };
  } catch (error) {
    await closeSecureDirectories(...opened.reverse());
    throw error;
  }
}

async function closeAttachmentDirectories(directories: AttachmentDirectories) {
  await closeSecureDirectories(directories.workspace, directories.byWorkspace, directories.temp, directories.attachments, directories.agent, directories.dataRoot);
}

async function assertAttachmentDirectoriesCurrent(directories: AttachmentDirectories, workspace = false) {
  await assertSecureDirectoryCurrent(directories.attachments, directories.dataRoot.realPath);
  await assertSecureDirectoryCurrent(directories.temp, directories.attachments.realPath);
  if (workspace && directories.byWorkspace && directories.workspace) {
    await assertSecureDirectoryCurrent(directories.byWorkspace, directories.attachments.realPath);
    await assertSecureDirectoryCurrent(directories.workspace, directories.byWorkspace.realPath);
  }
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

/**
 * 在 final 已发布而 temp 的逻辑父目录已变化时，将仍可由原 temp dirfd 定位的
 * source 移至 attachments 下稳定的 cleanup 目录。对已 retire 的 source，迁移时
 * 重新发布为 cleanup-root 内的 v1 identity slot，避免跨目录沿用不可关联的槽名。
 */
async function relocateAndCleanupAttachmentSource(params: {
  directories: AttachmentDirectories;
  sourceName: string;
  retired?: RetiredSecureEntry | null;
  expected: { dev: number; ino: number };
  removeRetiredForTest?: (params: { directory: SecureDirectory; retired: RetiredSecureEntry }) => Promise<boolean> | boolean;
}): Promise<boolean> {
  const sourceName = params.retired?.privateName ?? params.sourceName;
  const sourcePath = path.join(params.directories.temp.fdPath, sourceName);
  const before = await fs.lstat(sourcePath).catch(() => null);
  if (!before || before.isSymbolicLink() || !before.isFile() || before.dev !== params.expected.dev || before.ino !== params.expected.ino) return false;
  let cleanup: SecureDirectory | null = null;
  try {
    cleanup = await openSecureChildDirectory(params.directories.attachments, ".attachment-cleanup");
    await ensurePrivateDeletionDirectory(cleanup);
    const sourceIdentity = params.retired ? securePrivateSlotIdentity(params.retired.privateName) : null;
    if (params.retired && (!sourceIdentity || sourceIdentity.kind !== "file" || sourceIdentity.scope !== attachmentPrivateSlotScope(params.sourceName))) return false;
    const name = securePrivateDeleteName({
      dev: params.expected.dev,
      ino: params.expected.ino,
      kind: "file",
      scope: attachmentPrivateSlotScope(params.sourceName),
    });
    const target = path.join(cleanup.fdPath, name);
    await fs.rename(sourcePath, target);
    const moved = await fs.lstat(target);
    if (moved.isSymbolicLink() || !moved.isFile() || moved.dev !== params.expected.dev || moved.ino !== params.expected.ino) {
      await retainSecureEntryReplacement(cleanup, name);
      return false;
    }
    const retired = attachmentRetiredEntry(name, moved);
    return params.removeRetiredForTest?.({ directory: cleanup, retired })
      ?? removeRetiredSecureFile(cleanup, retired);
  } catch {
    return false;
  } finally {
    await cleanup?.handle.close().catch(() => undefined);
  }
}

export async function ensureAgentAttachmentStorageDirectories(dataDir: string, workspaceId: string) {
  const directories = await openAttachmentDirectories({ dataDir, workspaceId, create: true });
  try {
    await assertAttachmentDirectoriesCurrent(directories, true);
  } finally {
    await closeAttachmentDirectories(directories);
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
export async function commitAgentAttachmentTempFile(input: {
  dataDir: string;
  workspaceId: string;
  attachmentId: string;
  tempId: string;
  /** 仅用于对抗测试，在 hard-link 成功后、目录复验前调用。 */
  afterLinkForTest?: () => Promise<void> | void;
  /** 仅用于测试：source 已安全 retire 到 v1 槽、最终 unlink 前调用。 */
  afterSourceRetireForTest?: () => Promise<void> | void;
  /** 仅用于测试：局部模拟已 retire source 的 unlink 失败，避免污染全局 fs。 */
  removeSourceRetiredForTest?: (params: { directory: SecureDirectory; retired: RetiredSecureEntry }) => Promise<boolean> | boolean;
}) {
  const attachmentId = assertAgentAttachmentId(input.attachmentId);
  const tempId = assertAgentAttachmentTempId(input.tempId);
  const directories = await openAttachmentDirectories({ dataDir: input.dataDir, workspaceId: input.workspaceId, create: true });
  let sourceHandle: fs.FileHandle | null = null;
  let sourceStat: import("node:fs").Stats | null = null;
  let finalCreated = false;
  let finalCleanupPending = false;
  let sourceCleanupPending = false;
  let sourceCleanupCompleted = false;
  let sourceRetired: RetiredSecureEntry | null = null;
  try {
    await assertAttachmentDirectoriesCurrent(directories, true);
    const sourcePath = path.join(directories.temp.fdPath, `${tempId}.part`);
    const finalPath = path.join(directories.workspace!.fdPath, attachmentId);
    sourceHandle = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    sourceStat = await sourceHandle.stat();
    const sourcePathStat = await fs.lstat(sourcePath);
    if (!sourceStat.isFile() || sourcePathStat.isSymbolicLink() || !sourcePathStat.isFile() || sourcePathStat.dev !== sourceStat.dev || sourcePathStat.ino !== sourceStat.ino) {
      throw new Error("attachment temp file changed before commit");
    }
    await assertAttachmentDirectoriesCurrent(directories, true);
    await fs.link(sourcePath, finalPath);
    finalCreated = true;
    await input.afterLinkForTest?.();
    const finalStat = await fs.lstat(finalPath);
    if (finalStat.isSymbolicLink() || !finalStat.isFile() || finalStat.dev !== sourceStat.dev || finalStat.ino !== sourceStat.ino) {
      throw new Error("attachment final file changed during commit");
    }
    await assertAttachmentDirectoriesCurrent(directories, true);
    sourceRetired = await retireOwnedFile({ directory: directories.temp, name: `${tempId}.part`, expected: sourceStat });
    await input.afterSourceRetireForTest?.();
    const sourceRemoved = sourceRetired
      ? await (input.removeSourceRetiredForTest?.({ directory: directories.temp, retired: sourceRetired }) ?? removeRetiredSecureFile(directories.temp, sourceRetired))
      : false;
    if (!sourceRemoved) {
      sourceCleanupPending = true;
      throw new Error("attachment source cleanup is pending");
    }
    sourceCleanupCompleted = true;
    return agentAttachmentFilePath(input.dataDir, input.workspaceId, attachmentId);
  } catch (error) {
    // final 已发布后，目录拓扑复验失败可能发生在 source retire 之前。此时无法
    // 将 source 的存在当作已清理；保留独立 pending 信号，禁止上层按逻辑路径猜测。
    if (finalCreated && sourceStat && !sourceCleanupCompleted) sourceCleanupPending = true;
    if (finalCreated && sourceStat && !sourceCleanupCompleted) {
      const expectedSource = sourceStat;
      const sourceName = `${tempId}.part`;
      const topologyValid = await assertAttachmentDirectoriesCurrent(directories).then(() => true).catch(() => false);
      // topology 失效后，优先把原 temp fd 中仍可验证的业务名或已 retire 私有槽
      // 移入稳定 cleanup root，不能仅按业务 sourceName 猜测其是否已消失。
      sourceCleanupCompleted = await relocateAndCleanupAttachmentSource({
        directories,
        sourceName,
        retired: sourceRetired,
        expected: expectedSource,
        removeRetiredForTest: input.removeSourceRetiredForTest,
      });
      if (!sourceCleanupCompleted && topologyValid) sourceCleanupCompleted = await unlinkOwnedFile({ directory: directories.temp, name: sourceName, expected: expectedSource });
      sourceCleanupPending = !sourceCleanupCompleted;
    }
    if (finalCreated && sourceStat) {
      try {
        const removed = await unlinkOwnedFile({ directory: directories.workspace!, name: attachmentId, expected: sourceStat });
        if (removed) finalCreated = false;
        else finalCleanupPending = true;
      } catch {
        finalCleanupPending = true;
      }
    }
    throw new AgentAttachmentCommitError(finalCreated, finalCleanupPending, { cause: error }, sourceCleanupPending);
  } finally {
    await sourceHandle?.close().catch(() => undefined);
    await closeAttachmentDirectories(directories);
  }
}

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

export async function removeAgentAttachmentFinalFile(input: { dataDir: string; workspaceId: string; attachmentId: string }) {
  const attachmentId = assertAgentAttachmentId(input.attachmentId);
  const directories = await openAttachmentDirectories({ dataDir: input.dataDir, workspaceId: input.workspaceId, create: false });
  try {
    await assertAttachmentDirectoriesCurrent(directories, true);
    const name = attachmentId;
    const target = path.join(directories.workspace!.fdPath, name);
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!stat) {
      const pending = await cleanupAttachmentPrivateSlots(directories.workspace!, name);
      if (pending === "replacement_pending") throw new Error("attachment final cleanup is replacement pending");
      return;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("attachment final path is unsafe");
    if (!(await unlinkOwnedFile({ directory: directories.workspace!, name: attachmentId, expected: stat }))) throw new Error("attachment final cleanup is pending");
  } finally {
    await closeAttachmentDirectories(directories);
  }
}

/** 授权后立即用 O_NOFOLLOW 打开并返回同一 inode，路由不得再通过 pathname 重开。 */
export async function resolveSafeAgentAttachmentContentPath(
  input: { dataDir: string; workspaceId: string; storageKey: string; expectedByteSize: number },
): Promise<ResolvedAgentAttachmentContentPath | null> {
  try {
    const storageKey = assertAgentAttachmentId(input.storageKey);
    const directories = await openAttachmentDirectories({ dataDir: input.dataDir, workspaceId: input.workspaceId, create: false });
    try {
      await assertAttachmentDirectoriesCurrent(directories, true);
      const filePath = path.join(directories.workspace!.fdPath, storageKey);
      const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const [stat, pathStat] = await Promise.all([handle.stat(), fs.lstat(filePath)]);
        if (
          !stat.isFile()
          || stat.size !== input.expectedByteSize
          || pathStat.isSymbolicLink()
          || !pathStat.isFile()
          || pathStat.dev !== stat.dev
          || pathStat.ino !== stat.ino
        ) {
          await handle.close();
          return null;
        }
        await assertAttachmentDirectoriesCurrent(directories, true);
        return { handle, filePath: agentAttachmentFilePath(input.dataDir, input.workspaceId, storageKey) };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } finally {
      await closeAttachmentDirectories(directories);
    }
  } catch {
    return null;
  }
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
    storageKey: input.attachmentId,
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

/** 安全删除一个 Workspace 的附件目录；任何 symlink/目录变化均 fail-closed。 */
export async function removeAgentAttachmentWorkspaceDirectory(input: { dataDir: string; workspaceId: string }): Promise<"removed" | "not_found" | "replacement_pending" | "skipped_unsafe"> {
  try {
    const root = await openSecureRootDirectory(input.dataDir);
    try {
      return await removeSecureDirectoryTree({
        root,
        relativeSegments: ["agent", "attachments", "by_workspace", assertAgentAttachmentWorkspaceId(input.workspaceId)],
        quarantineDirectory: ".workspace-delete-quarantine",
      });
    } finally {
      await closeSecureDirectories(root);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("replacement pending")) return "replacement_pending";
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not_found";
    return "skipped_unsafe";
  }
}
