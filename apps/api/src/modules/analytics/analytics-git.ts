import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rmdir,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import type { RepoSyncStatus } from "@agent-workbench/shared";
import { openSecureAnalyticsRoot, type SecureAnalyticsDirectory } from "@agent-workbench/shared/node/analytics-root";
import {
  analyticsGitInstallationSecretPath,
  dbPath,
} from "../../infra/fs/paths.js";
import { gitConfigGet } from "../../infra/git/gitIdentity.js";
import type { AnalyticsDb } from "./analytics-db.js";
import { DEFAULT_ANALYTICS_RETENTION_MS } from "./analytics-maintenance.js";
import { readCurrentFactDomainConfig } from "./signal-store.js";

const SECRET_BYTES = 32;
const SCAN_TIMEOUT_MS = 20_000;
const GIT_RETENTION_MS = DEFAULT_ANALYTICS_RETENTION_MS;
const DEFAULT_MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 100_000;
const DEFAULT_MAX_COMMITS = 100_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const REPO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const GIT_FRESHNESS_MS = 2 * 60 * 60 * 1000;
const CHILD_GIT_DIR_FD = 3;
const SAFE_WORKSPACE_SEGMENT = /^[A-Za-z0-9._-]{1,160}$/;
const GIT_SOURCE_MAX_DEPTH = 16;
const GIT_SOURCE_MAX_ENTRIES = 200_000;
const GIT_CONFIG_MAX_BYTES = 1024 * 1024;
const GIT_REF_SNAPSHOT_MAX_REVISIONS = 100_000;
const GIT_CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

type SafeRepo = { id: string; syncStatus: RepoSyncStatus; credentialId: string };
type ParsedCommit = {
  identity: string;
  committedAt: number;
  parentCount: number;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
};
type ScanErrorCode =
  | "GIT_SCAN_SUPERSEDED"
  | "GIT_MIRROR_UNSAFE"
  | "GIT_SOURCE_UNSAFE"
  | "GIT_COMMAND_FAILED"
  | "GIT_SCAN_TIMEOUT"
  | "GIT_SCAN_BUDGET"
  | "GIT_SCAN_OUTPUT_INVALID"
  | "GIT_SCAN_IN_FLIGHT";
type ScanLimits = {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxRecords: number;
  maxCommits: number;
};
type SharedScanBudget = {
  deadlineAt: number;
  stdoutBytes: number;
  records: number;
  commits: number;
};
type GitRevisionScope = "mirror" | "workspace";
type GitObjectFingerprintEntry = {
  relativePath: string;
  type: "directory" | "file";
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};
type GitSourceSnapshot = {
  objectDir: FileHandle;
  objectFingerprint: readonly GitObjectFingerprintEntry[];
  revisions: readonly string[];
  objectFormat: "sha1" | "sha256";
};
type GitSourceLimits = {
  maxDepth: number;
  maxEntries: number;
};

class GitSourceValidationError extends Error {
  constructor(readonly code: "GIT_SOURCE_UNSAFE" | "GIT_SCAN_TIMEOUT") {
    super(code);
  }
}

const inFlightRepoIds = new Set<string>();

/** The raw SHA is deliberately accepted only inside this module and never returned. */
export function gitCommitIdentity(
  secret: Buffer,
  repoId: string,
  rawSha: string,
) {
  return createHmac("sha256", secret)
    .update(repoId)
    .update("\0")
    .update(rawSha)
    .digest("hex");
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

async function regularDirectory(directory: string) {
  const entry = await lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new Error("unsafe directory");
  return realpath(directory);
}

async function openSafeSecretForRead(
  dataDir: string,
): Promise<Buffer | "missing" | null> {
  let root: SecureAnalyticsDirectory;
  try { root = await openSecureAnalyticsRoot(dataDir); }
  catch { return null; }
  try {
    const value = await root.readFileBuffer("git-installation-secret", { requirePrivate: true }).catch((error: any) => error?.code === "ENOENT" ? null : null);
    if (value === null) {
      const names = await root.list();
      return names.includes("git-installation-secret") ? null : "missing";
    }
    return value.length === SECRET_BYTES ? value : null;
  } finally { await root.close(); }
}

/** Creates a stable secret only for a fresh Git Analytics installation. */
export async function readOrCreateGitInstallationSecret(
  dataDir: string,
  db: AnalyticsDb,
): Promise<Buffer | null> {
  const existing = await openSafeSecretForRead(dataDir);
  if (Buffer.isBuffer(existing)) return existing;
  if (existing !== "missing" || (await hasHistoricalGitAnalytics(db))) return null;
  let root: SecureAnalyticsDirectory | null = null;
  let temporary: string | null = null;
  try {
    root = await openSecureAnalyticsRoot(dataDir);
    const candidate = randomBytes(SECRET_BYTES);
    temporary = `.git-installation-secret.${randomBytes(16).toString("hex")}.tmp`;
    await root.writeExclusiveFile(temporary, candidate);
    try { await root.linkFile(temporary, "git-installation-secret"); }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const concurrent = await root.readFileBuffer("git-installation-secret", { requirePrivate: true });
      return concurrent.length === SECRET_BYTES ? concurrent : null;
    }
    return candidate;
  } catch { return null; }
  finally {
    if (root && temporary) await root.deleteFile(temporary).catch(() => undefined);
    await root?.close().catch(() => undefined);
  }
}

async function hasHistoricalGitAnalytics(db: AnalyticsDb) {
  const row = db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM (
    SELECT 1 AS present FROM analytics_git_scan
    UNION ALL SELECT 1 FROM analytics_git_repo_state
    UNION ALL SELECT 1 FROM analytics_git_membership
    UNION ALL SELECT 1 FROM analytics_git_commit_fact
  ) LIMIT 1) AS value`,
    )
    .get() as { value: number };
  return row.value === 1;
}

type OpenDirectory = { handle: FileHandle; realPath: string };

async function openDirectory(location: string): Promise<OpenDirectory> {
  // The child receives this same descriptor through /proc, rather than a path
  // that can be replaced between validation and Git's directory lookup.
  if (process.platform !== "linux" || DIRECTORY === 0)
    throw new Error("directory descriptors unavailable");
  const handle = await open(
    location,
    constants.O_RDONLY | DIRECTORY | NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error("not a directory");
    return { handle, realPath: await realpath(`/proc/self/fd/${handle.fd}`) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openDirectoryChild(parent: FileHandle, name: string) {
  if (path.basename(name) !== name)
    throw new Error("unsafe directory component");
  return openDirectory(`/proc/self/fd/${parent.fd}/${name}`);
}

/**
 * Every child is opened through the preceding directory FD, with O_NOFOLLOW
 * and O_DIRECTORY. The returned mirror FD is held by readCommits until Git and
 * its stdout parser have both finished.
 */
async function openSafeMirrorDirectory(
  dataDir: string,
  repoId: string,
): Promise<FileHandle | null> {
  if (!REPO_ID_PATTERN.test(repoId)) return null;
  let data: OpenDirectory | null = null;
  let repos: OpenDirectory | null = null;
  let repo: OpenDirectory | null = null;
  let mirror: OpenDirectory | null = null;
  try {
    data = await openDirectory(dataDir);
    repos = await openDirectoryChild(data.handle, "repos");
    if (!isInside(data.realPath, repos.realPath))
      throw new Error("repos escaped data root");
    repo = await openDirectoryChild(repos.handle, repoId);
    if (!isInside(repos.realPath, repo.realPath))
      throw new Error("repo escaped repos root");
    mirror = await openDirectoryChild(repo.handle, "mirror.git");
    if (
      !isInside(repo.realPath, mirror.realPath) ||
      !isInside(repos.realPath, mirror.realPath)
    )
      throw new Error("mirror escaped repo root");
    const handle = mirror.handle;
    mirror = null;
    return handle;
  } catch {
    return null;
  } finally {
    await mirror?.handle.close().catch(() => undefined);
    await repo?.handle.close().catch(() => undefined);
    await repos?.handle.close().catch(() => undefined);
    await data?.handle.close().catch(() => undefined);
  }
}

type WorkspaceLocator = { workspaceDir: string; repoDir: string };

async function openSafeWorkspaceGitDirectory(
  dataDir: string,
  locator: WorkspaceLocator,
): Promise<FileHandle | null> {
  if (
    !SAFE_WORKSPACE_SEGMENT.test(locator.workspaceDir) ||
    !SAFE_WORKSPACE_SEGMENT.test(locator.repoDir) ||
    locator.workspaceDir === "." ||
    locator.workspaceDir === ".." ||
    locator.repoDir === "." ||
    locator.repoDir === ".."
  )
    return null;
  let data: OpenDirectory | null = null;
  let workspaces: OpenDirectory | null = null;
  let workspace: OpenDirectory | null = null;
  let repo: OpenDirectory | null = null;
  let git: OpenDirectory | null = null;
  try {
    data = await openDirectory(dataDir);
    workspaces = await openDirectoryChild(data.handle, "workspaces");
    workspace = await openDirectoryChild(
      workspaces.handle,
      locator.workspaceDir,
    );
    repo = await openDirectoryChild(workspace.handle, locator.repoDir);
    git = await openDirectoryChild(repo.handle, ".git");
    if (
      !isInside(workspaces.realPath, workspace.realPath) ||
      !isInside(workspace.realPath, repo.realPath) ||
      !isInside(repo.realPath, git.realPath)
    )
      throw new Error("workspace git escaped");
    const handle = git.handle;
    git = null;
    return handle;
  } catch {
    return null;
  } finally {
    await git?.handle.close().catch(() => undefined);
    await repo?.handle.close().catch(() => undefined);
    await workspace?.handle.close().catch(() => undefined);
    await workspaces?.handle.close().catch(() => undefined);
    await data?.handle.close().catch(() => undefined);
  }
}

function fdChildPath(parent: FileHandle, name: string) {
  return `/proc/self/fd/${parent.fd}/${name}`;
}

async function optionalChildStat(parent: FileHandle, name: string) {
  try {
    return await lstat(fdChildPath(parent, name));
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertOptionalPlainFile(parent: FileHandle, name: string) {
  const entry = await optionalChildStat(parent, name);
  if (!entry) return null;
  if (entry.isSymbolicLink() || !entry.isFile())
    throw new Error("unsafe Git control file");
  return entry;
}

async function readOptionalSafeConfig(parent: FileHandle): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(fdChildPath(parent, "config"), constants.O_RDONLY | NOFOLLOW);
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size > GIT_CONFIG_MAX_BYTES)
      throw new Error("unsafe Git config");
    return (await handle.readFile()).toString("utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertSourceDeadline(sharedBudget: SharedScanBudget) {
  if (Date.now() >= sharedBudget.deadlineAt)
    throw new GitSourceValidationError("GIT_SCAN_TIMEOUT");
}

function unsafeGitSource(): never {
  throw new GitSourceValidationError("GIT_SOURCE_UNSAFE");
}

function addFingerprint(
  entries: GitObjectFingerprintEntry[],
  relativePath: string,
  type: "directory" | "file",
  entry: Awaited<ReturnType<typeof lstat>>,
) {
  entries.push({
    relativePath,
    type,
    dev: Number(entry.dev),
    ino: Number(entry.ino),
    size: Number(entry.size),
    mtimeMs: Number(entry.mtimeMs),
  });
}

async function inspectGitTree(
  directory: FileHandle,
  relativePath: string,
  depth: number,
  budget: { entries: number },
  sharedBudget: SharedScanBudget,
  fingerprints: GitObjectFingerprintEntry[] | null,
  sourceLimits: GitSourceLimits,
): Promise<void> {
  assertSourceDeadline(sharedBudget);
  if (depth > sourceLimits.maxDepth) unsafeGitSource();
  const names = (await readdir(`/proc/self/fd/${directory.fd}`)).sort();
  for (const name of names) {
    assertSourceDeadline(sharedBudget);
    budget.entries += 1;
    if (budget.entries > sourceLimits.maxEntries) unsafeGitSource();
    const entry = await lstat(fdChildPath(directory, name));
    if (entry.isSymbolicLink()) unsafeGitSource();
    const childRelativePath = relativePath ? `${relativePath}/${name}` : name;
    if (entry.isFile()) {
      if (fingerprints) addFingerprint(fingerprints, childRelativePath, "file", entry);
      continue;
    }
    if (!entry.isDirectory()) unsafeGitSource();
    const child = await openDirectoryChild(directory, name);
    try {
      const stableEntry = await child.handle.stat();
      if (fingerprints)
        addFingerprint(fingerprints, childRelativePath, "directory", stableEntry);
      await inspectGitTree(
        child.handle,
        childRelativePath,
        depth + 1,
        budget,
        sharedBudget,
        fingerprints,
        sourceLimits,
      );
    } finally {
      await child.handle.close().catch(() => undefined);
    }
  }
}

function parseLocalGitConfig(config: string): "sha1" | "sha256" | null {
  let section = "";
  let objectFormat: "sha1" | "sha256" = "sha1";
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[\s*([A-Za-z][A-Za-z0-9-]*)(?:\s+[^\]]+)?\s*\]$/.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      if (section === "include" || section === "includeif") return null;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    const key = match?.[1]?.toLowerCase();
    if (!key) continue;
    const value = match?.[2]?.trim().replace(/^"(.*)"$/, "$1").toLowerCase();
    if (key === "include" || key === "includeif") return null;
    if (section === "extensions") {
      if (key !== "objectformat") return null;
      if (value !== "sha1" && value !== "sha256") return null;
      objectFormat = value;
      continue;
    }
    if (
      (section === "remote" && ["promisor", "partialclonefilter"].includes(key)) ||
      (section === "core" &&
        [
          "worktree",
          "gitdir",
          "commondir",
          "objectdir",
          "objectdirectory",
          "alternates",
          "alternateobjectdirectories",
          "hookspath",
          "fsmonitor",
          "attributesfile",
        ].includes(key))
    )
      return null;
  }
  return objectFormat;
}

function validObjectId(value: string, objectFormat: "sha1" | "sha256") {
  return new RegExp(`^[0-9a-f]{${objectFormat === "sha1" ? 40 : 64}}$`, "i").test(value);
}

async function readSafeTextFile(
  parent: FileHandle,
  name: string,
  maxBytes: number,
): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(fdChildPath(parent, name), constants.O_RDONLY | NOFOLLOW);
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size > maxBytes) unsafeGitSource();
    return (await handle.readFile()).toString("utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof GitSourceValidationError) throw error;
    return unsafeGitSource();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function collectLooseRefs(
  directory: FileHandle,
  prefix: string,
  depth: number,
  budget: { entries: number },
  sharedBudget: SharedScanBudget,
  refs: Map<string, string>,
  sourceLimits: GitSourceLimits,
): Promise<void> {
  assertSourceDeadline(sharedBudget);
  if (depth > sourceLimits.maxDepth) unsafeGitSource();
  const names = (await readdir(`/proc/self/fd/${directory.fd}`)).sort();
  for (const name of names) {
    assertSourceDeadline(sharedBudget);
    budget.entries += 1;
    if (budget.entries > sourceLimits.maxEntries) unsafeGitSource();
    const entry = await lstat(fdChildPath(directory, name));
    if (entry.isSymbolicLink()) unsafeGitSource();
    const refName = `${prefix}/${name}`;
    if (entry.isDirectory()) {
      const child = await openDirectoryChild(directory, name);
      try {
        await collectLooseRefs(child.handle, refName, depth + 1, budget, sharedBudget, refs, sourceLimits);
      } finally {
        await child.handle.close().catch(() => undefined);
      }
      continue;
    }
    if (!entry.isFile()) unsafeGitSource();
    const content = await readSafeTextFile(directory, name, 4096);
    if (!content) unsafeGitSource();
    refs.set(refName, content.trim().split(/\s+/, 1)[0]!);
  }
}

async function snapshotGitSource(
  gitDir: FileHandle,
  scope: GitRevisionScope,
  sharedBudget: SharedScanBudget,
  sourceLimits: GitSourceLimits,
): Promise<GitSourceSnapshot> {
  let objects: OpenDirectory | null = null;
  let refs: OpenDirectory | null = null;
  let info: OpenDirectory | null = null;
  try {
    assertSourceDeadline(sharedBudget);
    if (!(await assertOptionalPlainFile(gitDir, "HEAD"))) unsafeGitSource();
    await assertOptionalPlainFile(gitDir, "packed-refs");
    if (await optionalChildStat(gitDir, "commondir")) unsafeGitSource();
    const config = await readOptionalSafeConfig(gitDir);
    const objectFormat = parseLocalGitConfig(config ?? "");
    if (!objectFormat) unsafeGitSource();
    objects = await openDirectoryChild(gitDir, "objects");
    refs = await openDirectoryChild(gitDir, "refs");
    try {
      info = await openDirectoryChild(objects.handle, "info");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (info && (await optionalChildStat(info.handle, "alternates"))) unsafeGitSource();
    const budget = { entries: 0 };
    const objectFingerprint: GitObjectFingerprintEntry[] = [];
    addFingerprint(objectFingerprint, ".", "directory", await objects.handle.stat());
    await inspectGitTree(objects.handle, "", 0, budget, sharedBudget, objectFingerprint, sourceLimits);
    const looseRefs = new Map<string, string>();
    await collectLooseRefs(refs.handle, "refs", 0, budget, sharedBudget, looseRefs, sourceLimits);
    const packedRefs = new Map<string, string>();
    const packed = await readSafeTextFile(gitDir, "packed-refs", 32 * 1024 * 1024);
    if (packed) {
      for (const line of packed.split(/\r?\n/)) {
        assertSourceDeadline(sharedBudget);
        if (!line || line.startsWith("#") || line.startsWith("^")) continue;
        const match = /^([0-9a-f]{40,64}) ([^\s]+)$/.exec(line);
        if (!match) unsafeGitSource();
        packedRefs.set(match![2]!, match![1]!);
      }
    }
    const lookup = (ref: string, seen = new Set<string>()): string | null => {
      if (seen.has(ref)) return null;
      seen.add(ref);
      const value = looseRefs.get(ref) ?? packedRefs.get(ref);
      if (!value) return null;
      if (value.startsWith("ref:")) return lookup(value.slice(4).trim(), seen);
      return validObjectId(value, objectFormat) ? value : null;
    };
    const revisions = new Set<string>();
    const namespace = scope === "mirror" ? "refs/remotes/origin/" : "refs/heads/";
    for (const ref of new Set([...looseRefs.keys(), ...packedRefs.keys()])) {
      if (!ref.startsWith(namespace)) continue;
      const revision = lookup(ref);
      if (!revision) unsafeGitSource();
      revisions.add(revision);
    }
    if (scope === "workspace") {
      const head = await readSafeTextFile(gitDir, "HEAD", 4096);
      if (!head) unsafeGitSource();
      const headValue = head.trim();
      const revision = headValue.startsWith("ref:")
        ? lookup(headValue.slice(4).trim())
        : validObjectId(headValue, objectFormat)
          ? headValue
          : null;
      if (!revision) unsafeGitSource();
      revisions.add(revision);
    }
    if (revisions.size > GIT_REF_SNAPSHOT_MAX_REVISIONS) unsafeGitSource();
    const objectDir = objects.handle;
    objects = null;
    return { objectDir, objectFingerprint, revisions: [...revisions].sort(), objectFormat };
  } catch (error) {
    if (error instanceof GitSourceValidationError) throw error;
    return unsafeGitSource();
  } finally {
    await info?.handle.close().catch(() => undefined);
    await refs?.handle.close().catch(() => undefined);
    await objects?.handle.close().catch(() => undefined);
  }
}

async function fingerprintGitObjects(
  objectDir: FileHandle,
  sharedBudget: SharedScanBudget,
  sourceLimits: GitSourceLimits,
) {
  assertSourceDeadline(sharedBudget);
  const root = await objectDir.stat();
  if (!root.isDirectory()) unsafeGitSource();
  const fingerprint: GitObjectFingerprintEntry[] = [];
  addFingerprint(fingerprint, ".", "directory", root);
  await inspectGitTree(objectDir, "", 0, { entries: 0 }, sharedBudget, fingerprint, sourceLimits);
  return fingerprint;
}

function sameObjectFingerprint(
  before: readonly GitObjectFingerprintEntry[],
  after: readonly GitObjectFingerprintEntry[],
) {
  return (
    before.length === after.length &&
    before.every((entry, index) => {
      const candidate = after[index];
      return candidate !== undefined &&
        entry.relativePath === candidate.relativePath && entry.type === candidate.type &&
        entry.dev === candidate.dev && entry.ino === candidate.ino &&
        entry.size === candidate.size && entry.mtimeMs === candidate.mtimeMs;
    })
  );
}

async function gitChildEnvironment(dataDir: string): Promise<NodeJS.ProcessEnv | null> {
  let root: SecureAnalyticsDirectory | null = null;
  let homeDirectory: SecureAnalyticsDirectory | null = null;
  try {
    root = await openSecureAnalyticsRoot(dataDir);
    homeDirectory = await root.openDirectory(["git-child-empty-home"]);
    const [rootPath, home, entries] = await Promise.all([
      realpath(root.fdPath),
      realpath(homeDirectory.fdPath),
      homeDirectory.list(),
    ]);
    if (!isInside(rootPath, home) || entries.length !== 0) return null;
    return {
      PATH: GIT_CHILD_PATH,
      HOME: home,
      XDG_CONFIG_HOME: home,
      LC_ALL: "C",
      LANG: "C",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
    };
  } catch {
    return null;
  } finally {
    await homeDirectory?.close().catch(() => undefined);
    await root?.close().catch(() => undefined);
  }
}

function scanLimits(overrides: Partial<ScanLimits> | undefined): ScanLimits {
  return {
    timeoutMs: overrides?.timeoutMs ?? SCAN_TIMEOUT_MS,
    maxStdoutBytes: overrides?.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
    maxRecords: overrides?.maxRecords ?? DEFAULT_MAX_RECORDS,
    maxCommits: overrides?.maxCommits ?? DEFAULT_MAX_COMMITS,
  };
}

function gitSourceLimits(overrides: Partial<GitSourceLimits> | undefined): GitSourceLimits {
  return {
    maxDepth: overrides?.maxDepth ?? GIT_SOURCE_MAX_DEPTH,
    maxEntries: overrides?.maxEntries ?? GIT_SOURCE_MAX_ENTRIES,
  };
}

async function createIsolatedGitDirectory(
  dataDir: string,
  objectFormat: "sha1" | "sha256",
): Promise<{ fd: number; cleanup: () => Promise<void> } | null> {
  let root: SecureAnalyticsDirectory | null = null;
  let directory: SecureAnalyticsDirectory | null = null;
  try {
    root = await openSecureAnalyticsRoot(dataDir);
    directory = await root.temporaryDirectory("git-scan");
    const objects = await directory.openDirectory(["objects"]);
    const refs = await directory.openDirectory(["refs"]);
    await objects.close(); await refs.close();
    await directory.writeExclusiveFile("HEAD", "ref: refs/heads/analytics-empty\n");
    const config = objectFormat === "sha256"
      ? "[core]\n\tbare = true\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n"
      : "[core]\n\tbare = true\n\trepositoryformatversion = 0\n";
    await directory.writeExclusiveFile("config", config);
    const retainedDirectory = directory; const retainedRoot = root;
    directory = null; root = null;
    return { fd: retainedDirectory.fd, cleanup: async () => {
      await retainedDirectory.deleteFile("HEAD").catch(() => undefined);
      await retainedDirectory.deleteFile("config").catch(() => undefined);
      for (const childName of ["objects", "refs"]) {
        const child = await retainedDirectory.openDirectory([childName], false).catch(() => null);
        await child?.close().catch(() => undefined);
        await rmdir(retainedDirectory.path(childName)).catch(() => undefined);
      }
      await retainedDirectory.removeTemporaryDirectory().catch(() => undefined);
      await retainedRoot.close().catch(() => undefined);
    } };
  } catch { return null; }
  finally { await directory?.close().catch(() => undefined); await root?.close().catch(() => undefined); }
}

/** Streams aggregate-only Git log output; stderr is intentionally never retained. */
async function readCommits(params: {
  gitDir: FileHandle;
  scope: GitRevisionScope;
  dataDir: string;
  repoId: string;
  secret: Buffer;
  authorEmail: string;
  coveredFrom: number;
  gitCommand: string;
  limits: ScanLimits;
  sharedBudget: SharedScanBudget;
  childEnv: NodeJS.ProcessEnv | null;
  sourceLimits: GitSourceLimits;
  afterSnapshotForTest?: (repoId: string, scope: GitRevisionScope) => void | Promise<void>;
  afterGitSpawnedForTest?: (repoId: string, scope: GitRevisionScope) => void | Promise<void>;
}): Promise<{ commits: ParsedCommit[] } | { error: ScanErrorCode }> {
  const {
    gitDir,
    scope,
    dataDir,
    repoId,
    secret,
    authorEmail,
    coveredFrom,
    gitCommand,
    limits,
    sharedBudget,
    childEnv,
    sourceLimits,
    afterSnapshotForTest,
    afterGitSpawnedForTest,
  } = params;
  if (!childEnv) {
    await gitDir.close().catch(() => undefined);
    return { error: "GIT_COMMAND_FAILED" };
  }
  let snapshot: GitSourceSnapshot;
  try {
    snapshot = await snapshotGitSource(gitDir, scope, sharedBudget, sourceLimits);
  } catch (error) {
    await gitDir.close().catch(() => undefined);
    return { error: error instanceof GitSourceValidationError ? error.code : "GIT_SOURCE_UNSAFE" };
  }
  await gitDir.close().catch(() => undefined);
  try {
    await afterSnapshotForTest?.(repoId, scope);
  } catch {
    await snapshot.objectDir.close().catch(() => undefined);
    return { error: "GIT_COMMAND_FAILED" };
  }
  const isolated = await createIsolatedGitDirectory(dataDir, snapshot.objectFormat);
  if (!isolated) {
    await snapshot.objectDir.close().catch(() => undefined);
    return { error: "GIT_COMMAND_FAILED" };
  }
  const args = [
    "--no-pager",
    `--git-dir=/proc/self/fd/${CHILD_GIT_DIR_FD}`,
    "log",
    "--stdin",
    `--since-as-filter=${new Date(coveredFrom).toISOString()}`,
    "--numstat",
    "--no-ext-diff",
    // NUL ends the header. Reject embedded line/field delimiters in untrusted
    // author metadata before parsing numstat; never pass the target email in argv.
    "--format=%x1e%H%x1f%ct%x1f%P%x1f%ae%x00",
  ];
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let child: ChildProcess | null = null;
    let failure: ScanErrorCode | null = null;
    let stdoutBytes = 0;
    let records = 0;
    let pending = "";
    let current: { identity: string | null; committedAt: number; parentCount: number } | null = null;
    let needsInitialRecordSeparator = true;
    const commits: ParsedCommit[] = [];
    const settle = (
      result: { commits: ParsedCommit[] } | { error: ScanErrorCode },
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Keep both descriptors alive until the child exits. The private Git-dir
      // contains no source refs/config; the object descriptor is the only
      // source FD inherited by Git.
      void snapshot.objectDir.close()
        .catch(() => undefined)
        .finally(() => isolated.cleanup())
        .catch(() => undefined)
        .finally(() => resolve(result));
    };
    const stop = (code: ScanErrorCode) => {
      if (failure) return;
      failure = code;
      child?.kill("SIGKILL");
    };

    const parseHeader = (header: string): boolean => {
      records += 1;
      sharedBudget.records += 1;
      if (
        records > limits.maxRecords ||
        sharedBudget.records > limits.maxRecords
      ) {
        stop("GIT_SCAN_BUDGET");
        return false;
      }
      const fields = header.split("\x1f");
      const [rawSha, seconds, parents, rawAuthor] = fields;
      if (fields.length !== 4 || !/^[0-9a-f]{40,64}$/i.test(rawSha ?? "") ||
          !/^\d+$/.test(seconds ?? "") || rawAuthor === undefined ||
          /[\x00-\x1f\x7f]/.test(rawAuthor)) {
        stop("GIT_SCAN_OUTPUT_INVALID");
        return false;
      }
      // Git permits an empty author address ("<>"). It is a valid record,
      // but cannot match a configured email; never reject the whole Repo for it.
      const candidate = normalizeAuthorEmail(rawAuthor);
      const parentCount = parents.trim()
        ? parents.trim().split(/\s+/).length
        : 0;
      // rawSha has no reference after this expression: it is neither returned,
      // persisted nor retained while numstat output is still being streamed.
      current = {
        identity: candidate === authorEmail ? gitCommitIdentity(secret, repoId, rawSha!) : null,
        committedAt: Number(seconds) * 1000,
        parentCount,
      };
      return true;
    };
    const finishCurrent = (stats: string): boolean => {
      if (!current) return stats.trim() === "";
      // The only NUL in the expected stream terminates each Git header. A
      // second one here means malformed output (including an injected NUL in
      // author metadata), even when this particular author does not match.
      if (stats.includes("\0")) {
        stop("GIT_SCAN_OUTPUT_INVALID");
        return false;
      }
      if (current.identity === null) {
        current = null;
        return true;
      }
      if (
        commits.length >= limits.maxCommits ||
        sharedBudget.commits >= limits.maxCommits
      ) {
        stop("GIT_SCAN_BUDGET");
        return false;
      }
      let filesChanged = 0;
      let insertions = 0;
      let deletions = 0;
      if (current.parentCount <= 1) {
        for (const line of stats.split("\n")) {
          const [added, deleted] = line.split("\t");
          if (added === undefined || deleted === undefined) continue;
          filesChanged += 1;
          if (/^\d+$/.test(added)) insertions += Number(added);
          if (/^\d+$/.test(deleted)) deletions += Number(deleted);
        }
      }
      commits.push({
        identity: current.identity,
        committedAt: current.committedAt,
        parentCount: current.parentCount,
        filesChanged: current.parentCount > 1 ? null : filesChanged,
        insertions: current.parentCount > 1 ? null : insertions,
        deletions: current.parentCount > 1 ? null : deletions,
      });
      sharedBudget.commits += 1;
      current = null;
      return true;
    };
    const consume = (closed: boolean): boolean => {
      while (!failure) {
        if (!current) {
          if (needsInitialRecordSeparator) {
            if (pending === "") return true;
            if (!pending.startsWith("\x1e")) {
              stop("GIT_SCAN_OUTPUT_INVALID");
              return false;
            }
            pending = pending.slice(1);
            needsInitialRecordSeparator = false;
          }
          if (pending === "") return true;
          const endHeader = pending.indexOf("\0");
          // A malicious author address must not be able to inject a record
          // separator, numstat line, or an extra header field.
          if (endHeader !== -1 && /[\n\r\x1e]/.test(pending.slice(0, endHeader))) {
            stop("GIT_SCAN_OUTPUT_INVALID");
            return false;
          }
          if (endHeader === -1 || pending.length === endHeader + 1) {
            if (closed) {
              stop("GIT_SCAN_OUTPUT_INVALID");
              return false;
            }
            return true;
          }
          if (pending[endHeader + 1] !== "\n" || !parseHeader(pending.slice(0, endHeader))) {
            stop("GIT_SCAN_OUTPUT_INVALID");
            return false;
          }
          pending = pending.slice(endHeader + 2);
          continue;
        }
        const nextRecord = pending.indexOf("\x1e");
        if (nextRecord === -1) {
          if (!closed) return true;
          return finishCurrent(pending);
        }
        if (!finishCurrent(pending.slice(0, nextRecord))) return false;
        pending = pending.slice(nextRecord + 1);
      }
      return false;
    };
    try {
      child = spawn(gitCommand, args, {
        // fd 3 is a scan-private Git directory; fd 4 is the validated object
        // source. No original refs/config path is visible to this child.
        stdio: ["pipe", "pipe", "ignore", isolated.fd, snapshot.objectDir.fd],
        env: {
          ...childEnv,
          GIT_OBJECT_DIRECTORY: "/proc/self/fd/4",
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
      });
    } catch {
      settle({ error: "GIT_COMMAND_FAILED" });
      return;
    }
    const activeChild = child;
    activeChild.on("error", () => {
      failure ??= "GIT_COMMAND_FAILED";
    });
    activeChild.on("close", (code) => void (async () => {
      if (failure) return settle({ error: failure });
      if (code !== 0 || !consume(true))
        return settle({ error: failure ?? "GIT_COMMAND_FAILED" });
      try {
        const after = await fingerprintGitObjects(snapshot.objectDir, sharedBudget, sourceLimits);
        if (!sameObjectFingerprint(snapshot.objectFingerprint, after))
          return settle({ error: "GIT_SOURCE_UNSAFE" });
      } catch (error) {
        return settle({
          error: error instanceof GitSourceValidationError ? error.code : "GIT_SOURCE_UNSAFE",
        });
      }
      settle({ commits });
    })());
    const remainingMs = Math.min(
      limits.timeoutMs,
      sharedBudget.deadlineAt - Date.now(),
    );
    if (remainingMs <= 0) return stop("GIT_SCAN_TIMEOUT");
    timer = setTimeout(() => stop("GIT_SCAN_TIMEOUT"), remainingMs);
    if (!activeChild.stdout) return stop("GIT_COMMAND_FAILED");
    if (!activeChild.stdin) return stop("GIT_COMMAND_FAILED");
    const sendSnapshot = async () => {
      try {
        await afterGitSpawnedForTest?.(repoId, scope);
        activeChild.stdin?.end(
          snapshot.revisions.length ? `${snapshot.revisions.join("\n")}\n` : "",
        );
      } catch {
        stop("GIT_COMMAND_FAILED");
      }
    };
    activeChild.stdin.on("error", () => stop("GIT_COMMAND_FAILED"));
    // Revision IDs are intentionally supplied only on stdin. The child sees
    // neither source refs nor a source config after this point.
    void sendSnapshot();

    activeChild.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      sharedBudget.stdoutBytes += chunk.length;
      if (
        stdoutBytes > limits.maxStdoutBytes ||
        sharedBudget.stdoutBytes > limits.maxStdoutBytes
      ) {
        stop("GIT_SCAN_BUDGET");
        return;
      }
      pending += chunk.toString("utf8");
      if (Buffer.byteLength(pending) > limits.maxStdoutBytes) {
        stop("GIT_SCAN_BUDGET");
        return;
      }
      consume(false);
    });
  });
}

function controlledManagedRepo(row: unknown): SafeRepo | null {
  if (typeof row !== "object" || row === null) return null;
  const value = row as { id?: unknown; syncStatus?: unknown; credentialId?: unknown };
  if (typeof value.id !== "string" || typeof value.credentialId !== "string") return null;
  if (
    value.syncStatus === "idle" ||
    value.syncStatus === "syncing" ||
    value.syncStatus === "failed"
  ) {
    return { id: value.id, syncStatus: value.syncStatus, credentialId: value.credentialId };
  }
  // A malformed business status is never eligible for a path-based scan.
  return { id: value.id, syncStatus: "failed", credentialId: value.credentialId };
}

// The Settings global Git identity is deliberately distinct from a Workspace's
// effective (repo-local-first) identity and the isolated git-log child config.
async function configuredAuthorEmail(dataDir: string): Promise<string | null> {
  return normalizeAuthorEmail(await gitConfigGet({ cwd: dataDir, global: true, key: "user.email" }));
}

function normalizeAuthorEmail(value: string | null): string | null {
  if (value === null) return null;
  const email = value.trim();
  if (!email || /[\x00-\x1f\x7f]/.test(email)) return null;
  return email.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function readManagedRepos(dataDir: string): SafeRepo[] | null {
  try {
    const business = new Database(dbPath(dataDir), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return business
        // A host-default credential does not opt a Repo into personal stats.
        // Never load credential secrets into the Analytics worker.
        .prepare(`SELECT r.id, r.sync_status AS syncStatus, r.credential_id AS credentialId
          FROM repos r JOIN credentials c ON c.id=r.credential_id WHERE r.credential_id IS NOT NULL`)
        .all()
        .flatMap((row) => {
          const repo = controlledManagedRepo(row);
          return repo ? [repo] : [];
        });
    } finally {
      business.close();
    }
  } catch {
    return null;
  }
}

function readWorkspaceLocators(
  dataDir: string,
  repoId: string,
): WorkspaceLocator[] | null {
  try {
    const business = new Database(dbPath(dataDir), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return business
        .prepare(
          `SELECT w.dir_name AS workspaceDir, wr.dir_name AS repoDir
        FROM workspace_repos wr JOIN workspaces w ON w.id=wr.workspace_id WHERE wr.repo_id=? ORDER BY w.dir_name,wr.dir_name`,
        )
        .all(repoId)
        .map((row) => {
          const value = row as { workspaceDir?: unknown; repoDir?: unknown };
          if (
            typeof value.workspaceDir !== "string" ||
            typeof value.repoDir !== "string"
          )
            throw new Error("invalid workspace locator");
          return { workspaceDir: value.workspaceDir, repoDir: value.repoDir };
        });
    } finally {
      business.close();
    }
  } catch {
    return null;
  }
}

function reconcileManagedRepos(db: AnalyticsDb, repos: readonly SafeRepo[]) {
  db.transaction(() => {
    if (repos.length === 0) {
      db.prepare("DELETE FROM analytics_git_membership").run();
      db.prepare("DELETE FROM analytics_git_repo_state").run();
      return;
    }
    const placeholders = repos.map(() => "?").join(",");
    const ids = repos.map((repo) => repo.id);
    db.prepare(
      `DELETE FROM analytics_git_membership WHERE repo_id NOT IN (${placeholders})`,
    ).run(...ids);
    db.prepare(
      `DELETE FROM analytics_git_repo_state WHERE repo_id NOT IN (${placeholders})`,
    ).run(...ids);
  })();
}

function ensureManagedRepoStates(db: AnalyticsDb, repos: readonly SafeRepo[]) {
  const insertState =
    db.prepare(`INSERT INTO analytics_git_repo_state(repo_id,current_scan_id,covered_from,covered_to,last_ready_at,last_scan_at)
    VALUES(?,NULL,NULL,NULL,NULL,NULL) ON CONFLICT(repo_id) DO NOTHING`);
  for (const repo of repos) insertState.run(repo.id);
}

function beginScan(
  db: AnalyticsDb,
  scanId: string,
  repoId: string,
  now: number,
) {
  db.transaction(() => {
    db.prepare(
      "UPDATE analytics_git_scan SET source_state='failed', completed_at=?, safe_error_code='GIT_SCAN_SUPERSEDED' WHERE repo_id=? AND source_state='running'",
    ).run(now, repoId);
    db.prepare(
      "INSERT INTO analytics_git_scan(scan_id,repo_id,started_at,completed_at,source_state,covered_from,covered_to,safe_error_code) VALUES(?,?,?,NULL,'running',NULL,NULL,NULL)",
    ).run(scanId, repoId, now);
  })();
}

function failScan(
  db: AnalyticsDb,
  scanId: string,
  repoId: string,
  completedAt: number,
  code: ScanErrorCode,
) {
  db.transaction(() => {
    db.prepare(
      "UPDATE analytics_git_scan SET source_state='failed', completed_at=?, safe_error_code=? WHERE scan_id=? AND source_state='running'",
    ).run(completedAt, code, scanId);
    db.prepare(
      "UPDATE analytics_git_repo_state SET last_scan_at=? WHERE repo_id=?",
    ).run(completedAt, repoId);
  })();
}

function commitReadyScan(
  db: AnalyticsDb,
  input: {
    scanId: string;
    repoId: string;
    completedAt: number;
    coveredFrom: number;
    sourceAnchor: number;
    commits: readonly ParsedCommit[];
    configRevision: string;
  },
) {
  return db.transaction(() => {
    const currentConfig = readCurrentFactDomainConfig(db);
    if (
      currentConfig.revision !== input.configRevision ||
      !currentConfig.enabled.has("git")
    ) {
      db.prepare(
        "UPDATE analytics_git_scan SET source_state='failed', completed_at=?, safe_error_code='GIT_SCAN_SUPERSEDED' WHERE scan_id=? AND source_state='running'",
      ).run(input.completedAt, input.scanId);
      return false;
    }
    const fact = db.prepare(
      "INSERT INTO analytics_git_commit_fact(repo_id,commit_identity,committed_at,parent_count,files_changed,insertions,deletions,collected_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(repo_id,commit_identity) DO NOTHING",
    );
    const membership = db.prepare(
      "INSERT INTO analytics_git_membership(scan_id,repo_id,commit_identity) VALUES(?,?,?)",
    );
    for (const commit of input.commits) {
      fact.run(
        input.repoId,
        commit.identity,
        commit.committedAt,
        commit.parentCount,
        commit.filesChanged,
        commit.insertions,
        commit.deletions,
        input.completedAt,
      );
      membership.run(input.scanId, input.repoId, commit.identity);
    }
    db.prepare(
      "UPDATE analytics_git_scan SET source_state='ready', completed_at=?, covered_from=?, covered_to=?, safe_error_code=NULL WHERE scan_id=? AND source_state='running'",
    ).run(
      input.completedAt,
      input.coveredFrom,
      input.sourceAnchor,
      input.scanId,
    );
    db.prepare(
      `INSERT INTO analytics_git_repo_state(repo_id,current_scan_id,covered_from,covered_to,last_ready_at,last_scan_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id) DO UPDATE SET current_scan_id=excluded.current_scan_id,
      covered_from=excluded.covered_from, covered_to=excluded.covered_to, last_ready_at=excluded.last_ready_at, last_scan_at=excluded.last_scan_at`,
    ).run(
      input.repoId,
      input.scanId,
      input.coveredFrom,
      input.sourceAnchor,
      input.completedAt,
      input.completedAt,
    );
    // Facts are retained for collected-at accounting and retention; only the
    // current-membership projection changes after a rebase or force-push.
    db.prepare(
      "DELETE FROM analytics_git_membership WHERE repo_id=? AND scan_id<>?",
    ).run(input.repoId, input.scanId);
    return true;
  })();
}

type GitRepoState = {
  current_scan_id: string | null;
  covered_from: number | null;
  covered_to: number | null;
  last_ready_at: number | null;
};
type LastGitScan = { source_state: "running" | "ready" | "failed" } | undefined;

function updateGitDomainState(
  db: AnalyticsDb,
  repos: readonly SafeRepo[],
  observedAt: number,
) {
  const state = db.prepare(
    "SELECT current_scan_id,covered_from,covered_to,last_ready_at FROM analytics_git_repo_state WHERE repo_id=?",
  );
  const currentGeneration = db.prepare(
    "SELECT source_state FROM analytics_git_scan WHERE scan_id=? AND repo_id=?",
  );
  const lastScan = db.prepare(
    "SELECT source_state FROM analytics_git_scan WHERE repo_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1",
  );
  const rows = repos.map((repo) => {
    const repoState = state.get(repo.id) as GitRepoState | undefined;
    return {
      repo,
      state: repoState,
      currentGeneration:
        repoState?.current_scan_id === null
          ? undefined
          : (currentGeneration.get(
              repoState?.current_scan_id,
              repo.id,
            ) as LastGitScan),
      lastScan: lastScan.get(repo.id) as LastGitScan,
    };
  });
  const current = rows.filter(
    (
      row,
    ): row is {
      repo: SafeRepo;
      state: GitRepoState;
      currentGeneration: LastGitScan;
      lastScan: LastGitScan;
    } => {
      const candidate = row.state;
      return (
        candidate !== undefined &&
        candidate.current_scan_id !== null &&
        candidate.covered_from !== null &&
        candidate.covered_to !== null &&
        candidate.last_ready_at !== null &&
        row.currentGeneration?.source_state === "ready"
      );
    },
  );
  const allCurrent = current.length === rows.length;
  const failed = rows.some(
    ({ repo, lastScan: latest }) =>
      repo.syncStatus === "failed" || latest?.source_state === "failed",
  );
  const notReady =
    !allCurrent ||
    rows.some(({ lastScan: latest }) => latest?.source_state === "running");
  const stale = current.some(
    ({ state }) => observedAt - state!.last_ready_at! > GIT_FRESHNESS_MS,
  );
  const healthy = !notReady && !failed && !stale;
  const reconciledThrough = allCurrent
    ? Math.min(...current.map(({ state }) => state!.covered_to!))
    : null;
  const collectionStartedAt = allCurrent
    ? Math.min(...current.map(({ state }) => state!.covered_from!))
    : null;
  const lastSucceededAt = healthy
    ? Math.min(...current.map(({ state }) => state!.last_ready_at!))
    : null;
  const error = healthy
    ? null
    : failed
      ? "GIT_SCAN_FAILED"
      : notReady
        ? "GIT_REPO_NOT_READY"
        : "GIT_SCAN_STALE";
  db.prepare(
    `UPDATE analytics_domain_state SET status=?, collection_started_at=CASE WHEN ? IS NULL THEN collection_started_at ELSE COALESCE(collection_started_at,?) END,
    reconciled_through=?, last_succeeded_at=COALESCE(?,last_succeeded_at), last_error_code=?, updated_at=? WHERE domain='git'`,
  ).run(
    healthy ? "healthy" : "degraded",
    collectionStartedAt,
    collectionStartedAt,
    reconciledThrough,
    lastSucceededAt,
    error,
    observedAt,
  );
}

/** Runs only in the Analytics child and never exposes Git paths, stderr, refs, or SHA values. */
export async function scanManagedGitRepos(params: {
  db: AnalyticsDb;
  dataDir: string;
  now?: number;
  gitCommand?: string;
  limits?: Partial<ScanLimits>;
  /** Internal test seam; production reads the same global identity as Settings. */
  readGlobalEmail?: () => Promise<string | null>;
  /** Internal deterministic test seam for bounded source-tree validation. */
  sourceLimitsForTest?: Partial<GitSourceLimits>;
  clock?: () => number;
  /** Internal deterministic test seam, called after the stable mirror FD is open. */
  afterMirrorOpenedForTest?: (repoId: string) => void | Promise<void>;
  /** Internal deterministic test seam. The descriptor is already fixed. */
  afterWorkspaceGitOpenedForTest?: (repoId: string) => void | Promise<void>;
  /** Internal test seam, called after refs/config snapshot and source FD close. */
  afterSourceSnapshotForTest?: (repoId: string, scope: GitRevisionScope) => void | Promise<void>;
  /** Internal test seam, called after Git spawn but before snapshot stdin. */
  afterGitSpawnedForTest?: (repoId: string, scope: GitRevisionScope) => void | Promise<void>;
}) {
  const { db, dataDir, now, gitCommand = "git" } = params;
  const clock = params.clock ?? (() => now ?? Date.now());
  const readGlobalEmail = params.readGlobalEmail ?? (() => configuredAuthorEmail(dataDir));
  const config = readCurrentFactDomainConfig(db);
  if (!config.enabled.has("git")) return { attempted: 0, succeeded: 0 };
  // The source anchor describes the intended Git range. It is deliberately
  // distinct from per-repo start, completion, and Fact collected timestamps.
  const sourceAnchor = now ?? clock();
  const repos = readManagedRepos(dataDir);
  if (!repos) {
    db.prepare(
      "UPDATE analytics_domain_state SET status='degraded', last_error_code='GIT_REPO_SOURCE_UNAVAILABLE', updated_at=? WHERE domain='git'",
    ).run(clock());
    return { attempted: 0, succeeded: 0 };
  }
  // Keep the previous snapshot until this scheduled scan cycle. Missing global
  // identity cannot certify an exact zero, even if managed repos still exist.
  const authorEmail = normalizeAuthorEmail(await readGlobalEmail());
  const eligibleRepos = authorEmail === null ? [] : repos;
  reconcileManagedRepos(db, eligibleRepos);
  if (authorEmail === null || eligibleRepos.length === 0) {
    db.prepare(
      "UPDATE analytics_domain_state SET status='unavailable', reconciled_through=NULL, last_succeeded_at=NULL, last_error_code=?, updated_at=? WHERE domain='git'",
    ).run(authorEmail === null ? "GIT_IDENTITY_UNAVAILABLE" : "GIT_NO_ELIGIBLE_REPOS", clock());
    return { attempted: 0, succeeded: 0 };
  }
  const secret = await readOrCreateGitInstallationSecret(dataDir, db);
  ensureManagedRepoStates(db, eligibleRepos);
  if (!secret) {
    db.prepare(
      "UPDATE analytics_domain_state SET status='unavailable', reconciled_through=NULL, last_error_code='GIT_SECRET_UNAVAILABLE', updated_at=? WHERE domain='git'",
    ).run(clock());
    return { attempted: 0, succeeded: 0 };
  }

  const childEnv = await gitChildEnvironment(dataDir);
  const coveredFrom = Math.max(0, sourceAnchor - GIT_RETENTION_MS);
  let attempted = 0;
  let succeeded = 0;
  for (const repo of eligibleRepos) {
    if (repo.syncStatus !== "idle") continue;
    if (inFlightRepoIds.has(repo.id)) continue;
    attempted += 1;
    inFlightRepoIds.add(repo.id);
    const scanId = randomBytes(16).toString("hex");
    const scanStartedAt = clock();
    const limits = scanLimits(params.limits);
    const sourceLimits = gitSourceLimits(params.sourceLimitsForTest);
    // All sources contributing to one Repo snapshot share a hard wall-clock,
    // output, record and commit budget. A growing workspace set must never
    // turn one low-frequency scan into an unbounded serial operation.
    const sharedBudget: SharedScanBudget = {
      deadlineAt: Date.now() + limits.timeoutMs,
      stdoutBytes: 0,
      records: 0,
      commits: 0,
    };
    try {
      beginScan(db, scanId, repo.id, scanStartedAt);
      // A locator query is part of the source snapshot. Treat any database
      // failure as a failed scan rather than silently publishing mirror-only
      // coverage that omits a Workspace's reachable history.
      const locators = readWorkspaceLocators(dataDir, repo.id);
      if (locators === null) {
        failScan(
          db,
          scanId,
          repo.id,
          Math.max(scanStartedAt, clock()),
          "GIT_MIRROR_UNSAFE",
        );
        continue;
      }
      const mirror = await openSafeMirrorDirectory(dataDir, repo.id);
      if (!mirror) {
        failScan(
          db,
          scanId,
          repo.id,
          Math.max(scanStartedAt, clock()),
          "GIT_MIRROR_UNSAFE",
        );
        continue;
      }
      try {
        await params.afterMirrorOpenedForTest?.(repo.id);
      } catch (error) {
        await mirror.close().catch(() => undefined);
        throw error;
      }
      const mirrorResult = await readCommits({
        gitDir: mirror,
        scope: "mirror",
        dataDir,
        repoId: repo.id,
        secret,
        authorEmail,
        coveredFrom,
        gitCommand,
        limits,
        sharedBudget,
        childEnv,
        sourceLimits,
        afterSnapshotForTest: params.afterSourceSnapshotForTest,
        afterGitSpawnedForTest: params.afterGitSpawnedForTest,
      });
      if ("error" in mirrorResult) {
        failScan(
          db,
          scanId,
          repo.id,
          Math.max(scanStartedAt, clock()),
          mirrorResult.error,
        );
        continue;
      }
      const commits = new Map(
        mirrorResult.commits.map((commit) => [commit.identity, commit]),
      );
      let workspaceError: ScanErrorCode | null = null;
      for (const locator of locators) {
        if (Date.now() >= sharedBudget.deadlineAt) {
          workspaceError = "GIT_SCAN_TIMEOUT";
          break;
        }
        const gitDir = await openSafeWorkspaceGitDirectory(dataDir, locator);
        if (!gitDir) {
          workspaceError = "GIT_COMMAND_FAILED";
          break;
        }
        try {
          await params.afterWorkspaceGitOpenedForTest?.(repo.id);
        } catch (error) {
          await gitDir.close().catch(() => undefined);
          throw error;
        }
        const result = await readCommits({
          gitDir,
          scope: "workspace",
          dataDir,
          repoId: repo.id,
          secret,
          authorEmail,
          coveredFrom,
          gitCommand,
          limits,
          sharedBudget,
          childEnv,
          sourceLimits,
          afterSnapshotForTest: params.afterSourceSnapshotForTest,
          afterGitSpawnedForTest: params.afterGitSpawnedForTest,
        });
        if ("error" in result) {
          workspaceError = result.error;
          break;
        }
        for (const commit of result.commits) {
          const previous = commits.get(commit.identity);
          if (
            previous &&
            (previous.committedAt !== commit.committedAt ||
              previous.parentCount !== commit.parentCount ||
              previous.filesChanged !== commit.filesChanged ||
              previous.insertions !== commit.insertions ||
              previous.deletions !== commit.deletions)
          ) {
            workspaceError = "GIT_SCAN_OUTPUT_INVALID";
            break;
          }
          commits.set(commit.identity, commit);
        }
        if (workspaceError) break;
      }
      if (workspaceError) {
        failScan(
          db,
          scanId,
          repo.id,
          Math.max(scanStartedAt, clock()),
          workspaceError,
        );
        continue;
      }
      // Best-effort check immediately before publishing: observable changes
      // supersede this scan and preserve the previous ready generation. Git
      // config and the business DB cannot be atomically read with the Analytics
      // publish transaction; a change after this check is fixed by a later scan.
      const currentEmail = normalizeAuthorEmail(await readGlobalEmail());
      const currentRepo = readManagedRepos(dataDir)?.find((item) => item.id === repo.id);
      if (currentEmail !== authorEmail || currentRepo?.credentialId !== repo.credentialId ||
          currentRepo?.syncStatus !== "idle") {
        failScan(db, scanId, repo.id, Math.max(scanStartedAt, clock()), "GIT_SCAN_SUPERSEDED");
        continue;
      }
      const completedAt = Math.max(scanStartedAt, clock());
      if (
        commitReadyScan(db, {
          scanId,
          repoId: repo.id,
          completedAt,
          sourceAnchor,
          coveredFrom,
          commits: [...commits.values()],
          configRevision: config.revision,
        })
      )
        succeeded += 1;
    } catch {
      try {
        failScan(
          db,
          scanId,
          repo.id,
          Math.max(scanStartedAt, clock()),
          "GIT_COMMAND_FAILED",
        );
      } catch {
        /* DB isolation: preserve the caller's business flow. */
      }
    } finally {
      inFlightRepoIds.delete(repo.id);
    }
  }

  const finalConfig = readCurrentFactDomainConfig(db);
  if (
    finalConfig.revision === config.revision &&
    finalConfig.enabled.has("git")
  )
    updateGitDomainState(db, eligibleRepos, clock());
  return { attempted, succeeded };
}
