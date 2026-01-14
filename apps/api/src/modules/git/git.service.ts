import path from "node:path";
import { TextDecoder } from "node:util";
import type {
  ChangesResponse,
  ChangeMode,
  FileCompareResponse,
  GitCommitResponse,
  GitDiscardRequest,
  GitIdentityInput,
  GitIdentityScope,
  GitIdentityStatus,
  GitPullResponse,
  GitPushResponse,
  GitStageRequest,
  GitUnstageRequest
} from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { getWorkspace } from "../workspaces/workspace.store.js";
import { getRepo } from "../repos/repo.store.js";
import { runGit, runGitBuffer } from "../../infra/git/gitExec.js";
import { buildGitEnv } from "../../infra/git/gitEnv.js";
import { withRepoLock } from "../../infra/locks/repoLock.js";
import { gitConfigGet, gitConfigSet, validateAndNormalizeGitIdentity } from "../../infra/git/gitIdentity.js";

function parseMode(modeRaw: unknown): ChangeMode {
  if (modeRaw === "staged" || modeRaw === "unstaged") return modeRaw;
  throw new HttpError(400, 'Invalid mode. Expected "staged" or "unstaged".');
}

function parseBool(raw: unknown) {
  return raw === "1" || raw === "true" || raw === "yes";
}

function parseNameStatusZ(output: string) {
  const parts = output.split("\0").filter((p) => p.length > 0);
  const files: { path: string; status: string; oldPath?: string }[] = [];

  let i = 0;
  while (i < parts.length) {
    const status = parts[i++]!;
    const code = status[0] ?? "";
    if (code === "R" || code === "C") {
      const oldPath = parts[i++]!;
      const newPath = parts[i++]!;
      files.push({ path: newPath, status: code, oldPath });
      continue;
    }
    const p = parts[i++]!;
    files.push({ path: p, status: code || status });
  }

  return files;
}

function parseUntrackedFromStatusZ(output: string) {
  const parts = output.split("\0").filter(Boolean);
  const files: { path: string; status: string }[] = [];
  for (const part of parts) {
    if (!part.startsWith("?? ")) continue;
    const p = part.slice(3);
    if (!p || p.includes("\0")) continue;
    if (p.endsWith("/")) continue;
    files.push({ path: p, status: "??" });
  }
  return files;
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
  if (!abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

function isSafePathInWorkspace(params: { wsPath: string; rel: string }) {
  if (!isValidRelativePath(params.rel)) return false;
  return safeResolveUnderRoot({ root: params.wsPath, rel: params.rel }) !== null;
}

function parseGitBool(raw: unknown) {
  if (typeof raw === "boolean") return raw;
  return parseBool(raw);
}

function normalizeGitMessage(raw: unknown) {
  const msg = typeof raw === "string" ? raw.trim() : "";
  return msg;
}

function normalizeGitRefLike(raw: unknown) {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return "";
  if (v.startsWith("-")) return "";
  if (/\s/.test(v)) return "";
  if (v.includes("\0")) return "";
  return v;
}

function truncateGitOutput(s: string, max = 4000) {
  const t = (s || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return t.slice(0, max) + "...";
}

function isOverwrittenByCheckoutError(stderrOrStdout: string) {
  const s = (stderrOrStdout || "").toLowerCase();
  return (
    s.includes("would be overwritten by checkout") ||
    s.includes("would be overwritten by merge") ||
    s.includes("untracked working tree file") ||
    s.includes("untracked working tree files")
  );
}

function isAuthOrInteractionError(stderrOrStdout: string) {
  const s = stderrOrStdout.toLowerCase();
  return (
    s.includes("could not read username") ||
    s.includes("authentication failed") ||
    s.includes("permission denied") ||
    s.includes("publickey") ||
    s.includes("host key verification failed") ||
    s.includes("the authenticity of host") ||
    s.includes("terminal prompts disabled") ||
    s.includes("could not read from remote repository")
  );
}

function isNonFastForwardError(stderrOrStdout: string) {
  const s = stderrOrStdout.toLowerCase();
  return (
    s.includes("non-fast-forward") ||
    s.includes("fetch first") ||
    s.includes("remote contains work that you do not have locally") ||
    s.includes("updates were rejected because the remote contains work") ||
    s.includes("tip of your current branch is behind")
  );
}

function isPullNotFastForwardError(stderrOrStdout: string) {
  const s = stderrOrStdout.toLowerCase();
  return s.includes("not possible to fast-forward") || s.includes("cannot fast-forward");
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

type PreviewFailReason = "too_large" | "binary" | "decode_failed" | "unsafe_path";

type ReadTextResult =
  | { kind: "missing"; bytes: 0; content: "" }
  | { kind: "not_previewable"; reason: PreviewFailReason; bytes: number }
  | { kind: "ok"; bytes: number; content: string };

function decodeUtf8(buf: Buffer): { ok: true; text: string } | { ok: false; reason: "decode_failed" } {
  try {
    const dec = new TextDecoder("utf-8", { fatal: true });
    return { ok: true, text: dec.decode(buf) };
  } catch {
    return { ok: false, reason: "decode_failed" };
  }
}

function readBufferAsText(buf: Buffer, maxBytes: number): ReadTextResult {
  if (buf.byteLength > maxBytes) return { kind: "not_previewable", reason: "too_large", bytes: buf.byteLength };
  if (buf.includes(0)) return { kind: "not_previewable", reason: "binary", bytes: buf.byteLength };
  const dec = decodeUtf8(buf);
  if (!dec.ok) return { kind: "not_previewable", reason: dec.reason, bytes: buf.byteLength };
  return { kind: "ok", bytes: buf.byteLength, content: dec.text };
}

async function readWorktreeText(params: { wsRoot: string; absPath: string; maxBytes: number }): Promise<ReadTextResult> {
  const fs = await import("node:fs/promises");
  try {
    const wsRootAbs = path.resolve(params.wsRoot);
    const absPath = path.resolve(params.absPath);
    if (!absPath.startsWith(wsRootAbs + path.sep)) {
      return { kind: "not_previewable", reason: "unsafe_path", bytes: 0 };
    }

    const st = await fs.lstat(absPath);
    if (st.isSymbolicLink()) return { kind: "not_previewable", reason: "unsafe_path", bytes: st.size };
    if (!st.isFile()) return { kind: "not_previewable", reason: "unsafe_path", bytes: st.size };

    const real = await fs.realpath(absPath);
    const realAbs = path.resolve(real);
    if (!realAbs.startsWith(wsRootAbs + path.sep)) {
      return { kind: "not_previewable", reason: "unsafe_path", bytes: st.size };
    }

    if (st.size > params.maxBytes) return { kind: "not_previewable", reason: "too_large", bytes: st.size };
    const buf = await fs.readFile(absPath);
    return readBufferAsText(buf, params.maxBytes);
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return { kind: "missing", bytes: 0, content: "" };
    return { kind: "missing", bytes: 0, content: "" };
  }
}

async function gitCatFileSizeOrMissing(params: { cwd: string; object: string }): Promise<{ kind: "missing" } | { kind: "ok"; bytes: number }> {
  const res = await runGit(["-C", params.cwd, "cat-file", "-s", params.object], { cwd: params.cwd });
  if (!res.ok) return { kind: "missing" };
  const bytes = Number.parseInt(res.stdout.trim(), 10);
  if (!Number.isFinite(bytes) || bytes < 0) return { kind: "missing" };
  return { kind: "ok", bytes };
}

async function gitCatFileText(params: { cwd: string; object: string; maxBytes: number }): Promise<ReadTextResult> {
  const sizeRes = await gitCatFileSizeOrMissing({ cwd: params.cwd, object: params.object });
  if (sizeRes.kind === "missing") return { kind: "missing", bytes: 0, content: "" };
  if (sizeRes.bytes > params.maxBytes) return { kind: "not_previewable", reason: "too_large", bytes: sizeRes.bytes };
  const res = await runGitBuffer(["-C", params.cwd, "cat-file", "-p", params.object], { cwd: params.cwd });
  if (!res.ok) return { kind: "missing", bytes: 0, content: "" };
  return readBufferAsText(res.stdout, params.maxBytes);
}

async function gitIndexBlobSha(params: { cwd: string; filePath: string }): Promise<{ kind: "missing" } | { kind: "ok"; sha: string }> {
  const res = await runGit(["-C", params.cwd, "ls-files", "-s", "--", params.filePath], { cwd: params.cwd });
  if (!res.ok) return { kind: "missing" };
  const lines = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let firstSha = "";
  for (const line of lines) {
    const m = line.match(/^(\d+)\s+([0-9a-f]{40})\s+(\d+)\t(.+)$/);
    if (!m) continue;
    const sha = m[2] || "";
    const stage = Number(m[3] || "0");
    if (!sha) continue;
    if (!firstSha) firstSha = sha;
    if (stage === 0) return { kind: "ok", sha };
  }

  if (!firstSha) return { kind: "missing" };
  return { kind: "ok", sha: firstSha };
}

async function gitIndexBlobShaBatch(params: { cwd: string; filePaths: string[] }) {
  const out = new Map<string, string>();
  const filePaths = params.filePaths.filter(isValidRelativePath);
  if (filePaths.length === 0) return out;

  const res = await runGit(["-C", params.cwd, "ls-files", "-s", "-z", "--", ...filePaths], { cwd: params.cwd });
  if (!res.ok) return out;

  const entries = res.stdout.split("\0").filter((e) => e.length > 0);
  for (const entry of entries) {
    const m = entry.match(/^(\d+)\s+([0-9a-f]{40})\s+(\d+)\t(.+)$/);
    if (!m) continue;
    const sha = m[2]!;
    const stage = Number(m[3] || "0");
    const filePath = m[4]!;
    const existing = out.get(filePath);
    if (!existing || stage === 0) out.set(filePath, sha);
  }
  return out;
}

function toSide(params: {
  label: string;
  path: string;
  read: ReadTextResult;
}): FileCompareResponse["base"] {
  if (params.read.kind === "not_previewable") {
    return { label: params.label, path: params.path, previewable: false, reason: params.read.reason, bytes: params.read.bytes };
  }
  return { label: params.label, path: params.path, previewable: true, bytes: params.read.bytes, content: params.read.content };
}

export async function listChanges(
  ctx: AppContext,
  workspaceId: string,
  modeRaw: unknown
): Promise<ChangesResponse> {
  const mode = parseMode(modeRaw);
  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");

  const args =
    mode === "staged"
      ? ["-C", ws.path, "diff", "--cached", "--name-status", "-z"]
      : ["-C", ws.path, "diff", "--name-status", "-z"];
  const res = await runGit(args, { cwd: ctx.dataDir });
  if (!res.ok) throw new HttpError(500, `Failed to read changes: ${truncateGitOutput(res.stderr || res.stdout)}`);

  const files = parseNameStatusZ(res.stdout);

  if (mode === "unstaged") {
    const statusRes = await runGit(["-C", ws.path, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: ctx.dataDir });
    if (statusRes.ok) {
      const untracked = parseUntrackedFromStatusZ(statusRes.stdout);
      const seen = new Set(files.map((f) => f.path));
      for (const u of untracked) {
        if (seen.has(u.path)) continue;
        files.push({ path: u.path, status: u.status });
      }
    }
  }

  const shaPaths = Array.from(
    new Set(
      files
        .map((f) => (mode === "unstaged" ? f.oldPath || f.path : f.path))
        .filter((p): p is string => typeof p === "string" && p.length > 0)
    )
  );
  const indexShaByPath = await gitIndexBlobShaBatch({ cwd: ws.path, filePaths: shaPaths });

  if (mode === "unstaged") {
    const fs = await import("node:fs/promises");
    await Promise.all(
      files.map(async (f) => {
        const shaPath = f.oldPath || f.path;
        const sha = indexShaByPath.get(shaPath);
        if (sha) (f as any).indexSha = sha;

        if (!isValidRelativePath(f.path)) return;
        const abs = safeResolveUnderRoot({ root: ws.path, rel: f.path });
        if (!abs) return;
        try {
          const st = await fs.stat(abs);
          (f as any).worktreeMtimeMs = Math.trunc(st.mtimeMs);
          (f as any).worktreeSize = st.size;
        } catch {
          // 文件可能已被删除/移动，忽略即可
        }
      })
    );
  } else {
    for (const f of files) {
      if (!isValidRelativePath(f.path)) continue;
      const sha = indexShaByPath.get(f.path);
      if (sha) (f as any).indexSha = sha;
    }
  }

  return { mode, files };
}

export async function fileCompare(
  ctx: AppContext,
  workspaceId: string,
  modeRaw: unknown,
  filePathRaw: unknown,
  oldPathRaw?: unknown
): Promise<FileCompareResponse> {
  const mode = parseMode(modeRaw);
  const filePath = typeof filePathRaw === "string" ? filePathRaw : "";
  const oldPath = typeof oldPathRaw === "string" ? oldPathRaw : "";

  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");

  if (!isSafePathInWorkspace({ wsPath: ws.path, rel: filePath })) {
    throw new HttpError(400, "Invalid path");
  }
  if (oldPath && !isSafePathInWorkspace({ wsPath: ws.path, rel: oldPath })) {
    throw new HttpError(400, "Invalid oldPath");
  }

  if (mode === "staged") {
    const basePath = oldPath || filePath;
    const baseRead = await gitCatFileText({ cwd: ws.path, object: `HEAD:${basePath}`, maxBytes: ctx.fileMaxBytes });
    const indexSha = await gitIndexBlobSha({ cwd: ws.path, filePath });
    const currentRead =
      indexSha.kind === "missing"
        ? ({ kind: "missing", bytes: 0, content: "" } as const)
        : await gitCatFileText({ cwd: ws.path, object: indexSha.sha, maxBytes: ctx.fileMaxBytes });

    return {
      mode,
      path: filePath,
      base: toSide({ label: baseRead.kind === "missing" ? "EMPTY" : "HEAD", path: basePath, read: baseRead }),
      current: toSide({ label: currentRead.kind === "missing" ? "EMPTY" : "INDEX", path: filePath, read: currentRead }),
      language: inferLanguage(filePath)
    };
  }

  const basePath = oldPath || filePath;
  const baseSha = await gitIndexBlobSha({ cwd: ws.path, filePath: basePath });
  const baseRead =
    baseSha.kind === "missing"
      ? ({ kind: "missing", bytes: 0, content: "" } as const)
      : await gitCatFileText({ cwd: ws.path, object: baseSha.sha, maxBytes: ctx.fileMaxBytes });

  const absPath = safeResolveUnderRoot({ root: ws.path, rel: filePath });
  if (!absPath) throw new HttpError(400, "Invalid path");
  const currentRead = await readWorktreeText({ wsRoot: ws.path, absPath, maxBytes: ctx.fileMaxBytes });

  return {
    mode,
    path: filePath,
    base: toSide({ label: baseRead.kind === "missing" ? "EMPTY" : "INDEX", path: basePath, read: baseRead }),
    current: toSide({ label: currentRead.kind === "missing" ? "EMPTY" : "WORKTREE", path: filePath, read: currentRead }),
    language: inferLanguage(filePath)
  };
}

async function getWorkspaceAndRepoOrThrow(ctx: AppContext, workspaceId: string) {
  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");
  const repo = getRepo(ctx.db, ws.repoId);
  if (!repo) throw new HttpError(404, "Repo not found");
  if (repo.syncStatus === "syncing") throw new HttpError(409, "Repo is syncing");
  if (repo.syncStatus === "failed") throw new HttpError(409, "Repo sync failed. Retry sync first.");
  return { ws, repo };
}

async function hasHeadCommit(params: { wsPath: string; dataDir: string }) {
  const res = await runGit(["-C", params.wsPath, "rev-parse", "--verify", "HEAD"], { cwd: params.dataDir });
  return res.ok;
}

async function listStagedPaths(params: { wsPath: string; dataDir: string }) {
  const res = await runGit(["-C", params.wsPath, "diff", "--cached", "--name-only", "-z"], { cwd: params.dataDir });
  if (!res.ok) return new Set<string>();
  const parts = res.stdout.split("\0").filter(Boolean);
  return new Set(parts);
}

async function listIndexTrackedPaths(params: { wsPath: string; dataDir: string; paths: string[] }) {
  const safePaths = params.paths.filter((p) => isSafePathInWorkspace({ wsPath: params.wsPath, rel: p }));
  if (safePaths.length === 0) return new Set<string>();
  const res = await runGit(["-C", params.wsPath, "ls-files", "-z", "--", ...safePaths], { cwd: params.dataDir });
  if (!res.ok) return new Set<string>();
  const parts = res.stdout.split("\0").filter(Boolean);
  return new Set(parts);
}

function collectPathspecs(params: { wsPath: string; items: { path: string; oldPath?: string }[] }) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of params.items) {
    const p = typeof it.path === "string" ? it.path : "";
    const op = typeof it.oldPath === "string" ? it.oldPath : "";
    for (const v of [p, op]) {
      if (!v) continue;
      if (!isSafePathInWorkspace({ wsPath: params.wsPath, rel: v })) {
        throw new HttpError(400, "Invalid path");
      }
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export async function stageWorkspace(ctx: AppContext, workspaceId: string, bodyRaw: unknown): Promise<void> {
  const body = (bodyRaw ?? {}) as GitStageRequest;
  const { ws, repo } = await getWorkspaceAndRepoOrThrow(ctx, workspaceId);

  await withRepoLock(repo.id, async () => {
    const all = parseGitBool((body as any).all);
    const items = Array.isArray((body as any).items) ? ((body as any).items as any[]) : [];

    if (all) {
      const res = await runGit(["-C", ws.path, "add", "-A"], { cwd: ctx.dataDir });
      if (!res.ok) throw new HttpError(409, `Failed to stage changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
      return;
    }

    if (items.length > 0) {
      const paths = collectPathspecs({ wsPath: ws.path, items });
      if (paths.length === 0) return;
      const res = await runGit(["-C", ws.path, "add", "-A", "--", ...paths], { cwd: ctx.dataDir });
      if (!res.ok) throw new HttpError(409, `Failed to stage changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
      return;
    }

    throw new HttpError(400, "Either all or items must be provided");
  });
}

export async function unstageWorkspace(ctx: AppContext, workspaceId: string, bodyRaw: unknown): Promise<void> {
  const body = (bodyRaw ?? {}) as GitUnstageRequest;
  const { ws, repo } = await getWorkspaceAndRepoOrThrow(ctx, workspaceId);

  await withRepoLock(repo.id, async () => {
    const all = parseGitBool((body as any).all);
    const items = Array.isArray((body as any).items) ? ((body as any).items as any[]) : [];

    const stagedSet = await listStagedPaths({ wsPath: ws.path, dataDir: ctx.dataDir });
    if (stagedSet.size === 0) return;

    const headExists = await hasHeadCommit({ wsPath: ws.path, dataDir: ctx.dataDir });

    if (all) {
      if (headExists) {
        const res = await runGit(["-C", ws.path, "reset", "-q", "HEAD"], { cwd: ctx.dataDir });
        if (!res.ok) throw new HttpError(409, `Failed to unstage changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
        return;
      }
      const res = await runGit(["-C", ws.path, "rm", "-r", "--cached", "--", "."], { cwd: ctx.dataDir });
      if (!res.ok) throw new HttpError(409, `Failed to unstage changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
      return;
    }

    if (items.length > 0) {
      const requested = collectPathspecs({ wsPath: ws.path, items });
      const toUnstage = requested.filter((p) => stagedSet.has(p));
      if (toUnstage.length === 0) return;

      if (headExists) {
        const res = await runGit(["-C", ws.path, "reset", "-q", "HEAD", "--", ...toUnstage], { cwd: ctx.dataDir });
        if (!res.ok) throw new HttpError(409, `Failed to unstage changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
        return;
      }

      const res = await runGit(["-C", ws.path, "rm", "-r", "--cached", "--ignore-unmatch", "--", ...toUnstage], { cwd: ctx.dataDir });
      if (!res.ok) throw new HttpError(409, `Failed to unstage changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
      return;
    }

    throw new HttpError(400, "Either all or items must be provided");
  });
}

export async function discardWorkspace(ctx: AppContext, workspaceId: string, bodyRaw: unknown): Promise<void> {
  const body = (bodyRaw ?? {}) as GitDiscardRequest;
  const { ws, repo } = await getWorkspaceAndRepoOrThrow(ctx, workspaceId);

  await withRepoLock(repo.id, async () => {
    const all = parseGitBool((body as any).all);
    const items = Array.isArray((body as any).items) ? ((body as any).items as any[]) : [];
    const includeUntracked = parseGitBool((body as any).includeUntracked);

    if (all) {
      if (includeUntracked) {
        const cleanRes = await runGit(["-C", ws.path, "clean", "-fd"], { cwd: ctx.dataDir });
        if (!cleanRes.ok) throw new HttpError(409, `Failed to clean untracked files: ${truncateGitOutput(cleanRes.stderr || cleanRes.stdout)}`);
      }

      const res = await runGit(["-C", ws.path, "checkout", "--", "."], { cwd: ctx.dataDir });
      if (!res.ok) {
        const out = truncateGitOutput(res.stderr || res.stdout);
        if (!includeUntracked && isOverwrittenByCheckoutError(out)) {
          throw new HttpError(409, "Failed to discard changes: untracked files would be overwritten. Retry with includeUntracked=true.");
        }
        throw new HttpError(409, `Failed to discard changes: ${out}`);
      }
      return;
    }

    if (items.length > 0) {
      const paths = collectPathspecs({ wsPath: ws.path, items });
      if (paths.length === 0) return;

      const trackedSet = await listIndexTrackedPaths({ wsPath: ws.path, dataDir: ctx.dataDir, paths });
      const toRestore = paths.filter((p) => trackedSet.has(p));
      const toClean = paths.filter((p) => !trackedSet.has(p));

      if (toClean.length > 0) {
        const cleanRes = await runGit(["-C", ws.path, "clean", "-f", "-d", "--", ...toClean], { cwd: ctx.dataDir });
        if (!cleanRes.ok) throw new HttpError(409, `Failed to delete untracked files: ${truncateGitOutput(cleanRes.stderr || cleanRes.stdout)}`);
      }

      if (toRestore.length > 0) {
        const res = await runGit(["-C", ws.path, "checkout", "--", ...toRestore], { cwd: ctx.dataDir });
        if (!res.ok) throw new HttpError(409, `Failed to discard changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
      }

      return;
    }

    throw new HttpError(400, "Either all or items must be provided");
  });
}

function parseGitIdentityScope(raw: unknown): GitIdentityScope | null {
  if (raw === "session" || raw === "repo" || raw === "global") return raw;
  return null;
}

function parseGitIdentityInput(raw: unknown): GitIdentityInput | null {
  const obj = (raw ?? {}) as any;
  const scope = parseGitIdentityScope(obj.scope);
  if (!scope) return null;
  const v = validateAndNormalizeGitIdentity(obj);
  if (!v) return null;
  return { scope, ...v };
}

async function setRepoGitIdentity(ctx: AppContext, repoPath: string, identity: { name: string; email: string }) {
  const okName = await gitConfigSet({ cwd: ctx.dataDir, repoPath, key: "user.name", value: identity.name });
  const okEmail = await gitConfigSet({ cwd: ctx.dataDir, repoPath, key: "user.email", value: identity.email });
  return okName && okEmail;
}

async function setGlobalGitIdentity(ctx: AppContext, identity: { name: string; email: string }) {
  const okName = await gitConfigSet({ cwd: ctx.dataDir, global: true, key: "user.name", value: identity.name });
  const okEmail = await gitConfigSet({ cwd: ctx.dataDir, global: true, key: "user.email", value: identity.email });
  return okName && okEmail;
}

export async function getWorkspaceGitIdentity(ctx: AppContext, workspaceId: string): Promise<GitIdentityStatus> {
  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");

  const [repoName, repoEmail, globalName, globalEmail] = await Promise.all([
    gitConfigGet({ cwd: ctx.dataDir, repoPath: ws.path, key: "user.name" }),
    gitConfigGet({ cwd: ctx.dataDir, repoPath: ws.path, key: "user.email" }),
    gitConfigGet({ cwd: ctx.dataDir, global: true, key: "user.name" }),
    gitConfigGet({ cwd: ctx.dataDir, global: true, key: "user.email" })
  ]);

  const repo = { name: repoName, email: repoEmail };
  const global = { name: globalName, email: globalEmail };
  const repoOk = Boolean(repo.name && repo.email);
  const globalOk = Boolean(global.name && global.email);
  const effective = repoOk
    ? { ...repo, source: "repo" as const }
    : globalOk
      ? { ...global, source: "global" as const }
      : { name: null, email: null, source: "none" as const };

  return { effective, repo: { name: repo.name, email: repo.email }, global: { name: global.name, email: global.email } };
}

export async function setWorkspaceGitIdentity(ctx: AppContext, workspaceId: string, bodyRaw: unknown) {
  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");

  const v = validateAndNormalizeGitIdentity(bodyRaw);
  if (!v) throw new HttpError(400, "Invalid identity. Expected {name,email}.", "GIT_IDENTITY_INVALID");

  const ok = await setRepoGitIdentity(ctx, ws.path, v);
  if (!ok) throw new HttpError(409, "Failed to set repo git identity.", "GIT_IDENTITY_SET_FAILED");
}

export async function commitWorkspace(ctx: AppContext, workspaceId: string, bodyRaw: unknown): Promise<GitCommitResponse> {
  const body = (bodyRaw ?? {}) as any;
  const { ws, repo } = await getWorkspaceAndRepoOrThrow(ctx, workspaceId);

  return withRepoLock(repo.id, async () => {
    const message = normalizeGitMessage(body.message);
    if (!message) throw new HttpError(400, "message is required");

    const identity = body.identity !== undefined ? parseGitIdentityInput(body.identity) : null;
    if (body.identity !== undefined && !identity) {
      throw new HttpError(400, "Invalid identity. Expected {scope,name,email}.", "GIT_IDENTITY_INVALID");
    }

    if (identity?.scope === "repo") {
      const ok = await setRepoGitIdentity(ctx, ws.path, identity);
      if (!ok) throw new HttpError(409, "Failed to set repo git identity.", "GIT_IDENTITY_SET_FAILED");
    }
    if (identity?.scope === "global") {
      const ok = await setGlobalGitIdentity(ctx, identity);
      if (!ok) throw new HttpError(409, "Failed to set global git identity.", "GIT_IDENTITY_SET_FAILED");
    }

    const args = ["-C", ws.path, "commit", "-m", message];
    if (parseGitBool(body.amend)) args.push("--amend");
    if (parseGitBool(body.signoff)) args.push("--signoff");
    if (parseGitBool(body.noVerify)) args.push("--no-verify");
    if (parseGitBool(body.allowEmpty)) args.push("--allow-empty");

    const env: NodeJS.ProcessEnv | undefined =
      identity?.scope === "session"
        ? {
            GIT_AUTHOR_NAME: identity.name,
            GIT_AUTHOR_EMAIL: identity.email,
            GIT_COMMITTER_NAME: identity.name,
            GIT_COMMITTER_EMAIL: identity.email
          }
        : undefined;

    const res = await runGit(args, { cwd: ctx.dataDir, env });
    if (!res.ok) {
      const out = truncateGitOutput(res.stderr || res.stdout);
      const lower = out.toLowerCase();
      if (lower.includes("nothing to commit")) {
        throw new HttpError(409, "Nothing to commit", "GIT_NOTHING_TO_COMMIT");
      }
      if (lower.includes("please tell me who you are") || lower.includes("unable to auto-detect email address")) {
        throw new HttpError(409, "Git identity is not configured. Set user.name and user.email.", "GIT_IDENTITY_REQUIRED");
      }
      throw new HttpError(409, `Commit failed: ${out}`);
    }

    const shaRes = await runGit(["-C", ws.path, "rev-parse", "HEAD"], { cwd: ctx.dataDir });
    const sha = shaRes.ok ? shaRes.stdout.trim() : "";
    const branchRes = await runGit(["-C", ws.path, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.dataDir });
    const branch = branchRes.ok ? branchRes.stdout.trim() : "";
    return { sha, branch };
  });
}

export async function pushWorkspace(ctx: AppContext, workspaceId: string, bodyRaw: unknown): Promise<GitPushResponse> {
  const body = (bodyRaw ?? {}) as any;
  const { ws, repo } = await getWorkspaceAndRepoOrThrow(ctx, workspaceId);

  return withRepoLock(repo.id, async () => {
    const gitEnv = await buildGitEnv({ ctx, repoUrl: repo.url, credentialId: repo.credentialId });
    const remote = normalizeGitRefLike(body.remote) || "origin";
    const branchRaw = normalizeGitRefLike(body.branch);
    const setUpstream = parseGitBool(body.setUpstream);

    try {
      const branchRes = await runGit(["-C", ws.path, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.dataDir, env: gitEnv.env });
    const currentBranch = branchRes.ok ? branchRes.stdout.trim() : "";
    const targetBranch = branchRaw || (currentBranch && currentBranch !== "HEAD" ? currentBranch : "");
    if (!targetBranch) throw new HttpError(409, "Detached HEAD. Specify a branch to push.", "GIT_DETACHED_HEAD");

    if (!branchRaw && !setUpstream) {
      const upstreamRes = await runGit(["-C", ws.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: ctx.dataDir, env: gitEnv.env });
      if (!upstreamRes.ok) {
        throw new HttpError(409, "No upstream configured. Specify branch or use setUpstream=true.", "GIT_NO_UPSTREAM");
      }
    }

    const args = ["-C", ws.path, "push"];
    if (parseGitBool(body.dryRun)) args.push("--dry-run");
    if (parseGitBool(body.tags)) args.push("--tags");
    if (parseGitBool(body.forceWithLease)) args.push("--force-with-lease");
    if (setUpstream) args.push("-u");
    args.push(remote);

    if (branchRaw) {
      args.push(`HEAD:${targetBranch}`);
    } else if (setUpstream && currentBranch && currentBranch !== "HEAD") {
      args.push(currentBranch);
    }

    const res = await runGit(args, { cwd: ctx.dataDir, env: gitEnv.env });
    if (!res.ok) {
      const out = truncateGitOutput(res.stderr || res.stdout);
      if (isAuthOrInteractionError(out)) {
        throw new HttpError(
          409,
          "Push auth failed. Configure credentials in Settings/Credentials and bind to the repo, then retry. If SSH host fingerprint changed, reset trust in Settings/Security.",
          "GIT_AUTH_REQUIRED"
        );
      }
      if (isNonFastForwardError(out)) {
        throw new HttpError(409, "Push rejected (non-fast-forward). Retry with force-with-lease.", "GIT_NON_FAST_FORWARD");
      }
      throw new HttpError(409, `Push failed: ${out}`);
    }

    return { remote, branch: targetBranch };
    } finally {
      await gitEnv.cleanup();
    }
  });
}

export async function pullWorkspace(ctx: AppContext, workspaceId: string, bodyRaw: unknown): Promise<GitPullResponse> {
  const _body = (bodyRaw ?? {}) as any;
  const { ws, repo } = await getWorkspaceAndRepoOrThrow(ctx, workspaceId);

  return withRepoLock(repo.id, async () => {
    const gitEnv = await buildGitEnv({ ctx, repoUrl: repo.url, credentialId: repo.credentialId });
    try {
      const branchRes = await runGit(["-C", ws.path, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.dataDir, env: gitEnv.env });
      const currentBranch = branchRes.ok ? branchRes.stdout.trim() : "";
      if (!currentBranch || currentBranch === "HEAD") {
        throw new HttpError(409, "Detached HEAD. Switch to a branch to pull.", "GIT_DETACHED_HEAD");
      }

      const upstreamRes = await runGit(["-C", ws.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: ctx.dataDir, env: gitEnv.env });
      if (!upstreamRes.ok) {
        throw new HttpError(409, "No upstream configured. Set upstream then retry pull.", "GIT_NO_UPSTREAM");
      }

      const beforeRes = await runGit(["-C", ws.path, "rev-parse", "HEAD"], { cwd: ctx.dataDir, env: gitEnv.env });
      const beforeSha = beforeRes.ok ? beforeRes.stdout.trim() : "";

      const res = await runGit(["-C", ws.path, "pull", "--ff-only"], { cwd: ctx.dataDir, env: gitEnv.env });
      if (!res.ok) {
      const out = truncateGitOutput(res.stderr || res.stdout);
      if (isAuthOrInteractionError(out)) {
        throw new HttpError(
          409,
          "Pull auth failed. Configure credentials in Settings/Credentials and bind to the repo, then retry. If SSH host fingerprint changed, reset trust in Settings/Security.",
          "GIT_AUTH_REQUIRED"
        );
      }
        if (isPullNotFastForwardError(out)) {
          throw new HttpError(409, "Pull failed (not fast-forward). Rebase/merge in terminal and retry.", "GIT_PULL_NOT_FAST_FORWARD");
        }
        throw new HttpError(409, `Pull failed: ${out}`);
      }

      const afterRes = await runGit(["-C", ws.path, "rev-parse", "HEAD"], { cwd: ctx.dataDir, env: gitEnv.env });
      const afterSha = afterRes.ok ? afterRes.stdout.trim() : "";
      const updated = Boolean(beforeSha && afterSha && beforeSha !== afterSha);
      return { branch: currentBranch, updated, beforeSha, afterSha };
    } finally {
      await gitEnv.cleanup();
    }
  });
}
