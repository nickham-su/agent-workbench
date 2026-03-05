import fs from "node:fs/promises";
import path from "node:path";
import { deriveNewContentFromChunks, type UpdateFileChunk } from "./applyPatchUpdate.js";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

type AddFileHunk = {
  kind: "add";
  path: string;
  contents: string;
};

type DeleteFileHunk = {
  kind: "delete";
  path: string;
};

type UpdateFileHunk = {
  kind: "update";
  path: string;
  movePath?: string;
  chunks: UpdateFileChunk[];
};

type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

type ResolvedOperation =
  | {
      kind: "add";
      path: string;
      fullPath: string;
      content: string;
    }
  | {
      kind: "update";
      path: string;
      fullPath: string;
      content: string;
    }
  | {
      kind: "delete";
      path: string;
      fullPath: string;
    }
  | {
      kind: "move";
      path: string;
      fromPath: string;
      fullPath: string;
      fromFullPath: string;
      content: string;
    };

export type ApplyPatchFileResult = {
  type: "add" | "update" | "delete" | "move";
  path: string;
  fromPath?: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
};

export type ApplyPatchSummary = {
  added: string[];
  modified: string[];
  deleted: string[];
  moved: Array<{ fromPath: string; toPath: string }>;
  fileCount: number;
  additions: number;
  deletions: number;
};

export type ApplyPatchPrepared = {
  operations: ResolvedOperation[];
  files: ApplyPatchFileResult[];
  summary: ApplyPatchSummary;
  text: string;
};

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new Error("operation aborted");
}

function ensureSafeRelativePath(input: string) {
  const value = String(input || "").trim();
  if (!value) {
    throw new Error("path is required");
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("invalid path");
  }
  if (path.isAbsolute(value)) {
    throw new Error("absolute path is not allowed");
  }
  return value;
}

function resolveWithinWorkspace(workspacePath: string, relativePath: string) {
  const fullPath = path.resolve(workspacePath, relativePath);
  const normalizedWorkspace = path.resolve(workspacePath);
  const withSep = normalizedWorkspace.endsWith(path.sep) ? normalizedWorkspace : `${normalizedWorkspace}${path.sep}`;
  if (fullPath !== normalizedWorkspace && !fullPath.startsWith(withSep)) {
    throw new Error("path is outside workspace");
  }
  return fullPath;
}

function isPathInside(rootPath: string, targetPath: string) {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(withSep);
}

async function ensureRealPathInsideWorkspace(workspaceRealPath: string, targetPath: string) {
  const targetRealPath = await fs.realpath(targetPath);
  if (!isPathInside(workspaceRealPath, targetRealPath)) {
    throw new Error("path is outside workspace");
  }
}

function ensureTrailingNewline(text: string) {
  if (!text) return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}

function countLines(text: string) {
  if (!text) return 0;
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return Math.max(0, lines.length - 1);
  }
  return lines.length;
}

function parsePatchText(input: string): { hunks: Hunk[] } {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Invalid patch: input is empty.");
  }

  const lines = trimmed.split(/\r?\n/);
  const validated = checkPatchBoundariesLenient(lines);
  const hunks: Hunk[] = [];
  let remaining = validated.slice(1, validated.length - 1);
  let lineNumber = 2;

  while (remaining.length > 0) {
    const { hunk, consumed } = parseOneHunk(remaining, lineNumber);
    hunks.push(hunk);
    lineNumber += consumed;
    remaining = remaining.slice(consumed);
  }

  return { hunks };
}

function checkPatchBoundariesLenient(lines: string[]) {
  const strictError = checkPatchBoundariesStrict(lines);
  if (!strictError) return lines;

  if (lines.length >= 4) {
    const firstLine = lines[0];
    const lastLine = lines[lines.length - 1] ?? "";
    if ((firstLine === "<<EOF" || firstLine === "<<'EOF'" || firstLine === '<<"EOF"') && lastLine.endsWith("EOF")) {
      const inner = lines.slice(1, lines.length - 1);
      const innerError = checkPatchBoundariesStrict(inner);
      if (!innerError) {
        return inner;
      }
      throw new Error(innerError);
    }
  }
  throw new Error(strictError);
}

function checkPatchBoundariesStrict(lines: string[]) {
  const firstLine = lines[0]?.trim();
  const lastLine = lines[lines.length - 1]?.trim();
  if (firstLine === BEGIN_PATCH_MARKER && lastLine === END_PATCH_MARKER) {
    return null;
  }
  if (firstLine !== BEGIN_PATCH_MARKER) {
    return "The first line of the patch must be '*** Begin Patch'";
  }
  return "The last line of the patch must be '*** End Patch'";
}

function parseOneHunk(lines: string[], lineNumber: number): { hunk: Hunk; consumed: number } {
  if (lines.length === 0) {
    throw new Error(`Invalid patch hunk at line ${lineNumber}: empty hunk`);
  }

  const firstLine = lines[0]?.trim() ?? "";
  if (firstLine.startsWith(ADD_FILE_MARKER)) {
    const targetPath = firstLine.slice(ADD_FILE_MARKER.length);
    let contents = "";
    let consumed = 1;
    for (const line of lines.slice(1)) {
      if (!line.startsWith("+")) break;
      contents += `${line.slice(1)}\n`;
      consumed += 1;
    }
    return {
      hunk: {
        kind: "add",
        path: targetPath,
        contents
      },
      consumed
    };
  }

  if (firstLine.startsWith(DELETE_FILE_MARKER)) {
    const targetPath = firstLine.slice(DELETE_FILE_MARKER.length);
    return {
      hunk: {
        kind: "delete",
        path: targetPath
      },
      consumed: 1
    };
  }

  if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
    const targetPath = firstLine.slice(UPDATE_FILE_MARKER.length);
    let remaining = lines.slice(1);
    let consumed = 1;
    let movePath: string | undefined;

    const chunks: UpdateFileChunk[] = [];
    while (remaining.length > 0) {
      const currentLine = remaining[0] ?? "";
      const trimmedCurrentLine = currentLine.trim();
      if (trimmedCurrentLine === "") {
        remaining = remaining.slice(1);
        consumed += 1;
        continue;
      }
      if (trimmedCurrentLine.startsWith(MOVE_TO_MARKER)) {
        if (movePath != null) {
          throw new Error(
            `Invalid patch hunk at line ${lineNumber + consumed}: duplicate move target for path '${targetPath}'`
          );
        }
        movePath = trimmedCurrentLine.slice(MOVE_TO_MARKER.length);
        remaining = remaining.slice(1);
        consumed += 1;
        continue;
      }
      if (currentLine.startsWith("***")) {
        break;
      }
      const parsed = parseUpdateFileChunk(remaining, lineNumber + consumed, chunks.length === 0);
      chunks.push(parsed.chunk);
      remaining = remaining.slice(parsed.consumed);
      consumed += parsed.consumed;
    }

    if (chunks.length === 0) {
      throw new Error(`Invalid patch hunk at line ${lineNumber}: Update file hunk for path '${targetPath}' is empty`);
    }

    return {
      hunk: {
        kind: "update",
        path: targetPath,
        movePath,
        chunks
      },
      consumed
    };
  }

  throw new Error(
    `Invalid patch hunk at line ${lineNumber}: '${lines[0]}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`
  );
}

function parseUpdateFileChunk(lines: string[], lineNumber: number, allowMissingContext: boolean) {
  if (lines.length === 0) {
    throw new Error(`Invalid patch hunk at line ${lineNumber}: Update hunk does not contain any lines`);
  }

  let changeContext: string | undefined;
  let startIndex = 0;
  if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) {
    startIndex = 1;
  } else if ((lines[0] ?? "").startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = (lines[0] ?? "").slice(CHANGE_CONTEXT_MARKER.length);
    startIndex = 1;
  } else if (!allowMissingContext) {
    throw new Error(
      `Invalid patch hunk at line ${lineNumber}: Expected update hunk to start with a @@ context marker, got: '${lines[0]}'`
    );
  }

  if (startIndex >= lines.length) {
    throw new Error(`Invalid patch hunk at line ${lineNumber + 1}: Update hunk does not contain any lines`);
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
    addedLines: 0,
    removedLines: 0
  };

  let parsedLines = 0;
  for (const line of lines.slice(startIndex)) {
    if (line === EOF_MARKER) {
      if (parsedLines === 0) {
        throw new Error(`Invalid patch hunk at line ${lineNumber + 1}: Update hunk does not contain any lines`);
      }
      chunk.isEndOfFile = true;
      parsedLines += 1;
      break;
    }

    const marker = line[0];
    if (!marker) {
      chunk.oldLines.push("");
      chunk.newLines.push("");
      parsedLines += 1;
      continue;
    }
    if (marker === " ") {
      const content = line.slice(1);
      chunk.oldLines.push(content);
      chunk.newLines.push(content);
      parsedLines += 1;
      continue;
    }
    if (marker === "+") {
      chunk.newLines.push(line.slice(1));
      chunk.addedLines += 1;
      parsedLines += 1;
      continue;
    }
    if (marker === "-") {
      chunk.oldLines.push(line.slice(1));
      chunk.removedLines += 1;
      parsedLines += 1;
      continue;
    }
    if (line.startsWith("***")) {
      break;
    }
    throw new Error(`Invalid line in update hunk at line ${lineNumber + startIndex + parsedLines}: '${line}'`);
  }

  if (parsedLines === 0) {
    throw new Error(`Invalid patch hunk at line ${lineNumber + startIndex}: Update hunk does not contain any lines`);
  }

  return {
    chunk,
    consumed: startIndex + parsedLines
  };
}

function recordUnique(target: string[], seen: Set<string>, value: string) {
  if (seen.has(value)) return;
  seen.add(value);
  target.push(value);
}

function normalizePathStateKey(fullPath: string) {
  return path.resolve(fullPath);
}

type VirtualFileState = {
  exists: boolean;
  content: string;
};

async function readVirtualFileState(params: {
  virtualFiles: Map<string, VirtualFileState>;
  relativePath: string;
  fullPath: string;
  workspaceRealPath: string;
}) {
  const key = normalizePathStateKey(params.fullPath);
  const cached = params.virtualFiles.get(key);
  if (cached) {
    return cached;
  }
  const stat = await fs.lstat(params.fullPath).catch(() => null);
  if (!stat) {
    const missing: VirtualFileState = {
      exists: false,
      content: ""
    };
    params.virtualFiles.set(key, missing);
    return missing;
  }
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory: ${params.fullPath}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`symlink path is not allowed: ${params.fullPath}`);
  }
  await ensureRealPathInsideWorkspace(params.workspaceRealPath, params.fullPath);
  const content = await fs.readFile(params.fullPath, "utf8");
  const existing: VirtualFileState = {
    exists: true,
    content
  };
  params.virtualFiles.set(key, existing);
  return existing;
}

function writeVirtualFileState(params: {
  virtualFiles: Map<string, VirtualFileState>;
  relativePath: string;
  fullPath: string;
  state: VirtualFileState;
}) {
  const key = normalizePathStateKey(params.fullPath);
  params.virtualFiles.set(key, {
    exists: params.state.exists,
    content: params.state.content
  });
}

async function ensureParentDirectorySafe(params: {
  workspacePath: string;
  workspaceRealPath: string;
  fullPath: string;
  createMissing: boolean;
}) {
  const workspaceLexicalPath = path.resolve(params.workspacePath);
  const fullLexicalPath = path.resolve(params.fullPath);
  const parentLexicalPath = path.dirname(fullLexicalPath);
  const relative = path.relative(workspaceLexicalPath, parentLexicalPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path is outside workspace");
  }
  if (!relative || relative === ".") {
    return;
  }

  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  let currentPath = params.workspaceRealPath;

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const stat = await fs.lstat(currentPath).catch(() => null);
    if (!stat) {
      if (!params.createMissing) {
        break;
      }
      await fs.mkdir(currentPath);
      const createdRealPath = await fs.realpath(currentPath);
      if (!isPathInside(params.workspaceRealPath, createdRealPath)) {
        throw new Error("path is outside workspace");
      }
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`symlink path is not allowed: ${currentPath}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${currentPath}`);
    }
    const currentRealPath = await fs.realpath(currentPath);
    if (!isPathInside(params.workspaceRealPath, currentRealPath)) {
      throw new Error("path is outside workspace");
    }
  }
}

async function verifyExistingRegularFile(workspaceRealPath: string, fullPath: string, label: string) {
  const stat = await fs.lstat(fullPath).catch(() => null);
  if (!stat) {
    throw new Error(`Failed to read file to ${label}: ${fullPath}`);
  }
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory: ${fullPath}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`symlink path is not allowed: ${fullPath}`);
  }
  await ensureRealPathInsideWorkspace(workspaceRealPath, fullPath);
}

function buildSummaryText(summary: ApplyPatchSummary) {
  const lines = ["Success. Updated the following files:"];
  for (const item of summary.added) {
    lines.push(`A ${item}`);
  }
  for (const item of summary.modified) {
    lines.push(`M ${item}`);
  }
  for (const item of summary.deleted) {
    lines.push(`D ${item}`);
  }
  return lines.join("\n");
}

export async function prepareApplyPatchTool(params: {
  workspacePath: string;
  patchText: string;
  signal?: AbortSignal;
}): Promise<ApplyPatchPrepared> {
  throwIfAborted(params.signal);

  const parsed = parsePatchText(params.patchText);
  if (parsed.hunks.length === 0) {
    throw new Error("no hunks found");
  }

  const workspaceRealPath = await fs.realpath(params.workspacePath);
  const operations: ResolvedOperation[] = [];
  const files: ApplyPatchFileResult[] = [];
  const virtualFiles = new Map<string, VirtualFileState>();

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const moved: Array<{ fromPath: string; toPath: string }> = [];
  const seenAdded = new Set<string>();
  const seenModified = new Set<string>();
  const seenDeleted = new Set<string>();
  const seenMoved = new Set<string>();
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const hunk of parsed.hunks) {
    throwIfAborted(params.signal);

    if (hunk.kind === "add") {
      const relativePath = ensureSafeRelativePath(hunk.path);
      const fullPath = resolveWithinWorkspace(params.workspacePath, relativePath);
      await ensureParentDirectorySafe({
        workspacePath: params.workspacePath,
        workspaceRealPath,
        fullPath,
        createMissing: false
      });
      const current = await readVirtualFileState({
        virtualFiles,
        relativePath,
        fullPath,
        workspaceRealPath
      });
      const before = current.exists ? current.content : "";
      const after = ensureTrailingNewline(hunk.contents);
      const additions = countLines(after);
      const deletions = before ? countLines(before) : 0;

      operations.push({
        kind: "add",
        path: relativePath,
        fullPath,
        content: after
      });
      files.push({
        type: "add",
        path: relativePath,
        before,
        after,
        additions,
        deletions
      });
      recordUnique(added, seenAdded, relativePath);
      totalAdditions += additions;
      totalDeletions += deletions;
      writeVirtualFileState({
        virtualFiles,
        relativePath,
        fullPath,
        state: {
          exists: true,
          content: after
        }
      });
      continue;
    }

    if (hunk.kind === "delete") {
      const relativePath = ensureSafeRelativePath(hunk.path);
      const fullPath = resolveWithinWorkspace(params.workspacePath, relativePath);
      const current = await readVirtualFileState({
        virtualFiles,
        relativePath,
        fullPath,
        workspaceRealPath
      });
      if (!current.exists) {
        throw new Error(`Failed to read file to delete: ${fullPath}`);
      }
      const before = current.content;
      const deletions = countLines(before);

      operations.push({
        kind: "delete",
        path: relativePath,
        fullPath
      });
      files.push({
        type: "delete",
        path: relativePath,
        before,
        after: "",
        additions: 0,
        deletions
      });
      recordUnique(deleted, seenDeleted, relativePath);
      totalDeletions += deletions;
      writeVirtualFileState({
        virtualFiles,
        relativePath,
        fullPath,
        state: {
          exists: false,
          content: ""
        }
      });
      continue;
    }

    const relativePath = ensureSafeRelativePath(hunk.path);
    const fullPath = resolveWithinWorkspace(params.workspacePath, relativePath);
    const current = await readVirtualFileState({
      virtualFiles,
      relativePath,
      fullPath,
      workspaceRealPath
    });
    if (!current.exists) {
      throw new Error(`Failed to read file to update: ${fullPath}`);
    }
    const before = current.content;
    const after = deriveNewContentFromChunks({
      filePath: fullPath,
      originalContent: before,
      chunks: hunk.chunks
    });
    let additions = 0;
    let deletions = 0;
    for (const chunk of hunk.chunks) {
      additions += chunk.addedLines;
      deletions += chunk.removedLines;
    }

    if (!hunk.movePath) {
      operations.push({
        kind: "update",
        path: relativePath,
        fullPath,
        content: after
      });
      files.push({
        type: "update",
        path: relativePath,
        before,
        after,
        additions,
        deletions
      });
      recordUnique(modified, seenModified, relativePath);
      totalAdditions += additions;
      totalDeletions += deletions;
      writeVirtualFileState({
        virtualFiles,
        relativePath,
        fullPath,
        state: {
          exists: true,
          content: after
        }
      });
      continue;
    }

    const movePath = ensureSafeRelativePath(hunk.movePath);
    const moveFullPath = resolveWithinWorkspace(params.workspacePath, movePath);
    await ensureParentDirectorySafe({
      workspacePath: params.workspacePath,
      workspaceRealPath,
      fullPath: moveFullPath,
      createMissing: false
    });
    if (moveFullPath === fullPath) {
      operations.push({
        kind: "update",
        path: relativePath,
        fullPath,
        content: after
      });
      files.push({
        type: "update",
        path: relativePath,
        before,
        after,
        additions,
        deletions
      });
      recordUnique(modified, seenModified, relativePath);
      totalAdditions += additions;
      totalDeletions += deletions;
      writeVirtualFileState({
        virtualFiles,
        relativePath,
        fullPath,
        state: {
          exists: true,
          content: after
        }
      });
      continue;
    }
    const moveCurrent = await readVirtualFileState({
      virtualFiles,
      relativePath: movePath,
      fullPath: moveFullPath,
      workspaceRealPath
    });
    if (moveCurrent.exists) {
      throw new Error(`move target already exists: ${moveFullPath}`);
    }
    operations.push({
      kind: "move",
      path: movePath,
      fromPath: relativePath,
      fullPath: moveFullPath,
      fromFullPath: fullPath,
      content: after
    });
    files.push({
      type: "move",
      path: movePath,
      fromPath: relativePath,
      before,
      after,
      additions,
      deletions
    });
    recordUnique(modified, seenModified, movePath);
    const movedKey = `${relativePath}->${movePath}`;
    if (!seenMoved.has(movedKey)) {
      seenMoved.add(movedKey);
      moved.push({ fromPath: relativePath, toPath: movePath });
    }
    totalAdditions += additions;
    totalDeletions += deletions;
    writeVirtualFileState({
      virtualFiles,
      relativePath,
      fullPath,
      state: {
        exists: false,
        content: ""
      }
    });
    writeVirtualFileState({
      virtualFiles,
      relativePath: movePath,
      fullPath: moveFullPath,
      state: {
        exists: true,
        content: after
      }
    });
  }

  const summary: ApplyPatchSummary = {
    added,
    modified,
    deleted,
    moved,
    fileCount: files.length,
    additions: totalAdditions,
    deletions: totalDeletions
  };

  return {
    operations,
    files,
    summary,
    text: buildSummaryText(summary)
  };
}

async function ensureWritableParent(workspacePath: string, workspaceRealPath: string, fullPath: string) {
  await ensureParentDirectorySafe({
    workspacePath,
    workspaceRealPath,
    fullPath,
    createMissing: true
  });
  const existingStat = await fs.lstat(fullPath).catch(() => null);
  if (existingStat?.isSymbolicLink()) {
    throw new Error(`symlink path is not allowed: ${fullPath}`);
  }
  if (existingStat?.isDirectory()) {
    throw new Error(`Path is a directory: ${fullPath}`);
  }
  const resolved = resolveWithinWorkspace(workspacePath, path.relative(workspacePath, fullPath));
  if (resolved !== fullPath) {
    throw new Error("path is outside workspace");
  }
}

export async function applyPreparedPatch(params: {
  workspacePath: string;
  prepared: ApplyPatchPrepared;
  signal?: AbortSignal;
}) {
  throwIfAborted(params.signal);
  const workspaceRealPath = await fs.realpath(params.workspacePath);

  for (const operation of params.prepared.operations) {
    throwIfAborted(params.signal);

    if (operation.kind === "add" || operation.kind === "update") {
      await ensureWritableParent(params.workspacePath, workspaceRealPath, operation.fullPath);
      await fs.writeFile(operation.fullPath, operation.content, { encoding: "utf8" });
      continue;
    }

    if (operation.kind === "move") {
      await verifyExistingRegularFile(workspaceRealPath, operation.fromFullPath, "move");
      await ensureWritableParent(params.workspacePath, workspaceRealPath, operation.fullPath);
      try {
        await fs.writeFile(operation.fullPath, operation.content, { encoding: "utf8", flag: "wx" });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "EEXIST") {
          throw new Error(`move target already exists: ${operation.fullPath}`);
        }
        throw err;
      }
      await fs.unlink(operation.fromFullPath);
      continue;
    }

    await verifyExistingRegularFile(workspaceRealPath, operation.fullPath, "delete");
    await fs.unlink(operation.fullPath);
  }
}
