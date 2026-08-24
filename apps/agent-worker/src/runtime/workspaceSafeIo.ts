import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type SafeWorkspace = {
  workspacePath: string;
  workspaceRealPath: string;
};

export type WorkspaceSafeIo = {
  lstat: typeof fs.lstat;
  mkdir: typeof fs.mkdir;
  realpath: typeof fs.realpath;
};

const defaultIo: WorkspaceSafeIo = {
  lstat: fs.lstat,
  mkdir: fs.mkdir,
  realpath: fs.realpath
};

export function safePathSegment(input: unknown) {
  const normalized = String(input || "").trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return (normalized || "unknown").slice(0, 120);
}

export function isPathInside(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function assertDirectory(stat: Awaited<ReturnType<typeof fs.lstat>>, targetPath: string) {
  if (stat.isSymbolicLink()) throw new Error(`unsafe symbolic link in workspace path: ${targetPath}`);
  if (!stat.isDirectory()) throw new Error(`workspace path segment is not a directory: ${targetPath}`);
}

function assertContained(rootPath: string, targetPath: string) {
  if (!isPathInside(rootPath, targetPath)) {
    throw new Error(`workspace path escapes workspace root: ${targetPath}`);
  }
}

export async function resolveSafeWorkspace(workspacePath: string, io: WorkspaceSafeIo = defaultIo): Promise<SafeWorkspace> {
  const resolved = path.resolve(workspacePath);
  const stat = await io.lstat(resolved);
  assertDirectory(stat, resolved);
  const real = await io.realpath(resolved);
  return { workspacePath: resolved, workspaceRealPath: real };
}

/**
 * Creates and revalidates every directory segment below an existing workspace.
 * The returned directory has been realpath-checked to remain below the workspace.
 */
export async function ensureSafeDirectoryUnderWorkspace(
  workspace: SafeWorkspace,
  segments: readonly string[],
  io: WorkspaceSafeIo = defaultIo
): Promise<string> {
  let currentPath = workspace.workspacePath;
  let currentRealPath = workspace.workspaceRealPath;

  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes(path.sep)) {
      throw new Error(`unsafe workspace path segment: ${segment}`);
    }

    const nextPath = path.resolve(currentPath, segment);
    assertContained(workspace.workspacePath, nextPath);
    assertContained(workspace.workspaceRealPath, currentRealPath);

    try {
      const stat = await io.lstat(nextPath);
      assertDirectory(stat, nextPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await io.mkdir(nextPath, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isMissing(mkdirError) && !(mkdirError && typeof mkdirError === "object" && (mkdirError as NodeJS.ErrnoException).code === "EEXIST")) {
          throw mkdirError;
        }
      }
      const stat = await io.lstat(nextPath);
      assertDirectory(stat, nextPath);
    }

    const nextRealPath = await io.realpath(nextPath);
    assertContained(workspace.workspaceRealPath, nextRealPath);
    currentPath = nextPath;
    currentRealPath = nextRealPath;
  }

  return currentPath;
}

export async function assertSafeRegularFile(
  workspace: SafeWorkspace,
  filePath: string,
  io: Pick<WorkspaceSafeIo, "lstat" | "realpath"> = defaultIo
) {
  const resolved = path.resolve(filePath);
  assertContained(workspace.workspacePath, resolved);
  const stat = await io.lstat(resolved);
  if (stat.isSymbolicLink()) throw new Error(`unsafe symbolic link file: ${resolved}`);
  if (!stat.isFile()) throw new Error(`workspace target is not a regular file: ${resolved}`);
  const real = await io.realpath(resolved);
  assertContained(workspace.workspaceRealPath, real);
}

/**
 * Reads an already-existing regular file without following its final path segment.
 * Parent-directory safety must be established by ensureSafeDirectoryUnderWorkspace.
 */
export async function readSafeRegularFileUtf8(workspace: SafeWorkspace, filePath: string) {
  const resolved = path.resolve(filePath);
  assertContained(workspace.workspacePath, resolved);
  const noFollow = requireNoFollowFlag();
  const handle = await fs.open(resolved, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`workspace target is not a regular file: ${resolved}`);
    const content = await handle.readFile({ encoding: "utf8" });
    const real = await fs.realpath(resolved);
    assertContained(workspace.workspaceRealPath, real);
    return content;
  } finally {
    await handle.close();
  }
}

export function requireNoFollowFlag() {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error("workspace error artifact storage requires O_NOFOLLOW support");
  }
  return noFollow;
}
