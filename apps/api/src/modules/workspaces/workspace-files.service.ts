import path from "node:path";
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import type {
  FileCreateResponse,
  FileDeleteResponse,
  FileEntry,
  FileListResponse,
  FileMkdirResponse,
  FileReadResponse,
  FileRenameResponse,
  FileStatResponse,
  FileVersion,
  FileWriteResponse,
  WorkspaceFileCreateRequest,
  WorkspaceFileDeleteRequest,
  WorkspaceFileListRequest,
  WorkspaceFileMkdirRequest,
  WorkspaceFileReadRequest,
  WorkspaceFileRenameRequest,
  WorkspaceFileStatRequest,
  WorkspaceFileWriteRequest
} from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { workspaceRoot } from "../../infra/fs/paths.js";
import { withWorkspaceLock } from "../../infra/locks/workspaceLock.js";
import { getWorkspace, listWorkspaceRepos } from "./workspace.store.js";
import {
  createFile as createRepoFile,
  deletePath as deleteRepoPath,
  FileConflictError,
  listFiles as listRepoFiles,
  mkdirPath as mkdirRepoPath,
  readFileText as readRepoFileText,
  renamePath as renameRepoPath,
  statFile as statRepoFile,
  writeFileText as writeRepoFileText
} from "../files/files.service.js";

const DENYLIST_SEGMENTS = [".git"];

type WorkspaceScope = {
  workspaceId: string;
  rootAbs: string;
  repoDirNames: Set<string>;
};

type WorkspaceDomain =
  | { kind: "workspaceRoot"; rel: string }
  | { kind: "repo"; dirName: string; rel: string };

type PreviewFailReason = "too_large" | "binary" | "decode_failed" | "unsafe_path" | "missing";

type ReadTextResult =
  | { kind: "missing"; bytes: 0; content: "" }
  | { kind: "not_previewable"; reason: PreviewFailReason; bytes: number }
  | { kind: "ok"; bytes: number; content: string; hash: string };

export class WorkspaceFileConflictError extends Error {
  payload: FileWriteResponse;

  constructor(payload: FileWriteResponse) {
    super("File changed");
    this.name = "WorkspaceFileConflictError";
    this.payload = payload;
  }
}

function parseWorkspaceId(raw: unknown) {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) throw new HttpError(400, "Invalid workspaceId");
  return id;
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

function toReadResponse(params: { path: string; read: ReadTextResult; language?: string; version?: FileVersion }): FileReadResponse {
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

function prefixWorkspacePath(prefix: string, rel: string) {
  return rel ? `${prefix}/${rel}` : prefix;
}

function buildWorkspaceScope(ctx: AppContext, workspaceIdRaw: string): WorkspaceScope {
  const workspaceId = parseWorkspaceId(workspaceIdRaw);
  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");
  const expectedRoot = workspaceRoot(ctx.dataDir, ws.dirName);
  if (path.resolve(ws.path) !== path.resolve(expectedRoot)) {
    throw new HttpError(409, "Workspace path is invalid", "WORKSPACE_PATH_INVALID");
  }
  const repos = listWorkspaceRepos(ctx.db, ws.id);
  const repoDirNames = new Set(repos.map((item) => item.dirName));
  return { workspaceId: ws.id, rootAbs: path.resolve(ws.path), repoDirNames };
}

function resolveWorkspaceDomain(rel: string, repoDirNames: Set<string>): WorkspaceDomain {
  if (!rel) return { kind: "workspaceRoot", rel: "" };
  const parts = rel.split(/[\\/]+/g).filter(Boolean);
  const head = parts[0] ?? "";
  if (head && repoDirNames.has(head)) {
    const rest = parts.slice(1).join("/");
    return { kind: "repo", dirName: head, rel: rest };
  }
  return { kind: "workspaceRoot", rel };
}

function isProtectedRootPath(rel: string, repoDirNames: Set<string>) {
  if (!rel) return false;
  const parts = rel.split(/[\\/]+/g).filter(Boolean);
  if (parts.length !== 1) return false;
  return repoDirNames.has(parts[0] ?? "");
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

function assertValidDir(rel: string) {
  if (rel && !isValidRelativePath(rel)) throw new HttpError(400, "Invalid dir");
  if (hasDeniedSegment(rel)) throw new HttpError(400, "Invalid dir");
}

function assertValidPath(rel: string) {
  if (!rel || !isValidRelativePath(rel)) throw new HttpError(400, "Invalid path");
  if (hasDeniedSegment(rel)) throw new HttpError(400, "Invalid path");
  if (isRootRelPath(rel)) throw new HttpError(400, "Invalid path");
}

async function listUnderRoot(rootAbs: string, dir: string): Promise<FileListResponse> {
  const absDir = safeResolveUnderRoot({ root: rootAbs, rel: dir || "." });
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
}

async function statUnderRoot(rootAbs: string, rel: string): Promise<FileStatResponse> {
  const absPath = safeResolveUnderRoot({ root: rootAbs, rel });
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
}

async function readUnderRoot(ctx: AppContext, rootAbs: string, rel: string): Promise<FileReadResponse> {
  const absPath = safeResolveUnderRoot({ root: rootAbs, rel });
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
}

async function writeUnderRoot(
  ctx: AppContext,
  rootAbs: string,
  rel: string,
  params: { content: string; expected?: FileVersion; force?: boolean }
): Promise<FileWriteResponse> {
  const absPath = safeResolveUnderRoot({ root: rootAbs, rel });
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
      if (!params.force) throw new HttpError(404, "File not found");
      st = null;
    } else {
      throw err;
    }
  }

  if (!params.force && st) {
    const expectedMatch = params.expected && params.expected.mtimeMs === st.mtimeMs && params.expected.size === st.size;
    if (!expectedMatch) {
      if (!params.expected?.hash) {
        throw new WorkspaceFileConflictError({ path: rel, version: toVersion(st) });
      }
      const current = await readFileAsText({ absPath, maxBytes: Number.MAX_SAFE_INTEGER });
      const currentHash = current.kind === "ok" ? current.hash : undefined;
      if (current.kind !== "ok" || current.hash !== params.expected.hash) {
        throw new WorkspaceFileConflictError({ path: rel, version: toVersion(st, currentHash) });
      }
    }
  }

  const buf = Buffer.from(params.content, "utf8");
  await fs.writeFile(absPath, buf);

  const statAfter = await fs.stat(absPath);
  const version = toVersion({ mtimeMs: statAfter.mtimeMs, size: statAfter.size }, hashBuffer(buf));
  return { path: rel, version };
}

async function createUnderRoot(rootAbs: string, rel: string, content: string): Promise<FileCreateResponse> {
  const absPath = safeResolveUnderRoot({ root: rootAbs, rel });
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

  const buf = Buffer.from(content, "utf8");
  await fs.writeFile(absPath, buf, { flag: "wx" });
  const st = await fs.stat(absPath);
  return { path: rel, version: toVersion({ mtimeMs: st.mtimeMs, size: st.size }, hashBuffer(buf)) };
}

async function mkdirUnderRoot(rootAbs: string, rel: string): Promise<FileMkdirResponse> {
  const absPath = safeResolveUnderRoot({ root: rootAbs, rel });
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
}

async function renameUnderRoot(rootAbs: string, from: string, to: string): Promise<FileRenameResponse> {
  const absFrom = safeResolveUnderRoot({ root: rootAbs, rel: from });
  const absTo = safeResolveUnderRoot({ root: rootAbs, rel: to });
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
}

async function deleteUnderRoot(rootAbs: string, rel: string, recursive: boolean): Promise<FileDeleteResponse> {
  const absPath = safeResolveUnderRoot({ root: rootAbs, rel });
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

  await fs.rm(absPath, { recursive, force: false });
  return { path: rel };
}

export async function listWorkspaceFiles(ctx: AppContext, workspaceIdRaw: string, bodyRaw: unknown): Promise<FileListResponse> {
  const body = (bodyRaw ?? {}) as WorkspaceFileListRequest;
  const scope = buildWorkspaceScope(ctx, workspaceIdRaw);
  const dir = normalizeDir((body as any).dir);
  assertValidDir(dir);
  const domain = resolveWorkspaceDomain(dir, scope.repoDirNames);
  if (domain.kind === "repo") {
    const res = await listRepoFiles(ctx, {
      target: { kind: "workspaceRepo", workspaceId: scope.workspaceId, dirName: domain.dirName },
      dir: domain.rel
    });
    return {
      dir: prefixWorkspacePath(domain.dirName, res.dir),
      entries: res.entries.map((entry) => ({ ...entry, path: prefixWorkspacePath(domain.dirName, entry.path) }))
    };
  }
  return listUnderRoot(scope.rootAbs, dir);
}

export async function statWorkspaceFile(ctx: AppContext, workspaceIdRaw: string, bodyRaw: unknown): Promise<FileStatResponse> {
  const body = (bodyRaw ?? {}) as WorkspaceFileStatRequest;
  const scope = buildWorkspaceScope(ctx, workspaceIdRaw);
  const rel = typeof (body as any).path === "string" ? (body as any).path.trim() : "";
  if (!rel || !isValidRelativePath(rel)) throw new HttpError(400, "Invalid path");
  if (hasDeniedSegment(rel)) return { path: rel, ok: false, reason: "unsafe_path" };
  if (isRootRelPath(rel)) throw new HttpError(400, "Invalid path");

  const domain = resolveWorkspaceDomain(rel, scope.repoDirNames);
  if (domain.kind === "repo") {
    if (!domain.rel) throw new HttpError(400, "Invalid path");
    const res = await statRepoFile(ctx, {
      target: { kind: "workspaceRepo", workspaceId: scope.workspaceId, dirName: domain.dirName },
      path: domain.rel
    });
    return {
      ...res,
      path: prefixWorkspacePath(domain.dirName, res.path),
      normalizedPath: res.normalizedPath ? prefixWorkspacePath(domain.dirName, res.normalizedPath) : res.normalizedPath
    };
  }
  return statUnderRoot(scope.rootAbs, rel);
}

export async function readWorkspaceFileText(ctx: AppContext, workspaceIdRaw: string, bodyRaw: unknown): Promise<FileReadResponse> {
  const body = (bodyRaw ?? {}) as WorkspaceFileReadRequest;
  const scope = buildWorkspaceScope(ctx, workspaceIdRaw);
  const rel = typeof (body as any).path === "string" ? (body as any).path.trim() : "";
  if (!rel || !isValidRelativePath(rel)) throw new HttpError(400, "Invalid path");
  if (hasDeniedSegment(rel)) {
    return toReadResponse({ path: rel, read: { kind: "not_previewable", reason: "unsafe_path", bytes: 0 } });
  }
  if (isRootRelPath(rel)) throw new HttpError(400, "Invalid path");

  const domain = resolveWorkspaceDomain(rel, scope.repoDirNames);
  if (domain.kind === "repo") {
    if (!domain.rel) throw new HttpError(400, "Invalid path");
    const res = await readRepoFileText(ctx, {
      target: { kind: "workspaceRepo", workspaceId: scope.workspaceId, dirName: domain.dirName },
      path: domain.rel
    });
    return { ...res, path: prefixWorkspacePath(domain.dirName, res.path) };
  }
  return readUnderRoot(ctx, scope.rootAbs, rel);
}

export async function writeWorkspaceFileText(ctx: AppContext, workspaceIdRaw: string, bodyRaw: unknown): Promise<FileWriteResponse> {
  const body = (bodyRaw ?? {}) as WorkspaceFileWriteRequest;
  const scope = buildWorkspaceScope(ctx, workspaceIdRaw);
  const rel = typeof (body as any).path === "string" ? (body as any).path.trim() : "";
  assertValidPath(rel);

  const force = parseBool((body as any).force, false);
  const expected = (body as any).expected as FileVersion | undefined;
  if (!force && !expected) throw new HttpError(400, "Expected version required");

  const domain = resolveWorkspaceDomain(rel, scope.repoDirNames);
  if (domain.kind === "repo") {
    if (!domain.rel) throw new HttpError(400, "Invalid path");
    try {
      const res = await writeRepoFileText(ctx, {
        target: { kind: "workspaceRepo", workspaceId: scope.workspaceId, dirName: domain.dirName },
        path: domain.rel,
        content: typeof (body as any).content === "string" ? (body as any).content : "",
        expected,
        force
      });
      return { ...res, path: prefixWorkspacePath(domain.dirName, res.path) };
    } catch (err) {
      if (err instanceof FileConflictError) {
        const payload = err.payload;
        throw new WorkspaceFileConflictError({
          ...payload,
          path: prefixWorkspacePath(domain.dirName, payload.path)
        });
      }
      throw err;
    }
  }

  return withWorkspaceLock({ workspaceId: scope.workspaceId }, async () => {
    const res = await writeUnderRoot(ctx, scope.rootAbs, rel, {
      content: typeof (body as any).content === "string" ? (body as any).content : "",
      expected,
      force
    });
    return res;
  });
}

export async function createWorkspaceFile(ctx: AppContext, workspaceIdRaw: string, bodyRaw: unknown): Promise<FileCreateResponse> {
  const body = (bodyRaw ?? {}) as WorkspaceFileCreateRequest;
  const scope = buildWorkspaceScope(ctx, workspaceIdRaw);
  const rel = typeof (body as any).path === "string" ? (body as any).path.trim() : "";
  assertValidPath(rel);

  const domain = resolveWorkspaceDomain(rel, scope.repoDirNames);
  if (domain.kind === "repo") {
    if (!domain.rel) throw new HttpError(400, "Invalid path");
    const res = await createRepoFile(ctx, {
      target: { kind: "workspaceRepo", workspaceId: scope.workspaceId, dirName: domain.dirName },
      path: domain.rel,
      content: typeof (body as any).content === "string" ? (body as any).content : ""
    });
    return { ...res, path: prefixWorkspacePath(domain.dirName, res.path) };
  }

  return withWorkspaceLock({ workspaceId: scope.workspaceId }, async () => {
    return createUnderRoot(scope.rootAbs, rel, typeof (body as any).content === "string" ? (body as any).content : "");
  });
}

export async function mkdirWorkspacePath(ctx: AppContext, workspaceIdRaw: string, bodyRaw: unknown): Promise<FileMkdirResponse> {
  const body = (bodyRaw ?? {}) as WorkspaceFileMkdirRequest;
  const scope = buildWorkspaceScope(ctx, workspaceIdRaw);
  const rel = typeof (body as any).path === "string" ? (body as any).path.trim() : "";
  assertValidPath(rel);

  const domain = resolveWorkspaceDomain(rel, scope.repoDirNames);
  if (domain.kind === "repo") {
    if (!domain.rel) throw new HttpError(400, "Invalid path");
    const res = await mkdirRepoPath(ctx, {
      target: { kind: "workspaceRepo", workspaceId: scope.workspaceId, dirName: domain.dirName },
      path: domain.rel
    });
    return { ...res, path: prefixWorkspacePath(domain.dirName, res.path) };
  }

  return withWorkspaceLock({ workspaceId: scope.workspaceId }, async () => {
    return mkdirUnderRoot(scope.rootAbs, rel);
  });
}

export async function renameWorkspacePath(ctx: AppContext, workspaceIdRaw: string, bodyRaw: unknown): Promise<FileRenameResponse> {
  const body = (bodyRaw ?? {}) as WorkspaceFileRenameRequest;
  const scope = buildWorkspaceScope(ctx, workspaceIdRaw);
  const from = typeof (body as any).from === "string" ? (body as any).from.trim() : "";
  const to = typeof (body as any).to === "string" ? (body as any).to.trim() : "";
  if (!from || !to) throw new HttpError(400, "Invalid path");
  if (!isValidRelativePath(from) || !isValidRelativePath(to)) throw new HttpError(400, "Invalid path");
  if (hasDeniedSegment(from) || hasDeniedSegment(to)) throw new HttpError(400, "Invalid path");
  if (isRootRelPath(from) || isRootRelPath(to)) throw new HttpError(400, "Invalid path");
  if (isProtectedRootPath(from, scope.repoDirNames) || isProtectedRootPath(to, scope.repoDirNames)) {
    throw new HttpError(409, "Path is protected");
  }

  const fromDomain = resolveWorkspaceDomain(from, scope.repoDirNames);
  const toDomain = resolveWorkspaceDomain(to, scope.repoDirNames);
  if (fromDomain.kind !== toDomain.kind) throw new HttpError(409, "Cross-root rename is not allowed");
  if (fromDomain.kind === "repo" && toDomain.kind === "repo" && fromDomain.dirName !== toDomain.dirName) {
    throw new HttpError(409, "Cross-root rename is not allowed");
  }

  if (fromDomain.kind === "repo" && toDomain.kind === "repo") {
    if (!fromDomain.rel || !toDomain.rel) throw new HttpError(400, "Invalid path");
    const res = await renameRepoPath(ctx, {
      target: { kind: "workspaceRepo", workspaceId: scope.workspaceId, dirName: fromDomain.dirName },
      from: fromDomain.rel,
      to: toDomain.rel
    });
    return {
      from: prefixWorkspacePath(fromDomain.dirName, res.from),
      to: prefixWorkspacePath(fromDomain.dirName, res.to)
    };
  }

  return withWorkspaceLock({ workspaceId: scope.workspaceId }, async () => {
    return renameUnderRoot(scope.rootAbs, fromDomain.rel, toDomain.rel);
  });
}

export async function deleteWorkspacePath(ctx: AppContext, workspaceIdRaw: string, bodyRaw: unknown): Promise<FileDeleteResponse> {
  const body = (bodyRaw ?? {}) as WorkspaceFileDeleteRequest;
  const scope = buildWorkspaceScope(ctx, workspaceIdRaw);
  const rel = typeof (body as any).path === "string" ? (body as any).path.trim() : "";
  assertValidPath(rel);
  if (isProtectedRootPath(rel, scope.repoDirNames)) throw new HttpError(409, "Path is protected");

  const domain = resolveWorkspaceDomain(rel, scope.repoDirNames);
  if (domain.kind === "repo") {
    if (!domain.rel) throw new HttpError(400, "Invalid path");
    const res = await deleteRepoPath(ctx, {
      target: { kind: "workspaceRepo", workspaceId: scope.workspaceId, dirName: domain.dirName },
      path: domain.rel,
      recursive: parseBool((body as any).recursive, true)
    });
    return { ...res, path: prefixWorkspacePath(domain.dirName, res.path) };
  }

  return withWorkspaceLock({ workspaceId: scope.workspaceId }, async () => {
    return deleteUnderRoot(scope.rootAbs, rel, parseBool((body as any).recursive, true));
  });
}
