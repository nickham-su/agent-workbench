import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_ROOT_ENV_KEY = "AWB_PROMPTS_DIR";
const promptTextCache = new Map<string, string>();
let promptsRootCache: string | null = null;

function normalizePromptText(raw: string) {
  return String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/g, "");
}

function resolvePromptsRoot() {
  const formatError = (msg: string) => `[prompts] ${msg}`;
  if (promptsRootCache) return promptsRootCache;
  const fromEnvRaw = String(process.env[PROMPTS_ROOT_ENV_KEY] || "").trim();
  if (fromEnvRaw) {
    const fromEnv = path.resolve(process.cwd(), fromEnvRaw);
    let st: fs.Stats;
    try {
      st = fs.statSync(fromEnv);
    } catch (err: any) {
      throw new Error(
        formatError(`AWB_PROMPTS_DIR is set but invalid: ${fromEnv} (${String(err?.message || err)})`)
      );
    }
    if (!st.isDirectory()) {
      throw new Error(formatError(`AWB_PROMPTS_DIR is set but not a directory: ${fromEnv}`));
    }
    promptsRootCache = fromEnv;
    return promptsRootCache;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(process.cwd(), "prompts"),
    path.resolve(moduleDir, "../../../prompts")
  ];

  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      if (st.isDirectory()) {
        promptsRootCache = candidate;
        return promptsRootCache;
      }
    } catch {
      continue;
    }
  }
  throw new Error(`[prompts] prompts directory not found. checked: ${candidates.join(", ")}`);
}

function resolvePromptPath(relativePath: string) {
  const raw = String(relativePath || "").trim();
  if (!raw) throw new Error("[prompts] relativePath is required");
  const normalized = path.posix.normalize(raw.replace(/\\/g, "/"));
  if (normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    throw new Error(`[prompts] invalid relativePath: ${relativePath}`);
  }
  const root = resolvePromptsRoot();
  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`[prompts] resolved path escapes prompts root: ${relativePath}`);
  }
  return resolved;
}

export function getPromptText(relativePath: string) {
  const key = String(relativePath || "").trim();
  if (promptTextCache.has(key)) {
    return promptTextCache.get(key) || "";
  }
  const filePath = resolvePromptPath(key);
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err: any) {
    throw new Error(`[prompts] failed to read prompt file (${key}) at ${filePath}: ${String(err?.message || err)}`);
  }
  const normalized = normalizePromptText(content);
  if (!normalized.trim()) {
    throw new Error(`[prompts] prompt file is empty: ${key}`);
  }
  promptTextCache.set(key, normalized);
  return normalized;
}

export function renderPromptTemplate(templateText: string, values: Record<string, string | number>) {
  const tokenRe = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  const source = normalizePromptText(templateText);
  const tokens = Array.from(source.matchAll(tokenRe)).map((item) => item[1] || "");
  for (const tokenName of tokens) {
    if (!Object.prototype.hasOwnProperty.call(values, tokenName)) {
      throw new Error(`[prompts] missing template variable: ${tokenName}`);
    }
    const value = values[tokenName];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`[prompts] template variable must be string/number: ${tokenName}`);
    }
  }

  return source.replace(tokenRe, (_match, tokenName: string) => {
    const value = values[tokenName];
    return String(value);
  });
}

export function renderPromptTemplateFile(relativePath: string, values: Record<string, string | number>) {
  return renderPromptTemplate(getPromptText(relativePath), values);
}

export function resetPromptTextCacheForTests() {
  promptTextCache.clear();
  promptsRootCache = null;
}
