import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isValidSkillRelativePath, parseSkillFrontmatter, parseStableSkillIdentifier } from "@agent-workbench/shared";

const DEFAULT_READ_LIMIT = 500;
const MAX_READ_LIMIT = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024}KB`;
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
const TEXT_SAMPLE_BYTES = 32 * 1024;
const MAX_ROOT_BODY_UTF8_BYTES = 40 * 1024;
const MAX_SKILL_FILES_SECTION_UTF8_BYTES = 10 * 1024;
const MAX_ROOT_CONTENT_UTF8_BYTES = 50 * 1024;
const MAX_SKILL_FILE_PATHS = 500;
const ROOT_BODY_TRUNCATION_SUFFIX = "\n\nRoot skill content truncated.";

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

async function classifyTextSampleFromHandle(handle: FileHandle, size: number): Promise<TextSampleKind> {
  if (size === 0) return { kind: "text", encoding: "utf8" };
  const sampleSize = Math.min(TEXT_SAMPLE_BYTES, size);
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
}

async function classifyTextSample(filePath: string, size: number): Promise<TextSampleKind> {
  const handle = await fs.open(filePath, "r");
  try {
    return await classifyTextSampleFromHandle(handle, size);
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

type NormalizedSkillFileRead = {
  content: string;
  truncatedByBytes: boolean;
  hasMoreLines: boolean;
  truncatedByLineLength: boolean;
};

async function readTextFileCappedFromHandle(params: {
  handle: FileHandle;
  encoding: SampleEncoding;
  signal?: AbortSignal;
}): Promise<NormalizedSkillFileRead> {
  const raw: string[] = [];
  const decoder = createStreamingDecoder(params.encoding);
  const buffer = Buffer.alloc(64 * 1024);
  let pending = "";
  let pendingEndedWithCr = false;
  let bytes = 0;
  let truncatedByBytes = false;
  let hasMoreLines = false;
  let truncatedByLineLength = false;

  const appendLine = (lineText: string) => {
    let line = lineText;
    if (line.length > MAX_LINE_LENGTH) {
      line = line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX;
      truncatedByLineLength = true;
    }
    const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0);
    if (bytes + size > MAX_BYTES) {
      truncatedByBytes = true;
      hasMoreLines = true;
      return false;
    }
    raw.push(line);
    bytes += size;
    return true;
  };

  const consumeCompleteLines = () => {
    while (true) {
      const index = pending.indexOf("\n");
      if (index < 0) return true;
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (!appendLine(line)) return false;
    }
  };

  const consumeText = (text: string, flush = false) => {
    let normalized = text;
    if (pendingEndedWithCr) {
      if (normalized.startsWith("\n")) normalized = normalized.slice(1);
      pending += "\n";
      pendingEndedWithCr = false;
      if (!consumeCompleteLines()) return false;
    }
    if (!flush && normalized.endsWith("\r")) {
      normalized = normalized.slice(0, -1);
      pendingEndedWithCr = true;
    }
    pending += normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!consumeCompleteLines()) return false;
    if (flush) {
      if (pendingEndedWithCr) {
        pending += "\n";
        pendingEndedWithCr = false;
        if (!consumeCompleteLines()) return false;
      }
      if (pending.length > 0 && !appendLine(pending)) return false;
      pending = "";
    }
    return true;
  };

  while (true) {
    throwIfAborted(params.signal);
    const { bytesRead } = await params.handle.read(buffer, 0, buffer.length, null);
    if (bytesRead <= 0) break;
    if (!consumeText(decoder.write(buffer.subarray(0, bytesRead)))) break;
  }
  if (!truncatedByBytes) consumeText(decoder.end(), true);

  return {
    content: raw.join("\n"),
    truncatedByBytes,
    hasMoreLines,
    truncatedByLineLength
  };
}

async function readTextFileCapped(params: { fullPath: string; encoding: SampleEncoding; signal?: AbortSignal }) {
  const handle = await fs.open(params.fullPath, "r");
  try {
    return await readTextFileCappedFromHandle({ handle, encoding: params.encoding, signal: params.signal });
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
    const effectiveLimit = Math.min(limit, MAX_READ_LIMIT);
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
  const effectiveLimit = Math.min(limit, MAX_READ_LIMIT);
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

type SafeSkillFile = {
  handle: FileHandle;
  stat: Awaited<ReturnType<typeof fs.lstat>>;
};

type SkillToolResult = {
  skillId: string;
  filePath: string;
  content: string;
  truncated: boolean;
};

const PUBLIC_SKILL_ERRORS = new Set([
  "skill is required",
  "invalid skill identifier",
  "skill not found",
  "skill root is not readable",
  "invalid skill path",
  "skill path must reference a file",
  "skill path is not a readable file",
  "binary file is not supported",
  "skill file not found",
  "skill file is not accessible",
  "skill tool failed to read target",
  "operation aborted"
]);

function compareSkillPath(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function skillError(message: string): never {
  throw new Error(message);
}

function errorCode(err: unknown) {
  return err && typeof err === "object" ? String((err as { code?: unknown }).code || "") : "";
}

function isAbortError(err: unknown, signal?: AbortSignal) {
  return signal?.aborted || (err instanceof Error && (err.name === "AbortError" || /\babort(?:ed)?\b/i.test(err.message)));
}

function sanitizeSkillToolError(err: unknown, signal?: AbortSignal) {
  if (isAbortError(err, signal)) return new Error("operation aborted");
  const message = err instanceof Error ? err.message : String(err || "");
  if (PUBLIC_SKILL_ERRORS.has(message)) return new Error(message);
  const code = errorCode(err);
  if (code === "ENOENT" || code === "ENOTDIR") return new Error("skill file not found");
  if (code === "EACCES" || code === "EPERM") return new Error("skill file is not accessible");
  return new Error("skill tool failed to read target");
}

function isAsciiSpaceTabOnly(value: string) {
  return /^[\u0020\u0009]*$/.test(value);
}

function parseSkillPath(raw: unknown): { root: true } | { root: false; path: string } {
  if (raw === undefined) return { root: true };
  if (typeof raw !== "string") skillError("invalid skill path");
  if (isAsciiSpaceTabOnly(raw) || raw === "SKILL.md") return { root: true };
  if (!isValidSkillRelativePath(raw)) skillError("invalid skill path");
  return { root: false, path: raw };
}

type SkillDiagnosticReason =
  | "non_utf8_filename"
  | "unreadable_directory"
  | "unreadable_file"
  | "root_content_invariant";

type SkillToolTestingOptions = {
  afterInitialRootDirectoryLstat?: (params: { skillsRoot: string; skillDirectory: string }) => void | Promise<void>;
  afterRootDirectoryRevalidationBeforeRootFileLstat?: (params: { skillsRoot: string; skillDirectory: string; rootSkillPath: string }) => void | Promise<void>;
  beforeOpenRootSkillFile?: (params: { skillsRoot: string; skillDirectory: string; rootSkillPath: string }) => void | Promise<void>;
  afterOpenRootSkillFileBeforeAfterLstat?: (params: { skillsRoot: string; skillDirectory: string; rootSkillPath: string }) => void | Promise<void>;
  beforeFinalRootSkillFileRevalidation?: (params: { skillsRoot: string; skillDirectory: string; rootSkillPath: string }) => void | Promise<void>;
  beforeOpenSkillFile?: (params: { skillRoot: string; targetPath: string }) => void | Promise<void>;
  afterOpenSkillFileBeforeStat?: (params: { handle: FileHandle; targetPath: string }) => void | Promise<void>;
  beforeEnumeratingSkillEntry?: (params: { relativePath: string; kind: "directory" | "file" }) => void | Promise<void>;
  rootFilesSectionBudgetOverride?: number;
  onRootContentInvariantFallback?: () => void | Promise<void>;
  onSkillDiagnostic?: (diagnostic: { source: "skills-v2"; reason: SkillDiagnosticReason }) => void | Promise<void>;
};

type RootDirectoryState =
  | { kind: "missing" }
  | { kind: "unsafe" }
  | {
      kind: "ready";
      skillsRootRealPath: string;
      skillDirectoryStat: { dev: number; ino: number };
    };

function hasSameIdentity(
  first: { dev: number; ino: number },
  second: { dev: number; ino: number }
) {
  return first.dev === second.dev && first.ino === second.ino;
}

function isMissingPathError(err: unknown) {
  const code = errorCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

function reportSkillDiagnostic(options: SkillToolTestingOptions | undefined, reason: SkillDiagnosticReason) {
  const diagnostic = { source: "skills-v2" as const, reason };
  console.warn("[agent-worker] skills-v2 diagnostic", diagnostic);
  return options?.onSkillDiagnostic?.(diagnostic);
}

async function readWholeFileFromHandle(handle: FileHandle, signal?: AbortSignal) {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  while (true) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead <= 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks);
}

async function currentRootDirectoryPresence(params: { skillsRoot: string; skillDirectory: string }): Promise<"missing" | "unsafe" | { skillDirectoryStat: { dev: number; ino: number } }> {
  const skillsRootStat = await fs.lstat(params.skillsRoot).catch((err: unknown) => isMissingPathError(err) ? null : undefined);
  if (skillsRootStat === null) return "missing";
  if (!skillsRootStat || !skillsRootStat.isDirectory() || skillsRootStat.isSymbolicLink()) return "unsafe";

  const skillDirectoryStat = await fs.lstat(params.skillDirectory).catch((err: unknown) => isMissingPathError(err) ? null : undefined);
  if (skillDirectoryStat === null) return "missing";
  if (!skillDirectoryStat || !skillDirectoryStat.isDirectory() || skillDirectoryStat.isSymbolicLink()) return "unsafe";
  return { skillDirectoryStat };
}

async function currentRootDirectoryState(params: {
  skillsRoot: string;
  skillDirectory: string;
  afterSkillDirectoryLstat?: () => void | Promise<void>;
}): Promise<RootDirectoryState> {
  if (!isPathInside(params.skillsRoot, params.skillDirectory) || params.skillDirectory === path.resolve(params.skillsRoot)) {
    return { kind: "unsafe" };
  }
  // The caller may use this seam only to cover the lstat -> realpath race in tests.
  const presence = await currentRootDirectoryPresence(params);
  if (presence === "missing") return { kind: "missing" };
  if (presence === "unsafe") return { kind: "unsafe" };

  await params.afterSkillDirectoryLstat?.();
  try {
    const [skillsRootRealPath, skillDirectoryRealPath] = await Promise.all([
      fs.realpath(params.skillsRoot),
      fs.realpath(params.skillDirectory)
    ]);
    if (!isPathInside(skillsRootRealPath, skillDirectoryRealPath)) return { kind: "unsafe" };
    return { kind: "ready", skillsRootRealPath, skillDirectoryStat: presence.skillDirectoryStat };
  } catch {
    // The directory may have disappeared between lstat and realpath; refresh before mapping it.
    const refreshedPresence = await currentRootDirectoryPresence(params);
    if (refreshedPresence === "missing") return { kind: "missing" };
    return { kind: "unsafe" };
  }
}

function throwForRootDirectoryState(
  state: RootDirectoryState,
  expected?: { skillsRootRealPath: string; skillDirectoryStat: { dev: number; ino: number } }
): never | Extract<RootDirectoryState, { kind: "ready" }> {
  if (state.kind === "missing") skillError("skill not found");
  if (state.kind === "unsafe") skillError("skill root is not readable");
  if (
    expected
    && (state.skillsRootRealPath !== expected.skillsRootRealPath
      || !hasSameIdentity(state.skillDirectoryStat, expected.skillDirectoryStat))
  ) {
    skillError("skill root is not readable");
  }
  return state;
}

async function assertCurrentRootDirectory(params: {
  skillsRoot: string;
  skillDirectory: string;
  expected?: { skillsRootRealPath: string; skillDirectoryStat: { dev: number; ino: number } };
  afterSkillDirectoryLstat?: () => void | Promise<void>;
}) {
  return throwForRootDirectoryState(await currentRootDirectoryState(params), params.expected);
}

async function mapRootFilesystemFailure(params: {
  skillsRoot: string;
  skillDirectory: string;
  signal?: AbortSignal;
}, err: unknown): Promise<never> {
  if (isAbortError(err, params.signal)) skillError("operation aborted");
  await assertCurrentRootDirectory(params);
  skillError("skill root is not readable");
}

async function runRootFilesystemOperation<T>(params: {
  skillsRoot: string;
  skillDirectory: string;
  signal?: AbortSignal;
}, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    return mapRootFilesystemFailure(params, err);
  }
}

async function revalidateOpenedRootSkillFile(params: {
  skillsRoot: string;
  skillDirectory: string;
  signal?: AbortSignal;
  rootSkillPath: string;
  rootBefore: { dev: number; ino: number };
  opened: { dev: number; ino: number };
}) {
  const finalRootStat = await runRootFilesystemOperation(params, () => fs.lstat(params.rootSkillPath));
  if (
    !finalRootStat.isFile()
    || finalRootStat.isSymbolicLink()
    || !hasSameIdentity(params.rootBefore, finalRootStat)
    || !hasSameIdentity(params.opened, finalRootStat)
  ) {
    skillError("skill root is not readable");
  }
}

function mapRootSkillError(err: unknown, signal?: AbortSignal): never {
  if (isAbortError(err, signal)) skillError("operation aborted");
  const message = err instanceof Error ? err.message : "";
  if (message === "skill not found" || message === "skill root is not readable") skillError(message);
  skillError("skill root is not readable");
}

async function validateSkillRoot(params: {
  skillsRoot: string;
  skillDirectory: string;
  signal?: AbortSignal;
  testing?: SkillToolTestingOptions;
}) {
  let handle: FileHandle | undefined;
  try {
    throwIfAborted(params.signal);
    const directory = await assertCurrentRootDirectory({
      skillsRoot: params.skillsRoot,
      skillDirectory: params.skillDirectory,
      afterSkillDirectoryLstat: async () => { await params.testing?.afterInitialRootDirectoryLstat?.({ skillsRoot: params.skillsRoot, skillDirectory: params.skillDirectory }); }
    });
    const expectedDirectory = {
      skillsRootRealPath: directory.skillsRootRealPath,
      skillDirectoryStat: directory.skillDirectoryStat
    };
    const rootSkillPath = path.join(params.skillDirectory, "SKILL.md");

    await params.testing?.afterRootDirectoryRevalidationBeforeRootFileLstat?.({
      skillsRoot: params.skillsRoot,
      skillDirectory: params.skillDirectory,
      rootSkillPath
    });
    throwIfAborted(params.signal);
    await assertCurrentRootDirectory({ ...params, expected: expectedDirectory });
    const before = await runRootFilesystemOperation(params, () => fs.lstat(rootSkillPath));
    if (!before.isFile() || before.isSymbolicLink()) skillError("skill root is not readable");

    await params.testing?.beforeOpenRootSkillFile?.({
      skillsRoot: params.skillsRoot,
      skillDirectory: params.skillDirectory,
      rootSkillPath
    });
    throwIfAborted(params.signal);
    handle = await runRootFilesystemOperation(params, () => fs.open(
      rootSkillPath,
      fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0)
    ));
    const opened = await runRootFilesystemOperation(params, () => handle!.stat());
    if (!opened.isFile() || !hasSameIdentity(before, opened)) skillError("skill root is not readable");

    await params.testing?.afterOpenRootSkillFileBeforeAfterLstat?.({
      skillsRoot: params.skillsRoot,
      skillDirectory: params.skillDirectory,
      rootSkillPath
    });
    throwIfAborted(params.signal);
    const after = await runRootFilesystemOperation(params, () => fs.lstat(rootSkillPath));
    if (!after.isFile() || after.isSymbolicLink() || !hasSameIdentity(before, after)) skillError("skill root is not readable");

    await assertCurrentRootDirectory({ ...params, expected: expectedDirectory });
    await params.testing?.beforeFinalRootSkillFileRevalidation?.({
      skillsRoot: params.skillsRoot,
      skillDirectory: params.skillDirectory,
      rootSkillPath
    });
    throwIfAborted(params.signal);
    await revalidateOpenedRootSkillFile({
      skillsRoot: params.skillsRoot,
      skillDirectory: params.skillDirectory,
      signal: params.signal,
      rootSkillPath,
      rootBefore: before,
      opened
    });

    const bytes = await runRootFilesystemOperation(params, () => readWholeFileFromHandle(handle!, params.signal));
    if (bytes.includes(0x00)) skillError("skill root is not readable");
    return bytes.toString("utf8");
  } catch (err) {
    return mapRootSkillError(err, params.signal);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function mapDirectSkillFileError(err: unknown, signal?: AbortSignal): never {
  if (isAbortError(err, signal)) skillError("operation aborted");
  const message = err instanceof Error ? err.message : "";
  if (PUBLIC_SKILL_ERRORS.has(message)) skillError(message);
  const code = errorCode(err);
  if (code === "ENOENT" || code === "ENOTDIR") skillError("skill file not found");
  if (code === "EACCES" || code === "EPERM") skillError("skill file is not accessible");
  if (code === "ELOOP") skillError("skill path is not a readable file");
  skillError("skill tool failed to read target");
}

async function assertSafeSkillDirectory(skillRoot: string, relativeDirectory: string) {
  const rootStat = await fs.lstat(skillRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) skillError("skill path is not a readable file");
  const rootRealPath = await fs.realpath(skillRoot);
  const segments = relativeDirectory ? relativeDirectory.split("/") : [];
  let current = skillRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) skillError("skill path is not a readable file");
  }
  const targetRealPath = await fs.realpath(current);
  if (!isPathInside(rootRealPath, targetRealPath)) skillError("skill path is not a readable file");
}

async function openSafeSkillFile(params: {
  skillRoot: string;
  relativePath: string;
  signal?: AbortSignal;
  testing?: SkillToolTestingOptions;
}): Promise<SafeSkillFile> {
  let handle: FileHandle | undefined;
  try {
    throwIfAborted(params.signal);
    const segments = params.relativePath.split("/");
    const targetPath = path.resolve(params.skillRoot, ...segments);
    if (!isPathInside(params.skillRoot, targetPath) || targetPath === path.resolve(params.skillRoot)) {
      skillError("skill path is not a readable file");
    }
    await assertSafeSkillDirectory(params.skillRoot, segments.slice(0, -1).join("/"));
    const before = await fs.lstat(targetPath);
    if (before.isDirectory()) skillError("skill path must reference a file");
    if (!before.isFile() || before.isSymbolicLink()) skillError("skill path is not a readable file");
    const rootRealPath = await fs.realpath(params.skillRoot);
    const targetRealPath = await fs.realpath(targetPath);
    if (!isPathInside(rootRealPath, targetRealPath)) skillError("skill path is not a readable file");

    await params.testing?.beforeOpenSkillFile?.({ skillRoot: params.skillRoot, targetPath });
    throwIfAborted(params.signal);
    const flags = fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
    handle = await fs.open(targetPath, flags);
    await params.testing?.afterOpenSkillFileBeforeStat?.({ handle, targetPath });
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      skillError("skill path is not a readable file");
    }
    const after = await fs.lstat(targetPath);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
      skillError("skill path is not a readable file");
    }
    await assertSafeSkillDirectory(params.skillRoot, segments.slice(0, -1).join("/"));
    const finalRealPath = await fs.realpath(targetPath);
    if (!isPathInside(rootRealPath, finalRealPath)) skillError("skill path is not a readable file");
    return { handle, stat: opened };
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    return mapDirectSkillFileError(err, params.signal);
  }
}

function decodeDirectoryEntryName(rawName: unknown) {
  if (Buffer.isBuffer(rawName)) {
    try {
      const name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
      if (!Buffer.from(name, "utf8").equals(rawName)) return null;
      return name;
    } catch {
      return null;
    }
  }
  return typeof rawName === "string" ? rawName : null;
}

async function listSafeSkillFilePaths(params: { skillRoot: string; signal?: AbortSignal; testing?: SkillToolTestingOptions }) {
  const selected: string[] = [];
  let candidateCount = 0;

  const addCandidate = (relativePath: string) => {
    candidateCount += 1;
    selected.push(relativePath);
    selected.sort(compareSkillPath);
    if (selected.length > MAX_SKILL_FILE_PATHS + 1) selected.pop();
  };

  const walk = async (relativeDirectory: string): Promise<void> => {
    throwIfAborted(params.signal);
    try {
      await assertSafeSkillDirectory(params.skillRoot, relativeDirectory);
    } catch {
      await reportSkillDiagnostic(params.testing, "unreadable_directory");
      return;
    }

    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean }>;
    try {
      const rawEntries = await fs.readdir(path.join(params.skillRoot, ...relativeDirectory.split("/").filter(Boolean)), {
        withFileTypes: true,
        encoding: "buffer"
      } as any) as Array<any>;
      entries = (await Promise.all(rawEntries.map(async (entry) => {
        const name = decodeDirectoryEntryName(entry.name);
        if (name === null) {
          await reportSkillDiagnostic(params.testing, "non_utf8_filename");
          return null;
        }
        return { entry, name };
      })))
        .filter((item): item is { entry: any; name: string } => item !== null)
        .map(({ entry, name }) => ({ name, isDirectory: () => entry.isDirectory(), isFile: () => entry.isFile(), isSymbolicLink: () => entry.isSymbolicLink() }))
        .sort((a, b) => compareSkillPath(a.name, b.name));
    } catch {
      await reportSkillDiagnostic(params.testing, "unreadable_directory");
      return;
    }

    for (const entry of entries) {
      throwIfAborted(params.signal);
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (!isValidSkillRelativePath(relativePath)) continue;
      await params.testing?.beforeEnumeratingSkillEntry?.({
        relativePath,
        kind: entry.isDirectory() ? "directory" : "file"
      });
      throwIfAborted(params.signal);
      if (entry.isDirectory()) {
        await walk(relativePath);
        continue;
      }
      if (!entry.isFile() || relativePath === "SKILL.md") continue;
      try {
        const file = await openSafeSkillFile({ skillRoot: params.skillRoot, relativePath, signal: params.signal, testing: params.testing });
        try {
          const kind = await classifyTextSampleFromHandle(file.handle, Number(file.stat.size));
          if (kind.kind === "text") addCandidate(relativePath);
        } finally {
          await file.handle.close();
        }
      } catch (err) {
        if (isAbortError(err, params.signal)) throw err;
        await reportSkillDiagnostic(params.testing, "unreadable_file");
      }
    }
  };

  await walk("");
  selected.sort(compareSkillPath);
  return { paths: selected.slice(0, MAX_SKILL_FILE_PATHS), candidateCount };
}

function truncateRootBody(text: string) {
  if (Buffer.byteLength(text, "utf8") <= MAX_ROOT_BODY_UTF8_BYTES) return { body: text, truncated: false };
  const suffixBytes = Buffer.byteLength(ROOT_BODY_TRUNCATION_SUFFIX, "utf8");
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(bytes.length, MAX_ROOT_BODY_UTF8_BYTES - suffixBytes);
  while (end > 0) {
    try {
      const prefix = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
      return { body: prefix + ROOT_BODY_TRUNCATION_SUFFIX, truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { body: ROOT_BODY_TRUNCATION_SUFFIX, truncated: true };
}

function buildSkillFilesSection(params: { body: string; paths: string[]; candidateCount: number; budget?: number }) {
  const budget = params.budget ?? MAX_SKILL_FILES_SECTION_UTF8_BYTES;
  const prefix = params.body.length > 0 ? "\n\n---\n\n## Skill files\n\n" : "## Skill files\n\n";
  if (params.candidateCount === 0) {
    return { content: `${prefix}No additional readable text files.`, truncated: false };
  }

  const available = params.paths;
  const listHint = "\n\nSkill file list truncated; additional files may be accessed if their paths are known.";
  const serialize = (count: number) => {
    const hasMore = count < available.length || params.candidateCount > available.length;
    return `${prefix}\`\`\`text\n${available.slice(0, count).join("\n")}\n\`\`\`${hasMore ? listHint : ""}`;
  };

  let bestCount = 0;
  for (let count = 1; count <= available.length; count += 1) {
    if (Buffer.byteLength(serialize(count), "utf8") <= budget) bestCount = count;
  }
  if (bestCount === 0) {
    return { content: `${prefix}Skill file list truncated; additional files may be accessed if their paths are known.`, truncated: true };
  }
  const content = serialize(bestCount);
  return { content, truncated: bestCount < available.length || params.candidateCount > available.length };
}

async function resolveSkillDirectory(params: {
  workspacePath: string;
  repoRoot: string;
  skillId: unknown;
  externalSkillRoots?: Array<{ sourceType: "workspace" | "repo"; repoId?: string; rootDir: string; rootPath: string }>;
}) {
  if (params.skillId === undefined) skillError("skill is required");
  const parsed = parseStableSkillIdentifier(params.skillId);
  if (parsed.kind === "required") skillError("skill is required");
  if (parsed.kind === "invalid") skillError("invalid skill identifier");
  const value = parsed.value;
  let skillsRoot: string;
  if (value.namespace === "builtin") {
    skillsRoot = path.resolve(params.repoRoot, "skills");
  } else if (value.namespace === "workspace") {
    const mapping = (params.externalSkillRoots || []).find(
      (item) => item.sourceType === "workspace" && item.rootDir === value.rootDir
    );
    if (!mapping) skillError("skill not found");
    skillsRoot = path.resolve(mapping.rootPath);
  } else {
    const mapping = (params.externalSkillRoots || []).find(
      (item) => item.sourceType === "repo" && item.repoId === value.repoId && item.rootDir === value.rootDir
    );
    if (!mapping) skillError("skill not found");
    skillsRoot = path.resolve(mapping.rootPath);
  }
  return { skill: value.skill, skillsRoot, skillDirectory: path.join(skillsRoot, value.skillDir) };
}

type RunSkillToolParams = {
  workspacePath: string;
  repoRoot: string;
  skillId: unknown;
  filePath?: unknown;
  externalSkillRoots?: Array<{ sourceType: "workspace" | "repo"; repoId?: string; rootDir: string; rootPath: string }>;
  signal?: AbortSignal;
};

async function runSkillToolInternal(params: RunSkillToolParams, testing?: SkillToolTestingOptions): Promise<SkillToolResult> {
  try {
    throwIfAborted(params.signal);
    const target = await resolveSkillDirectory(params);
    const rootSource = await validateSkillRoot({
      skillsRoot: target.skillsRoot,
      skillDirectory: target.skillDirectory,
      signal: params.signal,
      testing
    });
    const requestedPath = parseSkillPath(params.filePath);

    if (!requestedPath.root) {
      const file = await openSafeSkillFile({
        skillRoot: target.skillDirectory,
        relativePath: requestedPath.path,
        signal: params.signal,
        testing
      });
      try {
        const kind = await classifyTextSampleFromHandle(file.handle, Number(file.stat.size));
        if (kind.kind !== "text") skillError("binary file is not supported");
        const read = await readTextFileCappedFromHandle({ handle: file.handle, encoding: kind.encoding, signal: params.signal });
        return {
          skillId: target.skill,
          filePath: requestedPath.path,
          content: read.content,
          truncated: read.truncatedByBytes || read.hasMoreLines || read.truncatedByLineLength
        };
      } finally {
        await file.handle.close();
      }
    }

    const root = truncateRootBody(parseSkillFrontmatter(rootSource).body);
    const files = await listSafeSkillFilePaths({ skillRoot: target.skillDirectory, signal: params.signal, testing });
    let section = buildSkillFilesSection({
      body: root.body,
      paths: files.paths,
      candidateCount: files.candidateCount,
      ...(testing?.rootFilesSectionBudgetOverride === undefined
        ? {}
        : { budget: testing.rootFilesSectionBudgetOverride })
    });
    let content = root.body + section.content;
    let truncated = root.truncated || section.truncated;
    if (Buffer.byteLength(content, "utf8") > MAX_ROOT_CONTENT_UTF8_BYTES) {
      await reportSkillDiagnostic(testing, "root_content_invariant");
      await testing?.onRootContentInvariantFallback?.();
      section = buildSkillFilesSection({
        body: root.body,
        paths: files.paths,
        candidateCount: files.candidateCount,
        budget: Math.max(0, MAX_ROOT_CONTENT_UTF8_BYTES - Buffer.byteLength(root.body, "utf8"))
      });
      content = root.body + section.content;
      truncated = true;
    }
    return { skillId: target.skill, filePath: "SKILL.md", content, truncated };
  } catch (err) {
    throw sanitizeSkillToolError(err, params.signal);
  }
}

export async function runSkillTool(params: RunSkillToolParams): Promise<SkillToolResult> {
  return runSkillToolInternal(params);
}

export const __testing = {
  runSkillTool: (params: RunSkillToolParams, options: SkillToolTestingOptions) => runSkillToolInternal(params, options),
  buildSkillFilesSection
};

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
