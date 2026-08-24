import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import { ensureDir, rmrf } from "../../../infra/fs/fs.js";
import {
  agentArchivePendingSidecarPath,
  agentArchiveSessionDir,
} from "../../../infra/fs/paths.js";
import {
  ArchiveStorage,
  archiveStorageTestSupport,
} from "./archive-storage.js";
import {
  noArchiveFaultHook,
  type ArchiveFaultHook,
} from "./archive-fault-hook.js";

const dataDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...dataDirs].map(async (dataDir) => {
      dataDirs.delete(dataDir);
      await rmrf(dataDir);
    }),
  );
});

async function createDataDir() {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "archive-storage-"));
  dataDirs.add(dataDir);
  return dataDir;
}

function createStorage(
  dataDir: string,
  logger: ReturnType<typeof createLogger>["logger"],
  faultHook?: ArchiveFaultHook,
) {
  return new ArchiveStorage({ dataDir, logger: logger as any, faultHook });
}

function createLogger() {
  const warnings: Array<{ fields: unknown; message: string }> = [];
  return {
    warnings,
    logger: {
      warn(fields: unknown, message: string) {
        warnings.push({ fields, message });
      },
    },
  };
}

test("P2 Archive storage: append filters filenames, rolls over at 100 lines, and preserves append snapshot order", async () => {
  const dataDir = await createDataDir();
  const workspaceId = "workspace";
  const sessionId = "session";
  const dir = agentArchiveSessionDir(dataDir, workspaceId, sessionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "ignored.log"), "ignored\n");
  await fs.writeFile(path.join(dir, "00000002.log"), "old\n");
  await fs.writeFile(
    path.join(dir, "00000001.log"),
    `${Array.from({ length: 100 }, (_, index) => `old-${index}`).join("\n")}\n`,
  );

  assert.deepEqual(await archiveStorageTestSupport.listFilesAsc(dir), [
    "00000001.log",
    "00000002.log",
  ]);
  const snapshots = await createStorage(
    dataDir,
    createLogger().logger,
  ).appendLines({
    workspaceId,
    sessionId,
    lines: Array.from({ length: 100 }, (_, index) => `next-${index}`),
  });

  assert.deepEqual(
    snapshots.map((snapshot) => path.basename(snapshot.filePath)),
    ["00000002.log", "00000003.log"],
  );
  assert.equal(
    await fs.readFile(path.join(dir, "00000002.log"), "utf8"),
    "old\n" +
      `${Array.from({ length: 99 }, (_, index) => `next-${index}`).join("\n")}\n`,
  );
  assert.equal(
    await fs.readFile(path.join(dir, "00000003.log"), "utf8"),
    "next-99\n",
  );
  assert.equal(snapshots[0]?.beforeSize, Buffer.byteLength("old\n"));
  assert.equal(
    snapshots[0]?.expectedSize,
    Buffer.byteLength(
      await fs.readFile(path.join(dir, "00000002.log"), "utf8"),
    ),
  );
  assert.equal(snapshots[1]?.beforeSize, 0);
});

test("P2 Archive storage: append chunk fault leaves prior chunk written and does not return snapshots", async () => {
  const dataDir = await createDataDir();
  const dir = agentArchiveSessionDir(dataDir, "workspace", "session");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "00000001.log"),
    `${Array.from({ length: 99 }, (_, index) => `old-${index}`).join("\n")}\n`,
  );

  await assert.rejects(
    createStorage(dataDir, createLogger().logger, {
      afterAppendChunk(input) {
        if (input.chunkIndex >= 1) {
          const error = new Error("injected archive write failure");
          (error as Error & { code?: string }).code = "TEST_ARCHIVE_WRITE_FAIL";
          throw error;
        }
      },
    }).appendLines({
      workspaceId: "workspace",
      sessionId: "session",
      lines: ["written-before-failure", "would-be-next-file"],
    }),
    (error: Error & { code?: string }) =>
      error.code === "TEST_ARCHIVE_WRITE_FAIL",
  );
  assert.equal(
    (await fs.readFile(path.join(dir, "00000001.log"), "utf8")).includes(
      "written-before-failure\n",
    ),
    true,
  );
  assert.equal(
    await fs.stat(path.join(dir, "00000002.log")).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test("P2 Archive storage: rollback is reverse-order exact-size only and reports external change as skipped", async () => {
  const dataDir = await createDataDir();
  const workspaceId = "workspace";
  const sessionId = "session";
  const snapshots = await createStorage(
    dataDir,
    createLogger().logger,
  ).appendLines({
    workspaceId,
    sessionId,
    lines: Array.from({ length: 101 }, (_, index) => `line-${index}`),
  });
  assert.equal(snapshots.length, 2);

  const reverted = await createStorage(
    dataDir,
    createLogger().logger,
  ).rollbackBestEffort(snapshots);
  assert.deepEqual(
    { reverted: reverted.reverted, skipped: reverted.skipped },
    { reverted: 2, skipped: 0 },
  );
  const dir = agentArchiveSessionDir(dataDir, workspaceId, sessionId);
  assert.equal(await fs.readFile(path.join(dir, "00000001.log"), "utf8"), "");
  assert.equal(await fs.readFile(path.join(dir, "00000002.log"), "utf8"), "");

  const mismatchSnapshots = await createStorage(
    dataDir,
    createLogger().logger,
  ).appendLines({ workspaceId, sessionId, lines: ["kept"] });
  await fs.appendFile(mismatchSnapshots[0]!.filePath, "external\n");
  const skipped = await createStorage(
    dataDir,
    createLogger().logger,
  ).rollbackBestEffort(mismatchSnapshots);
  assert.deepEqual(
    { reverted: skipped.reverted, skipped: skipped.skipped },
    { reverted: 0, skipped: 1 },
  );
  assert.equal(
    (await fs.readFile(mismatchSnapshots[0]!.filePath, "utf8")).includes(
      "external\n",
    ),
    true,
  );
});

test("P2 Archive storage: pending sidecar only reconciles an exact-size single snapshot", async () => {
  const dataDir = await createDataDir();
  const workspaceId = "workspace";
  const sessionId = "session";
  const log = createLogger();
  const snapshots = await createStorage(
    dataDir,
    createLogger().logger,
  ).appendLines({ workspaceId, sessionId, lines: ["recover-me"] });
  await createStorage(dataDir, log.logger).writePendingBestEffort({
    workspaceId,
    sessionId,
    operation: "clear",
    snapshots,
  });
  const sidecarPath = agentArchivePendingSidecarPath(
    dataDir,
    workspaceId,
    sessionId,
  );
  assert.equal(
    (
      JSON.parse(await fs.readFile(sidecarPath, "utf8")) as {
        operation: string;
      }
    ).operation,
    "clear",
  );
  assert.equal(
    await createStorage(dataDir, log.logger).reconcilePendingBestEffort({
      workspaceId,
      sessionId,
    }),
    true,
  );
  assert.equal(await fs.readFile(snapshots[0]!.filePath, "utf8"), "");
  assert.equal(
    await fs.stat(sidecarPath).then(
      () => true,
      () => false,
    ),
    false,
  );

  const multi = await createStorage(dataDir, createLogger().logger).appendLines(
    {
      workspaceId,
      sessionId,
      lines: Array.from({ length: 101 }, (_, index) => `multi-${index}`),
    },
  );
  await createStorage(dataDir, log.logger).writePendingBestEffort({
    workspaceId,
    sessionId,
    operation: "compaction",
    snapshots: multi,
  });
  assert.equal(
    await createStorage(dataDir, log.logger).reconcilePendingBestEffort({
      workspaceId,
      sessionId,
    }),
    false,
  );
  assert.equal(
    await fs.stat(sidecarPath).then(
      () => true,
      () => false,
    ),
    true,
  );
  assert.equal(
    log.warnings.some((warning) =>
      warning.message.includes("multiple snapshots"),
    ),
    true,
  );
});

test("P2 Archive storage: invalid sidecar file key is retained and warned instead of escaping the session root", async () => {
  const dataDir = await createDataDir();
  const workspaceId = "workspace";
  const sessionId = "session";
  const log = createLogger();
  const sidecarPath = agentArchivePendingSidecarPath(
    dataDir,
    workspaceId,
    sessionId,
  );
  await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
  await fs.writeFile(
    sidecarPath,
    JSON.stringify({
      version: 1,
      operation: "clear",
      workspaceId,
      sessionId,
      createdAt: 1,
      snapshots: [
        {
          fileKey: "../../outside/00000001.log",
          beforeSize: 0,
          expectedSize: 1,
        },
      ],
    }),
  );

  assert.equal(
    await createStorage(dataDir, log.logger).reconcilePendingBestEffort({
      workspaceId,
      sessionId,
    }),
    false,
  );
  assert.equal(
    await fs.stat(sidecarPath).then(
      () => true,
      () => false,
    ),
    true,
  );
  assert.equal(
    log.warnings.some((warning) =>
      warning.message.includes("invalid file key"),
    ),
    true,
  );
});

test("P2 Archive storage: sidecar write and rename faults clean temporary files", async () => {
  for (const fault of [{ failWrite: true }, { failRename: true }]) {
    const dataDir = await createDataDir();
    const workspaceId = "workspace";
    const sessionId = `session-${fault.failWrite ? "write" : "rename"}`;
    const log = createLogger();
    const snapshots = await createStorage(
      dataDir,
      createLogger().logger,
    ).appendLines({ workspaceId, sessionId, lines: ["sidecar-fault"] });
    await createStorage(dataDir, log.logger, {
      beforePendingSidecarWrite() {
        if (fault.failWrite)
          throw new Error("injected archive pending sidecar write failure");
      },
      beforePendingSidecarRename() {
        if (fault.failRename)
          throw new Error("injected archive pending sidecar rename failure");
      },
    }).writePendingBestEffort({
      workspaceId,
      sessionId,
      operation: "compaction",
      snapshots,
    });
    const dir = agentArchiveSessionDir(dataDir, workspaceId, sessionId);
    assert.equal(
      await fs
        .stat(agentArchivePendingSidecarPath(dataDir, workspaceId, sessionId))
        .then(
          () => true,
          () => false,
        ),
      false,
    );
    assert.equal(
      (await fs.readdir(dir)).some(
        (name) =>
          name.startsWith(".pending-reconcile.json.") && name.endsWith(".tmp"),
      ),
      false,
    );
    assert.equal(log.warnings.length, 1);
  }
});

test("P2 Archive storage: split and excerpt preserve half-line filtering and pos calculation", async () => {
  const dataDir = await createDataDir();
  const workspaceId = "workspace";
  const sessionId = "session";
  const dir = agentArchiveSessionDir(dataDir, workspaceId, sessionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "00000001.log"),
    "item=10 | first\nitem=11 | partial",
  );
  assert.deepEqual(archiveStorageTestSupport.splitLines("first\npartial"), [
    "first",
  ]);
  assert.equal(archiveStorageTestSupport.toPos(2, 1), 101);
  assert.deepEqual(
    await createStorage(dataDir, createLogger().logger).findExcerptByItemIds({
      workspaceId,
      sessionId,
      itemIds: [10, 11],
    }),
    [{ pos: 1, line: "item=10 | first" }],
  );
});

test("P2 Archive fault hook vocabulary has a no-op and metadata-only fake surface", async () => {
  assert.deepEqual(noArchiveFaultHook, {});
  const calls: unknown[] = [];
  const hook: ArchiveFaultHook = {
    async afterAppendChunk(input) {
      calls.push(input);
    },
    async beforeRollback(input) {
      calls.push(input);
    },
  };
  await hook.afterAppendChunk?.({
    operation: "compaction",
    chunkIndex: 1,
    snapshotCount: 2,
  });
  await hook.beforeRollback?.({ snapshotCount: 2 });
  assert.deepEqual(calls, [
    { operation: "compaction", chunkIndex: 1, snapshotCount: 2 },
    { snapshotCount: 2 },
  ]);
});
