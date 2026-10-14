import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { PrepareRepoGitEnvResponseSchema, formatRepoGitSshCommand, type PrepareRepoGitEnvResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import { GitToolError } from "./gitErrors.js";

export const GIT_LEASE_SETTLEMENT_GRACE_MS = 2000;
const SECRET_FILE_MAX_BYTES = 1024 * 1024;
type PreparedLease = Extract<PrepareRepoGitEnvResponse, { ok: true }>;
type Directory = { handle: fs.FileHandle; logical: string; dev: number; ino: number };

function sameInode(a: { dev: number; ino: number }, b: { dev: number; ino: number }) {
  return a.dev === b.dev && a.ino === b.ino;
}
function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Pin the API's fixed data/workspaces/Workspace chain before any preparation RPC. */
export async function prepareGitRepositoryPath(params: { dataDir: string; workspacePath: string; repo: string }) {
  const directories: Directory[] = [];
  const handles: fs.FileHandle[] = [];
  const close = async () => {
    for (const handle of [...handles].reverse()) await handle.close().catch(() => undefined);
  };
  const assertDirectories = async () => {
    for (const directory of directories) {
      const [current, opened] = await Promise.all([fs.lstat(directory.logical), directory.handle.stat()]);
      if (current.isSymbolicLink() || !current.isDirectory() || !sameInode(current, directory) || !sameInode(opened, directory)) {
        throw new GitToolError("REPO_PATH_INVALID");
      }
    }
  };
  try {
    const dataDir = path.resolve(params.dataDir);
    const workspacesPath = path.join(dataDir, "workspaces");
    const workspaceName = path.relative(workspacesPath, path.resolve(params.workspacePath));
    if (!path.isAbsolute(params.workspacePath) || !/^[A-Za-z0-9._-]{1,160}$/.test(workspaceName)
      || workspaceName === "." || workspaceName === "..") throw new GitToolError("REPO_PATH_INVALID");
    for (const name of [null, "workspaces", workspaceName]) {
      const parent = directories.at(-1);
      const logical = parent ? path.join(parent.logical, name!) : dataDir;
      const openedPath = parent ? path.join(`/proc/self/fd/${parent.handle.fd}`, name!) : dataDir;
      const handle = await fs.open(openedPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(handle);
      const stat = await handle.stat();
      directories.push({ handle, logical, dev: stat.dev, ino: stat.ino });
      if (!stat.isDirectory()) throw new GitToolError("REPO_PATH_INVALID");
      await assertDirectories();
    }
    const workspace = directories.at(-1)!;
    const rootFdPath = `/proc/self/fd/${workspace.handle.fd}`;
    const initialRoot = await fs.realpath(rootFdPath);
    const assertWorkspaceIdentity = async () => {
      try {
        await assertDirectories();
        const [currentRoot, pinnedRoot] = await Promise.all([fs.realpath(workspace.logical), fs.realpath(rootFdPath)]);
        if (currentRoot !== initialRoot || pinnedRoot !== initialRoot) throw new GitToolError("REPO_PATH_INVALID");
      } catch { throw new GitToolError("REPO_PATH_INVALID"); }
    };
    const checkFinalPath = async () => {
      try {
        await assertWorkspaceIdentity();
        const candidate = path.join(workspace.logical, params.repo);
        const [physical, stat] = await Promise.all([fs.realpath(candidate), fs.stat(candidate)]);
        if (!stat.isDirectory() || !isInside(initialRoot, physical)) throw new GitToolError("REPO_PATH_INVALID");
        await assertWorkspaceIdentity();
        // Native argv may change Git's target; the remaining check-to-spawn
        // TOCTOU window is still not an atomic directory execution or sandbox.
        return candidate;
      } catch { throw new GitToolError("REPO_PATH_INVALID"); }
    };
    await assertWorkspaceIdentity();
    return { assertWorkspaceIdentity, checkFinalPath, close };
  } catch {
    await close();
    throw new GitToolError("REPO_PATH_INVALID");
  }
}

export function requireGitLeaseTime(lease: PreparedLease, timeoutMs: number, now: number) {
  const expires = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expires) || expires - now < timeoutMs + GIT_LEASE_SETTLEMENT_GRACE_MS) {
    throw new GitToolError("GIT_LEASE_EXPIRED");
  }
}

export function buildGitProcessEnv(extra: Record<string, string>, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const authKeys = new Set(["GIT_ASKPASS", "GIT_ASKPASS_USERNAME", "GIT_ASKPASS_TOKEN", "GIT_ASKPASS_TOKEN_FILE", "GIT_SSH", "GIT_SSH_COMMAND"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value === "string" && !key.startsWith("AWB_") && !authKeys.has(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Opens only fixed v2 directories and one protocol-specific file through pinned fds. */
export async function prepareGitOutputGuard(params: { response: PreparedLease; repo: string; dataDir: string; timeoutMs: number; now: number }) {
  const lease = params.response;
  if (!Value.Check(PrepareRepoGitEnvResponseSchema, lease) || lease.repo !== params.repo || !path.isAbsolute(params.dataDir)) {
    throw new GitToolError("GIT_ENV_RPC_FAILED");
  }
  requireGitLeaseTime(lease, params.timeoutMs, params.now);
  const dataDir = path.resolve(params.dataDir);
  const leaseDir = path.join(dataDir, "tmp", "git-env", "v2", lease.leaseId);
  const directories: Directory[] = [];
  const handles: fs.FileHandle[] = [];
  const files: Array<{ logical: string; stat: Stats }> = [];
  const sameFile = (a: Stats, b: Stats) =>
    a.isFile() && b.isFile() && sameInode(a, b) && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const assertFiles = async () => {
    for (const file of files) if (!sameFile(await fs.lstat(file.logical), file.stat)) throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
  };
  const assertCurrent = async () => {
    for (const directory of directories) {
      const [current, opened] = await Promise.all([fs.lstat(directory.logical), directory.handle.stat()]);
      if (current.isSymbolicLink() || !current.isDirectory() || !sameInode(current, directory) || !sameInode(opened, directory)) {
        throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
      }
    }
  };
  try {
    for (const name of [null, "tmp", "git-env", "v2", lease.leaseId]) {
      const parent = directories.at(-1);
      const logical = parent ? path.join(parent.logical, name!) : dataDir;
      const openedPath = parent ? path.join(`/proc/self/fd/${parent.handle.fd}`, name!) : dataDir;
      const handle = await fs.open(openedPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(handle);
      const stat = await handle.stat();
      directories.push({ handle, logical, dev: stat.dev, ino: stat.ino });
      if (!stat.isDirectory()) throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
      if (name === lease.leaseId && (stat.mode & 0o777) !== 0o700) throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
      await assertCurrent();
    }
    const directory = directories.at(-1)!;
    const knownValues = [leaseDir];
    const secretName = lease.kind === "https" ? "git-askpass-token" : lease.kind === "ssh" ? "ssh-key" : null;
    if (secretName) {
      const secretPath = path.join(leaseDir, secretName);
      if (lease.sensitiveFilePaths.length !== 1 || lease.sensitiveFilePaths[0] !== secretPath) throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
      if (lease.kind === "https") {
        const askpassPath = path.join(leaseDir, "git-askpass.sh");
        if (lease.env.GIT_ASKPASS_TOKEN_FILE !== secretPath || lease.env.GIT_ASKPASS !== askpassPath) throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
        const script = await fs.open(path.join(`/proc/self/fd/${directory.handle.fd}`, "git-askpass.sh"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await script.stat();
          if (!stat.isFile() || (stat.mode & 0o777) !== 0o700) throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
          files.push({ logical: askpassPath, stat });
        } finally { await script.close(); }
        knownValues.push(askpassPath);
      } else if (lease.kind !== "ssh"
        || lease.env.GIT_SSH_COMMAND !== formatRepoGitSshCommand(secretPath, path.join(dataDir, "ssh", "known_hosts"))) {
        throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
      }
      const handle = await fs.open(path.join(`/proc/self/fd/${directory.handle.fd}`, secretName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > SECRET_FILE_MAX_BYTES) throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
        // One bounded read also covers a file growing after stat; no unbounded readFile.
        const bytes = Buffer.alloc(SECRET_FILE_MAX_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          const read = await handle.read(bytes, size, bytes.length - size, size);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        if (size > SECRET_FILE_MAX_BYTES) throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
        const secret = bytes.subarray(0, size).toString("utf8");
        if (!sameFile(await handle.stat(), stat)) throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
        files.push({ logical: secretPath, stat });
        knownValues.push(secretPath, secret);
        if (lease.kind === "https") knownValues.push((secret.split("\n", 1)[0] ?? "").replace(/\r/g, ""));
      } finally { await handle.close(); }
    }
    await assertCurrent();
    await assertFiles();
    const assertPathIdentity = async () => {
      try {
        for (const directory of directories) {
          const current = await fs.lstat(directory.logical);
          if (current.isSymbolicLink() || !current.isDirectory() || !sameInode(current, directory)) {
            throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
          }
        }
        await assertFiles();
      } catch { throw new GitToolError("GIT_OUTPUT_GUARD_FAILED"); }
    };
    return { knownValues, assertPathIdentity };
  } catch (error) {
    if (error instanceof GitToolError) throw error;
    // Never propagate native errors: they carry fd paths and private logical paths.
    throw new GitToolError("GIT_OUTPUT_GUARD_FAILED");
  } finally {
    for (const handle of [...handles].reverse()) await handle.close().catch(() => undefined);
  }
}
