import type { ChangeItem, GitStatusResponse } from "@agent-workbench/shared";
import { runGit, runGitBuffer, type ExecBufferResult } from "../../infra/git/gitExec.js";

export const STATUS_TIMEOUT_MS = 10_000;
const STATUS_MAX_BYTES = 8 * 1024 * 1024;

type StatusChange = {
  path: string;
  index: string;
  worktree: string;
  oldPath?: string;
  kind?: ChangeItem["kind"];
};

export type RepositoryStatus = {
  head: GitStatusResponse["head"];
  hasChanges: boolean;
  dirty: NonNullable<GitStatusResponse["dirty"]>;
  upstream?: string;
  changes: StatusChange[];
};

function invalidStatus(): never {
  throw new Error("Invalid Git status output");
}

/** Porcelain v2 is NUL-delimited, including the extra original path of a rename. */
export function parseRepositoryStatus(output: Buffer | string): RepositoryStatus {
  const text = typeof output === "string" ? output : output.toString("utf8");
  if (!text.endsWith("\0")) invalidStatus();
  const records = text.split("\0");
  records.pop();
  let branch: string | undefined;
  let oid: string | undefined;
  let upstream: string | undefined;
  const changes: StatusChange[] = [];
  const dirty = { staged: 0, unstaged: 0, untracked: 0 };
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("# ")) {
      if (record.startsWith("# branch.head ")) branch = record.slice(14);
      else if (record.startsWith("# branch.oid ")) oid = record.slice(13);
      else if (record.startsWith("# branch.upstream ")) upstream = record.slice("# branch.upstream ".length);
      // Unknown headers are explicitly allowed by the porcelain v2 contract.
      continue;
    }
    if (record.startsWith("! ")) continue;
    if (record.startsWith("? ")) {
      const rawPath = record.slice(2);
      if (!rawPath) invalidStatus();
      changes.push({ path: rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath, index: ".", worktree: "?", ...(rawPath.endsWith("/") ? { kind: "directory" as const } : {}) });
      dirty.untracked++;
      continue;
    }
    const type = record[0];
    const fieldCount = type === "1" ? 8 : type === "2" ? 9 : type === "u" ? 10 : 0;
    if (!fieldCount || record[1] !== " ") invalidStatus();
    // Split only the fixed fields: a filename may itself contain spaces/newlines.
    const fields: string[] = [];
    let cursor = 0;
    for (let field = 0; field < fieldCount; field++) {
      const end = record.indexOf(" ", cursor);
      if (end < cursor) invalidStatus();
      fields.push(record.slice(cursor, end));
      cursor = end + 1;
    }
    const filePath = record.slice(cursor);
    const xy = fields[1]!;
    if (!filePath || !/^[.MADRCUT]{2}$/.test(xy)) invalidStatus();
    const oldPath = type === "2" ? records[++i] : undefined;
    if (type === "2" && !oldPath) invalidStatus();
    const submodule = fields[2]!.startsWith("S") || fields.slice(3).includes("160000");
    const index = type === "u" ? "U" : xy[0]!;
    const worktree = type === "u" ? "U" : xy[1]!;
    if (index !== ".") dirty.staged++;
    if (worktree !== ".") dirty.unstaged++;
    changes.push({ path: filePath, index, worktree, ...(oldPath ? { oldPath } : {}), ...(submodule ? { kind: "submodule" as const } : {}) });
  }
  if (!branch || !oid || (oid !== "(initial)" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))) invalidStatus();
  const detached = branch === "(detached)";
  return {
    head: { branch: detached ? null : branch, detached, sha: oid === "(initial)" ? "" : oid },
    hasChanges: dirty.staged + dirty.unstaged + dirty.untracked > 0,
    dirty,
    upstream,
    changes
  };
}

export function statusChanges(status: RepositoryStatus, mode: "staged" | "unstaged"): ChangeItem[] {
  return status.changes.flatMap((change) => {
    const code = mode === "staged" ? change.index : change.worktree;
    if (code === ".") return [];
    return [{
      path: change.path,
      status: code === "?" ? "??" : code,
      ...((code === "R" || code === "C") && change.oldPath ? { oldPath: change.oldPath } : {}),
      ...(change.kind ? { kind: change.kind } : {})
    }];
  });
}

/** Also pin core.worktree, so repository config cannot redirect worktree reads. */
export function worktreeGitArgs(repoPath: string, args: string[]) {
  return [`--work-tree=${repoPath}`, "-C", repoPath, ...args];
}

export type StatusRunner = (args: string[], opts: Parameters<typeof runGitBuffer>[1]) => Promise<ExecBufferResult>;

export async function readRepositoryStatus(
  params: { repoPath: string; cwd: string; untrackedFiles?: "normal" | "all" },
  run: StatusRunner = runGitBuffer
): Promise<RepositoryStatus> {
  const result = await run(worktreeGitArgs(params.repoPath, [
    "--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z",
    `--untracked-files=${params.untrackedFiles ?? "normal"}`
  ]), { cwd: params.cwd, timeoutMs: STATUS_TIMEOUT_MS, maxOutputBytes: STATUS_MAX_BYTES });
  if (!result.ok) {
    // Never propagate Git output: stderr can contain credentials or absolute paths.
    const reason = result.failure === "timeout" ? "Git status timed out" : result.failure === "output-limit" ? "Git status output is too large" : "Git status failed";
    throw new Error(reason);
  }
  return parseRepositoryStatus(result.stdout);
}

/** A configured tracking branch can legitimately be absent after pruning or before its first fetch. */
export async function readUpstreamStatus(
  params: { repoPath: string; cwd: string; status: RepositoryStatus },
  run: typeof runGit = runGit
): Promise<GitStatusResponse["upstream"]> {
  const { status } = params;
  if (!status.upstream || !status.head.branch || !status.head.sha) return undefined;
  const options = { cwd: params.cwd, timeoutMs: STATUS_TIMEOUT_MS, maxOutputBytes: 8192 };
  const execute = (args: string[]) => run(worktreeGitArgs(params.repoPath, args), options);
  const configured = await execute(["for-each-ref", "--format=%(upstream)", "--", `refs/heads/${status.head.branch}`]);
  if (!configured.ok) throw new Error("Failed to read upstream status");
  const ref = configured.stdout.trim();
  if (!ref) return undefined;
  if (!ref.startsWith("refs/") || /[\0\r\n]/.test(ref)) throw new Error("Failed to read upstream status");
  const exists = await execute(["show-ref", "--verify", "--quiet", ref]);
  if (!exists.ok) {
    // show-ref --verify --quiet documents exit 1 for a missing reference; other failures are not absence.
    if (exists.code === 1 && !exists.failure) return undefined;
    throw new Error("Failed to read upstream status");
  }
  const compared = await execute(["rev-list", "--left-right", "--count", `${ref}...${status.head.sha}`]);
  const counts = compared.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!compared.ok || !counts) throw new Error("Failed to read upstream status");
  return { name: status.upstream, ahead: Number(counts[2]), behind: Number(counts[1]) };
}
