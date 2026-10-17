import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { Readable, Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Parser, type ReadEntry } from "tar";
import * as yauzl from "yauzl";
import type { WorkspaceArchiveFormat } from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import { ArchiveStagingArea } from "./workspace-archive-staging.js";
import { addArchiveCount, archiveError, checkArchiveAbort, checkedArchiveSize, invalidArchive, safeArchiveError } from "./workspace-archive-policy.js";

function parserError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  return (error as NodeJS.ErrnoException)?.syscall ? safeArchiveError(error) : invalidArchive();
}

async function* archiveContent(content: AsyncIterable<Buffer | string>): AsyncIterable<Buffer | string> {
  try { yield* content; } catch (error) { throw parserError(error); }
}

/** A public yauzl adapter keeps explicit, awaitable ownership of the snapshot handle. */
class SnapshotZipReader extends yauzl.RandomAccessReader {
  private closeResult?: Promise<void>;
  constructor(private readonly handle: fs.FileHandle) { super(); }
  override _readStreamForRange(start: number, end: number): Readable {
    const handle = this.handle;
    // A FileHandle ReadStream can close the shared fd when yauzl destroys a
    // completed range. Positioned reads retain ownership until our explicit close.
    return Readable.from((async function* () {
      let position = start;
      while (position < end) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) throw invalidArchive();
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    })(), { objectMode: false });
  }
  override read(buffer: Buffer, offset: number, length: number, position: number, callback: (error: Error | null, count: number) => void): void {
    void this.handle.read(buffer, offset, length, position).then((result) => callback(null, result.bytesRead), (error: Error) => callback(error, 0));
  }
  override close(callback: (error: Error | null) => void): void {
    void this.closeHandle().then(() => callback(null), (error: Error) => callback(error));
  }
  closeHandle(): Promise<void> {
    // This is a known filesystem operation, not an unclassified parser error event.
    return this.closeResult ??= this.handle.close().catch((error: unknown) => { throw safeArchiveError(error); });
  }
}

function nextZipEntry(zip: yauzl.ZipFile, signal: AbortSignal): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off("entry", onEntry); zip.off("end", onEnd); zip.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onEntry = (entry: yauzl.Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = (error: unknown) => { cleanup(); reject(parserError(error)); };
    const onAbort = () => { cleanup(); reject(signal.reason instanceof HttpError ? signal.reason : archiveError("ARCHIVE_TIMEOUT", 408)); };
    zip.once("entry", onEntry); zip.once("end", onEnd); zip.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort(); else zip.readEntry();
  });
}

async function extractZip(handle: fs.FileHandle, size: number, area: ArchiveStagingArea, externalSignal?: AbortSignal): Promise<void> {
  const reader = new SnapshotZipReader(handle);
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  let zip: yauzl.ZipFile | undefined;
  let active: Readable | undefined;
  let failure: HttpError | undefined;
  const onError = (error: unknown) => {
    failure ??= parserError(error);
    controller.abort(failure);
    active?.destroy(failure);
  };
  const onAbort = () => onError(signal.reason instanceof HttpError ? signal.reason : archiveError("ARCHIVE_TIMEOUT", 408));
  signal.addEventListener("abort", onAbort);
  try {
    zip = await yauzl.fromRandomAccessReaderPromise(reader, size, {
      autoClose: false, lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true
    });
    zip.on("error", onError); // Remains installed while file streams, not only during enumeration.
    area.countMetadata(Buffer.isBuffer(zip.comment) ? zip.comment.length : Buffer.byteLength(zip.comment));
    while (true) {
      checkArchiveAbort(signal);
      const entry = await nextZipEntry(zip, signal);
      if (!entry) break;
      area.countRecord();
      area.countMetadata(entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength);
      checkedArchiveSize(entry.compressedSize);
      checkedArchiveSize(entry.uncompressedSize);
      if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) throw archiveError("ARCHIVE_FEATURE_UNSUPPORTED");
      const unix = (entry.versionMadeBy >>> 8) === 3;
      const unixMode = unix ? entry.externalFileAttributes >>> 16 : 0;
      const unixType = unixMode & 0o170000;
      if (unixType && unixType !== 0o100000 && unixType !== 0o040000) throw archiveError("ARCHIVE_ENTRY_UNSUPPORTED");
      const directory = entry.fileName.endsWith("/") || unixType === 0o040000 || !!(entry.externalFileAttributes & 0x10);
      if ((directory && unixType === 0o100000) || (unixType === 0o040000 && !entry.fileName.endsWith("/"))
        || (directory && entry.uncompressedSize !== 0)) throw archiveError("ARCHIVE_ENTRY_INVALID");
      if (directory) {
        await area.writeEntry({ name: entry.fileName, kind: "dir", size: entry.uncompressedSize, signal });
      } else {
        // Header/path/size checks happen before opening a data stream wherever possible.
        if (entry.uncompressedSize > area.limits.fileBytes) throw archiveError("ARCHIVE_LIMIT_EXCEEDED", 413);
        active = await zip.openReadStreamPromise(entry);
        active.on("error", onError);
        try {
          await area.writeEntry({ name: entry.fileName, kind: "file", size: entry.uncompressedSize,
            executable: unixType === 0o100000 && !!(unixMode & 0o111), content: archiveContent(active), crc: entry.crc32, signal });
        } finally {
          active.destroy();
          // Async iteration and the output FileHandle have already settled before this scope exits.
          active = undefined;
        }
      }
    }
    if (failure) throw failure;
  } catch (error) {
    // The processing rejection remains authoritative: iterator teardown can emit
    // a secondary AbortError before this catch observes the original quota/IO error.
    failure = parserError(error);
  } finally {
    signal.removeEventListener("abort", onAbort);
    active?.destroy();
    try { zip?.close(); }
    catch (error) { failure ??= parserError(error); }
    // No private yauzl fields: our public RandomAccessReader owns and awaits close,
    // including open failures and a close error that yauzl may otherwise suppress.
    try { await reader.closeHandle(); }
    catch (error) { failure ??= safeArchiveError(error); }
  }
  if (failure) throw failure;
}

/** Bounded two-byte lookahead prevents Parser's automatic nested gzip decoder. */
export class ArchiveTarGuard extends Transform {
  bytes = 0;
  private prefix = Buffer.alloc(0);
  private releasedPrefix = false;
  private allZero = true;
  inputComplete = false;
  constructor(private readonly area: ArchiveStagingArea) { super(); }
  get isEmptyTar(): boolean { return this.allZero && this.bytes >= 1024 && this.bytes % 512 === 0; }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.bytes = addArchiveCount(this.bytes, chunk.length, this.area.limits.tarStreamBytes);
      if (this.allZero && chunk.some((byte) => byte !== 0)) this.allZero = false;
      if (this.releasedPrefix) this.push(chunk);
      else {
        const needed = Math.min(2 - this.prefix.length, chunk.length);
        this.prefix = Buffer.concat([this.prefix, chunk.subarray(0, needed)]);
        if (this.prefix.length === 2) {
          if (this.prefix[0] === 0x1f && this.prefix[1] === 0x8b) throw invalidArchive();
          this.releasedPrefix = true;
          this.push(this.prefix);
          this.prefix = Buffer.alloc(0);
          this.push(chunk.subarray(needed));
        }
      }
      callback();
    } catch (error) { callback(parserError(error)); }
  }
  override _flush(callback: TransformCallback): void {
    this.inputComplete = true;
    if (!this.releasedPrefix) this.push(this.prefix);
    callback();
  }
}

async function extractTar(handle: fs.FileHandle, format: WorkspaceArchiveFormat, area: ArchiveStagingArea, externalSignal?: AbortSignal): Promise<void> {
  const source = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
  const gzip = format === "tar-gzip" ? createGunzip({ chunkSize: 16 * 1024 }) : undefined;
  const guard = new ArchiveTarGuard(area);
  const parser = new Parser({ strict: true, maxMetaEntrySize: area.limits.metadataRecordBytes, brotli: false, zstd: false });
  let parserEof = false;
  parser.once("eof", () => { parserEof = true; });
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  let failure: HttpError | undefined;
  let tail = Promise.resolve();
  const entries = new Set<ReadEntry>();
  let resolveParser!: () => void;
  let rejectParser!: (error: Error) => void;
  const parserDone = new Promise<void>((resolve, reject) => { resolveParser = resolve; rejectParser = reject; });
  void parserDone.catch(() => {}); // Joined below; prevents an early synchronous parser rejection becoming unhandled.
  const fail = (error: unknown) => {
    if (failure) return;
    failure = parserError(error);
    controller.abort(failure);
    source.destroy(failure); gzip?.destroy(failure); guard.destroy(failure); bridge.destroy(failure);
    for (const entry of entries) entry.destroy(failure);
    parser.abort(failure);
    rejectParser(failure);
  };
  parser.on("error", (error: NodeJS.ErrnoException) => {
    // node-tar rejects even a standards-conforming, all-zero empty TAR. The
    // constant-space guard identifies only whole zero blocks (>=2), never headers.
    if (error.code === "TAR_BAD_ARCHIVE" && guard.inputComplete && guard.isEmptyTar) return;
    fail(error);
  });
  parser.once("end", resolveParser);
  parser.on("ignoredEntry", (entry: ReadEntry) => {
    try {
      area.countRecord();
      checkedArchiveSize(entry.size);
      const oversizedMeta = entry.meta && entry.size > area.limits.metadataRecordBytes;
      fail(archiveError(oversizedMeta ? "ARCHIVE_LIMIT_EXCEEDED" : "ARCHIVE_ENTRY_UNSUPPORTED", oversizedMeta ? 413 : 400));
    } catch (error) { fail(error); }
  });
  parser.on("meta", (text: string) => {
    try {
      area.countMetadata(Buffer.byteLength(text));
      if (/GNU\.sparse\.|SCHILY\.realsize|SCHILY\.filetype=sparse/.test(text)) throw archiveError("ARCHIVE_ENTRY_UNSUPPORTED");
      // Parser drops negative/non-numeric PAX sizes and truncates PAX names at
      // NUL. Conservatively reject those observable declarations, not by
      // implementing a second PAX parser or accessing private Parser state.
      for (const match of text.matchAll(/(?:^|\n)\d+ size=([^\n]*)/g)) {
        checkedArchiveSize(Number(match[1]));
      }
      if (/(?:^|\n)\d+ (?:path|linkpath)=[^\n]*\0/.test(text)) {
        throw archiveError("ARCHIVE_ENTRY_INVALID");
      }
    } catch (error) { fail(error); }
  });
  parser.on("entry", (entry: ReadEntry) => {
    entries.add(entry);
    entry.on("error", fail);
    entry.pause();
    tail = tail.then(async () => {
      checkArchiveAbort(signal);
      area.countRecord();
      area.countMetadata(Buffer.byteLength(entry.path));
      if (!["File", "OldFile", "Directory"].includes(entry.type)) throw archiveError("ARCHIVE_ENTRY_UNSUPPORTED");
      await area.writeEntry({ name: entry.path, kind: entry.type === "Directory" ? "dir" : "file", size: entry.size,
        executable: !!((entry.mode ?? 0) & 0o111), content: archiveContent(entry), signal });
      entries.delete(entry);
    }).catch(fail);
  });
  const bridge = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (failure) { callback(failure); return; }
      // node-tar retains later writes after EOF without parsing them. Only stop
      // forwarding on its public EOF event, preserving entry/drain ordering.
      // The EOF-containing chunk is bounded by source (64 KiB) or gunzip (16 KiB).
      // Keep draining through guard so all tail bytes count and gzip validates
      // its complete CRC/length; parser.end() and all entry IO are still joined.
      if (parserEof) { callback(); return; }
      const cleanup = () => { parser.off("drain", onDrain); parser.off("error", onError); };
      const onDrain = () => { cleanup(); callback(); };
      const onError = (error: Error) => { cleanup(); callback(parserError(error)); };
      parser.once("drain", onDrain); parser.once("error", onError);
      try {
        if (parser.write(chunk)) { cleanup(); callback(); }
      } catch (error) { cleanup(); callback(parserError(error)); }
    },
    final(callback) {
      try { parser.end(); callback(); } catch (error) { callback(parserError(error)); }
    }
  });
  const onAbort = () => fail(signal.reason instanceof HttpError ? signal.reason : archiveError("ARCHIVE_TIMEOUT", 408));
  signal.addEventListener("abort", onAbort, { once: true });
  let flow: Promise<void> | undefined;
  try {
    checkArchiveAbort(signal);
    flow = gzip ? pipeline(source, gzip, guard, bridge) : pipeline(source, guard, bridge);
    await flow;
    await parserDone;
    await tail;
    if (failure) throw failure;
  } catch (error) { fail(error); }
  finally {
    signal.removeEventListener("abort", onAbort);
    await Promise.allSettled([flow, parserDone, tail]);
    try { await handle.close(); }
    catch (error) { failure ??= safeArchiveError(error); }
  }
  if (failure) throw failure;
}

/**
 * Parses one caller-owned immutable private snapshot into its empty private area.
 * On failure, partial nodes remain in area.nodes for ownership-aware caller cleanup;
 * all parsing, writes and handle closures have settled before rejection.
 */
export async function extractArchiveToStaging(options: {
  inputPath: string;
  format: WorkspaceArchiveFormat;
  area: ArchiveStagingArea;
  signal?: AbortSignal;
}): Promise<void> {
  const { inputPath, format, area, signal } = options;
  checkArchiveAbort(signal);
  let handle: fs.FileHandle | undefined;
  let failure: HttpError | undefined;
  try {
    handle = await fs.open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw archiveError("ARCHIVE_PATH_INVALID");
    if (stat.size > BigInt(area.limits.inputBytes)) throw archiveError("ARCHIVE_LIMIT_EXCEEDED", 413);
    if (stat.size === 0n) throw invalidArchive();
    if (format !== "zip" && format !== "tar" && format !== "tar-gzip") throw archiveError("ARCHIVE_FORMAT_UNSUPPORTED");
    // The adapter owns the handle from this point, including failure/abort.
    const ownedHandle = handle;
    handle = undefined;
    if (format === "zip") await extractZip(ownedHandle, Number(stat.size), area, signal);
    else await extractTar(ownedHandle, format, area, signal);
    await area.verify(signal);
  } catch (error) { failure = safeArchiveError(error); }
  finally {
    try { await handle?.close(); }
    catch (error) { failure ??= safeArchiveError(error); }
  }
  if (failure) throw failure;
}
