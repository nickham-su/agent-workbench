import path from "node:path";
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import type {
  FileCreateRequest,
  FileCreateResponse,
  FileDeleteRequest,
  FileDeleteResponse,
  FileEntry,
  FileListRequest,
  FileListResponse,
  FileMkdirRequest,
  FileMkdirResponse,
  FileReadRequest,
  FileReadResponse,
  FileStatRequest,
  FileStatResponse,
  FileRenameRequest,
  FileRenameResponse,
  FileSearchRequest,
  FileSearchResponse,
  FileWriteRequest,
  FileWriteResponse,
  FileVersion,
  GitTarget
} from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { getWorkspace, getWorkspaceRepoByDirName } from "../workspaces/workspace.store.js";
import { getRepo } from "../repos/repo.store.js";
import { withWorkspaceRepoLock } from "../../infra/locks/workspaceRepoLock.js";
import { getSearchSettings } from "../settings/settings.service.js";
import { SEARCH_FORCED_EXCLUDES, runFileSearch } from "./file-search.js";

const DENYLIST_SEGMENTS = [".git"];

function parseTarget(targetRaw: unknown): GitTarget {
  const target = (targetRaw ?? {}) as any;
  if (target?.kind !== "workspaceRepo") throw new HttpError(400, "Invalid target");
  const workspaceId = typeof target.workspaceId === "string" ? target.workspaceId.trim() : "";
  const dirName = typeof target.dirName === "string" ? target.dirName.trim() : "";
  if (!workspaceId || !dirName) throw new HttpError(400, "Invalid target");
  return { kind: "workspaceRepo", workspaceId, dirName };
}

function isValidRelativePath(filePath: string) {
  if (!filePath) return false;
  if (filePath.startsWith("-")) return false;
  if (filePath.startsWith(":")) return false;
  if (path.isAbsolute(filePath)) return false;
  if (filePath.includes("\0")) return false;
  if (filePath.includes("\n") || filePath.includes("\r")) return false;
  const parts = filePath.split(/[\\/]+/g);
  if (parts.some((p) => p === "..")) return false;
  return true;
}

function safeResolveUnderRoot(params: { root: string; rel: string }) {
  const rootAbs = path.resolve(params.root);
  const abs = path.resolve(params.root, params.rel);
  if (abs === rootAbs) return abs;
  if (!abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

function normalizeDir(raw: unknown) {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (v === "." || v === "./") return "";
  return v;
}

function isRootRelPath(rel: string) {
  return rel === "" || rel === "." || rel === "./";
}

function hasDeniedSegment(rel: string) {
  if (!rel) return false;
  const parts = rel.split(/[\\/]+/g).filter(Boolean);
  return parts.some((p) => DENYLIST_SEGMENTS.includes(p));
}

function joinRelPath(parent: string, name: string) {
  return parent ? `${parent}/${name}` : name;
}

function parseBool(raw: unknown, fallback = false) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "boolean") return raw;
  return raw === "1" || raw === "true" || raw === "yes";
}

function normalizeRelPath(params: { rootAbs: string; absPath: string; fallback: string }) {
  const rel = path.relative(params.rootAbs, params.absPath);
  const normalized = rel && rel !== "." ? rel.replace(/\\/g, "/") : "";
  return normalized || params.fallback;
}

function inferLanguage(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".vue":
      return "vue";
    case ".json":
      return "json";
    case ".md":
      return "markdown";
    case ".css":
      return "css";
    case ".html":
      return "html";
    case ".yml":
    case ".yaml":
      return "yaml";
    default:
      return undefined;
  }
}

type PreviewFailReason = "too_large" | "binary" | "decode_failed" | "unsafe_path" | "missing";

type ReadTextResult =
  | { kind: "missing"; bytes: 0; content: "" }
  | { kind: "not_previewable"; reason: PreviewFailReason; bytes: number }
  | { kind: "ok"; bytes: number; content: string; hash: string };

function decodeUtf8(buf: Buffer): { ok: true; text: string } | { ok: false; reason: "decode_failed" } {
  try {
    const dec = new TextDecoder("utf-8", { fatal: true });
    return { ok: true, text: dec.decode(buf) };
  } catch {
    return { ok: false, reason: "decode_failed" };
  }
}

function hashBuffer(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function readBufferAsText(buf: Buffer, maxBytes: number): ReadTextResult {
  if (buf.byteLength > maxBytes) return { kind: "not_previewable", reason: "too_large", bytes: buf.byteLength };
  if (buf.includes(0)) return { kind: "not_previewable", reason: "binary", bytes: buf.byteLength };
  const dec = decodeUtf8(buf);
  if (!dec.ok) return { kind: "not_previewable", reason: dec.reason, bytes: buf.byteLength };
  return { kind: "ok", bytes: buf.byteLength, content: dec.text, hash: hashBuffer(buf) };
}

async function readFileAsText(params: { absPath: string; maxBytes: number }): Promise<ReadTextResult> {
  const fs = await import("node:fs/promises");
  try {
    const st = await fs.lstat(params.absPath);
    if (st.isSymbolicLink()) return { kind: "not_previewable", reason: "unsafe_path", bytes: st.size };
    if (!st.isFile()) return { kind: "not_previewable", reason: "unsafe_path", bytes: st.size };
    if (st.size > params.maxBytes) return { kind: "not_previewable", reason: "too_large", bytes: st.size };
    const buf = await fs.readFile(params.absPath);
    return readBufferAsText(buf, params.maxBytes);
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return { kind: "missing", bytes: 0, content: "" };
    throw err;
  }
}

function toVersion(stat: { mtimeMs: number; size: number }, hash?: string): FileVersion {
  if (hash) return { mtimeMs: stat.mtimeMs, size: stat.size, hash };
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

function toReadResponse(params: {
  path: string;
  read: ReadTextResult;
  language?: string;
  version?: FileVersion;
}): FileReadResponse {
  if (params.read.kind === "ok") {
    return {
      path: params.path,
      previewable: true,
      bytes: params.read.bytes,
      content: params.read.content,
      language: params.language,
      version: params.version
    };
  }
  if (params.read.kind === "missing") {
    return { path: params.path, previewable: false, reason: "missing", bytes: 0, version: params.version };
  }
  return {
    path: params.path,
    previewable: false,
    reason: params.read.reason,
    bytes: params.read.bytes,
    version: params.version
  };
}

function getTargetInfoOrThrow(ctx: AppContext, targetRaw: unknown) {
  const target = parseTarget(targetRaw);
  const ws = getWorkspace(ctx.db, target.workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");
  const wsRepo = getWorkspaceRepoByDirName(ctx.db, ws.id, target.dirName);
  if (!wsRepo) throw new HttpError(404, "Workspace repo not found");
  const repo = getRepo(ctx.db, wsRepo.repoId);
  if (!repo) throw new HttpError(404, "Repo not found");

  const safePath = safeResolveUnderRoot({ root: ws.path, rel: target.dirName });
  if (!safePath) throw new HttpError(400, "Invalid target");
  const repoPath = path.resolve(wsRepo.path);
  if (safePath !== repoPath) throw new HttpError(400, "Invalid target");

  return { target, ws, wsRepo, repo };
}

async function ensureDirSafe(absPath: string) {
  const fs = await import("node:fs/promises");
  const st = await fs.lstat(absPath);
  if (st.isSymbolicLink()) throw new HttpError(400, "Invalid path");
  if (!st.isDirectory()) throw new HttpError(409, "Not a directory");
  return st;
}

async function ensureRealPathUnderRoot(rootAbs: string, absPath: string) {
  const fs = await import("node:fs/promises");
  const real = await fs.realpath(absPath);
  const realAbs = path.resolve(real);
  if (realAbs === rootAbs) return realAbs;
  if (!realAbs.startsWith(rootAbs + path.sep)) throw new HttpError(400, "Invalid path");
  return realAbs;
}

async function ensureParentDirSafe(rootAbs: string, absPath: string) {
  const fs = await import("node:fs/promises");
  const parent = path.dirname(absPath);
  if (parent !== rootAbs && !parent.startsWith(rootAbs + path.sep)) {
    throw new HttpError(400, "Invalid path");
  }
  const st = await fs.lstat(parent);
  if (st.isSymbolicLink()) throw new HttpError(400, "Invalid path");
  if (!st.isDirectory()) throw new HttpError(409, "Parent is not a directory");
  await ensureRealPathUnderRoot(rootAbs, parent);
  return st;
}

export async function listFiles(ctx: AppContext, bodyRaw: unknown): Promise<FileListResponse> {
  const body = (bodyRaw ?? {}) as FileListRequest;
  const target = parseTarget((body as any).target);
  return withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = getTargetInfoOrThrow(ctx, target);
    const dir = normalizeDir((body as any).dir);
    if (dir && !isValidRelativePath(dir)) throw new HttpError(400, "Invalid dir");
    if (hasDeniedSegment(dir)) throw new HttpError(400, "Invalid dir");

    const rootAbs = path.resolve(wsRepo.path);
    const absDir = safeResolveUnderRoot({ root: wsRepo.path, rel: dir || "." });
    if (!absDir) throw new HttpError(400, "Invalid dir");
    if (absDir === rootAbs) {
      // ok
    } else if (!absDir.startsWith(rootAbs + path.sep)) {
      throw new HttpError(400, "Invalid dir");
    }

    await ensureDirSafe(absDir);
    await ensureRealPathUnderRoot(rootAbs, absDir);

    const fs = await import("node:fs/promises");
    const dirents = await fs.readdir(absDir, { withFileTypes: true });

    const entries: FileEntry[] = [];
    for (const dirent of dirents) {
      const name = dirent.name;
      if (!name) continue;
      if (DENYLIST_SEGMENTS.includes(name)) continue;
      const childAbs = path.join(absDir, name);
      let st;
      try {
        st = await fs.lstat(childAbs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      const relPath = joinRelPath(dir, name);
      if (st.isDirectory()) {
        entries.push({ name, path: relPath, kind: "dir", mtimeMs: st.mtimeMs });
        continue;
      }
      if (st.isFile()) {
        entries.push({ name, path: relPath, kind: "file", size: st.size, mtimeMs: st.mtimeMs });
      }
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { dir, entries };
  });
}

export async function statFile(ctx: AppContext, bodyRaw: unknown): Promise<FileStatResponse> {
  const body = (bodyRaw ?? {}) as FileStatRequest;
  const target = parseTarget((body as any).target);
  return withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = getTargetInfoOrThrow(ctx, target);
    const rel = typeof (body as any).path === "string" ? (body as any).path.trim() : "";
    if (!rel || !isValidRelativePath(rel)) throw new HttpError(400, "Invalid path");
    if (hasDeniedSegment(rel)) return { path: rel, ok: false, reason: "unsafe_path" };
    if (isRootRelPath(rel)) throw new HttpError(400, "Invalid path");

    const rootAbs = path.resolve(wsRepo.path);
    const absPath = safeResolveUnderRoot({ root: wsRepo.path, rel });
    if (!absPath) throw new HttpError(400, "Invalid path");
    if (absPath === rootAbs) throw new HttpError(400, "Invalid path");
    const normalizedPath = normalizeRelPath({ rootAbs, absPath, fallback: rel });

    const fs = await import("node:fs/promises");
    let st: { isSymbolicLink: () => boolean; isDirectory: () => boolean; isFile: () => boolean };
    try {
      st = await fs.lstat(absPath);
    } catch (err: any) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        return { path: rel, ok: false, reason: "missing", normalizedPath };
      }
      if (err && (err.code === "EACCES" || err.code === "EPERM")) {
        throw new HttpError(403, "Permission denied");
      }
      throw err;
    }

    if (st.isSymbolicLink()) return { path: rel, ok: false, reason: "unsafe_path", normalizedPath };
    if (st.isDirectory()) return { path: rel, ok: false, reason: "not_file", kind: "dir", normalizedPath };
    if (!st.isFile()) return { path: rel, ok: false, reason: "not_file", normalizedPath };

    try {
      await ensureRealPathUnderRoot(rootAbs, absPath);
    } catch (err: any) {
      if (err instanceof HttpError && err.statusCode === 400) {
        return { path: rel, ok: false, reason: "unsafe_path", normalizedPath };
      }
      if (err && (err.code === "EACCES" || err.code === "EPERM")) {
        throw new HttpError(403, "Permission denied");
      }
      throw err;
    }
    return { path: rel, ok: true, kind: "file", normalizedPath };
  });
}

export async function readFileText(ctx: AppContext, bodyRaw: unknown): Promise<FileReadResponse> {
  const body = (bodyRaw ?? {}) as FileReadRequest;
  const target = parseTarget((body as any).target);
  return withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = getTargetInfoOrThrow(ctx, target);
    const rel = typeof (body as any).path === "string" ? (body as any).path.trim() : "";
    if (!rel || !isValidRelativePath(rel)) throw new HttpError(400, "Invalid path");
    if (hasDeniedSegment(rel)) {
      return toReadResponse({ path: rel, read: { kind: "not_previewable", reason: "unsafe_path", bytes: 0 } });
    }
    if (isRootRelPath(rel)) throw new HttpError(400, "Invalid path");

    const rootAbs = path.resolve(wsRepo.path);
    const absPath = safeResolveUnderRoot({ root: wsRepo.path, rel });
    if (!absPath) throw new HttpError(400, "Invalid path");
    if (absPath === rootAbs) throw new HttpError(400, "Invalid path");

    const fs = await import("node:fs/promises");
    let st: { mtimeMs: number; size: number } | null = null;
    try {
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink()) {
        return toReadResponse({ path: rel, read: { kind: "not_previewable", reason: "unsafe_path", bytes: stat.size } });
      }
      if (!stat.isFile()) {
        return toReadResponse({ path: rel, read: { kind: "not_previewable", reason: "unsafe_path", bytes: stat.size } });
      }
      st = { mtimeMs: stat.mtimeMs, size: stat.size };
      await ensureRealPathUnderRoot(rootAbs, absPath);
    } catch (err: any) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        return toReadResponse({ path: rel, read: { kind: "missing", bytes: 0, content: "" } });
      }
      throw err;
    }

    let read: ReadTextResult;
    try {
      read = await readFileAsText({ absPath, maxBytes: ctx.fileMaxBytes });
    } catch (err: any) {
      if (err && (err.code === "EACCES" || err.code === "EPERM")) throw new HttpError(403, "Permission denied");
      throw err;
    }
    const version = st ? toVersion(st, read.kind === "ok" ? read.hash : undefined) : undefined;
    return toReadResponse({ path: rel, read, language: inferLanguage(rel), version });
  });
}

export class FileConflictError extends Error {
  payload: FileWriteResponse;

  constructor(payload: FileWriteResponse) {
    super("File changed");
    this.name = "FileConflictError";
    this.payload = payload;
  }
}

export async function writeFileText(ctx: AppContext, bodyRaw: unknown): Promise<FileWriteResponse> {
  const body = (bodyRaw ?? {}) as FileWriteRequest;
  const target = parseTarget((body as any).target);
  return withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = getTargetInfoOrThrow(ctx, target);
    const rel = typeof (body as any).path === "string" ? (body as any).path.trim() : "";
    if (!rel || !isValidRelativePath(rel)) throw new HttpError(400, "Invalid path");
    if (hasDeniedSegment(rel)) throw new HttpError(400, "Invalid path");
    if (isRootRelPath(rel)) throw new HttpError(400, "Invalid path");

    const force = parseBool((body as any).force, false);
    const expected = (body as any).expected as FileVersion | undefined;
    if (!force && !expected) throw new HttpError(400, "Expected version required");

    const rootAbs = path.resolve(wsRepo.path);
    const absPath = safeResolveUnderRoot({ root: wsRepo.path, rel });
    if (!absPath) throw new HttpError(400, "Invalid path");
    if (absPath === rootAbs) throw new HttpError(400, "Invalid path");

    await ensureParentDirSafe(rootAbs, absPath);

    const fs = await import("node:fs/promises");
    let st: { mtimeMs: number; size: number } | null = null;
    try {
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink()) throw new HttpError(400, "Invalid path");
      if (!stat.isFile()) throw new HttpError(400, "Invalid path");
      st = { mtimeMs: stat.mtimeMs, size: stat.size };
      await ensureRealPathUnderRoot(rootAbs, absPath);
    } catch (err: any) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        if (!force) throw new HttpError(404, "File not found");
        st = null;
      } else {
        throw err;
      }
    }

    if (!force && st) {
      const expectedMatch = expected && expected.mtimeMs === st.mtimeMs && expected.size === st.size;
      if (!expectedMatch) {
        if (!expected?.hash) {
          throw new FileConflictError({ path: rel, version: toVersion(st) });
        }
        const current = await readFileAsText({ absPath, maxBytes: Number.MAX_SAFE_INTEGER });
        const currentHash = current.kind === "ok" ? current.hash : undefined;
        if (current.kind !== "ok" || current.hash !== expected.hash) {
          throw new FileConflictError({ path: rel, version: toVersion(st, currentHash) });
        }
      }
    }

    const content = typeof (body as any).content === "string" ? (body as any).content : "";
    const buf = Buffer.from(content, "utf8");
    await fs.writeFile(absPath, buf);

    const statAfter = await fs.stat(absPath);
    const version = toVersion({ mtimeMs: statAfter.mtimeMs, size: statAfter.size }, hashBuffer(buf));
    return { path: rel, version };
  });
}

export async function createFile(ctx: AppContext, bodyRaw: unknown): Promise<FileCreateResponse> {
  const body = (bodyRaw ?? {}) as FileCreateRequest;
  const target = parseTarget((body as any).target);
  return withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = getTargetInfoOrThrow(ctx, target);
    const rel = typeof (body as any).path === "string" ? (body as any).path.trim() : "";
    if (!rel || !isValidRelativePath(rel)) throw new HttpError(400, "Invalid path");
    if (hasDeniedSegment(rel)) throw new HttpError(400, "Invalid path");
    if (isRootRelPath(rel)) throw new HttpError(400, "Invalid path");

    const rootAbs = path.resolve(wsRepo.path);
    const absPath = safeResolveUnderRoot({ root: wsRepo.path, rel });
    if (!absPath) throw new HttpError(400, "Invalid path");
    if (absPath === rootAbs) throw new HttpError(400, "Invalid path");

    await ensureParentDirSafe(rootAbs, absPath);

    const fs = await import("node:fs/promises");
    try {
      await fs.lstat(absPath);
      throw new HttpError(409, "File already exists");
    } catch (err: any) {
      if (!(err && (err.code === "ENOENT" || err.code === "ENOTDIR"))) throw err;
    }

    const content = typeof (body as any).content === "string" ? (body as any).content : "";
    const buf = Buffer.from(content, "utf8");
    await fs.writeFile(absPath, buf, { flag: "wx" });
    const st = await fs.stat(absPath);
    return { path: rel, version: toVersion({ mtimeMs: st.mtimeMs, size: st.size }, hashBuffer(buf)) };
  });
}

export async function mkdirPath(ctx: AppContext, bodyRaw: unknown): Promise<FileMkdirResponse> {
  const body = (bodyRaw ?? {}) as FileMkdirRequest;
  const target = parseTarget((body as any).target);
  return withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = getTargetInfoOrThrow(ctx, target);
    const rel = typeof (body as any).path === "string" ? (body as any).path.trim() : "";
    if (!rel || !isValidRelativePath(rel)) throw new HttpError(400, "Invalid path");
    if (hasDeniedSegment(rel)) throw new HttpError(400, "Invalid path");
    if (isRootRelPath(rel)) throw new HttpError(400, "Invalid path");

    const rootAbs = path.resolve(wsRepo.path);
    const absPath = safeResolveUnderRoot({ root: wsRepo.path, rel });
    if (!absPath) throw new HttpError(400, "Invalid path");
    if (absPath === rootAbs) throw new HttpError(400, "Invalid path");

    await ensureParentDirSafe(rootAbs, absPath);

    const fs = await import("node:fs/promises");
    try {
      await fs.mkdir(absPath);
    } catch (err: any) {
      if (err && err.code === "EEXIST") throw new HttpError(409, "Path already exists");
      throw err;
    }
    return { path: rel };
  });
}

export async function renamePath(ctx: AppContext, bodyRaw: unknown): Promise<FileRenameResponse> {
  const body = (bodyRaw ?? {}) as FileRenameRequest;
  const target = parseTarget((body as any).target);
  return withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = getTargetInfoOrThrow(ctx, target);
    const from = typeof (body as any).from === "string" ? (body as any).from.trim() : "";
    const to = typeof (body as any).to === "string" ? (body as any).to.trim() : "";
    if (!from || !to) throw new HttpError(400, "Invalid path");
    if (!isValidRelativePath(from) || !isValidRelativePath(to)) throw new HttpError(400, "Invalid path");
    if (hasDeniedSegment(from) || hasDeniedSegment(to)) throw new HttpError(400, "Invalid path");
    if (isRootRelPath(from) || isRootRelPath(to)) throw new HttpError(400, "Invalid path");

    const rootAbs = path.resolve(wsRepo.path);
    const absFrom = safeResolveUnderRoot({ root: wsRepo.path, rel: from });
    const absTo = safeResolveUnderRoot({ root: wsRepo.path, rel: to });
    if (!absFrom || !absTo) throw new HttpError(400, "Invalid path");
    if (absFrom === rootAbs || absTo === rootAbs) throw new HttpError(400, "Invalid path");

    await ensureParentDirSafe(rootAbs, absFrom);
    await ensureParentDirSafe(rootAbs, absTo);

    const fs = await import("node:fs/promises");
    try {
      const st = await fs.lstat(absFrom);
      if (st.isSymbolicLink()) throw new HttpError(400, "Invalid path");
      await ensureRealPathUnderRoot(rootAbs, absFrom);
    } catch (err: any) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) throw new HttpError(404, "Path not found");
      throw err;
    }

    try {
      await fs.lstat(absTo);
      throw new HttpError(409, "Target already exists");
    } catch (err: any) {
      if (!(err && (err.code === "ENOENT" || err.code === "ENOTDIR"))) throw err;
    }

    await fs.rename(absFrom, absTo);
    return { from, to };
  });
}

export async function deletePath(ctx: AppContext, bodyRaw: unknown): Promise<FileDeleteResponse> {
  const body = (bodyRaw ?? {}) as FileDeleteRequest;
  const target = parseTarget((body as any).target);
  return withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = getTargetInfoOrThrow(ctx, target);
    const rel = typeof (body as any).path === "string" ? (body as any).path.trim() : "";
    if (!rel || !isValidRelativePath(rel)) throw new HttpError(400, "Invalid path");
    if (hasDeniedSegment(rel)) throw new HttpError(400, "Invalid path");
    if (isRootRelPath(rel)) throw new HttpError(400, "Invalid path");

    const rootAbs = path.resolve(wsRepo.path);
    const absPath = safeResolveUnderRoot({ root: wsRepo.path, rel });
    if (!absPath) throw new HttpError(400, "Invalid path");
    if (absPath === rootAbs) throw new HttpError(400, "Invalid path");

    const fs = await import("node:fs/promises");
    try {
      const st = await fs.lstat(absPath);
      if (st.isSymbolicLink()) throw new HttpError(400, "Invalid path");
      await ensureRealPathUnderRoot(rootAbs, absPath);
    } catch (err: any) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) throw new HttpError(404, "Path not found");
      throw err;
    }

    const recursive = parseBool((body as any).recursive, true);
    await fs.rm(absPath, { recursive, force: false });
    return { path: rel };
  });
}

export async function searchFiles(ctx: AppContext, bodyRaw: unknown): Promise<FileSearchResponse> {
  const body = (bodyRaw ?? {}) as FileSearchRequest;
  const target = parseTarget((body as any).target);
  const { wsRepo } = getTargetInfoOrThrow(ctx, target);
  const query = typeof (body as any).query === "string" ? (body as any).query.trim() : "";
  if (!query) throw new HttpError(400, "Invalid query");

  const useRegex = Boolean((body as any).useRegex);
  const caseSensitive = Boolean((body as any).caseSensitive);
  const wholeWord = parseBool((body as any).wholeWord, false);

  const settings = getSearchSettings(ctx);
  const excludeGlobs = [...settings.excludeGlobs, ...SEARCH_FORCED_EXCLUDES];
  return runFileSearch({
    cwd: wsRepo.path,
    query,
    useRegex,
    caseSensitive,
    wholeWord,
    excludeGlobs,
    searchPaths: ["."]
  });
}
