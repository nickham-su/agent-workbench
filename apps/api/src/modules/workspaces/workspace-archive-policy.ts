import { HttpError } from "../../app/errors.js";

const MiB = 1024 ** 2;
export const ARCHIVE_LIMITS = Object.freeze({
  inputBytes: 512 * MiB,
  outputBytes: 2048 * MiB,
  fileBytes: 512 * MiB,
  nodes: 20_000,
  records: 40_000,
  depth: 64,
  pathBytes: 4096,
  segmentBytes: 255,
  metadataRecordBytes: 64 * 1024,
  metadataBytes: 8 * MiB,
  tarStreamBytes: 2048 * MiB + 64 * MiB,
  timeoutMs: 120_000,
  activeOperations: 1
});
export type ArchiveLimits = { -readonly [K in keyof typeof ARCHIVE_LIMITS]: number };
export type ArchiveLimitOverrides = Partial<ArchiveLimits>;

/** Test limits can only tighten production limits, never disable a safety bound. */
export function archiveLimits(overrides: ArchiveLimitOverrides = {}): ArchiveLimits {
  const result: ArchiveLimits = { ...ARCHIVE_LIMITS };
  for (const key of Object.keys(overrides) as (keyof ArchiveLimits)[]) {
    const value = overrides[key];
    if (!Number.isSafeInteger(value) || value! < 1 || value! > ARCHIVE_LIMITS[key]) {
      throw new Error("Invalid archive limit override");
    }
    result[key] = value!;
  }
  return result;
}

export function archiveError(code: string, statusCode = 400): HttpError {
  const messages: Record<string, string> = {
    ARCHIVE_SOURCE_NOT_FOUND: "Archive source file was not found",
    ARCHIVE_SOURCE_CHANGED: "Archive source changed during extraction",
    ARCHIVE_TARGET_CONFLICT: "Archive output conflicts with an existing file or directory",
    ARCHIVE_FILESYSTEM_UNSUPPORTED: "Filesystem does not support safe archive extraction",
    ARCHIVE_BUSY: "Another archive extraction is already running",
    ARCHIVE_CLEANUP_INCOMPLETE: "Files may have been extracted and some content could not be cleaned up; refresh to confirm",
    ARCHIVE_PATH_INVALID: "Invalid archive source path or file type",
    ARCHIVE_INVALID: "Invalid or damaged archive",
    ARCHIVE_FORMAT_UNSUPPORTED: "Archive format is not supported",
    ARCHIVE_FEATURE_UNSUPPORTED: "Archive feature is not supported",
    ARCHIVE_ENTRY_UNSUPPORTED: "Archive contains an unsupported entry",
    ARCHIVE_ENTRY_INVALID: "Archive contains an invalid or conflicting entry path",
    ARCHIVE_LIMIT_EXCEEDED: "Archive exceeds extraction limits",
    ARCHIVE_TARGET_CHANGED: "Archive extraction target changed",
    ARCHIVE_PERMISSION_DENIED: "Archive file access was denied",
    ARCHIVE_STORAGE_EXHAUSTED: "Insufficient space to extract archive",
    ARCHIVE_IO_FAILED: "Archive file operation failed",
    ARCHIVE_TIMEOUT: "Archive extraction timed out"
  };
  return new HttpError(statusCode, messages[code] ?? "Archive extraction failed", code);
}

/** Never expose parser messages, file names or native error paths to HTTP/logs. */
export function safeArchiveError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return archiveError("ARCHIVE_STORAGE_EXHAUSTED", 507);
  if (code === "EACCES" || code === "EPERM") return archiveError("ARCHIVE_PERMISSION_DENIED", 403);
  return archiveError("ARCHIVE_IO_FAILED", 500);
}

export function invalidArchive(): HttpError {
  return archiveError("ARCHIVE_INVALID");
}

export function checkArchiveAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof HttpError ? signal.reason : archiveError("ARCHIVE_TIMEOUT", 408);
}

export function checkedArchiveSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidArchive();
  return value;
}

export function addArchiveCount(current: number, increment: number, maximum: number): number {
  checkedArchiveSize(increment);
  if (!Number.isSafeInteger(current + increment) || current + increment > maximum) {
    throw archiveError("ARCHIVE_LIMIT_EXCEEDED", 413);
  }
  return current + increment;
}

/** New endpoint only; validate before selecting a Workspace/repository lock. */
export function validateArchiveSourcePath(value: string): string {
  const parts = value.split("/");
  if (!value || Buffer.byteLength(value) > 4096 || Buffer.from(value, "utf8").toString("utf8") !== value
    || /[\\\0\r\n:]/.test(value)
    || parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || Buffer.byteLength(part) > 255)) {
    throw archiveError("ARCHIVE_PATH_INVALID");
  }
  return value;
}

export function normalizeArchiveEntryPath(name: string, kind: "file" | "dir", limits: ArchiveLimits): string {
  if (!name || name.startsWith("/") || /[\\\0\r\n:]/.test(name)) throw archiveError("ARCHIVE_ENTRY_INVALID");
  const rawParts = name.split("/");
  if (rawParts.includes("..")) throw archiveError("ARCHIVE_ENTRY_INVALID");
  const parts = rawParts.filter((part) => part && part !== ".");
  if (parts.some((part) => part.toLowerCase() === ".git")) throw archiveError("ARCHIVE_ENTRY_INVALID");
  const rel = parts.join("/");
  if (!rel && kind !== "dir") throw archiveError("ARCHIVE_ENTRY_INVALID");
  if (Buffer.byteLength(name) > limits.pathBytes || Buffer.byteLength(rel) > limits.pathBytes
    || parts.length > limits.depth || parts.some((part) => Buffer.byteLength(part) > limits.segmentBytes)) {
    throw archiveError("ARCHIVE_LIMIT_EXCEEDED", 413);
  }
  return rel;
}
