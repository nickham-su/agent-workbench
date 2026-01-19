import { spawn } from "node:child_process";
import type { FileSearchResponse } from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";

const SEARCH_CONTEXT_LINES = 2;
const SEARCH_RESULT_LIMIT = 1000;
const SEARCH_TIMEOUT_MS = 5000;
export const SEARCH_FORCED_EXCLUDES = ["**/.git/**"];

type FileSearchRunOptions = {
  cwd: string;
  query: string;
  useRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  excludeGlobs: string[];
  searchPaths: string[];
};

function trimLineText(raw: string) {
  if (!raw) return "";
  if (raw.endsWith("\r\n")) return raw.slice(0, -2);
  if (raw.endsWith("\n")) return raw.slice(0, -1);
  return raw;
}

function byteOffsetToColumn(lineText: string, byteOffset: number) {
  const buf = Buffer.from(lineText, "utf8");
  const clipped = Math.max(0, Math.min(byteOffset, buf.length));
  const prefix = buf.subarray(0, clipped).toString("utf8");
  return prefix.length + 1;
}

function normalizeSearchExcludeGlobs(raw: string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of raw) {
    const value = String(item || "").trim();
    if (!value) continue;
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  return next;
}

function isRgUserError(message: string) {
  const lower = message.toLowerCase();
  if (!lower) return false;
  return (
    lower.includes("regex parse error") ||
    lower.includes("error parsing regex") ||
    lower.includes("invalid regex") ||
    lower.includes("error parsing --glob") ||
    lower.includes("invalid glob") ||
    lower.includes("error parsing glob") ||
    lower.includes("unrecognized escape") ||
    lower.includes("invalid escape")
  );
}

export async function runFileSearch(params: FileSearchRunOptions): Promise<FileSearchResponse> {
  const query = params.query.trim();
  if (!query) throw new HttpError(400, "Invalid query");

  const excludeGlobs = normalizeSearchExcludeGlobs(params.excludeGlobs);
  const args = ["--no-config", "--no-follow", "--json", "--hidden", "-C", String(SEARCH_CONTEXT_LINES)];
  if (!params.useRegex) args.push("--fixed-strings");
  if (!params.caseSensitive) args.push("--ignore-case");
  if (params.wholeWord) args.push("-w");
  for (const glob of excludeGlobs) {
    args.push("--glob", `!${glob}`);
  }
  const searchPaths = params.searchPaths.length > 0 ? params.searchPaths : ["."];
  args.push("--", query, ...searchPaths);

  const startedAt = Date.now();
  let truncated = false;
  let timedOut = false;
  let killed = false;
  let matchCount = 0;
  let stderrText = "";

  const linesByFile = new Map<string, Map<number, string>>();
  const hitsByFile = new Map<string, Map<number, Array<{ kind: "range"; startCol: number; endCol: number }>>>();
  const matches: FileSearchResponse["matches"] = [];

  const child = spawn("rg", args, { cwd: params.cwd });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const killChild = () => {
    if (killed) return;
    killed = true;
    child.kill();
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    killChild();
  }, SEARCH_TIMEOUT_MS);

  let buffer = "";
  const addLine = (pathText: string, lineNumber: number, lineText: string) => {
    const fileMap = linesByFile.get(pathText) ?? new Map<number, string>();
    fileMap.set(lineNumber, lineText);
    linesByFile.set(pathText, fileMap);
  };
  const addHits = (pathText: string, lineNumber: number, hits: Array<{ kind: "range"; startCol: number; endCol: number }>) => {
    if (hits.length === 0) return;
    const fileMap = hitsByFile.get(pathText) ?? new Map<number, Array<{ kind: "range"; startCol: number; endCol: number }>>();
    const list = fileMap.get(lineNumber) ?? [];
    list.push(...hits);
    fileMap.set(lineNumber, list);
    hitsByFile.set(pathText, fileMap);
  };

  const onLine = (line: string) => {
    if (!line) return;
    let payload: any;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    const type = payload?.type;
    if (type !== "match" && type !== "context") return;
    const data = payload?.data ?? {};
    const pathText = typeof data?.path?.text === "string" ? data.path.text : "";
    const lineNumber = typeof data?.line_number === "number" ? data.line_number : 0;
    const rawLine = typeof data?.lines?.text === "string" ? data.lines.text : "";
    if (!pathText || !lineNumber) return;
    const lineText = trimLineText(rawLine);
    addLine(pathText, lineNumber, lineText);

    if (type === "context") return;
    if (matchCount >= SEARCH_RESULT_LIMIT) return;

    let highlight: FileSearchResponse["matches"][number]["highlight"];
    let hits: Array<{ kind: "range"; startCol: number; endCol: number }> = [];
    if (!params.useRegex) {
      const submatches = Array.isArray(data?.submatches) ? data.submatches : [];
      for (const sub of submatches) {
        const start = typeof sub?.start === "number" ? sub.start : -1;
        const end = typeof sub?.end === "number" ? sub.end : -1;
        if (start < 0 || end <= start) continue;
        const startCol = byteOffsetToColumn(lineText, start);
        const endCol = byteOffsetToColumn(lineText, end);
        hits.push({ kind: "range", startCol, endCol });
      }
    }

    if (params.useRegex || hits.length === 0) {
      highlight = { kind: "line" };
    } else {
      highlight = { kind: "range", startCol: hits[0]!.startCol, endCol: hits[0]!.endCol };
      addHits(pathText, lineNumber, hits);
    }

    matches.push({ path: pathText, line: lineNumber, lineText, highlight });
    matchCount += 1;
    if (matchCount >= SEARCH_RESULT_LIMIT) {
      truncated = true;
      killChild();
    }
  };

  const done = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(line);
        idx = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (buffer) onLine(buffer);
      if (timedOut || truncated) return resolve();
      if (code === 0 || code === 1) return resolve();
      const reason = stderrText.trim() || "rg failed";
      const status = isRgUserError(reason) ? 400 : 500;
      reject(new HttpError(status, reason));
    });
  });

  await done;

  const matchesByFile = new Map<string, Array<{ line: number }>>();
  for (const match of matches) {
    const list = matchesByFile.get(match.path) ?? [];
    list.push({ line: match.line });
    matchesByFile.set(match.path, list);
  }

  const blocks: FileSearchResponse["blocks"] = [];
  for (const [pathText, list] of matchesByFile) {
    const ranges = list
      .map((item) => ({
        from: Math.max(1, item.line - SEARCH_CONTEXT_LINES),
        to: item.line + SEARCH_CONTEXT_LINES,
        line: item.line
      }))
      .sort((a, b) => (a.from === b.from ? a.to - b.to : a.from - b.from));

    const merged: Array<{ from: number; to: number; lines: number[] }> = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (!last || range.from > last.to + 1) {
        merged.push({ from: range.from, to: range.to, lines: [range.line] });
        continue;
      }
      last.to = Math.max(last.to, range.to);
      last.lines.push(range.line);
    }

    const lineMap = linesByFile.get(pathText) ?? new Map<number, string>();
    const hitMap = hitsByFile.get(pathText) ?? new Map<number, Array<{ kind: "range"; startCol: number; endCol: number }>>();
    for (const block of merged) {
      const lineNumbers = Array.from(lineMap.keys())
        .filter((n) => n >= block.from && n <= block.to)
        .sort((a, b) => a - b);
      const lines = lineNumbers.map((lineNumber) => {
        const text = lineMap.get(lineNumber) ?? "";
        const hits = params.useRegex ? undefined : hitMap.get(lineNumber);
        if (hits && hits.length > 0) return { line: lineNumber, text, hits };
        return { line: lineNumber, text };
      });
      const hitLines = Array.from(new Set(block.lines)).sort((a, b) => a - b);
      blocks.push({
        path: pathText,
        fromLine: block.from,
        toLine: block.to,
        lines,
        hitLines
      });
    }
  }

  return {
    query,
    useRegex: params.useRegex,
    caseSensitive: params.caseSensitive,
    wholeWord: params.wholeWord ? true : undefined,
    limit: SEARCH_RESULT_LIMIT,
    matches,
    blocks,
    truncated,
    timedOut,
    tookMs: Date.now() - startedAt,
    ignoredByVcs: true,
    ignoredByDotIgnore: true
  };
}
