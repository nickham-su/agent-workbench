import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  compareWorkspaceRelativePathsUtf8,
  parseExternalWorkspaceSkillId,
  parseWorkspaceAgentsInstructionPath,
  parseWorkspaceRelativePosixPath,
} from "@agent-workbench/shared";

export const WORKSPACE_CONTEXT_SCAN_MAX_PARENT_DEPTH = 4;
const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", ".agent-workbench"]);

export type WorkspaceContextFileDiscovery = {
  skills: Array<{ skillId: string; skillFilePath: string }>;
  agentsInstructions: Array<{ path: string }>;
};

// Optional file-system port makes replacement races deterministic in tests; production uses fs/promises.
export type WorkspaceContextScanFileSystem = {
  lstat(entryPath: string): Promise<Stats>;
  realpath(entryPath: string): Promise<string>;
  readdir(dirPath: string): Promise<Dirent[]>;
};

const defaultFileSystem: WorkspaceContextScanFileSystem = {
  lstat: (entryPath) => fs.lstat(entryPath),
  realpath: (entryPath) => fs.realpath(entryPath),
  readdir: (dirPath) => fs.readdir(dirPath, { withFileTypes: true }),
};

/** A scan failure never carries an absolute filesystem path into the caller's response. */
export class WorkspaceContextScanError extends Error {
  readonly code = "WORKSPACE_CONTEXT_SCAN_FAILED";
  constructor() {
    super("Workspace context scan failed");
    this.name = "WorkspaceContextScanError";
  }
}

function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function scanFs<T>(action: () => Promise<T>, allowGone: boolean): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    if (allowGone && isGone(error)) return undefined;
    throw new WorkspaceContextScanError();
  }
}

function contained(rootRealPath: string, realPath: string): boolean {
  const relative = path.relative(rootRealPath, realPath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

type DirectoryIdentity = Pick<Stats, "dev" | "ino">;

function sameIdentity(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** The first observation of an ineligible directory is skipped. A changed observed directory fails the whole scan. */
async function checkedDirectory(
  fileSystem: WorkspaceContextScanFileSystem,
  entryPath: string,
  rootRealPath: string,
  expected?: DirectoryIdentity,
): Promise<DirectoryIdentity | null> {
  const before = await scanFs(() => fileSystem.lstat(entryPath), true);
  if (!before) return null; // ENOENT/ENOTDIR: a naturally vanished entry.
  if (expected && !sameIdentity(before, expected)) throw new WorkspaceContextScanError();
  if (before.isSymbolicLink() || !before.isDirectory()) {
    if (expected) throw new WorkspaceContextScanError();
    return null;
  }
  const real = await scanFs(() => fileSystem.realpath(entryPath), true);
  if (!real) return null;
  if (!contained(rootRealPath, real)) {
    if (expected) throw new WorkspaceContextScanError();
    return null;
  }
  const after = await scanFs(() => fileSystem.lstat(entryPath), true);
  if (!after) return null;
  if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(before, after)) {
    throw new WorkspaceContextScanError();
  }
  return { dev: after.dev, ino: after.ino };
}

async function checkedFile(
  fileSystem: WorkspaceContextScanFileSystem,
  entryPath: string,
  rootRealPath: string,
): Promise<boolean> {
  const before = await scanFs(() => fileSystem.lstat(entryPath), true);
  if (!before || before.isSymbolicLink() || !before.isFile()) return false;
  const real = await scanFs(() => fileSystem.realpath(entryPath), true);
  if (!real || !contained(rootRealPath, real)) return false;
  const after = await scanFs(() => fileSystem.lstat(entryPath), true);
  return Boolean(after && !after.isSymbolicLink() && after.isFile() && sameIdentity(before, after));
}

type Frame = {
  absDir: string;
  relativeDir: string;
  depth: number;
  skillBlockedByAncestor: boolean;
  identity: DirectoryIdentity;
};

/** Metadata-only discovery: this function never reads SKILL.md or AGENTS.md contents. */
export async function discoverWorkspaceContextFiles(
  workspacePath: string,
  fileSystem: WorkspaceContextScanFileSystem = defaultFileSystem,
): Promise<WorkspaceContextFileDiscovery> {
  const rootStat = await scanFs(() => fileSystem.lstat(workspacePath), false);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new WorkspaceContextScanError();
  const rootRealPath = await scanFs(() => fileSystem.realpath(workspacePath), false);
  if (!rootRealPath) throw new WorkspaceContextScanError();
  const rootIdentity = await checkedDirectory(fileSystem, workspacePath, rootRealPath, rootStat);
  if (!rootIdentity) throw new WorkspaceContextScanError();

  const skills: WorkspaceContextFileDiscovery["skills"] = [];
  const agentsInstructions: WorkspaceContextFileDiscovery["agentsInstructions"] = [];
  const stack: Frame[] = [{
    absDir: workspacePath, relativeDir: "", depth: 0, skillBlockedByAncestor: false, identity: rootIdentity,
  }];

  while (stack.length) {
    const frame = stack.pop()!;
    // Validate the exact queued directory both before and after reading it.
    if (!(await checkedDirectory(fileSystem, frame.absDir, rootRealPath, frame.identity))) {
      if (frame.depth === 0) throw new WorkspaceContextScanError();
      continue;
    }
    const entries = await scanFs(() => fileSystem.readdir(frame.absDir), frame.depth !== 0);
    if (!entries) continue;
    if (!(await checkedDirectory(fileSystem, frame.absDir, rootRealPath, frame.identity))) {
      if (frame.depth === 0) throw new WorkspaceContextScanError();
      continue;
    }
    entries.sort((a, b) => compareWorkspaceRelativePathsUtf8(a.name, b.name));
    let registeredSkillHere = false;
    if (frame.depth > 0 && !frame.skillBlockedByAncestor) {
      const id = parseExternalWorkspaceSkillId(frame.relativeDir);
      if (id && entries.some((entry) => entry.name === "SKILL.md")
        && await checkedFile(fileSystem, path.join(frame.absDir, "SKILL.md"), rootRealPath)) {
        skills.push({ skillId: id.path, skillFilePath: `${id.path}/SKILL.md` });
        registeredSkillHere = true;
      }
    }

    const agentsPath = frame.relativeDir ? `${frame.relativeDir}/AGENTS.md` : "AGENTS.md";
    if (parseWorkspaceAgentsInstructionPath(agentsPath) && entries.some((entry) => entry.name === "AGENTS.md")
      && await checkedFile(fileSystem, path.join(frame.absDir, "AGENTS.md"), rootRealPath)) {
      agentsInstructions.push({ path: agentsPath });
    }

    if (frame.depth === WORKSPACE_CONTEXT_SCAN_MAX_PARENT_DEPTH) continue;
    // LIFO stack: push reverse UTF-8 order so traversal and output are deterministic.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (IGNORED_DIRECTORY_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
      // Files and special types cannot be directories. Unknown Dirent types still need lstat.
      if (entry.isFile() || entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket()) continue;
      const childRelative = frame.relativeDir ? `${frame.relativeDir}/${entry.name}` : entry.name;
      if (!parseWorkspaceRelativePosixPath(childRelative)) continue;
      const absDir = path.join(frame.absDir, entry.name);
      const identity = await checkedDirectory(fileSystem, absDir, rootRealPath);
      if (!identity) continue;
      stack.push({
        absDir,
        relativeDir: childRelative,
        depth: frame.depth + 1,
        skillBlockedByAncestor: frame.skillBlockedByAncestor || registeredSkillHere,
        identity,
      });
    }
  }

  skills.sort((a, b) => compareWorkspaceRelativePathsUtf8(a.skillId, b.skillId));
  agentsInstructions.sort((a, b) => compareWorkspaceRelativePathsUtf8(a.path, b.path));
  return { skills, agentsInstructions };
}
