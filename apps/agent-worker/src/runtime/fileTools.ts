import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

const DEFAULT_READ_LIMIT = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024}KB`;
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
const TEXT_SAMPLE_BYTES = 32 * 1024;
const WRITE_UI_ARTIFACT_MAX_BYTES_PER_SIDE = readPositiveIntEnv("AWB_WRITE_UI_ARTIFACT_MAX_BYTES_PER_SIDE", 200 * 1024);

type SampleEncoding = "utf8" | "utf16le" | "utf16be" | "utf32le" | "utf32be" | "latin1";

type TextSampleKind =
  | { kind: "binary" }
  | {
      kind: "text";
      encoding: SampleEncoding;
    };

type WriteArtifactSide = {
  available: boolean;
  text?: string;
  truncated: boolean;
  bytes: number;
  reason?: string;
  encoding?: SampleEncoding;
};

function readPositiveIntEnv(name: string, fallback: number) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

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

function hasBinaryMagic(buffer: Buffer) {
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return true;
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return true;
    if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) return true;
  }
  if (buffer.length >= 3) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
    if (buffer[0] === 0x1f && buffer[1] === 0x8b && buffer[2] === 0x08) return true;
  }
  if (buffer.length >= 6) {
    if (buffer.subarray(0, 6).toString("ascii") === "GIF87a") return true;
    if (buffer.subarray(0, 6).toString("ascii") === "GIF89a") return true;
  }
  return false;
}

function detectBomEncoding(buffer: Buffer): SampleEncoding | null {
  if (buffer.length >= 4) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00) return "utf32le";
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff) return "utf32be";
  }
  if (buffer.length >= 3) {
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return "utf8";
  }
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return "utf16le";
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return "utf16be";
  }
  return null;
}

function detectUtf16Or32ByNullPattern(buffer: Buffer): SampleEncoding | null {
  const bytesRead = buffer.length;
  if (bytesRead < 8) return null;
  let oddNulls = 0;
  let evenNulls = 0;
  let mod4_0 = 0;
  let mod4_1 = 0;
  let mod4_2 = 0;
  let mod4_3 = 0;
  for (let i = 0; i < bytesRead; i++) {
    if (buffer[i] !== 0) continue;
    if (i % 2 === 0) evenNulls += 1;
    else oddNulls += 1;
    if (i % 4 === 0) mod4_0 += 1;
    else if (i % 4 === 1) mod4_1 += 1;
    else if (i % 4 === 2) mod4_2 += 1;
    else mod4_3 += 1;
  }
  const oddSlots = Math.floor(bytesRead / 2);
  const evenSlots = Math.ceil(bytesRead / 2);
  const mod4Slots = [0, 1, 2, 3].map((m) => Math.ceil((bytesRead - m) / 4)).map((n) => (n > 0 ? n : 0));
  if (oddSlots >= 4 && oddNulls / oddSlots >= 0.6 && evenNulls / evenSlots <= 0.2) return "utf16le";
  if (evenSlots >= 4 && evenNulls / evenSlots >= 0.6 && oddNulls / oddSlots <= 0.2) return "utf16be";
  if (mod4Slots[1] >= 2 && mod4Slots[2] >= 2 && mod4Slots[3] >= 2) {
    if (mod4_1 / mod4Slots[1] >= 0.6 && mod4_2 / mod4Slots[2] >= 0.6 && mod4_3 / mod4Slots[3] >= 0.6) return "utf32le";
    if (mod4_0 / mod4Slots[0] >= 0.6 && mod4_1 / mod4Slots[1] >= 0.6 && mod4_2 / mod4Slots[2] >= 0.6) return "utf32be";
  }
  return null;
}

function tryDecodeSample(sample: Buffer, encoding: SampleEncoding) {
  try {
    if (encoding === "latin1") return new TextDecoder("latin1").decode(sample);
    if (encoding === "utf16be") {
      const normalized = Buffer.alloc(sample.length - (sample.length % 2));
      for (let i = 0; i + 1 < sample.length; i += 2) {
        normalized[i] = sample[i + 1]!;
        normalized[i + 1] = sample[i]!;
      }
      return new TextDecoder("utf-16le", { fatal: false }).decode(normalized);
    }
    if (encoding === "utf32le" || encoding === "utf32be") {
      const end = sample.length - (sample.length % 4);
      const parts: string[] = [];
      for (let i = 0; i < end; i += 4) {
        const codePoint =
          encoding === "utf32le"
            ? (sample[i]! | (sample[i + 1]! << 8) | (sample[i + 2]! << 16) | (sample[i + 3]! << 24)) >>> 0
            : ((sample[i + 3]! | (sample[i + 2]! << 8) | (sample[i + 1]! << 16) | (sample[i]! << 24)) >>> 0);
        if (parts.length === 0 && codePoint === 0xfeff) continue;
        if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          parts.push("\uFFFD");
          continue;
        }
        parts.push(String.fromCodePoint(codePoint));
      }
      return parts.join("");
    }
    const decoderName = encoding === "utf16le" ? "utf-16le" : "utf-8";
    return new TextDecoder(decoderName, { fatal: false }).decode(sample);
  } catch {
    return null;
  }
}

function truncateTextUtf8Bytes(text: string, maxBytes: number) {
  const bytes = Buffer.from(text, "utf8");
  return decodeUtf8Prefix(bytes, maxBytes);
}

function createStreamingDecoder(encoding: SampleEncoding) {
  if (encoding === "utf8") {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    return {
      write(chunk: Buffer) {
        return decoder.decode(chunk, { stream: true });
      },
      end() {
        return decoder.decode();
      }
    };
  }
  if (encoding === "latin1") {
    const decoder = new TextDecoder("latin1");
    return {
      write(chunk: Buffer) {
        return decoder.decode(chunk, { stream: true });
      },
      end() {
        return decoder.decode();
      }
    };
  }
  if (encoding === "utf16le") {
    const decoder = new TextDecoder("utf-16le", { fatal: false });
    return {
      write(chunk: Buffer) {
        return decoder.decode(chunk, { stream: true });
      },
      end() {
        return decoder.decode();
      }
    };
  }
  if (encoding === "utf16be") {
    const decoder = new TextDecoder("utf-16le", { fatal: false });
    let carry = Buffer.alloc(0);
    return {
      write(chunk: Buffer) {
        const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        const usable = combined.length - (combined.length % 2);
        carry = Buffer.from(combined.subarray(usable));
        const normalized = Buffer.alloc(usable);
        for (let i = 0; i < usable; i += 2) {
          normalized[i] = combined[i + 1]!;
          normalized[i + 1] = combined[i]!;
        }
        return decoder.decode(normalized, { stream: true });
      },
      end() {
        const tail = carry.length > 0 ? "\uFFFD" : "";
        carry = Buffer.alloc(0);
        return decoder.decode() + tail;
      }
    };
  }
  let carry = Buffer.alloc(0);
  let emitted = 0;
  return {
    write(chunk: Buffer) {
      const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const usable = combined.length - (combined.length % 4);
      carry = Buffer.from(combined.subarray(usable));
      const parts: string[] = [];
      for (let i = 0; i < usable; i += 4) {
        const codePoint =
          encoding === "utf32le"
            ? (combined[i]! | (combined[i + 1]! << 8) | (combined[i + 2]! << 16) | (combined[i + 3]! << 24)) >>> 0
            : ((combined[i + 3]! | (combined[i + 2]! << 8) | (combined[i + 1]! << 16) | (combined[i]! << 24)) >>> 0);
        if (emitted === 0 && codePoint === 0xfeff) {
          emitted += 1;
          continue;
        }
        if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          parts.push("\uFFFD");
        } else {
          parts.push(String.fromCodePoint(codePoint));
        }
        emitted += 1;
      }
      return parts.join("");
    },
    end() {
      const tail = carry.length > 0 ? "\uFFFD" : "";
      carry = Buffer.alloc(0);
      return tail;
    }
  };
}

function splitDecodedLines(text: string) {
  if (!text) return [] as string[];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

async function classifyTextSample(filePath: string, size: number): Promise<TextSampleKind> {
  if (size === 0) return { kind: "text", encoding: "utf8" };
  const sampleSize = Math.min(TEXT_SAMPLE_BYTES, size);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(sampleSize);
    const { bytesRead } = await handle.read(buffer, 0, sampleSize, 0);
    if (bytesRead === 0) return { kind: "text", encoding: "utf8" };
    const sample = buffer.subarray(0, bytesRead);
    if (hasBinaryMagic(sample)) return { kind: "binary" };
    const bomEncoding = detectBomEncoding(sample);
    if (bomEncoding) return { kind: "text", encoding: bomEncoding };
    const nulPatternEncoding = detectUtf16Or32ByNullPattern(sample);
    if (nulPatternEncoding) return { kind: "text", encoding: nulPatternEncoding };
    let nulCount = 0;
    let suspiciousControlCount = 0;
    for (let i = 0; i < bytesRead; i++) {
      const value = sample[i]!;
      if (value === 0) nulCount += 1;
      if (value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d && value !== 0x0c) {
        suspiciousControlCount += 1;
      }
    }
    if (nulCount > 0) return { kind: "binary" };
    const suspiciousControlRatio = suspiciousControlCount / bytesRead;
    if (suspiciousControlCount >= 32 && suspiciousControlRatio > 0.1) return { kind: "binary" };
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample);
      return { kind: "text", encoding: "utf8" };
    } catch {
      const lossyDecoded = tryDecodeSample(sample, "latin1");
      if (!lossyDecoded) return { kind: "binary" };
      let textLikeChars = 0;
      for (const ch of lossyDecoded) {
        const code = ch.charCodeAt(0);
        if (ch === "�" || ch === "\t" || ch === "\n" || ch === "\r") textLikeChars += 1;
        else if (code >= 0x20 && code !== 0x7f) textLikeChars += 1;
      }
      return textLikeChars / Math.max(1, lossyDecoded.length) >= 0.85 ? { kind: "text", encoding: "latin1" } : { kind: "binary" };
    }
  } finally {
    await handle.close();
  }
}

function decodeUtf8Prefix(bytes: Buffer, maxBytes: number) {
  const truncated = bytes.length > maxBytes;
  const prefix = truncated ? bytes.subarray(0, maxBytes) : bytes;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let end = prefix.length;
  while (end > 0) {
    try {
      const text = decoder.decode(prefix.subarray(0, end));
      return { text, truncated };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated };
}

function writeSideFromText(text: string, maxBytes: number): WriteArtifactSide {
  const bytes = Buffer.from(String(text || ""), "utf8");
  const decoded = decodeUtf8Prefix(bytes, maxBytes);
  return {
    available: true,
    text: decoded.text,
    truncated: decoded.truncated,
    bytes: bytes.length
  };
}

function decodeBuffer(source: Buffer, encoding: SampleEncoding, maxBytes: number) {
  if (encoding === "utf8") return truncateTextUtf8Bytes(new TextDecoder("utf-8", { fatal: false }).decode(source), maxBytes);
  const decoded = tryDecodeSample(source, encoding);
  return truncateTextUtf8Bytes(decoded ?? new TextDecoder("latin1").decode(source), maxBytes);
}

async function readWriteBeforeSide(filePath: string, maxBytes: number): Promise<WriteArtifactSide> {
  const stat = await fs.lstat(filePath).catch((err: any) => {
    if (err && err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) {
    return {
      available: false,
      truncated: false,
      bytes: 0,
      reason: "missing_file"
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      available: false,
      truncated: false,
      bytes: 0,
      reason: "symlink"
    };
  }
  if (!stat.isFile()) {
    return {
      available: false,
      truncated: false,
      bytes: 0,
      reason: "non_file"
    };
  }
  const size = Number(stat.size);
  const sampleKind = await classifyTextSample(filePath, size);
  if (sampleKind.kind !== "text") {
    return {
      available: false,
      truncated: false,
      bytes: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0,
      reason: "non_text"
    };
  }

  const readLen = Math.max(0, Math.min(maxBytes * 4, Number.isFinite(size) ? Math.floor(size) : maxBytes * 4));
  if (readLen === 0) {
    return {
      available: true,
      text: "",
      encoding: sampleKind.encoding,
      truncated: false,
      bytes: 0
    };
  }

  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(readLen);
    const { bytesRead } = await handle.read(buffer, 0, readLen, 0);
    const source = buffer.subarray(0, bytesRead);
    const originalBytes = Number.isFinite(size) && size >= 0 ? Math.floor(size) : bytesRead;
    const decoded = decodeBuffer(source, sampleKind.encoding, maxBytes);
    const truncated = originalBytes > source.length || decoded.truncated;
    return {
      available: true,
      text: decoded.text,
      truncated,
      bytes: originalBytes,
      encoding: sampleKind.encoding
    };
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
    const offsetOutOfRange = items.length < offset && !(items.length === 0 && offset === 1);
    let body = sliced.join("\n");
    const actualStart = sliced.length > 0 ? offset : undefined;
    const actualEnd = sliced.length > 0 ? offset + sliced.length - 1 : undefined;
    if (offsetOutOfRange) {
      body = `(End of directory - total ${items.length} entries. Requested offset=${offset} exceeds directory length. No more entries to read. Do not call read again for this directory unless the directory contents change.)`;
    } else if (truncated) {
      body += `\n\n(Showing ${sliced.length} of ${items.length} entries. To continue reading this same directory, use exactly offset=${offset + sliced.length}. Do not guess the next offset.)`;
    } else {
      body += `\n\n(End of directory - total ${items.length} entries. No more entries to read.)`;
    }
    return {
      summary: `读取目录 ${safePath}`,
      content: body,
      actualStart,
      actualEnd,
      totalEntries: items.length,
      nextOffset: !offsetOutOfRange && truncated ? offset + sliced.length : undefined,
      eof: offsetOutOfRange || !truncated,
      offsetOutOfRange
    };
  }

  if (!stat.isFile()) {
    throw new Error("unsupported non-regular file type");
  }
  const sampleKind = await classifyTextSample(fullPath, Number(stat.size));
  if (sampleKind.kind !== "text") {
    throw new Error("binary file is not supported");
  }

  const offset = Number.isFinite(params.offset) ? Math.max(1, Math.floor(params.offset || 1)) : 1;
  const limit = Number.isFinite(params.limit)
    ? Math.max(1, Math.floor(params.limit || DEFAULT_READ_LIMIT))
    : DEFAULT_READ_LIMIT;
  const effectiveLimit = Math.min(limit, DEFAULT_READ_LIMIT);
  const raw: string[] = [];
  const decoder = createStreamingDecoder(sampleKind.encoding);
  const chunkSize = 64 * 1024;
  const handle = await fs.open(fullPath, "r");
  const buffer = Buffer.alloc(chunkSize);
  let pending = "";
  let bytes = 0;
  let truncatedByBytes = false;
  let lines = 0;
  let hasMoreLines = false;
  let pendingEndedWithCr = false;

  const consumeText = (text: string, flush = false) => {
    let normalized = text;
    if (pendingEndedWithCr) {
      if (normalized.startsWith("\n")) {
        normalized = normalized.slice(1);
      }
      pending += "\n";
      pendingEndedWithCr = false;
    }
    if (!flush && normalized.endsWith("\r")) {
      normalized = normalized.slice(0, -1);
      pendingEndedWithCr = true;
    }
    pending += normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    while (true) {
      const idx = pending.indexOf("\n");
      if (idx < 0) break;
      const lineText = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      lines += 1;
      if (lines < offset) continue;
      if (raw.length >= effectiveLimit) {
        hasMoreLines = true;
        continue;
      }
      const line = lineText.length > MAX_LINE_LENGTH ? lineText.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : lineText;
      const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0);
      if (bytes + size > MAX_BYTES) {
        truncatedByBytes = true;
        hasMoreLines = true;
        return false;
      }
      raw.push(line);
      bytes += size;
    }
    if (flush && pending.length > 0) {
      if (pendingEndedWithCr) {
        pending += "\n";
        pendingEndedWithCr = false;
      }
      lines += 1;
      if (lines >= offset) {
        if (raw.length >= effectiveLimit) {
          hasMoreLines = true;
        } else {
          const line = pending.length > MAX_LINE_LENGTH ? pending.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : pending;
          const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0);
          if (bytes + size > MAX_BYTES) {
            truncatedByBytes = true;
            hasMoreLines = true;
            pending = "";
            return false;
          }
          raw.push(line);
          bytes += size;
        }
      }
      pending = "";
    }
    return true;
  };

  try {
    while (true) {
      throwIfAborted(params.signal);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
      if (bytesRead <= 0) break;
      const chunkText = decoder.write(buffer.subarray(0, bytesRead));
      if (!consumeText(chunkText, false)) break;
    }
    if (!truncatedByBytes) {
      consumeText(decoder.end(), true);
    }
  } finally {
    await handle.close();
  }

  const content = raw.map((line, index) => `${index + offset}: ${line}`);
  let body = content.join("\n");
  const totalLines = lines;
  const offsetOutOfRange = lines < offset && !(lines === 0 && offset === 1);
  const lastReadLine = raw.length > 0 ? offset + raw.length - 1 : 0;
  const nextOffset = raw.length > 0 ? lastReadLine + 1 : offset;
  let suffix = "";
  if (offsetOutOfRange) {
    suffix = `(End of file - total ${totalLines} lines. Requested offset=${offset} exceeds file length. No more content to read. Do not call read again for this file unless the file changes.)`;
  } else if (raw.length === 0) {
    suffix = `(End of file - total ${totalLines} lines. No more content to read.)`;
  } else if (truncatedByBytes) {
    suffix = `(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${offset}-${lastReadLine}. To continue reading this same file, use exactly offset=${nextOffset}. Do not guess the next offset.)`;
  } else if (hasMoreLines) {
    suffix = `(Showing lines ${offset}-${lastReadLine} of ${totalLines}. To continue reading this same file, use exactly offset=${nextOffset}. Do not guess the next offset.)`;
  } else {
    suffix = `(End of file - total ${totalLines} lines. No more content to read.)`;
  }
  body = body ? `${body}\n\n${suffix}` : suffix;
  return {
    summary: `读取文件 ${safePath}`,
    content: body,
    actualStart: raw.length > 0 ? offset : undefined,
    actualEnd: raw.length > 0 ? lastReadLine : undefined,
    totalLines,
    nextOffset: !offsetOutOfRange && raw.length > 0 && (truncatedByBytes || hasMoreLines) ? nextOffset : undefined,
    eof: offsetOutOfRange || (!truncatedByBytes && !hasMoreLines),
    offsetOutOfRange
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

  const before = await readWriteBeforeSide(fullPath, WRITE_UI_ARTIFACT_MAX_BYTES_PER_SIDE);
  const existedBefore = before.reason !== "missing_file";
  const after = writeSideFromText(params.content, WRITE_UI_ARTIFACT_MAX_BYTES_PER_SIDE);

  throwIfAborted(params.signal);
  await fs.writeFile(fullPath, params.content, { encoding: "utf8" });
  const bytes = Buffer.byteLength(params.content, "utf8");
  return {
    summary: `写入文件 ${safePath}`,
    content: `ok: wrote ${bytes} bytes to ${safePath}`,
    filePath: safePath,
    bytesWritten: bytes,
    existedBefore,
    before,
    after
  };
}
