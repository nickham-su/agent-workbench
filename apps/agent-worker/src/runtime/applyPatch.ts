import fs from "node:fs/promises";
import path from "node:path";
import { deriveNewContentFromChunks, type UpdateFileChunk } from "./applyPatchUpdate.js";

const END_PATCH_MARKER = "*** End Patch";
const LEGACY_PATCH_MARKER_LINES = [
  "*** Begin Patch",
  "*** Update File:",
  "*** Add File:",
  "*** Delete File:"
];

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
  notes: string[];
  text: string;
  snapshots: ApplyPatchSnapshot[];
};

type ApplyPatchSnapshot =
  | {
      kind: "present";
      path: string;
      fullPath: string;
      content: string;
    }
  | {
      kind: "absent";
      path: string;
      fullPath: string;
    };

type NormalizedApplyPatchInput = {
  text: string;
  notes: string[];
};

type ApplyPatchFailureCode =
  | "INVALID_FORMAT"
  | "LEGACY_PATCH_FORMAT"
  | "CONTEXT_MISMATCH"
  | "PATH_OUT_OF_SCOPE"
  | "PATH_INVALID"
  | "BINARY_UNSUPPORTED"
  | "SUBMODULE_UNSUPPORTED"
  | "COPY_UNSUPPORTED"
  | "CONFLICT"
  | "ABORTED"
  | "IO_RETRYABLE"
  | "MISSING_PARENT_DIR"
  | "INTERNAL_ERROR";

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new Error("operation aborted");
}

function buildApplyPatchFailureText(params: {
  code: ApplyPatchFailureCode;
  retryable: boolean;
  repairAttempted: boolean;
  failedFiles: string[];
  details: string[];
  hint: string;
}) {
  const lines = [`apply_patch verification failed: ${params.code}`];
  lines.push("", "Summary:");
  lines.push(`- Retryable: ${params.retryable ? "yes" : "no"}`);
  lines.push(`- Repair attempted: ${params.repairAttempted ? "yes" : "no"}`);
  if (params.failedFiles.length > 0) {
    lines.push(`- Failed files: ${params.failedFiles.join(", ")}`);
  }
  lines.push("", "Details:");
  if (params.details.length > 0) {
    for (const detail of params.details) {
      lines.push(`- ${detail}`);
    }
  } else {
    lines.push("- (no additional details)");
  }
  lines.push("", "Hint:");
  lines.push(params.hint || "Regenerate the patch and try again.");
  return lines.join("\n");
}

export type ApplyPatchFailureClassification = ReturnType<typeof classifyApplyPatchFailureMessage>;

export function formatApplyPatchFailureTextFromMessage(message: string, params?: { repairAttempted?: boolean }) {
  const classified = classifyApplyPatchFailureMessage(message);
  return buildApplyPatchFailureText({
    code: classified.code,
    retryable: classified.retryable,
    repairAttempted: params?.repairAttempted ?? false,
    failedFiles: classified.failedFiles,
    details: message.split("\n").filter((line) => String(line || "").trim().length > 0),
    hint: classified.hint
  });
}

function buildSnapshotMismatchMessage(params: {
  reason: string;
  path: string;
  fullPath: string;
  details: string[];
}) {
  const lines = [`prepare/apply snapshot mismatch: ${params.reason}`];
  lines.push(`Failed file: ${params.path}`);
  lines.push(`Path: ${params.fullPath}`);
  for (const detail of params.details) {
    lines.push(detail);
  }
  lines.push("Hint: re-run apply_patch after re-reading the latest workspace files.");
  return lines.join("\n");
}

function summarizeSnapshotContent(label: string, content: string) {
  const normalized = content.replace(/\r\n?/g, "\n");
  const preview = normalized.split("\n").slice(0, 3).join("\n");
  const suffix = countLines(normalized) > 3 ? "…" : "";
  return `${label}: ${countLines(normalized)} line(s), ${Buffer.byteLength(content, "utf8")} byte(s)${preview ? `, preview: ${JSON.stringify(preview + suffix)}` : ""}.`;
}

export function classifyApplyPatchFailureMessage(message: string): {
  code: ApplyPatchFailureCode;
  retryable: boolean;
  failedFiles: string[];
  hint: string;
} {
  const normalized = String(message || "");
  const failedFiles = extractFailedFilesFromMessage(normalized);

  if (/operation aborted/i.test(normalized)) {
    return {
      code: "ABORTED",
      retryable: false,
      failedFiles,
      hint: "The operation was aborted. Re-run the patch if the task is still needed."
    };
  }

  if (/legacy patch format/i.test(normalized) || /only supports git unified diff/i.test(normalized)) {
    return {
      code: "LEGACY_PATCH_FORMAT",
      retryable: false,
      failedFiles,
      hint: "Rewrite the patch using git unified diff syntax, starting with diff --git, --- and +++ lines."
    };
  }

  if (
    /outside workspace/i.test(normalized) ||
    /absolute path is not allowed/i.test(normalized) ||
    /symlink path is not allowed/i.test(normalized)
  ) {
    return {
      code: "PATH_OUT_OF_SCOPE",
      retryable: false,
      failedFiles,
      hint: "Use a path inside the current workspace and avoid symlinks or parent-directory escapes."
    };
  }

  if (/invalid path/i.test(normalized)) {
    return {
      code: "PATH_INVALID",
      retryable: false,
      failedFiles,
      hint: "Use a valid relative file path without NUL or newline characters."
    };
  }

  if (/binary patch is not supported/i.test(normalized)) {
    return {
      code: "BINARY_UNSUPPORTED",
      retryable: false,
      failedFiles,
      hint: "Use apply_patch only for text files. Handle binary files with another workflow."
    };
  }

  if (/submodule diff is not supported/i.test(normalized)) {
    return {
      code: "SUBMODULE_UNSUPPORTED",
      retryable: false,
      failedFiles,
      hint: "Submodule changes are not supported by apply_patch. Use git operations or another workflow."
    };
  }

  if (/copy from\/to is not supported/i.test(normalized)) {
    return {
      code: "COPY_UNSUPPORTED",
      retryable: false,
      failedFiles,
      hint: "Rewrite the patch as an explicit add/update/delete sequence instead of copy from/to."
    };
  }

  if (/Failed to find expected lines/i.test(normalized) || /did not match current file content/i.test(normalized)) {
    return {
      code: "CONTEXT_MISMATCH",
      retryable: true,
      failedFiles,
      hint: "Re-read the target file and regenerate a smaller patch with more accurate context."
    };
  }

  if (/snapshot mismatch/i.test(normalized) || /state drift/i.test(normalized) || /changed after prepare/i.test(normalized)) {
    return {
      code: "CONFLICT",
      retryable: false,
      failedFiles,
      hint: "Re-read the latest workspace state and regenerate the patch against the current file contents."
    };
  }

  if (/^MISSING_PARENT_DIR:/i.test(normalized) || /missing parent directory/i.test(normalized)) {
    return {
      code: "MISSING_PARENT_DIR",
      retryable: true,
      failedFiles,
      hint: "Re-run after ensuring the target parent directory exists and is writable."
    };
  }

  if (/^IO_RETRYABLE:/i.test(normalized) || /\b(EBUSY|EAGAIN|EMFILE|ENFILE|ETXTBSY)\b/i.test(normalized)) {
    return {
      code: "IO_RETRYABLE",
      retryable: true,
      failedFiles,
      hint: "Retry the operation once after the transient filesystem error clears."
    };
  }

  if (/already exists/i.test(normalized)) {
    return {
      code: "CONFLICT",
      retryable: false,
      failedFiles,
      hint: "Adjust the patch so it does not create or move a file over an existing target."
    };
  }

  if (/invalid patch/i.test(normalized) || /invalid unified diff/i.test(normalized) || /no hunks found/i.test(normalized)) {
    return {
      code: "INVALID_FORMAT",
      retryable: false,
      failedFiles,
      hint: "Provide a valid git unified diff patch with diff --git, ---/+++ file headers, and @@ hunks."
    };
  }

  return {
    code: "INTERNAL_ERROR",
    retryable: false,
    failedFiles,
    hint: "Fix the patch and try again. If the problem persists, regenerate the diff from the latest file contents."
  };
}

function extractFailedFilesFromMessage(message: string) {
  const matches = [
    /(?:MISSING_PARENT_DIR|IO_RETRYABLE): .*? for (.+)/i,
    /Failed to read file to (?:delete|move|update): (.+)/i,
    /add target already exists: (.+)/i,
    /move target already exists: (.+)/i,
    /Failed to find expected lines in (.+)/i,
    /symlink path is not allowed: (.+)/i,
    /absolute path is not allowed(?:[: ]+(.+))?/i,
    /path is outside workspace(?:[: ]+(.+))?/i
  ];
  for (const pattern of matches) {
    const result = pattern.exec(message);
    if (result?.[1]) {
      return [result[1].trim()];
    }
  }
  return [];
}

function normalizeMarkdownFence(text: string) {
  const lines = text.split("\n");
  if (lines.length < 3) return null;
  const first = lines[0]?.trim() ?? "";
  const last = lines[lines.length - 1]?.trim() ?? "";
  const match = /^```([A-Za-z0-9_-]+)?\s*$/.exec(first);
  if (!match || last !== "```") return null;
  return {
    language: match[1] ?? "",
    body: lines.slice(1, -1).join("\n").trim()
  };
}

function normalizeApplyPatchInput(input: string): NormalizedApplyPatchInput {
  let text = String(input ?? "");
  const notes: string[] = [];

  if (/\r/.test(text)) {
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    notes.push("Normalized line endings to LF.");
  }

  const trimmed = text.trim();
  if (trimmed !== text) {
    text = trimmed;
    notes.push("Trimmed leading and trailing whitespace.");
  }

  const fenced = normalizeMarkdownFence(text);
  if (fenced) {
    text = fenced.body;
    notes.push(`Removed outer Markdown code block${fenced.language ? ` (${fenced.language})` : ""}.`);
  }

  const diffIndex = text.search(/^diff --git /m);
  if (diffIndex > 0) {
    const prefix = text.slice(0, diffIndex).trim();
    if (prefix) {
      text = text.slice(diffIndex).trimEnd();
      notes.push("Removed leading explanatory text before diff --git.");
    }
  }

  return { text, notes };
}

async function readCurrentFileStateForValidation(fullPath: string) {
  const stat = await fs.lstat(fullPath).catch(() => null);
  if (!stat) {
    return { exists: false, content: "" };
  }
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory: ${fullPath}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`symlink path is not allowed: ${fullPath}`);
  }
  const content = await fs.readFile(fullPath, "utf8");
  return { exists: true, content };
}

async function validatePreparedPatchSnapshots(params: {
  workspacePath: string;
  workspaceRealPath: string;
  snapshots: ApplyPatchSnapshot[];
}) {
  const seen = new Set<string>();
  for (const snapshot of params.snapshots) {
    const key = path.resolve(snapshot.fullPath);
    if (seen.has(key)) continue;
    seen.add(key);

    await ensureExistingPathSegmentsSafeForValidation({
      workspacePath: params.workspacePath,
      workspaceRealPath: params.workspaceRealPath,
      fullPath: snapshot.fullPath
    });
    const current = await readCurrentFileStateForValidation(snapshot.fullPath);

    if (snapshot.kind === "absent") {
      if (current.exists) {
        throw new Error(
          buildSnapshotMismatchMessage({
            reason: "target already exists before apply",
            path: snapshot.path,
            fullPath: snapshot.fullPath,
            details: ["Expected: file to be absent at apply time.", summarizeSnapshotContent("Actual", current.content)]
          })
        );
      }
      continue;
    }

    if (!current.exists) {
      throw new Error(
        buildSnapshotMismatchMessage({
          reason: "source disappeared before apply",
          path: snapshot.path,
          fullPath: snapshot.fullPath,
          details: ["Expected: file to still exist at apply time.", "Actual: file is missing."]
        })
      );
    }
    if (current.content !== snapshot.content) {
      throw new Error(
        buildSnapshotMismatchMessage({
          reason: "content changed after prepare",
          path: snapshot.path,
          fullPath: snapshot.fullPath,
          details: [summarizeSnapshotContent("Expected", snapshot.content), summarizeSnapshotContent("Actual", current.content)]
        })
      );
    }
  }
}

async function ensureExistingPathSegmentsSafeForValidation(params: {
  workspacePath: string;
  workspaceRealPath: string;
  fullPath: string;
}) {
  if (!isPathInside(params.workspacePath, params.fullPath)) {
    throw new Error("path is outside workspace");
  }

  let current = path.resolve(params.workspacePath);
  await ensureRealPathInsideWorkspace(params.workspaceRealPath, current);

  const relative = path.relative(current, params.fullPath);
  const parts = relative.split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`symlink path is not allowed: ${current}`);
    }
    await ensureRealPathInsideWorkspace(params.workspaceRealPath, current);
    if (!stat.isDirectory()) return;
  }
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

function stripTrailingEndPatchMarkerForUnifiedDiff(input: string) {
  const text = String(input ?? "");
  const lines = text.split(/\r?\n/);

  // Strip trailing empty lines first.
  let end = lines.length;
  while (end > 0 && String(lines[end - 1] ?? "").trim() === "") {
    end -= 1;
  }
  if (end <= 0) return text;

  const lastLine = String(lines[end - 1] ?? "");
  // Only tolerate a *bare* legacy marker at the very end of a unified diff.
  // NOTE: a leading space like " *** End Patch" may be a valid unified diff context line and must not be stripped.
  if (/^[\t ]/.test(lastLine)) return text;
  if (lastLine.trimEnd() !== END_PATCH_MARKER) return text;

  return lines.slice(0, end - 1).join("\n");
}

function detectPatchDialect(input: string): "legacy" | "unified" | "unknown" {
  const firstLine = String(input ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

  if (LEGACY_PATCH_MARKER_LINES.some((marker) => firstLine === marker || firstLine.startsWith(marker))) {
    return "legacy";
  }
  if (
    firstLine.startsWith("diff --git ") ||
    firstLine.startsWith("--- ") ||
    firstLine.startsWith("rename from ") ||
    firstLine.startsWith("rename to ")
  ) {
    return "unified";
  }
  return "unknown";
}

function buildLegacyPatchFormatError() {
  return [
    "apply_patch only supports git unified diff.",
    "Detected legacy patch format like '*** Begin Patch' / '*** Update File:'.",
    "Please rewrite the patch using unified diff lines such as:",
    "diff --git a/<path> b/<path>",
    "--- a/<path>",
    "+++ b/<path>",
    "@@ -1,1 +1,1 @@"
  ].join("\n");
}

function parseAnyPatchText(input: string): { hunks: Hunk[] } {
  const text = String(input ?? "");
  if (!text.trim()) throw new Error("Invalid patch: input is empty.");
  if (detectPatchDialect(text) === "legacy") {
    throw new Error(buildLegacyPatchFormatError());
  }
  const normalized = stripTrailingEndPatchMarkerForUnifiedDiff(text);
  return parseUnifiedDiffPatchText(normalized);
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

function buildSummaryText(files: ApplyPatchFileResult[], notes: string[]) {
  const lines = ["Success. Updated the following files:"];
  for (const file of files) {
    const prefix = file.type === "add" ? "A" : file.type === "delete" ? "D" : file.type === "move" ? "R" : "M";
    const pathLabel = file.type === "move" && file.fromPath ? `${file.fromPath} -> ${file.path}` : file.path;
    lines.push(`${prefix} ${pathLabel} (+${file.additions} -${file.deletions})`);
  }

  if (notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

export async function prepareApplyPatchTool(params: {
  workspacePath: string;
  patchText: string;
  signal?: AbortSignal;
}): Promise<ApplyPatchPrepared> {
  throwIfAborted(params.signal);

  const normalizedInput = normalizeApplyPatchInput(params.patchText);
  const parsed = parseAnyPatchText(normalizedInput.text);
  if (parsed.hunks.length === 0) {
    throw new Error("no hunks found");
  }

  const workspaceRealPath = await fs.realpath(params.workspacePath);
  const operations: ResolvedOperation[] = [];
  const files: ApplyPatchFileResult[] = [];
  const snapshots: ApplyPatchSnapshot[] = [];
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
      snapshots.push({ kind: "absent", path: relativePath, fullPath });
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
      snapshots.push({ kind: "present", path: relativePath, fullPath, content: before });
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
      snapshots.push({ kind: "present", path: fromPath, fullPath: fromFullPath, content: before });

      await ensureParentDirectorySafe({
        workspacePath: params.workspacePath,
        workspaceRealPath,
        fullPath: toFullPath,
        createMissing: false
      });
      if (toFullPath !== fromFullPath) {
        snapshots.push({ kind: "absent", path: toPath, fullPath: toFullPath });
      }

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
    snapshots.push({ kind: "present", path: relativePath, fullPath, content: before });
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
    snapshots.push({ kind: "absent", path: movePath, fullPath: moveFullPath });
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
    notes: normalizedInput.notes,
    text: buildSummaryText(files, normalizedInput.notes),
    snapshots
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

  await validatePreparedPatchSnapshots({
    workspacePath: params.workspacePath,
    workspaceRealPath,
    snapshots: params.prepared.snapshots
  });

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
        if (code === "ENOENT") {
          throw new Error(`MISSING_PARENT_DIR: add failed for ${operation.fullPath}`);
        }
        if (code === "EBUSY" || code === "EAGAIN" || code === "EMFILE" || code === "ENFILE" || code === "ETXTBSY") {
          throw new Error(`IO_RETRYABLE: add failed for ${operation.fullPath} (${code})`);
        }
        throw err;
      }
      continue;
    }

    if (operation.kind === "update") {
      await ensureWritableParent(params.workspacePath, workspaceRealPath, operation.fullPath);
      try {
        await fs.writeFile(operation.fullPath, operation.content, { encoding: "utf8" });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") {
          throw new Error(`MISSING_PARENT_DIR: update failed for ${operation.fullPath}`);
        }
        if (code === "EBUSY" || code === "EAGAIN" || code === "EMFILE" || code === "ENFILE" || code === "ETXTBSY") {
          throw new Error(`IO_RETRYABLE: update failed for ${operation.fullPath} (${code})`);
        }
        throw err;
      }
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
        if (code === "ENOENT") {
          throw new Error(`MISSING_PARENT_DIR: move failed for ${operation.fullPath}`);
        }
        if (code === "EBUSY" || code === "EAGAIN" || code === "EMFILE" || code === "ENFILE" || code === "ETXTBSY") {
          throw new Error(`IO_RETRYABLE: move failed for ${operation.fullPath} (${code})`);
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
