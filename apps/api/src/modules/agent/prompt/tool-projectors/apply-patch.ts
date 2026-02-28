import type { ToolPromptProjector } from "./types.js";

const MAX_PROMPT_FILES = 40;

function toRecord(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function toStringOrEmpty(raw: unknown) {
  return typeof raw === "string" ? raw : "";
}

function toNonNegativeInt(raw: unknown) {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function resolvePath(file: Record<string, unknown>) {
  const candidates = [file.path, file.relativePath, file.filePath, file.toPath];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }
  return "";
}

function resolveFromPath(file: Record<string, unknown>) {
  const candidates = [file.fromPath, file.moveFromPath, file.movePathFrom, file.sourcePath];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }
  return "";
}

export const applyPatchToolPromptProjector: ToolPromptProjector = {
  projectCallInput(args) {
    // 保留 patchText 原文,让模型明确知道历史操作意图。
    return args;
  },
  projectResult(result, ctx) {
    const source = toRecord(result);
    if (!source) return result;

    const summary = toRecord(source.summary);
    const filesRaw = Array.isArray(source.files) ? source.files : [];

    const files: Array<{
      type: "add" | "update" | "delete" | "move";
      path: string;
      fromPath?: string;
      additions: number;
      deletions: number;
    }> = [];
    let sumAdditions = 0;
    let sumDeletions = 0;

    for (const item of filesRaw) {
      const file = toRecord(item);
      if (!file) continue;
      const typeRaw = String(file.type || "").trim();
      const type = typeRaw === "add" || typeRaw === "update" || typeRaw === "delete" || typeRaw === "move"
        ? typeRaw
        : "update";
      const filePath = resolvePath(file);
      if (!filePath) continue;
      const additions = toNonNegativeInt(file.additions) ?? 0;
      const deletions = toNonNegativeInt(file.deletions) ?? 0;
      sumAdditions += additions;
      sumDeletions += deletions;
      const fromPath = type === "move" ? resolveFromPath(file) : "";

      files.push({
        type,
        path: filePath,
        ...(fromPath ? { fromPath } : {}),
        additions,
        deletions
      });
    }

    const fileCount = toNonNegativeInt(summary?.fileCount) ?? files.length;
    const additions = toNonNegativeInt(summary?.additions) ?? sumAdditions;
    const deletions = toNonNegativeInt(summary?.deletions) ?? sumDeletions;
    const text = toStringOrEmpty(source.text);
    const shownFiles = files.slice(0, MAX_PROMPT_FILES);
    const omittedFiles = Math.max(0, files.length - shownFiles.length);

    return {
      status: ctx.status,
      text,
      fileCount,
      additions,
      deletions,
      files: shownFiles,
      omittedFiles
    };
  }
};
