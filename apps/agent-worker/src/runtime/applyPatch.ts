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
  chunks: UpdateFileChunk[];
  allowDeleteWithoutHunks?: boolean;
};

type UpdateFileHunk = {
  kind: "update";
  path: string;
  movePath?: string;
  chunks: UpdateFileChunk[];
};

type MoveOnlyHunk = {
  kind: "move_only";
  fromPath: string;
  toPath: string;
};

type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk | MoveOnlyHunk;

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
        path: targetPath,
        chunks: [],
        allowDeleteWithoutHunks: true
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

function splitGitPatchTokens(input: string) {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (char === " " || char === "\t")) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function parseUnifiedDiffPathToken(raw: string) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value;
}

function stripGitPathPrefix(raw: string) {
  if (raw === "/dev/null") return raw;
  if (raw.startsWith("a/")) return raw.slice(2);
  if (raw.startsWith("b/")) return raw.slice(2);
  return raw;
}

function parseUnifiedDiffHunkHeader(raw: string) {
  const line = String(raw || "").trim();
  const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
  if (!match) return null;
  const oldStart = Number(match[1]);
  const oldLen = match[2] == null ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLen = match[4] == null ? 1 : Number(match[4]);
  if (![oldStart, oldLen, newStart, newLen].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return {
    oldStart: Math.floor(oldStart),
    oldLen: Math.floor(oldLen),
    newStart: Math.floor(newStart),
    newLen: Math.floor(newLen)
  };
}

function buildNewFileContentsFromUnifiedDiffChunks(chunks: UpdateFileChunk[]) {
  if (chunks.length === 0) return "";

  type Segment = { start: number; len: number; lines: string[]; header: string };
  const segments: Segment[] = [];

  for (const chunk of chunks) {
    if (chunk.removedLines > 0 || chunk.oldLines.length > 0) {
      throw new Error(
        `Unsupported add-file hunk: add-file hunks must not contain deletions or context lines.\nHunk: ${chunk.sourceHunkHeader || "@@ ... @@"}`
      );
    }
    const header = chunk.sourceHunkHeader || "@@ ... @@";
    const parsed = parseUnifiedDiffHunkHeader(header);
    if (!parsed) {
      throw new Error(`Unsupported add-file hunk header: ${header}`);
    }
    if (parsed.newLen !== chunk.newLines.length) {
      throw new Error(
        `Unsupported add-file hunk: expected ${parsed.newLen} added lines, got ${chunk.newLines.length}.\nHunk: ${header}`
      );
    }
    if (parsed.newLen === 0) continue;
    segments.push({
      start: parsed.newStart,
      len: parsed.newLen,
      lines: chunk.newLines,
      header
    });
  }

  if (segments.length === 0) return "";
  segments.sort((a, b) => a.start - b.start);

  let maxLine = 0;
  for (const seg of segments) {
    maxLine = Math.max(maxLine, seg.start - 1 + seg.len);
  }
  if (maxLine <= 0) return "";

  const out = new Array<string | undefined>(maxLine);
  for (const seg of segments) {
    const startIndex = Math.max(0, seg.start - 1);
    for (let i = 0; i < seg.lines.length; i += 1) {
      const index = startIndex + i;
      if (index >= out.length) {
        throw new Error(`Unsupported add-file hunk: out-of-range insertion.\nHunk: ${seg.header}`);
      }
      if (out[index] != null) {
        throw new Error(`Unsupported add-file hunk: overlapping hunks.\nHunk: ${seg.header}`);
      }
      out[index] = seg.lines[i] ?? "";
    }
  }

  for (let i = 0; i < out.length; i += 1) {
    if (out[i] == null) {
      throw new Error("Unsupported add-file diff: add-file hunks must fully specify file contents");
    }
  }

  const joined = (out as string[]).join("\n");
  return joined.length > 0 ? `${joined}\n` : "";
}

function parseUnifiedDiffPatchText(input: string): { hunks: Hunk[] } {
  const normalized = input.replace(/\r\n/g, "\n");
  if (!normalized.trim()) {
    throw new Error("Invalid patch: input is empty.");
  }

  const lines = normalized.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line === "GIT binary patch" || line.startsWith("GIT binary patch")) {
      throw new Error("binary patch is not supported");
    }
    if (line.startsWith("Binary files ")) {
      throw new Error("binary patch is not supported");
    }
    if (line.startsWith("Submodule ")) {
      throw new Error("submodule diff is not supported");
    }
    if (line.startsWith("copy from ") || line.startsWith("copy to ")) {
      throw new Error("copy from/to is not supported");
    }
  }

  type UnifiedFilePatch = {
    aPath?: string;
    bPath?: string;
    oldPath?: string;
    newPath?: string;
    renameFrom?: string;
    renameTo?: string;
    chunks: UpdateFileChunk[];
    hasDiffHeader: boolean;
  };

  const filePatches: UnifiedFilePatch[] = [];
  let current: UnifiedFilePatch | null = null;

  function ensureCurrent() {
    if (current) return current;
    current = { chunks: [], hasDiffHeader: false };
    return current;
  }

  function pushCurrent() {
    if (!current) return;
    const hasAnyMetadata =
      Boolean(current.aPath || current.bPath || current.oldPath || current.newPath || current.renameFrom || current.renameTo);
    const hasAnyChunks = current.chunks.length > 0;
    if (hasAnyMetadata || hasAnyChunks) {
      filePatches.push(current);
    }
    current = null;
  }

  const hunkHeaderRegex = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    if (line.startsWith("diff --git ")) {
      pushCurrent();
      const rest = line.slice("diff --git ".length);
      const tokens = splitGitPatchTokens(rest);
      if (tokens.length < 2) {
        throw new Error(`Invalid unified diff at line ${i + 1}: expected 'diff --git a/<path> b/<path>'`);
      }
      current = {
        aPath: parseUnifiedDiffPathToken(tokens[0] ?? ""),
        bPath: parseUnifiedDiffPathToken(tokens[1] ?? ""),
        chunks: [],
        hasDiffHeader: true
      };
      continue;
    }

    if (!current && line.trim() === "") continue;
    let patch = ensureCurrent();

    if (line.startsWith("rename from ")) {
      const rest = line.slice("rename from ".length);
      const tokens = splitGitPatchTokens(rest);
      const p = parseUnifiedDiffPathToken(tokens[0] ?? "");
      if (!p) throw new Error(`Invalid unified diff at line ${i + 1}: rename from path is missing`);
      patch.renameFrom = p;
      continue;
    }
    if (line.startsWith("rename to ")) {
      const rest = line.slice("rename to ".length);
      const tokens = splitGitPatchTokens(rest);
      const p = parseUnifiedDiffPathToken(tokens[0] ?? "");
      if (!p) throw new Error(`Invalid unified diff at line ${i + 1}: rename to path is missing`);
      patch.renameTo = p;
      continue;
    }

    if (line.startsWith("--- ")) {
      if (
        patch.hasDiffHeader === false &&
        (patch.oldPath || patch.newPath || patch.renameFrom || patch.renameTo || patch.chunks.length > 0)
      ) {
        // old-style unified diff may omit "diff --git", use "---/+++" pairs to delimit file blocks.
        pushCurrent();
        patch = ensureCurrent();
      }
      const rest = line.slice("--- ".length);
      const tokens = splitGitPatchTokens(rest);
      const p = parseUnifiedDiffPathToken(tokens[0] ?? "");
      if (!p) throw new Error(`Invalid unified diff at line ${i + 1}: missing '---' path`);
      patch.oldPath = p;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const rest = line.slice("+++ ".length);
      const tokens = splitGitPatchTokens(rest);
      const p = parseUnifiedDiffPathToken(tokens[0] ?? "");
      if (!p) throw new Error(`Invalid unified diff at line ${i + 1}: missing '+++' path`);
      patch.newPath = p;
      continue;
    }

    if (line.startsWith("@@")) {
      if (!hunkHeaderRegex.test(line)) {
        throw new Error(`Invalid unified diff at line ${i + 1}: invalid hunk header '${line}'`);
      }
      const chunk: UpdateFileChunk = {
        sourceHunkHeader: line,
        oldLines: [],
        newLines: [],
        isEndOfFile: false,
        addedLines: 0,
        removedLines: 0
      };
      let parsedAny = false;

      for (i = i + 1; i < lines.length; i += 1) {
        const bodyLine = lines[i] ?? "";
        if (bodyLine.startsWith("diff --git ")) {
          i -= 1;
          break;
        }
        if (bodyLine.startsWith("@@") && hunkHeaderRegex.test(bodyLine)) {
          i -= 1;
          break;
        }
        if (bodyLine.startsWith("--- ") && patch.hasDiffHeader === false && patch.oldPath && patch.newPath) {
          i -= 1;
          break;
        }
        if (bodyLine.startsWith("\\ No newline at end of file")) {
          continue;
        }

        parsedAny = true;
        if (bodyLine === "") {
          chunk.oldLines.push("");
          chunk.newLines.push("");
          continue;
        }

        const marker = bodyLine[0];
        if (marker === " ") {
          const content = bodyLine.slice(1);
          chunk.oldLines.push(content);
          chunk.newLines.push(content);
          continue;
        }
        if (marker === "+") {
          chunk.newLines.push(bodyLine.slice(1));
          chunk.addedLines += 1;
          continue;
        }
        if (marker === "-") {
          chunk.oldLines.push(bodyLine.slice(1));
          chunk.removedLines += 1;
          continue;
        }
        if (marker === "\\") {
          continue;
        }
        throw new Error(`Invalid unified diff at line ${i + 1}: invalid hunk line '${bodyLine}'`);
      }

      if (!parsedAny) {
        throw new Error(`Invalid unified diff at line ${i + 1}: hunk body is empty`);
      }

      patch.chunks.push(chunk);
      continue;
    }

    if (
      line.startsWith("index ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("dissimilarity index ")
    ) {
      continue;
    }

    if (line.trim() === "") continue;
    // 其他未知元信息行忽略,避免对使用者产生额外心智负担。
  }

  pushCurrent();

  const hunks: Hunk[] = [];

  for (const patch of filePatches) {
    const oldToken = patch.oldPath || patch.renameFrom || patch.aPath || "";
    const newToken = patch.newPath || patch.renameTo || patch.bPath || "";
    const oldPath = stripGitPathPrefix(oldToken);
    const newPath = stripGitPathPrefix(newToken);

    const oldIsDevNull = stripGitPathPrefix(patch.oldPath || "") === "/dev/null";
    const newIsDevNull = stripGitPathPrefix(patch.newPath || "") === "/dev/null";

    if (oldIsDevNull) {
      if (!newPath || newPath === "/dev/null") {
        throw new Error("Invalid unified diff: new file path is missing");
      }
      const contents = buildNewFileContentsFromUnifiedDiffChunks(patch.chunks);
      hunks.push({
        kind: "add",
        path: newPath,
        contents
      });
      continue;
    }

    if (newIsDevNull) {
      if (!oldPath || oldPath === "/dev/null") {
        throw new Error("Invalid unified diff: deleted file path is missing");
      }
      hunks.push({
        kind: "delete",
        path: oldPath,
        chunks: patch.chunks
      });
      continue;
    }

    if (!oldPath || !newPath) {
      throw new Error("Invalid unified diff: file path is missing");
    }

    if (patch.chunks.length === 0 && oldPath !== newPath) {
      hunks.push({
        kind: "move_only",
        fromPath: oldPath,
        toPath: newPath
      });
      continue;
    }

    if (patch.chunks.length === 0) {
      throw new Error(`Invalid unified diff: no hunks found for path '${oldPath}'`);
    }

    hunks.push({
      kind: "update",
      path: oldPath,
      movePath: oldPath === newPath ? undefined : newPath,
      chunks: patch.chunks
    });
  }

  return { hunks };
}

function parseAnyPatchText(input: string): { hunks: Hunk[] } {
  const text = String(input ?? "");
  if (!text.trim()) {
    throw new Error("Invalid patch: input is empty.");
  }
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.trim() === BEGIN_PATCH_MARKER) {
    return parsePatchText(text);
  }
  return parseUnifiedDiffPatchText(text);
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

  const parsed = parseAnyPatchText(params.patchText);
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
      if (current.exists) {
        throw new Error(`add target already exists: ${fullPath}`);
      }
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
      if (hunk.chunks.length === 0 && before !== "" && hunk.allowDeleteWithoutHunks !== true) {
        throw new Error(`delete patch for non-empty file must include hunks: ${fullPath}`);
      }
      if (hunk.chunks.length > 0) {
        // 仅用于内容校验,不影响最终删除语义。
        deriveNewContentFromChunks({
          filePath: fullPath,
          originalContent: before,
          chunks: hunk.chunks
        });
      }
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

    if (hunk.kind === "move_only") {
      const fromPath = ensureSafeRelativePath(hunk.fromPath);
      const toPath = ensureSafeRelativePath(hunk.toPath);
      const fromFullPath = resolveWithinWorkspace(params.workspacePath, fromPath);
      const toFullPath = resolveWithinWorkspace(params.workspacePath, toPath);

      const current = await readVirtualFileState({
        virtualFiles,
        relativePath: fromPath,
        fullPath: fromFullPath,
        workspaceRealPath
      });
      if (!current.exists) {
        throw new Error(`Failed to read file to move: ${fromFullPath}`);
      }
      const before = current.content;

      await ensureParentDirectorySafe({
        workspacePath: params.workspacePath,
        workspaceRealPath,
        fullPath: toFullPath,
        createMissing: false
      });

      if (toFullPath === fromFullPath) {
        operations.push({
          kind: "update",
          path: fromPath,
          fullPath: fromFullPath,
          content: before
        });
        files.push({
          type: "update",
          path: fromPath,
          before,
          after: before,
          additions: 0,
          deletions: 0
        });
        recordUnique(modified, seenModified, fromPath);
        writeVirtualFileState({
          virtualFiles,
          relativePath: fromPath,
          fullPath: fromFullPath,
          state: {
            exists: true,
            content: before
          }
        });
        continue;
      }

      const target = await readVirtualFileState({
        virtualFiles,
        relativePath: toPath,
        fullPath: toFullPath,
        workspaceRealPath
      });
      if (target.exists) {
        throw new Error(`move target already exists: ${toFullPath}`);
      }

      operations.push({
        kind: "move",
        path: toPath,
        fromPath,
        fullPath: toFullPath,
        fromFullPath,
        content: before
      });
      files.push({
        type: "move",
        path: toPath,
        fromPath,
        before,
        after: before,
        additions: 0,
        deletions: 0
      });
      recordUnique(modified, seenModified, toPath);
      const movedKey = `${fromPath}->${toPath}`;
      if (!seenMoved.has(movedKey)) {
        seenMoved.add(movedKey);
        moved.push({ fromPath, toPath });
      }
      writeVirtualFileState({
        virtualFiles,
        relativePath: fromPath,
        fullPath: fromFullPath,
        state: {
          exists: false,
          content: ""
        }
      });
      writeVirtualFileState({
        virtualFiles,
        relativePath: toPath,
        fullPath: toFullPath,
        state: {
          exists: true,
          content: before
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

    if (operation.kind === "add") {
      await ensureWritableParent(params.workspacePath, workspaceRealPath, operation.fullPath);
      try {
        await fs.writeFile(operation.fullPath, operation.content, { encoding: "utf8", flag: "wx" });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "EEXIST") {
          throw new Error(`add target already exists: ${operation.fullPath}`);
        }
        throw err;
      }
      continue;
    }

    if (operation.kind === "update") {
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
