import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { getWorkspacePreviewResourceDescriptor, type WorkspacePreviewResourceDescriptor } from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { getWorkspace } from "../workspaces/workspace.store.js";

export type PreviewPathFailure =
  | "invalid_path"
  | "encoded_separator"
  | "workspace_missing"
  | "path_missing"
  | "path_escape"
  | "denied_segment"
  | "symlink"
  | "not_regular"
  | "unsupported_type"
  | "permission_denied"
  | "changed_during_open";

export class PreviewFileError extends Error {
  constructor(readonly failure: PreviewPathFailure) {
    super(`Preview file request rejected: ${failure}`);
    this.name = "PreviewFileError";
  }
}

export type PreviewWorkspaceRecord = Readonly<{ id: string; path: string }>;

export type PreviewFileStat = Pick<Stats, "dev" | "ino" | "size" | "isDirectory" | "isFile" | "isSymbolicLink">;

export type PreviewFileHandle = {
  readonly fd: number;
  stat(): Promise<PreviewFileStat>;
  close(): Promise<void>;
};

export type PreviewFileSystem = {
  lstat(filePath: string): Promise<PreviewFileStat>;
  realpath(filePath: string): Promise<string>;
  open(filePath: string, flags: string): Promise<PreviewFileHandle>;
};

export type ResolvedPreviewFile = Readonly<{
  kind: "file";
  workspaceId: string;
  rootRealPath: string;
  relativePath: string;
  absolutePath: string;
  stat: PreviewFileStat;
  resource: WorkspacePreviewResourceDescriptor;
}>;

export type ResolvedPreviewRedirect = Readonly<{
  kind: "redirect";
  relativePath: string;
}>;

export type ResolvedPreviewTarget = ResolvedPreviewFile | ResolvedPreviewRedirect;

export type OpenedPreviewFile = Readonly<{
  handle: PreviewFileHandle;
  stat: PreviewFileStat;
  target: ResolvedPreviewFile;
}>;

export type PreviewFileService = {
  resolve(input: { workspaceId: string; decodedPath: string; trailingSlash: boolean }): Promise<ResolvedPreviewTarget>;
  open(target: ResolvedPreviewFile): Promise<OpenedPreviewFile>;
};

const DENIED_SEGMENTS = new Set([".git", ".awb"]);

const nodeFileSystem: PreviewFileSystem = {
  lstat: async (filePath) => await fs.lstat(filePath),
  realpath: async (filePath) => await fs.realpath(filePath),
  open: async (filePath, flags) => await fs.open(filePath, flags)
};

function failureFromFileSystemError(error: unknown): PreviewFileError {
  if (error instanceof PreviewFileError) return error;
  const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return new PreviewFileError("path_missing");
  if (code === "EACCES" || code === "EPERM") return new PreviewFileError("permission_denied");
  return new PreviewFileError("changed_during_open");
}

function containsUnsafeDecodedCharacter(value: string) {
  return value.includes("\\") || value.includes("\0") || value.includes("\r") || value.includes("\n");
}

function normalizeWorkspacePath(decodedPath: string) {
  if (containsUnsafeDecodedCharacter(decodedPath)) throw new PreviewFileError("invalid_path");
  if (path.posix.isAbsolute(decodedPath)) throw new PreviewFileError("path_escape");

  const segments: string[] = [];
  for (const segment of decodedPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw new PreviewFileError("path_escape");
      segments.pop();
      continue;
    }
    if (DENIED_SEGMENTS.has(segment.toLowerCase())) throw new PreviewFileError("denied_segment");
    segments.push(segment);
  }
  return segments;
}

function isRealPathUnderRoot(rootRealPath: string, targetRealPath: string) {
  const root = path.resolve(rootRealPath);
  const target = path.resolve(targetRealPath);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function matchesOpenedTarget(before: PreviewFileStat, after: PreviewFileStat) {
  if (!after.isFile() || after.isSymbolicLink()) return false;
  return before.dev === after.dev && before.ino === after.ino;
}

function matchesResolvedTarget(before: PreviewFileStat, after: PreviewFileStat) {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    before.dev === after.dev &&
    before.ino === after.ino
  );
}

/**
 * Validates the raw HTTP URL spelling before a framework performs its single
 * percent-decoding pass. It never decodes its input.
 */
export function assertPreviewRawUrlPath(rawUrl: string): void {
  const pathname = rawUrl.split("?", 1)[0] ?? "";
  for (let index = 0; index < pathname.length; index += 1) {
    if (pathname[index] !== "%") continue;
    const encoded = pathname.slice(index + 1, index + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(encoded)) throw new PreviewFileError("invalid_path");
    if (encoded.toLowerCase() === "2f" || encoded.toLowerCase() === "5c") {
      throw new PreviewFileError("encoded_separator");
    }
    index += 2;
  }
}

async function lstatSafe(fileSystem: PreviewFileSystem, absolutePath: string) {
  try {
    return await fileSystem.lstat(absolutePath);
  } catch (error) {
    throw failureFromFileSystemError(error);
  }
}

async function realpathSafe(fileSystem: PreviewFileSystem, absolutePath: string) {
  try {
    return path.resolve(await fileSystem.realpath(absolutePath));
  } catch (error) {
    throw failureFromFileSystemError(error);
  }
}

export function createPreviewFileService(params: {
  getWorkspaceById: (workspaceId: string) => PreviewWorkspaceRecord | null | Promise<PreviewWorkspaceRecord | null>;
  fileSystem?: PreviewFileSystem;
}): PreviewFileService {
  const fileSystem = params.fileSystem ?? nodeFileSystem;

  const resolveExisting = async (workspace: PreviewWorkspaceRecord, decodedPath: string) => {
    const rootPath = path.resolve(workspace.path);
    const rootStat = await lstatSafe(fileSystem, rootPath);
    if (rootStat.isSymbolicLink()) throw new PreviewFileError("symlink");
    if (!rootStat.isDirectory()) throw new PreviewFileError("not_regular");
    const rootRealPath = await realpathSafe(fileSystem, rootPath);

    const segments = normalizeWorkspacePath(decodedPath);
    let absolutePath = rootPath;
    for (const segment of segments) {
      absolutePath = path.join(absolutePath, segment);
      const stat = await lstatSafe(fileSystem, absolutePath);
      if (stat.isSymbolicLink()) throw new PreviewFileError("symlink");
      if (absolutePath !== path.join(rootPath, ...segments) && !stat.isDirectory()) {
        throw new PreviewFileError("not_regular");
      }
    }

    const stat = segments.length === 0 ? rootStat : await lstatSafe(fileSystem, absolutePath);
    if (stat.isSymbolicLink()) throw new PreviewFileError("symlink");
    const targetRealPath = await realpathSafe(fileSystem, absolutePath);
    if (!isRealPathUnderRoot(rootRealPath, targetRealPath)) throw new PreviewFileError("path_escape");
    return { rootRealPath, absolutePath: targetRealPath, relativePath: segments.join("/"), stat };
  };

  return {
    async resolve(input) {
      const workspace = await params.getWorkspaceById(input.workspaceId);
      if (!workspace) throw new PreviewFileError("workspace_missing");

      let resolved = await resolveExisting(workspace, input.decodedPath);
      if (resolved.stat.isDirectory()) {
        if (!input.trailingSlash) return { kind: "redirect", relativePath: resolved.relativePath };
        const indexPath = resolved.relativePath ? `${resolved.relativePath}/index.html` : "index.html";
        resolved = await resolveExisting(workspace, indexPath);
      }
      if (!resolved.stat.isFile()) throw new PreviewFileError("not_regular");
      const resource = getWorkspacePreviewResourceDescriptor(resolved.relativePath);
      if (!resource) throw new PreviewFileError("unsupported_type");
      return {
        kind: "file",
        workspaceId: workspace.id,
        rootRealPath: resolved.rootRealPath,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        stat: resolved.stat,
        resource
      };
    },
    async open(target) {
      let handle: PreviewFileHandle | null = null;
      try {
        const rootStat = await lstatSafe(fileSystem, target.rootRealPath);
        if (rootStat.isSymbolicLink()) throw new PreviewFileError("symlink");
        if (!rootStat.isDirectory()) throw new PreviewFileError("not_regular");

        let currentPath = target.rootRealPath;
        const segments = target.relativePath.split("/");
        for (const [index, segment] of segments.entries()) {
          currentPath = path.join(currentPath, segment);
          const stat = await lstatSafe(fileSystem, currentPath);
          if (stat.isSymbolicLink()) throw new PreviewFileError("symlink");
          if (index < segments.length - 1 && !stat.isDirectory()) throw new PreviewFileError("not_regular");
          if (index === segments.length - 1 && !matchesResolvedTarget(target.stat, stat)) {
            throw new PreviewFileError("changed_during_open");
          }
        }
        const targetRealPath = await realpathSafe(fileSystem, target.absolutePath);
        if (!isRealPathUnderRoot(target.rootRealPath, targetRealPath)) throw new PreviewFileError("path_escape");

        handle = await fileSystem.open(target.absolutePath, "r");
        const stat = await handle.stat();
        if (!matchesOpenedTarget(target.stat, stat)) throw new PreviewFileError("changed_during_open");
        return { handle, stat, target };
      } catch (error) {
        try {
          await handle?.close();
        } catch {
          // The original security failure is more useful than best-effort close failure.
        }
        throw failureFromFileSystemError(error);
      }
    }
  };
}

/** Future preview routes use the DB workspace record as the sole filesystem root. */
export function createWorkspacePreviewFileService(ctx: Pick<AppContext, "db">, fileSystem?: PreviewFileSystem) {
  return createPreviewFileService({
    getWorkspaceById: (workspaceId) => getWorkspace(ctx.db, workspaceId),
    fileSystem
  });
}
