import type { FastifyBaseLogger } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import {
  agentArchivePendingSidecarPath,
  agentArchiveSessionDir,
} from "../../../infra/fs/paths.js";
import { newSortableId } from "../../../utils/ids.js";
import { nowMs } from "../../../utils/time.js";
import type { ArchiveFaultHook } from "./archive-fault-hook.js";
import { noArchiveFaultHook } from "./archive-fault-hook.js";

const FILE_WIDTH = 8;
const FILE_LIMIT = 100;
const FILE_RE = /^\d{8}\.log$/;

export type ArchiveWriteSnapshot = {
  filePath: string;
  beforeSize: number;
  expectedSize: number;
};

type PendingRecord = {
  version: 1;
  operation: "compaction" | "clear";
  workspaceId: string;
  sessionId: string;
  runId?: string;
  createdAt: number;
  snapshots: Array<{
    fileKey: string;
    beforeSize: number;
    expectedSize: number;
  }>;
};

function isNonNegativeSafeInt(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function formatFileName(seq: number) {
  return `${String(seq).padStart(FILE_WIDTH, "0")}.log`;
}

function parseFileName(name: string) {
  if (!FILE_RE.test(name)) return null;
  const value = Number(name.slice(0, FILE_WIDTH));
  return Number.isFinite(value) && value >= 1 ? value : null;
}

async function listFilesAsc(dirPath: string) {
  const entries = await fs
    .readdir(dirPath)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
  return entries
    .map((name) => ({ name, seq: parseFileName(name) }))
    .filter((item): item is { name: string; seq: number } => item.seq != null)
    .sort((a, b) => a.seq - b.seq)
    .map((item) => item.name);
}

function splitLines(text: string) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (/\r?\n$/.test(text)) {
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }
  // 末行没有换行符时视为潜在半行，读取时忽略以避免并发写入噪声。
  lines.pop();
  return lines;
}

function fileKeyFromPath(
  dataDir: string,
  workspaceId: string,
  sessionId: string,
  filePath: string,
) {
  const root = path.resolve(dataDir);
  const sessionDir = path.resolve(
    agentArchiveSessionDir(dataDir, workspaceId, sessionId),
  );
  const fileAbs = path.resolve(filePath);
  if (!fileAbs.startsWith(sessionDir + path.sep)) return null;

  const fileKey = path.relative(root, fileAbs);
  const parts = fileKey.split(path.sep);
  if (
    parts.length < 4 ||
    parts[0] !== "agent" ||
    parts[1] !== "archive" ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    return null;
  }
  return FILE_RE.test(parts.at(-1) || "") ? fileKey : null;
}

function pathFromFileKey(
  dataDir: string,
  workspaceId: string,
  sessionId: string,
  fileKey: unknown,
) {
  if (typeof fileKey !== "string" || !fileKey) return null;
  const root = path.resolve(dataDir);
  const sessionDir = path.resolve(
    agentArchiveSessionDir(dataDir, workspaceId, sessionId),
  );
  const filePath = path.resolve(root, fileKey);
  return filePath.startsWith(sessionDir + path.sep) &&
    fileKeyFromPath(dataDir, workspaceId, sessionId, filePath) === fileKey
    ? filePath
    : null;
}

function parsePendingRecord(value: unknown): PendingRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    (record.operation !== "compaction" && record.operation !== "clear") ||
    typeof record.workspaceId !== "string" ||
    !record.workspaceId ||
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    !isNonNegativeSafeInt(record.createdAt) ||
    !Array.isArray(record.snapshots) ||
    record.snapshots.length === 0
  ) {
    return null;
  }

  const snapshots = record.snapshots.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    return typeof row.fileKey === "string" &&
      isNonNegativeSafeInt(row.beforeSize) &&
      isNonNegativeSafeInt(row.expectedSize) &&
      (row.beforeSize as number) <= (row.expectedSize as number)
      ? {
          fileKey: row.fileKey,
          beforeSize: row.beforeSize as number,
          expectedSize: row.expectedSize as number,
        }
      : null;
  });
  if (snapshots.some((item) => item == null)) return null;

  return {
    version: 1,
    operation: record.operation,
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    ...(typeof record.runId === "string" && record.runId
      ? { runId: record.runId }
      : {}),
    createdAt: record.createdAt as number,
    snapshots: snapshots as PendingRecord["snapshots"],
  };
}

function toPos(fileSeq: number, lineNo: number) {
  return (fileSeq - 1) * FILE_LIMIT + lineNo;
}

function parseArchivedItemId(line: string) {
  const match = /^item=(\d+)\s/.exec(String(line || ""));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export class ArchiveStorage {
  constructor(
    private readonly options: {
      dataDir: string;
      logger: FastifyBaseLogger;
      faultHook?: ArchiveFaultHook;
    },
  ) {}

  private get fault() {
    return this.options.faultHook ?? noArchiveFaultHook;
  }

  async appendLines(params: {
    operation?: "fork" | "compaction" | "clear";
    workspaceId: string;
    sessionId: string;
    lines: string[];
  }) {
    if (params.lines.length === 0) return [] as ArchiveWriteSnapshot[];

    const dirPath = agentArchiveSessionDir(
      this.options.dataDir,
      params.workspaceId,
      params.sessionId,
    );
    await fs.mkdir(dirPath, { recursive: true });
    const snapshots = new Map<string, ArchiveWriteSnapshot>();
    const files = await listFilesAsc(dirPath);
    let currentSeq =
      files.length > 0 ? (parseFileName(files.at(-1) || "") ?? 1) : 1;
    let currentPath = path.join(dirPath, formatFileName(currentSeq));
    let currentCount = await fs
      .readFile(currentPath, "utf8")
      .then((content) => splitLines(content).length)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      });
    let cursor = 0;
    let writtenChunks = 0;

    while (cursor < params.lines.length) {
      if (currentCount >= FILE_LIMIT) {
        currentSeq += 1;
        currentPath = path.join(dirPath, formatFileName(currentSeq));
        currentCount = 0;
      }

      const writable = Math.min(
        FILE_LIMIT - currentCount,
        params.lines.length - cursor,
      );
      const chunk = params.lines.slice(cursor, cursor + writable);
      let snapshot = snapshots.get(currentPath);
      if (!snapshot) {
        const beforeSize = await fs
          .stat(currentPath)
          .then((stat) => stat.size)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return 0;
            throw error;
          });
        snapshot = {
          filePath: currentPath,
          beforeSize,
          expectedSize: beforeSize,
        };
        snapshots.set(currentPath, snapshot);
      }

      const payload = `${chunk.join("\n")}\n`;
      await fs.appendFile(currentPath, payload, "utf8");
      snapshot.expectedSize += Buffer.byteLength(payload, "utf8");
      currentCount += chunk.length;
      cursor += chunk.length;
      writtenChunks += 1;
      await this.fault.afterAppendChunk?.({
        operation: params.operation ?? "compaction",
        chunkIndex: writtenChunks,
        snapshotCount: snapshots.size,
      });
    }

    return [...snapshots.values()];
  }

  async rollbackBestEffort(snapshots: ArchiveWriteSnapshot[]) {
    await this.fault.beforeRollback?.({
      snapshotCount: snapshots.length,
      firstSnapshotPath: snapshots[0]?.filePath,
    });

    let reverted = 0;
    const skippedSnapshots: ArchiveWriteSnapshot[] = [];
    for (const snapshot of snapshots.slice().reverse()) {
      try {
        if ((await fs.stat(snapshot.filePath)).size !== snapshot.expectedSize) {
          skippedSnapshots.push(snapshot);
          continue;
        }
        await fs.truncate(snapshot.filePath, snapshot.beforeSize);
        reverted += 1;
      } catch {
        skippedSnapshots.push(snapshot);
      }
    }
    return { reverted, skipped: skippedSnapshots.length, skippedSnapshots };
  }

  async writePendingBestEffort(params: {
    operation: PendingRecord["operation"];
    workspaceId: string;
    sessionId: string;
    runId?: string;
    snapshots: ArchiveWriteSnapshot[];
  }) {
    const snapshots = params.snapshots.map((snapshot) => {
      const fileKey = fileKeyFromPath(
        this.options.dataDir,
        params.workspaceId,
        params.sessionId,
        snapshot.filePath,
      );
      return fileKey &&
        isNonNegativeSafeInt(snapshot.beforeSize) &&
        isNonNegativeSafeInt(snapshot.expectedSize)
        ? {
            fileKey,
            beforeSize: snapshot.beforeSize,
            expectedSize: snapshot.expectedSize,
          }
        : null;
    });
    if (
      snapshots.length === 0 ||
      snapshots.some((snapshot) => snapshot == null)
    )
      return;

    const record: PendingRecord = {
      version: 1,
      operation: params.operation,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      ...(params.runId ? { runId: params.runId } : {}),
      createdAt: nowMs(),
      snapshots: snapshots as PendingRecord["snapshots"],
    };
    const sidecarPath = agentArchivePendingSidecarPath(
      this.options.dataDir,
      params.workspaceId,
      params.sessionId,
    );
    const tmpPath = `${sidecarPath}.${newSortableId("tmp")}.tmp`;

    try {
      await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
      await this.fault.beforePendingSidecarWrite?.({
        operation: params.operation,
        snapshotCount: record.snapshots.length,
      });
      await fs.writeFile(tmpPath, JSON.stringify(record), "utf8");
      await this.fault.beforePendingSidecarRename?.({
        operation: params.operation,
        snapshotCount: record.snapshots.length,
      });
      await fs.rename(tmpPath, sidecarPath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      this.options.logger.warn(
        {
          err,
          operation: params.operation,
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          snapshots: record.snapshots.length,
        },
        "archive pending sidecar write failed",
      );
    }
  }

  async reconcilePendingBestEffort(params: {
    workspaceId: string;
    sessionId: string;
  }) {
    const sidecarPath = agentArchivePendingSidecarPath(
      this.options.dataDir,
      params.workspaceId,
      params.sessionId,
    );
    let raw: string;
    try {
      raw = await fs.readFile(sidecarPath, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return false;
      this.options.logger.warn(
        { err, workspaceId: params.workspaceId, sessionId: params.sessionId },
        "archive pending sidecar read failed",
      );
      return false;
    }

    let record: PendingRecord | null = null;
    try {
      record = parsePendingRecord(JSON.parse(raw));
    } catch {
      record = null;
    }
    if (
      !record ||
      record.workspaceId !== params.workspaceId ||
      record.sessionId !== params.sessionId
    ) {
      this.options.logger.warn(
        { workspaceId: params.workspaceId, sessionId: params.sessionId },
        "archive pending sidecar is invalid",
      );
      return false;
    }
    if (record.snapshots.length !== 1) {
      this.options.logger.warn(
        {
          operation: record.operation,
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          snapshots: record.snapshots.length,
        },
        "archive pending sidecar has multiple snapshots; automatic reconcile skipped",
      );
      return false;
    }

    const targets = record.snapshots.map((snapshot) => ({
      ...snapshot,
      filePath: pathFromFileKey(
        this.options.dataDir,
        params.workspaceId,
        params.sessionId,
        snapshot.fileKey,
      ),
    }));
    if (targets.some((target) => !target.filePath)) {
      this.options.logger.warn(
        {
          operation: record.operation,
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          snapshots: record.snapshots.length,
        },
        "archive pending sidecar has invalid file key",
      );
      return false;
    }

    try {
      const stats = await Promise.all(
        targets.map(async (target) => fs.stat(target.filePath!)),
      );
      if (
        stats.some((stat, index) => stat.size !== targets[index]?.expectedSize)
      ) {
        this.options.logger.warn(
          {
            operation: record.operation,
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            snapshots: targets.length,
          },
          "archive pending sidecar size mismatch",
        );
        return false;
      }
      for (const target of targets) {
        await fs.truncate(target.filePath!, target.beforeSize);
      }
      await fs.rm(sidecarPath, { force: true });
      return true;
    } catch (err) {
      this.options.logger.warn(
        {
          err,
          operation: record.operation,
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          snapshots: targets.length,
        },
        "archive pending sidecar reconcile failed",
      );
      return false;
    }
  }

  async findExcerptByItemIds(params: {
    workspaceId: string;
    sessionId: string;
    itemIds: number[];
  }) {
    const need = new Set<number>(params.itemIds);
    const resolved = new Map<number, { pos: number; line: string }>();
    if (need.size === 0) return [] as Array<{ pos: number; line: string }>;

    const dirPath = agentArchiveSessionDir(
      this.options.dataDir,
      params.workspaceId,
      params.sessionId,
    );
    const files = await listFilesAsc(dirPath);
    outer: for (let index = files.length - 1; index >= 0; index -= 1) {
      const fileName = files[index];
      if (!fileName) continue;
      const fileSeq = parseFileName(fileName);
      if (fileSeq == null) continue;
      const content = await fs
        .readFile(path.join(dirPath, fileName), "utf8")
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
      const lines = splitLines(content);
      for (let lineNo = lines.length; lineNo >= 1; lineNo -= 1) {
        if (resolved.size >= need.size) break outer;
        const line = String(lines[lineNo - 1] || "");
        const itemId = parseArchivedItemId(line);
        if (itemId == null || !need.has(itemId) || resolved.has(itemId))
          continue;
        resolved.set(itemId, { pos: toPos(fileSeq, lineNo), line });
      }
    }

    return params.itemIds
      .map((id) => resolved.get(id) || null)
      .filter((row): row is { pos: number; line: string } => row != null)
      .sort((a, b) => a.pos - b.pos);
  }
}

export const archiveStorageTestSupport = {
  formatFileName,
  parseFileName,
  listFilesAsc,
  splitLines,
  fileKeyFromPath,
  pathFromFileKey,
  parsePendingRecord,
  toPos,
};
