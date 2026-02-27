import fs from "node:fs/promises";
import path from "node:path";

function ensureSafeRelativePath(input: string) {
  const value = String(input || "").trim();
  if (!value) throw new Error("path is required");
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

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new Error("operation aborted");
}

async function ensureRealPathInsideWorkspace(workspacePath: string, targetPath: string) {
  const [workspaceRealPath, targetRealPath] = await Promise.all([fs.realpath(workspacePath), fs.realpath(targetPath)]);
  if (!isPathInside(workspaceRealPath, targetRealPath)) {
    throw new Error("path is outside workspace");
  }
}

function readTextLines(text: string, offset: number, limit: number) {
  const lines = text.split("\n");
  const start = Math.max(0, offset - 1);
  const end = Math.min(lines.length, start + limit);
  const sliced = lines.slice(start, end);
  return sliced
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n");
}

export async function runReadTool(params: {
  workspacePath: string;
  filePath: string;
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}) {
  throwIfAborted(params.signal);
  const safePath = ensureSafeRelativePath(params.filePath);
  const fullPath = resolveWithinWorkspace(params.workspacePath, safePath);
  const stat = await fs.lstat(fullPath);
  if (stat.isSymbolicLink()) {
    throw new Error("symlink path is not allowed");
  }
  await ensureRealPathInsideWorkspace(params.workspacePath, fullPath);
  throwIfAborted(params.signal);

  if (stat.isDirectory()) {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const body = entries
      .map((item) => `${item.name}${item.isDirectory() ? "/" : ""}`)
      .sort((a, b) => a.localeCompare(b))
      .join("\n");
    return {
      summary: `读取目录 ${safePath}`,
      content: body
    };
  }

  const raw = await fs.readFile(fullPath, "utf8");
  throwIfAborted(params.signal);
  const offset = Number.isFinite(params.offset) ? Math.max(1, Math.floor(params.offset || 1)) : 1;
  const limit = Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit || 2000)) : 2000;
  return {
    summary: `读取文件 ${safePath}`,
    content: readTextLines(raw, offset, limit)
  };
}

export async function runWriteTool(params: {
  workspacePath: string;
  filePath: string;
  content: string;
  signal?: AbortSignal;
}) {
  throwIfAborted(params.signal);
  const safePath = ensureSafeRelativePath(params.filePath);
  const fullPath = resolveWithinWorkspace(params.workspacePath, safePath);
  const workspaceRealPath = await fs.realpath(params.workspacePath);
  const parentPath = path.dirname(fullPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const parentRealPath = await fs.realpath(parentPath);
  if (!isPathInside(workspaceRealPath, parentRealPath)) {
    throw new Error("path is outside workspace");
  }

  const existingStat = await fs.lstat(fullPath).catch(() => null);
  if (existingStat?.isSymbolicLink()) {
    throw new Error("symlink path is not allowed");
  }

  throwIfAborted(params.signal);
  await fs.writeFile(fullPath, params.content, { encoding: "utf8" });
  const bytes = Buffer.byteLength(params.content, "utf8");
  return {
    summary: `写入文件 ${safePath}`,
    content: `ok: wrote ${bytes} bytes to ${safePath}`
  };
}
