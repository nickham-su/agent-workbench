import path from "node:path";
import { TextDecoder } from "node:util";
import type {
  ChangesResponse,
  ChangeMode,
  FileCompareResponse,
  GitBranchesRequest,
  GitBranchesResponse,
  GitCheckoutRequest,
  GitCheckoutResponse,
  GitChangesRequest,
  GitCommitResponse,
  GitDiscardRequest,
  GitIdentityInput,
  GitIdentityScope,
  GitIdentityStatus,
  GitStatusResponse,
  WorkspaceGitStatusRequest,
  WorkspaceGitStatusResponse,
  GitTarget,
  GitPullResponse,
  GitPushResponse,
  GitStageRequest,
  GitUnstageRequest
} from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { getWorkspace, getWorkspaceRepoByDirName, listWorkspaceRepos } from "../workspaces/workspace.store.js";
import { getRepo } from "../repos/repo.store.js";
import { runGit as execGit, runGitBuffer as execGitBuffer } from "../../infra/git/gitExec.js";
import { assertWorkspaceRepoSafe } from "./git-target.js";
import { readRepositoryStatus, readUpstreamStatus, statusChanges, worktreeGitArgs, STATUS_TIMEOUT_MS } from "./git-status.js";
import { buildGitEnv } from "../../infra/git/gitEnv.js";
import { gitConfigGet, gitConfigSet, validateAndNormalizeGitIdentity } from "../../infra/git/gitIdentity.js";
import { getOriginDefaultBranchFromRepo, listOriginBranchesFromRepo } from "../../infra/git/refs.js";
import { withWorkspaceRepoLock } from "../../infra/locks/workspaceRepoLock.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";

// All worktree commands are pinned even when core.worktree is set in repository config.
function pinnedWorktreeArgs(args: string[]) {
  return args[0] === "-C" && args[1] ? worktreeGitArgs(args[1], args.slice(2)) : args;
}
function runGit(args: string[], opts: Parameters<typeof execGit>[1]) {
  return execGit(pinnedWorktreeArgs(args), opts);
}
function runGitBuffer(args: string[], opts: Parameters<typeof execGitBuffer>[1]) {
  return execGitBuffer(pinnedWorktreeArgs(args), opts);
}

function parseMode(modeRaw: unknown): ChangeMode {
  if (modeRaw === "staged" || modeRaw === "unstaged") return modeRaw;
  throw new HttpError(400, 'Invalid mode. Expected "staged" or "unstaged".');
}

function parseTarget(targetRaw: unknown): GitTarget {
  const target = (targetRaw ?? {}) as any;
  if (target?.kind !== "workspaceRepo") throw new HttpError(400, "Invalid target");
  const workspaceId = typeof target.workspaceId === "string" ? target.workspaceId.trim() : "";
  const dirName = typeof target.dirName === "string" ? target.dirName.trim() : "";
  if (!workspaceId || !dirName) throw new HttpError(400, "Invalid target");
  return { kind: "workspaceRepo", workspaceId, dirName };
}

function parseBool(raw: unknown) {
  return raw === "1" || raw === "true" || raw === "yes";
}

function isValidRelativePath(filePath: string) {
  if (!filePath) return false;
  if (path.isAbsolute(filePath)) return false;
  if (filePath.includes("\0")) return false;
  const parts = process.platform === "win32" ? filePath.split(/[\\/]+/g) : filePath.split(/\/+/g);
  if (parts.some((p) => p === "..")) return false;
  return true;
}

function safeResolveUnderRoot(params: { root: string; rel: string }) {
  const rootAbs = path.resolve(params.root);
  const abs = path.resolve(params.root, params.rel);
  if (!abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

function isSafePathInRepo(params: { repoPath: string; rel: string }) {
  if (!isValidRelativePath(params.rel)) return false;
  return safeResolveUnderRoot({ root: params.repoPath, rel: params.rel }) !== null;
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
    throw new HttpError(500, "Failed to read working tree file", "GIT_COMPARE_FAILED");
  }
}

function compareReadFailed(): never {
  throw new HttpError(500, "Failed to read repository file comparison", "GIT_COMPARE_FAILED");
}

async function gitCatFileText(params: { cwd: string; object: string; maxBytes: number }): Promise<ReadTextResult> {
  // Entry lookup has already proved the object exists. Any subsequent Git failure is not a missing file.
  const options = { cwd: params.cwd, timeoutMs: STATUS_TIMEOUT_MS, maxOutputBytes: 8192 };
  const type = await runGit(["-C", params.cwd, "cat-file", "-t", params.object], options);
  if (!type.ok) compareReadFailed();
  if (["tree", "commit", "tag"].includes(type.stdout.trim())) return { kind: "not_previewable", reason: "unsafe_path", bytes: 0 };
  if (type.stdout.trim() !== "blob") compareReadFailed();
  const size = await runGit(["-C", params.cwd, "cat-file", "-s", params.object], options);
  const bytes = Number(size.stdout.trim());
  if (!size.ok || !/^\d+$/.test(size.stdout.trim()) || !Number.isSafeInteger(bytes)) compareReadFailed();
  if (bytes > params.maxBytes) return { kind: "not_previewable", reason: "too_large", bytes };
  const res = await runGitBuffer(["-C", params.cwd, "cat-file", "-p", params.object], { ...options, maxOutputBytes: params.maxBytes + 8192 });
  if (!res.ok) compareReadFailed();
  return readBufferAsText(res.stdout, params.maxBytes);
}

/** Normal HEAD resolves in one command; only a verified absent symbolic ref is unborn. */
async function resolveHeadCommit(params: { wsPath: string; dataDir: string }): Promise<string | null> {
  const options = { cwd: params.dataDir, timeoutMs: STATUS_TIMEOUT_MS, maxOutputBytes: 8192 };
  const head = await runGit(["-C", params.wsPath, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], options);
  if (head.ok && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head.stdout.trim())) return head.stdout.trim();
  if (head.ok || head.failure || head.code !== 1) compareReadFailed();
  const symbolic = await runGit(["-C", params.wsPath, "symbolic-ref", "--quiet", "HEAD"], options);
  const ref = symbolic.stdout.trim();
  if (!symbolic.ok || !ref.startsWith("refs/") || /[\0\r\n]/.test(ref)) compareReadFailed();
  const exists = await runGit(["-C", params.wsPath, "show-ref", "--verify", "--quiet", ref], options);
  if (!exists.ok && exists.code === 1 && !exists.failure) return null;
  // An existing but unreadable/non-commit HEAD is corrupt, not an empty repository.
  compareReadFailed();
}

type GitEntry = { kind: "missing" } | { kind: "ok"; sha: string; blob: boolean };

async function gitIndexEntry(params: { cwd: string; filePath: string }): Promise<GitEntry> {
  const res = await runGit(["-C", params.cwd, "--literal-pathspecs", "ls-files", "-s", "-z", "--", params.filePath], {
    cwd: params.cwd, timeoutMs: STATUS_TIMEOUT_MS, maxOutputBytes: 65536
  });
  if (!res.ok || (res.stdout && !res.stdout.endsWith("\0"))) compareReadFailed();
  let first: GitEntry = { kind: "missing" };
  for (const record of res.stdout.split("\0")) {
    const entry = record.match(/^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/);
    if (!record) continue;
    if (!entry) compareReadFailed();
    if (entry[4] !== params.filePath) continue;
    const value = { kind: "ok" as const, sha: entry[2]!, blob: entry[1] === "100644" || entry[1] === "100755" || entry[1] === "120000" };
    if (entry[3] === "0") return value;
    if (first.kind === "missing") first = value;
  }
  return first;
}

async function gitHeadEntry(params: { cwd: string; filePath: string }): Promise<GitEntry> {
  const head = await resolveHeadCommit({ wsPath: params.cwd, dataDir: params.cwd });
  if (!head) return { kind: "missing" };
  const res = await runGit(["-C", params.cwd, "--literal-pathspecs", "ls-tree", "--full-name", "-z", head, "--", params.filePath], {
    cwd: params.cwd, timeoutMs: STATUS_TIMEOUT_MS, maxOutputBytes: 65536
  });
  if (!res.ok || (res.stdout && !res.stdout.endsWith("\0"))) compareReadFailed();
  for (const record of res.stdout.split("\0")) {
    const entry = record.match(/^(\d{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/);
    if (!record) continue;
    if (!entry) compareReadFailed();
    if (entry[4] === params.filePath) return { kind: "ok", sha: entry[3]!, blob: entry[2] === "blob" };
  }
  return { kind: "missing" };
}

async function gitIndexBlobShaBatch(params: { cwd: string; filePaths: string[] }) {
  const out = new Map<string, string>();
  const filePaths = params.filePaths.filter(isValidRelativePath);
  if (filePaths.length === 0) return out;

  const res = await runGit(["-C", params.cwd, "--literal-pathspecs", "ls-files", "-s", "-z", "--", ...filePaths], { cwd: params.cwd });
  if (!res.ok) throw new HttpError(500, "Failed to inspect repository index", "GIT_CHANGES_FAILED");

  const entries = res.stdout.split("\0").filter((e) => e.length > 0);
  for (const entry of entries) {
    const m = entry.match(/^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/);
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

export async function listChanges(ctx: AppContext, bodyRaw: unknown): Promise<ChangesResponse> {
  const body = (bodyRaw ?? {}) as GitChangesRequest;
  const mode = parseMode((body as any).mode);
  const { wsRepo } = await getTargetInfoOrThrow(ctx, (body as any).target);
  const repoPath = wsRepo.path;

  const status = await readRepositoryStatus({ repoPath, cwd: ctx.dataDir, untrackedFiles: "all" }).catch(() => {
    throw new HttpError(500, "Failed to read repository changes", "GIT_CHANGES_FAILED");
  });
  // Use the same authoritative status records as the summary, including submodule dirtiness
  // and nested repositories. Directory entries remain explicitly non-text items.
  const files = statusChanges(status, mode);

  const shaPaths = Array.from(
    new Set(
      files
        .map((f) => (mode === "unstaged" ? f.oldPath || f.path : f.path))
        .filter((p): p is string => typeof p === "string" && p.length > 0)
    )
  );
  const indexShaByPath = await gitIndexBlobShaBatch({ cwd: repoPath, filePaths: shaPaths });

  if (mode === "unstaged") {
    const fs = await import("node:fs/promises");
    await Promise.all(
      files.map(async (f) => {
        const shaPath = f.oldPath || f.path;
        const sha = indexShaByPath.get(shaPath);
        if (sha) (f as any).indexSha = sha;

        if (!isValidRelativePath(f.path)) return;
        const abs = safeResolveUnderRoot({ root: repoPath, rel: f.path });
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

export async function fileCompare(ctx: AppContext, bodyRaw: unknown): Promise<FileCompareResponse> {
  const body = (bodyRaw ?? {}) as any;
  const mode = parseMode(body.mode);
  const filePath = typeof body.path === "string" ? body.path : "";
  const oldPath = typeof body.oldPath === "string" ? body.oldPath : "";
  const { wsRepo } = await getTargetInfoOrThrow(ctx, body.target);
  const repoPath = wsRepo.path;

  if (!isSafePathInRepo({ repoPath, rel: filePath })) {
    throw new HttpError(400, "Invalid path");
  }
  if (oldPath && !isSafePathInRepo({ repoPath, rel: oldPath })) {
    throw new HttpError(400, "Invalid oldPath");
  }

  const nonTextCompare = (): FileCompareResponse => {
    const side = { label: "NON_TEXT", path: filePath, previewable: false, reason: "unsafe_path" as const, bytes: 0 };
    return { mode, path: filePath, base: side, current: side };
  };
  const basePath = oldPath || filePath;
  if (mode === "staged") {
    const [head, index] = await Promise.all([
      gitHeadEntry({ cwd: repoPath, filePath: basePath }),
      gitIndexEntry({ cwd: repoPath, filePath })
    ]);
    if ((head.kind === "ok" && !head.blob) || (index.kind === "ok" && !index.blob)) return nonTextCompare();
    const baseRead = head.kind === "missing"
      ? ({ kind: "missing", bytes: 0, content: "" } as const)
      : await gitCatFileText({ cwd: repoPath, object: head.sha, maxBytes: ctx.fileMaxBytes });
    const currentRead = index.kind === "missing"
      ? ({ kind: "missing", bytes: 0, content: "" } as const)
      : await gitCatFileText({ cwd: repoPath, object: index.sha, maxBytes: ctx.fileMaxBytes });
    return {
      mode,
      path: filePath,
      base: toSide({ label: baseRead.kind === "missing" ? "EMPTY" : "HEAD", path: basePath, read: baseRead }),
      current: toSide({ label: currentRead.kind === "missing" ? "EMPTY" : "INDEX", path: filePath, read: currentRead }),
      language: inferLanguage(filePath)
    };
  }

  const fs = await import("node:fs/promises");
  const stat = await fs.lstat(path.join(repoPath, filePath)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    compareReadFailed();
  });
  if (stat?.isDirectory()) return nonTextCompare();
  const base = await gitIndexEntry({ cwd: repoPath, filePath: basePath });
  if (base.kind === "ok" && !base.blob) return nonTextCompare();
  if (base.kind === "missing" && !stat) {
    const head = await gitHeadEntry({ cwd: repoPath, filePath: basePath });
    if (head.kind === "ok" && !head.blob) return nonTextCompare();
  }
  const baseRead = base.kind === "missing"
    ? ({ kind: "missing", bytes: 0, content: "" } as const)
    : await gitCatFileText({ cwd: repoPath, object: base.sha, maxBytes: ctx.fileMaxBytes });

  const absPath = safeResolveUnderRoot({ root: repoPath, rel: filePath });
  if (!absPath) throw new HttpError(400, "Invalid path");
  const currentRead = await readWorktreeText({ wsRoot: repoPath, absPath, maxBytes: ctx.fileMaxBytes });

  return {
    mode,
    path: filePath,
    base: toSide({ label: baseRead.kind === "missing" ? "EMPTY" : "INDEX", path: basePath, read: baseRead }),
    current: toSide({ label: currentRead.kind === "missing" ? "EMPTY" : "WORKTREE", path: filePath, read: currentRead }),
    language: inferLanguage(filePath)
  };
}

export async function gitCheckout(ctx: AppContext, bodyRaw: unknown): Promise<GitCheckoutResponse> {
  const body = (bodyRaw ?? {}) as GitCheckoutRequest;
  const target = parseTarget((body as any).target);
  const branch = normalizeGitRefLike((body as any).branch);
  if (!branch) throw new HttpError(400, "branch is required");
  return workspaceLifecycleCoordinator.withMutation(target.workspaceId, () =>
    withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo, repo } = await getTargetInfoOrThrow(ctx, target);

    const res = await runGit(["-C", wsRepo.path, "switch", branch], { cwd: ctx.dataDir });
    if (res.ok) return { branch };

    const out = truncateGitOutput(res.stderr || res.stdout);
    if (isOverwrittenByCheckoutError(out)) {
      throw new HttpError(409, out, "GIT_OVERWRITE_REQUIRED");
    }

    // 兜底：本地可能还没有 origin/<branch> 远端跟踪分支引用，先 fetch 再尝试创建跟踪分支。
    const gitEnv = await buildGitEnv({ ctx, repoUrl: repo.url, credentialId: repo.credentialId });
    try {
      const fetchRes = await runGit(["-C", wsRepo.path, "fetch", "--prune", "origin"], { cwd: ctx.dataDir, env: gitEnv.env });
      if (!fetchRes.ok) {
        const fetchOut = truncateGitOutput(fetchRes.stderr || fetchRes.stdout);
        if (isAuthOrInteractionError(fetchOut)) {
          throw new HttpError(
            409,
            "Fetch auth failed. Configure credentials in Settings/Credentials and bind to the repo, then retry. If SSH host fingerprint changed, reset trust in Settings/Security.",
            "GIT_AUTH_REQUIRED"
          );
        }
        throw new HttpError(409, `Fetch failed: ${fetchOut}`);
      }
    } finally {
      await gitEnv.cleanup();
    }

    const remoteRef = `origin/${branch}`;
    const create = await runGit(["-C", wsRepo.path, "switch", "-c", branch, "--track", remoteRef], { cwd: ctx.dataDir });
    if (!create.ok) {
      throw new HttpError(409, `Checkout failed: ${(create.stderr || create.stdout || out).trim().replace(/\\s+/g, " ")}`);
    }
    return { branch };
    })
  );
}

export async function gitBranches(ctx: AppContext, bodyRaw: unknown): Promise<GitBranchesResponse> {
  const body = (bodyRaw ?? {}) as GitBranchesRequest;
  const target = parseTarget((body as any).target);
  const fetch = Boolean((body as any).fetch);
  return withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo, repo } = await getTargetInfoOrThrow(ctx, target);

    if (fetch) {
      const gitEnv = await buildGitEnv({ ctx, repoUrl: repo.url, credentialId: repo.credentialId });
      try {
        const fetchRes = await runGit(["-C", wsRepo.path, "fetch", "--prune", "origin"], { cwd: ctx.dataDir, env: gitEnv.env });
        if (!fetchRes.ok) {
          const fetchOut = truncateGitOutput(fetchRes.stderr || fetchRes.stdout);
          if (isAuthOrInteractionError(fetchOut)) {
            throw new HttpError(
              409,
              "Fetch auth failed. Configure credentials in Settings/Credentials and bind to the repo, then retry. If SSH host fingerprint changed, reset trust in Settings/Security.",
              "GIT_AUTH_REQUIRED"
            );
          }
          throw new HttpError(409, `Fetch failed: ${fetchOut}`);
        }

        // 尽量设置 origin/HEAD 以便解析默认分支；失败则降级为 null。
        await runGit(["-C", wsRepo.path, "remote", "set-head", "origin", "-a"], { cwd: ctx.dataDir, env: gitEnv.env });
      } finally {
        await gitEnv.cleanup();
      }
    }

    try {
      const branches = await listOriginBranchesFromRepo({ repoPath: wsRepo.path, cwd: ctx.dataDir });
      const defaultBranch = await getOriginDefaultBranchFromRepo({ repoPath: wsRepo.path, cwd: ctx.dataDir });
      return { defaultBranch, branches };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpError(409, msg);
    }
  });
}

export async function gitStatus(ctx: AppContext, bodyRaw: unknown): Promise<GitStatusResponse> {
  const body = (bodyRaw ?? {}) as any;
  const { wsRepo } = await getTargetInfoOrThrow(ctx, body.target);
  const status = await readRepositoryStatus({ repoPath: wsRepo.path, cwd: ctx.dataDir, untrackedFiles: "all" }).catch(() => {
    throw new HttpError(500, "Failed to read repository status", "GIT_STATUS_FAILED");
  });
  const upstream = await readUpstreamStatus({ repoPath: wsRepo.path, cwd: ctx.dataDir, status }).catch(() => {
    throw new HttpError(500, "Failed to read upstream status", "GIT_STATUS_FAILED");
  });
  return { head: status.head, upstream, dirty: status.dirty };
}

/** One bounded batch, no cache or per-repository partial success state. */
export async function gitWorkspaceStatus(
  ctx: AppContext,
  bodyRaw: unknown,
  readStatus: typeof readRepositoryStatus = readRepositoryStatus
): Promise<WorkspaceGitStatusResponse> {
  const body = (bodyRaw ?? {}) as WorkspaceGitStatusRequest;
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");
  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");
  const registered = listWorkspaceRepos(ctx.db, ws.id);
  const repos: WorkspaceGitStatusResponse["repos"] = new Array(registered.length);
  let next = 0;
  let failure: HttpError | undefined;
  const worker = async () => {
    while (!failure) {
      const index = next++;
      const item = registered[index];
      if (!item) return;
      try {
        const { wsRepo } = await getTargetInfoOrThrow(ctx, { kind: "workspaceRepo", workspaceId, dirName: item.dirName });
        const status = await readStatus({ repoPath: wsRepo.path, cwd: ctx.dataDir });
        repos[index] = { repoId: item.repoId, dirName: item.dirName, head: status.head, hasChanges: status.hasChanges };
      } catch (error) {
        const knownReasons = ["Git status timed out", "Git status output is too large", "Invalid Git status output"];
        const reason = error instanceof HttpError && error.code === "GIT_TARGET_INVALID"
          ? "repository location or Git metadata is invalid"
          : error instanceof Error && knownReasons.includes(error.message) ? error.message : "Git status failed";
        // Use only a registered display name and a fixed reason; never forward raw Git/filesystem errors.
        const name = item.dirName.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
        failure ??= new HttpError(500, `Failed to read status for repository "${name}": ${reason}`, "GIT_WORKSPACE_STATUS_FAILED");
      }
    }
  };
  // Four local workers keep an eight-repository Workspace responsive without spawning unbounded Git processes.
  // Await active workers even after failure, so the next poll cannot overlap this batch's remaining work.
  await Promise.all(Array.from({ length: Math.min(4, registered.length) }, () => worker()));
  if (failure) throw failure;
  return { repos };
}

async function getTargetInfoOrThrow(ctx: AppContext, targetRaw: unknown) {
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

  await assertWorkspaceRepoSafe(ctx, ws, wsRepo);
  return { target, ws, wsRepo, repo };
}

async function hasHeadCommit(params: { wsPath: string; dataDir: string }) {
  return (await resolveHeadCommit(params)) !== null;
}

async function listStagedPaths(params: { wsPath: string; dataDir: string }) {
  const res = await runGit(["-C", params.wsPath, "diff", "--cached", "--name-only", "-z"], { cwd: params.dataDir });
  if (!res.ok) throw new HttpError(500, "Failed to inspect repository changes", "GIT_CHANGES_FAILED");
  const parts = res.stdout.split("\0").filter(Boolean);
  return new Set(parts);
}

async function listIndexTrackedPaths(params: { repoPath: string; dataDir: string; paths: string[] }) {
  const safePaths = params.paths.filter((p) => isSafePathInRepo({ repoPath: params.repoPath, rel: p }));
  if (safePaths.length === 0) return new Set<string>();
  const res = await runGit(["-C", params.repoPath, "--literal-pathspecs", "ls-files", "-z", "--", ...safePaths], { cwd: params.dataDir });
  if (!res.ok) throw new HttpError(500, "Failed to inspect repository changes", "GIT_CHANGES_FAILED");
  const parts = res.stdout.split("\0").filter(Boolean);
  return new Set(parts);
}

function collectPathspecs(params: { repoPath: string; items: { path: string; oldPath?: string }[] }) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of params.items) {
    const p = typeof it.path === "string" ? it.path : "";
    const op = typeof it.oldPath === "string" ? it.oldPath : "";
    for (const v of [p, op]) {
      if (!v) continue;
      if (!isSafePathInRepo({ repoPath: params.repoPath, rel: v })) {
        throw new HttpError(400, "Invalid path");
      }
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export async function stageWorkspace(ctx: AppContext, bodyRaw: unknown): Promise<void> {
  const body = (bodyRaw ?? {}) as GitStageRequest;
  const target = parseTarget((body as any).target);
  return workspaceLifecycleCoordinator.withMutation(target.workspaceId, () =>
    withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = await getTargetInfoOrThrow(ctx, target);

    const all = parseGitBool((body as any).all);
    const items = Array.isArray((body as any).items) ? ((body as any).items as any[]) : [];

    if (all) {
      const res = await runGit(["-C", wsRepo.path, "add", "-A"], { cwd: ctx.dataDir });
      if (!res.ok) throw new HttpError(409, `Failed to stage changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
      return;
    }

    if (items.length > 0) {
      const paths = collectPathspecs({ repoPath: wsRepo.path, items });
      if (paths.length === 0) return;
      const res = await runGit(["-C", wsRepo.path, "--literal-pathspecs", "add", "-A", "--", ...paths], { cwd: ctx.dataDir });
      if (!res.ok) throw new HttpError(409, `Failed to stage changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
      return;
    }

    throw new HttpError(400, "Either all or items must be provided");
    })
  );
}

export async function unstageWorkspace(ctx: AppContext, bodyRaw: unknown): Promise<void> {
  const body = (bodyRaw ?? {}) as GitUnstageRequest;
  const target = parseTarget((body as any).target);
  return workspaceLifecycleCoordinator.withMutation(target.workspaceId, () =>
    withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = await getTargetInfoOrThrow(ctx, target);

    const all = parseGitBool((body as any).all);
    const items = Array.isArray((body as any).items) ? ((body as any).items as any[]) : [];

    const stagedSet = await listStagedPaths({ wsPath: wsRepo.path, dataDir: ctx.dataDir });
    if (stagedSet.size === 0) return;

    const headExists = await hasHeadCommit({ wsPath: wsRepo.path, dataDir: ctx.dataDir });

    if (all) {
      if (headExists) {
        const res = await runGit(["-C", wsRepo.path, "reset", "-q", "HEAD"], { cwd: ctx.dataDir });
        if (!res.ok) throw new HttpError(409, `Failed to unstage changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
        return;
      }
      const res = await runGit(["-C", wsRepo.path, "rm", "-r", "--cached", "--", "."], { cwd: ctx.dataDir });
      if (!res.ok) throw new HttpError(409, `Failed to unstage changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
      return;
    }

    if (items.length > 0) {
      const requested = collectPathspecs({ repoPath: wsRepo.path, items });
      const toUnstage = requested.filter((p) => stagedSet.has(p));
      if (toUnstage.length === 0) return;

      if (headExists) {
        const res = await runGit(["-C", wsRepo.path, "--literal-pathspecs", "reset", "-q", "HEAD", "--", ...toUnstage], { cwd: ctx.dataDir });
        if (!res.ok) throw new HttpError(409, `Failed to unstage changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
        return;
      }

      const res = await runGit(["-C", wsRepo.path, "--literal-pathspecs", "rm", "-r", "--cached", "--ignore-unmatch", "--", ...toUnstage], {
        cwd: ctx.dataDir
      });
      if (!res.ok) throw new HttpError(409, `Failed to unstage changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
      return;
    }

    throw new HttpError(400, "Either all or items must be provided");
    })
  );
}

export async function discardWorkspace(ctx: AppContext, bodyRaw: unknown): Promise<void> {
  const body = (bodyRaw ?? {}) as GitDiscardRequest;
  const target = parseTarget((body as any).target);
  return workspaceLifecycleCoordinator.withMutation(target.workspaceId, () =>
    withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = await getTargetInfoOrThrow(ctx, target);

    const all = parseGitBool((body as any).all);
    const items = Array.isArray((body as any).items) ? ((body as any).items as any[]) : [];
    const includeUntracked = parseGitBool((body as any).includeUntracked);

    if (all) {
      if (includeUntracked) {
        const cleanRes = await runGit(["-C", wsRepo.path, "clean", "-fd"], { cwd: ctx.dataDir });
        if (!cleanRes.ok) throw new HttpError(409, `Failed to clean untracked files: ${truncateGitOutput(cleanRes.stderr || cleanRes.stdout)}`);
      }

      const res = await runGit(["-C", wsRepo.path, "checkout", "--", "."], { cwd: ctx.dataDir });
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
      const paths = collectPathspecs({ repoPath: wsRepo.path, items });
      if (paths.length === 0) return;

      const trackedSet = await listIndexTrackedPaths({ repoPath: wsRepo.path, dataDir: ctx.dataDir, paths });
      const toRestore = paths.filter((p) => trackedSet.has(p));
      const toClean = paths.filter((p) => !trackedSet.has(p));

      if (toClean.length > 0) {
        const cleanRes = await runGit(["-C", wsRepo.path, "--literal-pathspecs", "clean", "-f", "-d", "--", ...toClean], { cwd: ctx.dataDir });
        if (!cleanRes.ok) throw new HttpError(409, `Failed to delete untracked files: ${truncateGitOutput(cleanRes.stderr || cleanRes.stdout)}`);
      }

      if (toRestore.length > 0) {
        const res = await runGit(["-C", wsRepo.path, "--literal-pathspecs", "checkout", "--", ...toRestore], { cwd: ctx.dataDir });
        if (!res.ok) throw new HttpError(409, `Failed to discard changes: ${truncateGitOutput(res.stderr || res.stdout)}`);
      }

      return;
    }

    throw new HttpError(400, "Either all or items must be provided");
  })
  );
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

export async function getWorkspaceGitIdentity(ctx: AppContext, bodyRaw: unknown): Promise<GitIdentityStatus> {
  const body = (bodyRaw ?? {}) as any;
  const { wsRepo } = await getTargetInfoOrThrow(ctx, body.target);

  const [repoName, repoEmail, globalName, globalEmail] = await Promise.all([
    gitConfigGet({ cwd: ctx.dataDir, repoPath: wsRepo.path, key: "user.name" }),
    gitConfigGet({ cwd: ctx.dataDir, repoPath: wsRepo.path, key: "user.email" }),
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

export async function setWorkspaceGitIdentity(ctx: AppContext, bodyRaw: unknown) {
  const body = (bodyRaw ?? {}) as any;
  const target = parseTarget(body.target);
  return workspaceLifecycleCoordinator.withMutation(target.workspaceId, () =>
    withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = await getTargetInfoOrThrow(ctx, target);
    const v = validateAndNormalizeGitIdentity(bodyRaw);
    if (!v) throw new HttpError(400, "Invalid identity. Expected {name,email}.", "GIT_IDENTITY_INVALID");

    const ok = await setRepoGitIdentity(ctx, wsRepo.path, v);
    if (!ok) throw new HttpError(409, "Failed to set repo git identity.", "GIT_IDENTITY_SET_FAILED");
    })
  );
}

export async function commitWorkspace(ctx: AppContext, bodyRaw: unknown): Promise<GitCommitResponse> {
  const body = (bodyRaw ?? {}) as any;
  const target = parseTarget(body.target);
  return workspaceLifecycleCoordinator.withMutation(target.workspaceId, () =>
    withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo } = await getTargetInfoOrThrow(ctx, target);

    const message = normalizeGitMessage(body.message);
    if (!message) throw new HttpError(400, "message is required");

    const identity = body.identity !== undefined ? parseGitIdentityInput(body.identity) : null;
    if (body.identity !== undefined && !identity) {
      throw new HttpError(400, "Invalid identity. Expected {scope,name,email}.", "GIT_IDENTITY_INVALID");
    }

    if (identity?.scope === "repo") {
      const ok = await setRepoGitIdentity(ctx, wsRepo.path, identity);
      if (!ok) throw new HttpError(409, "Failed to set repo git identity.", "GIT_IDENTITY_SET_FAILED");
    }
    if (identity?.scope === "global") {
      const ok = await setGlobalGitIdentity(ctx, identity);
      if (!ok) throw new HttpError(409, "Failed to set global git identity.", "GIT_IDENTITY_SET_FAILED");
    }

    const args = ["-C", wsRepo.path, "commit", "-m", message];
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

    const shaRes = await runGit(["-C", wsRepo.path, "rev-parse", "HEAD"], { cwd: ctx.dataDir });
    const sha = shaRes.ok ? shaRes.stdout.trim() : "";
    const branchRes = await runGit(["-C", wsRepo.path, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.dataDir });
    const branch = branchRes.ok ? branchRes.stdout.trim() : "";
    return { sha, branch };
    })
  );
}

export async function pushWorkspace(ctx: AppContext, bodyRaw: unknown): Promise<GitPushResponse> {
  const body = (bodyRaw ?? {}) as any;
  const target = parseTarget(body.target);
  return workspaceLifecycleCoordinator.withMutation(target.workspaceId, () =>
    withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo, repo } = await getTargetInfoOrThrow(ctx, target);

    const gitEnv = await buildGitEnv({ ctx, repoUrl: repo.url, credentialId: repo.credentialId });
    const remote = normalizeGitRefLike(body.remote) || "origin";
    const branchRaw = normalizeGitRefLike(body.branch);
    const setUpstream = parseGitBool(body.setUpstream);

    try {
      const branchRes = await runGit(["-C", wsRepo.path, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.dataDir, env: gitEnv.env });
      const currentBranch = branchRes.ok ? branchRes.stdout.trim() : "";
      const targetBranch = branchRaw || (currentBranch && currentBranch !== "HEAD" ? currentBranch : "");
      if (!targetBranch) throw new HttpError(409, "Detached HEAD. Specify a branch to push.", "GIT_DETACHED_HEAD");

      if (!branchRaw && !setUpstream) {
        const upstreamRes = await runGit(["-C", wsRepo.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
          cwd: ctx.dataDir,
          env: gitEnv.env
        });
        if (!upstreamRes.ok) {
          throw new HttpError(409, "No upstream configured. Specify branch or use setUpstream=true.", "GIT_NO_UPSTREAM");
        }
      }

      const args = ["-C", wsRepo.path, "push"];
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
    })
  );
}

export async function pullWorkspace(ctx: AppContext, bodyRaw: unknown): Promise<GitPullResponse> {
  const body = (bodyRaw ?? {}) as any;
  const target = parseTarget(body.target);
  return workspaceLifecycleCoordinator.withMutation(target.workspaceId, () =>
    withWorkspaceRepoLock({ workspaceId: target.workspaceId, dirName: target.dirName }, async () => {
    const { wsRepo, repo } = await getTargetInfoOrThrow(ctx, target);

    const gitEnv = await buildGitEnv({ ctx, repoUrl: repo.url, credentialId: repo.credentialId });
    try {
      const branchRes = await runGit(["-C", wsRepo.path, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.dataDir, env: gitEnv.env });
      const currentBranch = branchRes.ok ? branchRes.stdout.trim() : "";
      if (!currentBranch || currentBranch === "HEAD") {
        throw new HttpError(409, "Detached HEAD. Switch to a branch to pull.", "GIT_DETACHED_HEAD");
      }

      const upstreamRes = await runGit(["-C", wsRepo.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
        cwd: ctx.dataDir,
        env: gitEnv.env
      });
      if (!upstreamRes.ok) {
        throw new HttpError(409, "No upstream configured. Set upstream then retry pull.", "GIT_NO_UPSTREAM");
      }

      const beforeRes = await runGit(["-C", wsRepo.path, "rev-parse", "HEAD"], { cwd: ctx.dataDir, env: gitEnv.env });
      const beforeSha = beforeRes.ok ? beforeRes.stdout.trim() : "";

      const res = await runGit(["-C", wsRepo.path, "pull", "--ff-only"], { cwd: ctx.dataDir, env: gitEnv.env });
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

      const afterRes = await runGit(["-C", wsRepo.path, "rev-parse", "HEAD"], { cwd: ctx.dataDir, env: gitEnv.env });
      const afterSha = afterRes.ok ? afterRes.stdout.trim() : "";
      const updated = Boolean(beforeSha && afterSha && beforeSha !== afterSha);
      return { branch: currentBranch, updated, beforeSha, afterSha };
    } finally {
      await gitEnv.cleanup();
    }
  })
  );
}
