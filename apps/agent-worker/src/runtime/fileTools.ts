import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { TextDecoder } from "node:util";

const DEFAULT_READ_LIMIT = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024}KB`;
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
const TEXT_SAMPLE_BYTES = 32 * 1024;

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

async function isUtf8TextFile(filePath: string, size: number) {
  if (size === 0) return true;
  const sampleSize = Math.min(TEXT_SAMPLE_BYTES, size);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(sampleSize);
    const { bytesRead } = await handle.read(buffer, 0, sampleSize, 0);
    if (bytesRead === 0) return true;
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return false;
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      return false;
    }
    return true;
  } finally {
    await handle.close();
  }
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
    const items = entries
      .map((item) => `${item.name}${item.isDirectory() ? "/" : ""}`)
      .sort((a, b) => a.localeCompare(b))
      .filter((entry) => entry.length > 0);
    const offset = Number.isFinite(params.offset) ? Math.max(1, Math.floor(params.offset || 1)) : 1;
    const limit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit || DEFAULT_READ_LIMIT))
      : DEFAULT_READ_LIMIT;
    const effectiveLimit = Math.min(limit, DEFAULT_READ_LIMIT);
    const start = offset - 1;
    const end = Math.min(items.length, start + effectiveLimit);
    const sliced = items.slice(start, end);
    const truncated = end < items.length;
    let body = sliced.join("\n");
    if (truncated) {
      body += `\n\n(Showing ${sliced.length} of ${items.length} entries. Use offset=${offset + sliced.length} to continue.)`;
    } else {
      body += `\n\n(${items.length} entries)`;
    }
    return {
      summary: `读取目录 ${safePath}`,
      content: body
    };
  }

  if (!stat.isFile()) {
    throw new Error("unsupported file type");
  }
  const isText = await isUtf8TextFile(fullPath, Number(stat.size));
  if (!isText) {
    throw new Error("unsupported file type");
  }

  const offset = Number.isFinite(params.offset) ? Math.max(1, Math.floor(params.offset || 1)) : 1;
  const limit = Number.isFinite(params.limit)
    ? Math.max(1, Math.floor(params.limit || DEFAULT_READ_LIMIT))
    : DEFAULT_READ_LIMIT;
  const effectiveLimit = Math.min(limit, DEFAULT_READ_LIMIT);
  const start = offset - 1;
  const raw: string[] = [];
  let bytes = 0;
  let lines = 0;
  let truncatedByBytes = false;
  let hasMoreLines = false;
  const stream = createReadStream(fullPath, { encoding: "utf8" });
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity
  });
  try {
    for await (const text of rl) {
      throwIfAborted(params.signal);
      lines += 1;
      if (lines <= start) continue;
      if (raw.length >= effectiveLimit) {
        hasMoreLines = true;
        continue;
      }
      const line =
        text.length > MAX_LINE_LENGTH
          ? text.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX
          : text;
      const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0);
      if (bytes + size > MAX_BYTES) {
        truncatedByBytes = true;
        hasMoreLines = true;
        break;
      }
      raw.push(line);
      bytes += size;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (lines < offset && !(lines === 0 && offset === 1)) {
    throw new Error(`offset ${offset} is out of range for this file (${lines} lines)`);
  }

  const content = raw.map((line, index) => `${index + offset}: ${line}`);
  let body = content.join("\n");
  const totalLines = lines;
  const lastReadLine = raw.length > 0 ? offset + raw.length - 1 : 0;
  const nextOffset = raw.length > 0 ? lastReadLine + 1 : offset;
  let suffix = "";
  if (raw.length === 0) {
    suffix = `(End of file - total ${totalLines} lines)`;
  } else if (truncatedByBytes) {
    suffix = `(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${offset}-${lastReadLine}. Use offset=${nextOffset} to continue.)`;
  } else if (hasMoreLines) {
    suffix = `(Showing lines ${offset}-${lastReadLine} of ${totalLines}. Use offset=${nextOffset} to continue.)`;
  } else {
    suffix = `(End of file - total ${totalLines} lines)`;
  }
  body = body ? `${body}\n\n${suffix}` : suffix;
  return {
    summary: `读取文件 ${safePath}`,
    content: body
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
