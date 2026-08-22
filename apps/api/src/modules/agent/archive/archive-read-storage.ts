import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { agentArchiveSessionDir } from "../../../infra/fs/paths.js";

const WIDTH = 8;
const LIMIT = 100;
const FILE_RE = /^\d{8}\.log$/;
const TRUNCATED = "[超过最大字符数限制,从此处截断内容]";
const SNIPPET_CONTEXT = 40;
const SNIPPET_GAP = 12;
const SNIPPET_MAX_WINDOWS = 5;
const SNIPPET_FALLBACK = 100;

type Match = { line: number; text: string; submatches?: Array<{ start: number; end: number }> };

function splitLines(text: string) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (/\r?\n$/.test(text)) { if (lines.at(-1) === "") lines.pop(); return lines; }
  lines.pop();
  return lines;
}
function parseName(name: string) { if (!FILE_RE.test(name)) return null; const n = Number(name.slice(0, WIDTH)); return Number.isFinite(n) && n >= 1 ? n : null; }
function pos(fileSeq: number, line: number) { return (fileSeq - 1) * LIMIT + line; }
function trimEnding(text: string) { return text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text; }
function fit(lines: string[], maxChars: number) {
  const kept: string[] = []; let chars = 0;
  for (const line of lines) {
    const remain = maxChars - chars; if (remain <= 1) break;
    const budget = remain - 1;
    if (line.length <= budget) { kept.push(line); chars += line.length + 1; continue; }
    const sep = line.indexOf(" | ");
    if (sep >= 0 && budget >= sep + 3 + TRUNCATED.length) kept.push(`${line.slice(0, sep + 3)}${line.slice(sep + 3, sep + 3 + budget - (sep + 3) - TRUNCATED.length)}${TRUNCATED}`);
    else if (budget >= TRUNCATED.length) kept.push(`${line.slice(0, budget - TRUNCATED.length)}${TRUNCATED}`);
    break;
  }
  return kept.reverse().join("\n");
}
async function rg(filePath: string, query: string, regex: boolean, includeOffsets: boolean) {
  const args = includeOffsets ? ["--json", "-n", "--color", "never", "--max-columns", "20000", "--max-columns-preview", "-i"] : ["-n", "--no-heading", "--color", "never", "--max-columns", "20000", "--max-columns-preview", "-i"];
  if (!regex) args.push("-F"); args.push("--", query, filePath);
  return new Promise<Match[]>((resolve, reject) => {
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += String(c || ""); }); child.stderr.on("data", c => { stderr += String(c || ""); }); child.on("error", reject);
    child.on("close", code => { if (code !== 0 && code !== 1) return reject(new Error(stderr.trim() || `rg exit code ${String(code)}`)); if (code === 1) return resolve([]);
      const result: Match[] = []; for (const raw of stdout.split(/\r?\n/)) { if (!raw) continue;
        if (!includeOffsets) { const i = raw.indexOf(":"); const line = Number(raw.slice(0, i)); const text = trimEnding(raw.slice(i + 1)); if (i > 0 && Number.isInteger(line) && line > 0 && text) result.push({ line, text }); continue; }
        try { const event = JSON.parse(raw); const data = event?.type === "match" ? event.data : null; const line = Number(data?.line_number); const text = trimEnding(rgJsonText(data?.lines)); if (!Number.isInteger(line) || line < 1 || !text) continue; const submatches = Array.isArray(data?.submatches) ? data.submatches.map((x: any) => ({ start: Number(x.start), end: Number(x.end) })).filter((x: any) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.start >= 0 && x.end >= x.start) : []; result.push({ line, text, submatches }); } catch {}
      } resolve(result);
    });
  });
}
function rgJsonText(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const field = value as { text?: unknown; bytes?: unknown };
  if (typeof field.text === "string") return field.text;
  if (typeof field.bytes !== "string") return "";
  try { return Buffer.from(field.bytes, "base64").toString("utf8"); } catch { return ""; }
}
function byteToUnit(text: string, byte: number) { const target = Math.max(0, Math.min(Buffer.byteLength(text, "utf8"), Math.floor(byte))); let bytes = 0, units = 0; for (const char of text) { const size = Buffer.byteLength(char, "utf8"); if (bytes + size > target) break; bytes += size; units += char.length; } return units; }
function snippet(match: Match) {
  const separator = match.text.indexOf(" | "); const meta = separator >= 0 ? match.text.slice(0, separator) : ""; const text = separator >= 0 ? match.text.slice(separator + 3) : match.text;
  if (!text) return meta;
  const startBytes = separator >= 0 ? Buffer.byteLength(match.text.slice(0, separator + 3), "utf8") : 0; const textBytes = Buffer.byteLength(text, "utf8");
  const windows: Array<{ start: number; end: number }> = [];
  for (const hit of match.submatches || []) { const localStart = Math.max(0, hit.start - startBytes), localEnd = Math.min(textBytes, hit.end - startBytes); let start = byteToUnit(text, localStart), end = byteToUnit(text, localEnd); if (end <= start) { if (start >= text.length) { start = Math.max(0, text.length - 1); end = text.length; } else end = Math.min(text.length, start + 1); } if (end > start) windows.push({ start: Math.max(0, start - SNIPPET_CONTEXT), end: Math.min(text.length, end + SNIPPET_CONTEXT) }); }
  if (!windows.length) { const fallback = text.length <= SNIPPET_FALLBACK ? text : `${text.slice(0, SNIPPET_FALLBACK)}...`; return meta ? `${meta} | ${fallback}` : fallback; }
  windows.sort((a,b) => a.start - b.start || a.end - b.end); const merged: Array<{ start: number; end: number }> = [];
  for (const window of windows) { const previous = merged.at(-1); if (!previous) { merged.push(window); continue; } if (window.start <= previous.end + SNIPPET_GAP) { previous.end = Math.max(previous.end, window.end); continue; } if (merged.length >= SNIPPET_MAX_WINDOWS) break; merged.push(window); }
  const value = merged.map(window => `${window.start > 0 ? "..." : ""}${text.slice(window.start, window.end).trim()}${window.end < text.length ? "..." : ""}`).filter(Boolean).join(" ... ");
  return meta ? `${meta} | ${value || text.slice(0, SNIPPET_FALLBACK)}` : value || text;
}

/** Filesystem-only Archive read capability. It owns listing, complete-line reads and rg invocation. */
export class ArchiveReadStorage {
  constructor(private readonly dataDir: string) {}
  private async files(workspaceId: string, sessionId: string) {
    const dir = agentArchiveSessionDir(this.dataDir, workspaceId, sessionId);
    const names = await fs.readdir(dir).catch((err: NodeJS.ErrnoException) => err.code === "ENOENT" ? [] : Promise.reject(err));
    return { dir, names: names.map(name => ({ name, seq: parseName(name) })).filter((x): x is { name: string; seq: number } => x.seq != null).sort((a,b) => a.seq - b.seq) };
  }
  async search(params: { workspaceId: string; sessionId: string; query: string; beforePos?: number; maxHits: number; maxChars: number; snippet: boolean; regex: boolean }) {
    const { dir, names } = await this.files(params.workspaceId, params.sessionId); if (!names.length) return { text: "", noArchive: true as const };
    const output: string[] = [];
    outer: for (let i = names.length - 1; i >= 0; i--) { const entry = names[i]!; const filePath = path.join(dir, entry.name); let matches: Match[];
      try { matches = await rg(filePath, params.query, params.regex, params.snippet); const content = await fs.readFile(filePath, "utf8").catch((err: NodeJS.ErrnoException) => err.code === "ENOENT" ? "" : Promise.reject(err)); const count = splitLines(content).length; matches = matches.filter(m => m.line <= count); } catch (err) { const message = err instanceof Error ? err.message : String(err); throw new Error(`archive search failed: ${message}`); }
      matches.sort((a,b) => b.line - a.line); for (const match of matches) { if (output.length >= params.maxHits) break outer; const value = pos(entry.seq, match.line); if (params.beforePos != null && value >= params.beforePos) continue; output.push(`pos=${value} | ${params.snippet ? snippet(match) : match.text}`); }
    } return { text: fit(output, params.maxChars) };
  }
  async read(params: { workspaceId: string; sessionId: string; beforePos?: number; lineCount: number; maxChars: number }) {
    const { dir, names } = await this.files(params.workspaceId, params.sessionId); if (!names.length) return { text: "", noArchive: true as const };
    const output: string[] = []; outer: for (let i = names.length - 1; i >= 0; i--) { const entry = names[i]!; const content = await fs.readFile(path.join(dir, entry.name), "utf8").catch((err: NodeJS.ErrnoException) => err.code === "ENOENT" ? "" : Promise.reject(err)); const lines = splitLines(content); let upper = lines.length; if (params.beforePos != null) upper = Math.min(upper, Math.max(0, params.beforePos - (entry.seq - 1) * LIMIT - 1)); for (let line = upper; line >= 1; line--) { if (output.length >= params.lineCount) break outer; const value = pos(entry.seq, line); if (params.beforePos != null && value >= params.beforePos) continue; output.push(`pos=${value} | ${String(lines[line - 1] || "")}`); } }
    return { text: fit(output, params.maxChars) };
  }
}
