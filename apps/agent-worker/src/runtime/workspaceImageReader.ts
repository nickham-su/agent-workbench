import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { AgentWorkspaceImagePathSchema } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { AgentImageMediaType } from "@agent-workbench/shared/internal-contracts/agent-api-session";

export const WORKSPACE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

function sameInode(a: { dev: number; ino: number }, b: { dev: number; ino: number }) {
  return a.dev === b.dev && a.ino === b.ino;
}

export function detectWorkspaceImageMediaType(bytes: Uint8Array): AgentImageMediaType | null {
  const has = (prefix: number[]) => bytes.length >= prefix.length && prefix.every((n, i) => bytes[i] === n);
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (has([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 12 && has([0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

async function workspaceRootAncestors(absoluteRoot: string) {
  const root = path.parse(absoluteRoot).root;
  const parts = path.relative(root, absoluteRoot).split(path.sep).filter(Boolean);
  let logicalPath = root;
  const ancestors: Array<{ logicalPath: string; stat: import("node:fs").Stats }> = [];
  for (const part of parts) {
    logicalPath = path.join(logicalPath, part);
    const stat = await fs.lstat(logicalPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe Workspace root ancestor");
    ancestors.push({ logicalPath, stat });
  }
  return ancestors;
}

function mediaTypeForExtension(filename: string): AgentImageMediaType | null {
  const extension = path.posix.extname(filename).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return null;
}

/**
 * Open each path component from a pinned Workspace handle, without following symlinks.
 * Inode checks ensure a swapped pathname cannot redirect reads to another file. No bytes
 * are returned until all ancestors and the final entry have been checked again.
 */
export async function readWorkspaceImage(input: { workspacePath: string; path: string }): Promise<{ bytes: Uint8Array; mediaType: AgentImageMediaType }> {
  if (!Value.Check(AgentWorkspaceImagePathSchema, input.path)) throw new Error("invalid Workspace image path");
  const segments = input.path.split("/");
  const expectedType = mediaTypeForExtension(segments[segments.length - 1]!);
  if (!expectedType) throw new Error("unsupported Workspace image extension");
  const absoluteRoot = path.resolve(input.workspacePath);
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("secure Workspace image read is unavailable on this platform");
  const prefix = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  const opened: Array<{ handle: fs.FileHandle; logicalPath: string; stat: import("node:fs").Stats }> = [];
  let file: fs.FileHandle | null = null;
  try {
    const rootAncestors = await workspaceRootAncestors(absoluteRoot);
    const rootLstat = await fs.lstat(absoluteRoot);
    if (!rootLstat.isDirectory() || rootLstat.isSymbolicLink()) throw new Error("unsafe Workspace root");
    const root = await fs.open(absoluteRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    opened.push({ handle: root, logicalPath: absoluteRoot, stat: await root.stat() });
    if (!sameInode(rootLstat, opened[0]!.stat)) throw new Error("Workspace root changed");
    for (const segment of segments.slice(0, -1)) {
      const parent = opened[opened.length - 1]!;
      const pinnedPath = path.join(prefix, String(parent.handle.fd), segment);
      const entry = await fs.lstat(pinnedPath);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe Workspace image directory");
      const directory = await fs.open(pinnedPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      const stat = await directory.stat();
      opened.push({ handle: directory, logicalPath: path.join(parent.logicalPath, segment), stat });
      if (!sameInode(entry, stat)) throw new Error("Workspace image directory changed");
    }
    const parent = opened[opened.length - 1]!;
    const pinnedFilePath = path.join(prefix, String(parent.handle.fd), segments[segments.length - 1]!);
    file = await fs.open(pinnedFilePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stat = await file.stat();
    const entry = await fs.lstat(pinnedFilePath);
    if (!stat.isFile() || !entry.isFile() || entry.isSymbolicLink() || !sameInode(stat, entry)
      || stat.size < 1 || stat.size > WORKSPACE_IMAGE_MAX_BYTES) throw new Error("unsafe Workspace image file or size");
    const buffer = Buffer.alloc(stat.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== stat.size || !sameInode(stat, await file.stat()) || (await file.stat()).size !== stat.size) {
      throw new Error("Workspace image changed during read");
    }
    const mediaType = detectWorkspaceImageMediaType(buffer.subarray(0, bytesRead));
    if (!mediaType || mediaType !== expectedType) throw new Error("Workspace image signature does not match its extension");
    if (!sameInode(stat, await fs.lstat(pinnedFilePath))) throw new Error("Workspace image path changed during read");
    for (let i = opened.length - 1; i >= 0; i -= 1) {
      const dir = opened[i]!;
      const current = await fs.lstat(dir.logicalPath);
      if (current.isSymbolicLink() || !current.isDirectory() || !sameInode(dir.stat, current)) throw new Error("Workspace image directory changed during read");
      if (i > 0) {
        const parentDir = opened[i - 1]!;
        const pinned = await fs.lstat(path.join(prefix, String(parentDir.handle.fd), segments[i - 1]!));
        if (!sameInode(pinned, dir.stat) || pinned.isSymbolicLink()) throw new Error("Workspace image ancestor changed during read");
      }
    }
    for (const ancestor of rootAncestors) {
      const current = await fs.lstat(ancestor.logicalPath);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameInode(ancestor.stat, current)) throw new Error("Workspace root ancestor changed during read");
    }
    return { bytes: buffer.subarray(0, bytesRead), mediaType };
  } finally {
    await file?.close().catch(() => undefined);
    for (const dir of opened.reverse()) await dir.handle.close().catch(() => undefined);
  }
}
