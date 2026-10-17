import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { HttpError } from "../../app/errors.js";
import { createRequire } from "node:module";
import {
  addArchiveCount, archiveError, archiveLimits, checkArchiveAbort, checkedArchiveSize,
  normalizeArchiveEntryPath, safeArchiveError, type ArchiveLimitOverrides, type ArchiveLimits
} from "./workspace-archive-policy.js";
import { sameArchiveIdentity as sameIdentity, sameArchiveFileVersion, settledArchivePrivateWriter } from "./workspace-archive-owned.js";

// 1.0.0's ESM declaration uses export=; use its public CJS export without changing project interop settings.
const crc32: typeof import("buffer-crc32") = createRequire(import.meta.url)("buffer-crc32");

export type StagedArchiveNode = {
  rel: string;
  kind: "file" | "dir";
  explicit: boolean;
  bytes: number;
  finalMode: number;
  /** Undefined only if creation succeeded but identity registration failed. Never guess ownership. */
  stat?: BigIntStats;
};

/**
 * Request-local staging ledger, not a filesystem transaction. The caller creates an
 * empty private payload directory, owns cleanup (including failure), and must keep
 * this ledger until all IO has settled. No final Workspace files are written here.
 */
export class ArchiveStagingArea {
  readonly nodes = new Map<string, StagedArchiveNode>();
  readonly limits: ArchiveLimits;
  records = 0;
  metadataBytes = 0;
  outputBytes = 0;
  private constructor(readonly payloadDir: string, readonly rootStat: BigIntStats, limits: ArchiveLimits) {
    this.limits = limits;
  }

  static async open(payloadDir: string, overrides: ArchiveLimitOverrides = {}): Promise<ArchiveStagingArea> {
    const abs = path.resolve(payloadDir);
    const stat = await fs.lstat(abs, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777n) !== 0o700n
      || await fs.realpath(abs) !== abs || (await fs.readdir(abs)).length !== 0) {
      throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
    }
    return new ArchiveStagingArea(abs, stat, archiveLimits(overrides));
  }

  countRecord(): void {
    this.records = addArchiveCount(this.records, 1, this.limits.records);
  }

  countMetadata(bytes: number): void {
    this.metadataBytes = addArchiveCount(this.metadataBytes, bytes, this.limits.metadataBytes);
  }

  absolutePath(rel: string): string {
    const abs = path.resolve(this.payloadDir, rel);
    if (abs !== this.payloadDir && !abs.startsWith(this.payloadDir + path.sep)) {
      throw archiveError("ARCHIVE_ENTRY_INVALID");
    }
    return abs;
  }

  private async assertDirectory(rel: string): Promise<void> {
    const expected = rel ? this.nodes.get(rel)?.stat : this.rootStat;
    if (!expected) throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
    const current = await fs.lstat(this.absolutePath(rel), { bigint: true });
    if (!current.isDirectory() || !sameIdentity(current, expected) || (current.mode & 0o7777n) !== 0o700n) {
      throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
    }
  }

  private async assertParents(rel: string, signal?: AbortSignal): Promise<void> {
    checkArchiveAbort(signal);
    await this.assertDirectory("");
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      checkArchiveAbort(signal);
      await this.assertDirectory(parts.slice(0, i).join("/"));
    }
  }

  private checkNodeCapacity(): void {
    addArchiveCount(this.nodes.size, 1, this.limits.nodes);
  }

  private async ensureDirectory(rel: string, explicit: boolean, signal?: AbortSignal): Promise<void> {
    const previous = this.nodes.get(rel);
    if (previous) {
      if (previous.kind !== "dir") throw archiveError("ARCHIVE_ENTRY_INVALID");
      await this.assertDirectory(rel);
      previous.explicit ||= explicit;
      return;
    }
    this.checkNodeCapacity();
    await this.assertParents(rel, signal);
    const node: StagedArchiveNode = { rel, kind: "dir", explicit, bytes: 0, finalMode: 0o755 };
    try {
      await fs.mkdir(this.absolutePath(rel), { recursive: false, mode: 0o700 });
      this.nodes.set(rel, node); // Register success before any subsequent IO can fail.
      node.stat = await fs.lstat(this.absolutePath(rel), { bigint: true });
      if (!node.stat.isDirectory()) throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
      if ((node.stat.mode & 0o7777n) !== 0o700n) {
        await fs.chmod(this.absolutePath(rel), 0o700);
        node.stat = await fs.lstat(this.absolutePath(rel), { bigint: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw archiveError("ARCHIVE_ENTRY_INVALID");
      throw safeArchiveError(error);
    }
  }

  async writeEntry(options: {
    name: string;
    kind: "file" | "dir";
    size: number;
    executable?: boolean;
    content?: AsyncIterable<Buffer | string>;
    crc?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const { name, kind, content, signal } = options;
    checkArchiveAbort(signal);
    checkedArchiveSize(options.size);
    if (kind === "dir" && options.size !== 0) throw archiveError("ARCHIVE_ENTRY_INVALID");
    if (kind === "file" && options.size > this.limits.fileBytes) throw archiveError("ARCHIVE_LIMIT_EXCEEDED", 413);
    if (kind === "file" && name.endsWith("/")) throw archiveError("ARCHIVE_ENTRY_INVALID");
    const rel = normalizeArchiveEntryPath(name, kind, this.limits);
    const parts = rel ? rel.split("/") : [];
    for (let i = 1; i < parts.length; i++) await this.ensureDirectory(parts.slice(0, i).join("/"), false, signal);
    if (kind === "dir") {
      if (rel) await this.ensureDirectory(rel, true, signal);
      if (content) {
        for await (const chunk of content) {
          checkArchiveAbort(signal);
          if (Buffer.byteLength(chunk) !== 0) throw archiveError("ARCHIVE_ENTRY_INVALID");
        }
      }
      return;
    }
    if (!content) throw archiveError("ARCHIVE_INVALID");
    if (this.nodes.has(rel)) throw archiveError("ARCHIVE_ENTRY_INVALID");
    this.checkNodeCapacity();
    await this.assertParents(rel, signal);
    let handle: fs.FileHandle | undefined;
    let node: StagedArchiveNode | undefined;
    let failure: HttpError | undefined;
    try {
      handle = await fs.open(this.absolutePath(rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      node = { rel, kind, explicit: true, bytes: 0, finalMode: options.executable ? 0o755 : 0o644 };
      this.nodes.set(rel, node);
      node.stat = await handle.stat({ bigint: true });
      if (!node.stat.isFile()) throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
      await handle.chmod(0o600);
      node.stat = settledArchivePrivateWriter(node.stat, await handle.stat({ bigint: true }));
      let checksum = 0;
      for await (const value of content) {
        checkArchiveAbort(signal);
        const chunk = typeof value === "string" ? Buffer.from(value) : value;
        const nextBytes = addArchiveCount(node.bytes, chunk.length, this.limits.fileBytes);
        addArchiveCount(this.outputBytes, chunk.length, this.limits.outputBytes);
        if (nextBytes > options.size) throw archiveError("ARCHIVE_INVALID");
        if (options.crc !== undefined) checksum = crc32.unsigned(chunk, checksum);
        let offset = 0;
        while (offset < chunk.length) {
          checkArchiveAbort(signal);
          const result = await handle.write(chunk, offset, chunk.length - offset);
          if (result.bytesWritten <= 0) throw archiveError("ARCHIVE_IO_FAILED", 500);
          offset += result.bytesWritten;
          node.bytes += result.bytesWritten;
          this.outputBytes += result.bytesWritten;
        }
      }
      checkArchiveAbort(signal);
      if (node.bytes !== options.size || (options.crc !== undefined && checksum !== options.crc)) throw archiveError("ARCHIVE_INVALID");
    } catch (error) {
      failure = (error as NodeJS.ErrnoException).code === "EEXIST" ? archiveError("ARCHIVE_ENTRY_INVALID") : safeArchiveError(error);
    }
    if (handle) {
      try {
        // Observe even after processing failed; never advance an untrusted cleanup baseline.
        if (node) node.stat = settledArchivePrivateWriter(node.stat, await handle.stat({ bigint: true }));
      } catch (error) { failure ??= safeArchiveError(error); }
      try { await handle.close(); }
      catch (error) { failure ??= safeArchiveError(error); }
    }
    if (failure) throw failure;
  }

  /** Detect unexpected names and changed nodes before handing the plan to publication. */
  async verify(signal?: AbortSignal): Promise<void> {
    const children = new Map<string, Set<string>>();
    for (const name of this.nodes.keys()) {
      const slash = name.lastIndexOf("/");
      const parent = slash < 0 ? "" : name.slice(0, slash);
      let names = children.get(parent);
      if (!names) children.set(parent, names = new Set());
      names.add(name.slice(slash + 1));
    }
    for (const rel of ["", ...this.nodes.keys()]) {
      checkArchiveAbort(signal);
      const node = rel ? this.nodes.get(rel)! : undefined;
      if (!node || node.kind === "dir") {
        await this.assertDirectory(rel);
        const expected = children.get(rel) ?? new Set<string>();
        const actual = await fs.readdir(this.absolutePath(rel));
        if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
      } else {
        await this.assertParents(rel, signal);
        const current = await fs.lstat(this.absolutePath(rel), { bigint: true });
        const expected = node.stat;
        if (!expected || !sameArchiveFileVersion(current, expected)
          || current.nlink !== 1n || (current.mode & 0o7777n) !== 0o600n || current.size !== BigInt(node.bytes)) {
          throw archiveError("ARCHIVE_TARGET_CHANGED", 409);
        }
      }
    }
  }

  summary(): { topLevelCount: number; fileCount: number; directoryCount: number; extractedBytes: number } {
    const nodes = [...this.nodes.values()];
    return {
      topLevelCount: nodes.filter((node) => !node.rel.includes("/")).length,
      fileCount: nodes.filter((node) => node.kind === "file").length,
      directoryCount: nodes.filter((node) => node.kind === "dir").length,
      extractedBytes: this.outputBytes
    };
  }
}
