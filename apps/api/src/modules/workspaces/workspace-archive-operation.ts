import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { detectWorkspaceArchiveFormat, type WorkspaceFileExtractResponse } from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import { ArchiveStagingArea } from "./workspace-archive-staging.js";
import { extractArchiveToStaging } from "./workspace-archive-extract.js";
import { ArchiveOwnedNodes, ArchiveParentGuard, sameArchiveFileVersion } from "./workspace-archive-owned.js";
import { addArchiveCount, archiveError, archiveLimits, checkArchiveAbort, safeArchiveError, validateArchiveSourcePath, type ArchiveLimitOverrides } from "./workspace-archive-policy.js";

export type ArchiveOperationPhase = "source-inspected" | "source-opened" | "snapshot-complete" | "staging-complete"
  | "preflight-complete" | "before-publish" | "published" | "before-commit" | "committed" | "before-cleanup";
export type ArchiveOperationHooks = {
  /** Internal deterministic test seam. Never populated from HTTP input. */
  onPhase?: (event: { phase: ArchiveOperationPhase; source: string; staging?: string; path?: string; signal: AbortSignal }) => Promise<void> | void;
  beforeCleanupNode?: (event: { action: "unlink" | "rmdir"; path: string }) => Promise<void> | void;
};
export type ArchiveFailureSummary = { code: string; originalCode: string; phase: string; residualCount: number; temporaryName?: string; errno?: string };
export type ArchiveOperationOptions = {
  limits?: ArchiveLimitOverrides;
  hooks?: ArchiveOperationHooks;
  onFailure?: (summary: ArchiveFailureSummary) => void;
};

function operationError(error: unknown, phase = ""): HttpError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return archiveError(phase === "resolve" ? "ARCHIVE_SOURCE_NOT_FOUND" : "ARCHIVE_TARGET_CHANGED", phase === "resolve" ? 404 : 409);
  if (code === "ELOOP" || code === "ENOTDIR") return archiveError("ARCHIVE_PATH_INVALID");
  if (code === "EXDEV" || code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP") return archiveError("ARCHIVE_FILESYSTEM_UNSUPPORTED", 409);
  return safeArchiveError(error);
}

async function sourceStat(source: string, changed = false): Promise<BigIntStats> {
  try {
    const stat = await fs.lstat(source, { bigint: true });
    if (!stat.isFile()) throw archiveError(changed ? "ARCHIVE_SOURCE_CHANGED" : "ARCHIVE_PATH_INVALID", changed ? 409 : 400);
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw archiveError(changed ? "ARCHIVE_SOURCE_CHANGED" : "ARCHIVE_SOURCE_NOT_FOUND", changed ? 409 : 404);
    throw error;
  }
}

/** Owner and input snapshot writers share settlement, but retain the first raw cause for classification. */
async function writePrivateFile(ledger: ArchiveOwnedNodes, abs: string, write: (handle: fs.FileHandle) => Promise<void>): Promise<void> {
  const handle = await ledger.createFile(abs);
  // The wrapper also preserves non-Error throws without mistaking them for success.
  let failure: { error: unknown } | undefined;
  try { await write(handle); }
  catch (error) { failure = { error }; }
  try { ledger.settleWriter(abs, await handle.stat({ bigint: true })); }
  catch (error) { failure ??= { error }; }
  try { await handle.close(); }
  catch (error) { failure ??= { error }; }
  if (failure) throw failure.error;
}

/** The caller holds the lifecycle gate and the source's existing region lock until this settles. */
export async function runWorkspaceArchiveOperation(params: {
  /** Trusted lexical Workspace boundary, never a repo's independently canonicalized root. */
  rootAbs: string;
  /** Canonical relative repo region, or empty for the ordinary Workspace region. */
  regionInWorkspace?: string;
  sourceInRegion: string;
  sourcePath: string;
  protectedTopLevelNames: ReadonlySet<string>;
  options?: ArchiveOperationOptions;
}): Promise<WorkspaceFileExtractResponse> {
  if (params.regionInWorkspace) validateArchiveSourcePath(params.regionInWorkspace);
  validateArchiveSourcePath(params.sourceInRegion);
  validateArchiveSourcePath(params.sourcePath);
  const options = params.options ?? {};
  const limits = archiveLimits(options.limits);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(archiveError("ARCHIVE_TIMEOUT", 408)), limits.timeoutMs);
  const signal = controller.signal;
  let phase = "resolve";
  let source = "";
  let staging: string | undefined;
  let ledger: ArchiveOwnedNodes | undefined;
  let area: ArchiveStagingArea | undefined;
  let sourceHandle: fs.FileHandle | undefined;
  let failure: HttpError | undefined;
  let originalErrno: string | undefined;
  let response: WorkspaceFileExtractResponse | undefined;
  let committed = false;
  let cleanupFailures = 0;
  const notify = async (next: ArchiveOperationPhase, output?: string) => {
    phase = next;
    checkArchiveAbort(signal);
    await options.hooks?.onPhase?.({ phase: next, source, staging, path: output, signal });
    checkArchiveAbort(signal);
  };
  try {
    if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number" || process.platform === "win32") {
      throw archiveError("ARCHIVE_FILESYSTEM_UNSUPPORTED", 409);
    }
    const parentInRegion = path.posix.dirname(params.sourceInRegion);
    const parentInWorkspace = path.posix.join(params.regionInWorkspace ?? "", parentInRegion);
    const guard = await ArchiveParentGuard.open(params.rootAbs, parentInWorkspace === "." ? "" : parentInWorkspace, signal);
    ledger = new ArchiveOwnedNodes(guard, signal);
    source = path.join(guard.parent, path.posix.basename(params.sourceInRegion));
    const inspected = await sourceStat(source);
    await notify("source-inspected");
    await guard.assert(signal);
    try { sourceHandle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ELOOP") throw archiveError("ARCHIVE_SOURCE_CHANGED", 409);
      throw error;
    }
    const opened = await sourceHandle.stat({ bigint: true });
    if (!opened.isFile()) throw archiveError("ARCHIVE_PATH_INVALID");
    if (!sameArchiveFileVersion(inspected, opened)) throw archiveError("ARCHIVE_SOURCE_CHANGED", 409);
    if (opened.size > BigInt(limits.inputBytes)) throw archiveError("ARCHIVE_LIMIT_EXCEEDED", 413);
    await notify("source-opened");
    const format = detectWorkspaceArchiveFormat(path.posix.basename(params.sourcePath));
    if (!format) throw archiveError("ARCHIVE_FORMAT_UNSUPPORTED");

    for (;;) {
      checkArchiveAbort(signal);
      const candidate = path.join(guard.parent, `.awb-extract-${randomUUID()}`);
      try { await ledger.mkdir(candidate, "temporary"); staging = candidate; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (ledger.nodes.get(staging)!.stat!.dev !== (await fs.lstat(guard.parent, { bigint: true })).dev) {
      throw archiveError("ARCHIVE_FILESYSTEM_UNSUPPORTED", 409);
    }
    const owner = path.join(staging, "owner.json");
    await writePrivateFile(ledger, owner, (handle) => handle.writeFile(JSON.stringify({ version: 1, operationId: randomUUID(), createdAt: Date.now() })));
    const input = path.join(staging, "input.archive");
    let copied = 0;
    await writePrivateFile(ledger, input, async (snapshot) => {
      const chunk = Buffer.alloc(64 * 1024);
      for (;;) {
        checkArchiveAbort(signal);
        const { bytesRead } = await sourceHandle!.read(chunk, 0, chunk.length, copied);
        if (!bytesRead) break;
        addArchiveCount(copied, bytesRead, limits.inputBytes);
        let offset = 0;
        while (offset < bytesRead) {
          checkArchiveAbort(signal);
          const { bytesWritten } = await snapshot.write(chunk, offset, bytesRead - offset);
          if (!bytesWritten) throw archiveError("ARCHIVE_IO_FAILED", 500);
          offset += bytesWritten;
        }
        copied += bytesRead;
      }
    });
    const verifySource = async () => {
      checkArchiveAbort(signal);
      await guard.assert(signal);
      if (BigInt(copied) !== opened.size || !sameArchiveFileVersion(opened, await sourceHandle!.stat({ bigint: true }))
        || !sameArchiveFileVersion(opened, await sourceStat(source, true))) throw archiveError("ARCHIVE_SOURCE_CHANGED", 409);
    };
    await verifySource();
    await notify("snapshot-complete");
    const payload = path.join(staging, "payload");
    await ledger.mkdir(payload, "temporary");
    area = await ArchiveStagingArea.open(payload, options.limits);
    try { await extractArchiveToStaging({ inputPath: input, format, area, signal }); }
    finally {
      // Even failed partial writes have settled and must be included in safe cleanup.
      for (const node of area.nodes.values()) ledger.remember(area.absolutePath(node.rel), node.kind, "temporary", node.stat);
    }
    await notify("staging-complete");
    await ledger.verify("temporary", signal);
    await verifySource();
    const planned = [...area.nodes.values()].sort((a, b) => a.rel.split("/").length - b.rel.split("/").length || a.rel.localeCompare(b.rel));
    const tops = planned.filter((node) => !node.rel.includes("/"));
    phase = "preflight";
    for (const node of tops) {
      checkArchiveAbort(signal);
      await guard.assert(signal);
      if (parentInRegion === "." && params.protectedTopLevelNames.has(node.rel)) throw archiveError("ARCHIVE_TARGET_CONFLICT", 409);
      try { await fs.lstat(path.join(guard.parent, node.rel)); throw archiveError("ARCHIVE_TARGET_CONFLICT", 409); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await notify("preflight-complete");
    await verifySource();
    for (const node of planned) {
      const output = path.join(guard.parent, node.rel);
      await notify("before-publish", output);
      try {
        if (node.kind === "dir") await ledger.mkdir(output, "output");
        else {
          const staged = area.absolutePath(node.rel);
          await ledger.chmod(staged, node.finalMode);
          await ledger.link(staged, output);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw archiveError("ARCHIVE_TARGET_CONFLICT", 409);
        throw error;
      }
      await notify("published", output);
    }
    for (const node of [...planned].reverse()) {
      checkArchiveAbort(signal);
      if (node.kind === "dir") await ledger.chmod(path.join(guard.parent, node.rel), node.finalMode);
    }
    await notify("before-commit");
    await ledger.verify(undefined, signal);
    checkArchiveAbort(signal);
    committed = true;
    response = { path: params.sourcePath, dir: path.posix.dirname(params.sourcePath) === "." ? "" : path.posix.dirname(params.sourcePath), format, ...area.summary() };
    phase = "committed";
    // Commit has happened; a hook/transport failure must not roll the output back.
    await options.hooks?.onPhase?.({ phase: "committed", source, staging, signal });
  } catch (error) {
    failure = operationError(error, phase);
    const errno = (error as NodeJS.ErrnoException)?.code;
    const nativeCodes = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP", "EIO", "ENOSPC", "EDQUOT", "EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EEXIST", "EMFILE", "ENFILE", "ENAMETOOLONG"]);
    if (typeof errno === "string" && nativeCodes.has(errno)) originalErrno = errno;
  } finally {
    clearTimeout(timer);
    if (sourceHandle) {
      try { await sourceHandle.close(); } catch (error) { failure ??= operationError(error); }
    }
    if (ledger) {
      try { await options.hooks?.onPhase?.({ phase: "before-cleanup", source, staging, signal }); }
      catch (error) { failure ??= operationError(error); cleanupFailures++; }
      cleanupFailures += await ledger.cleanup(committed, options.hooks?.beforeCleanupNode);
    }
  }
  if (cleanupFailures) {
    const originalCode = failure?.code ?? "ARCHIVE_CLEANUP_INCOMPLETE";
    failure = archiveError("ARCHIVE_CLEANUP_INCOMPLETE", 500);
    const residualCount = ledger ? [...ledger.nodes.values()].filter((node) => !committed || node.group === "temporary").length : cleanupFailures;
    options.onFailure?.({ code: failure.code!, originalCode, phase, residualCount, temporaryName: staging ? path.basename(staging) : undefined, errno: originalErrno });
    throw failure;
  }
  if (failure) {
    options.onFailure?.({ code: failure.code!, originalCode: failure.code!, phase, residualCount: 0, temporaryName: staging ? path.basename(staging) : undefined, errno: originalErrno });
    throw failure;
  }
  return response!;
}
