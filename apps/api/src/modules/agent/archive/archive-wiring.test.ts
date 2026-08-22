import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { noArchiveFaultHook } from "./archive-fault-hook.js";
import { ArchiveStorage } from "./archive-storage.js";
import { SqliteCompactionArchivePersistence } from "./sqlite-compaction-archive-persistence.js";

test("P2 Archive wiring: extracted storage, persistence, and no-op hook have explicit boundaries", () => {
  assert.deepEqual(Object.keys(noArchiveFaultHook), []);
  assert.equal(typeof ArchiveStorage, "function");
  assert.equal(typeof SqliteCompactionArchivePersistence, "function");
});

test("P2 Archive wiring: only composition root maps legacy faults into extracted adapters", async () => {
  const [contextSource, moduleSource, serviceSource] = await Promise.all([
    fs.readFile(new URL("../../../app/context.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../agent.module.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../agent.service.ts", import.meta.url), "utf8")
  ]);
  assert.match(contextSource, /export type AgentTestFaults/);
  assert.match(contextSource, /archiveWrite\?:/);
  assert.match(contextSource, /archiveRollback\?:/);
  assert.match(contextSource, /archiveSidecar\?:/);
  assert.match(moduleSource, /archiveFaultHookFromLegacyTestFaults\(ctx\.agentTestFaults\)/);
  assert.match(moduleSource, /new ArchiveStorage\(/);
  assert.match(moduleSource, /new SqliteCompactionArchivePersistence\(ctx\.db\)/);
  assert.match(serviceSource, /private readonly archiveStorage: ArchiveStorage/);
  assert.match(serviceSource, /private readonly compactionArchivePersistence: SqliteCompactionArchivePersistence/);
  assert.doesNotMatch(serviceSource, /agentTestFaults\?\.archive/);
  assert.doesNotMatch(serviceSource, /__archiveTestSupport/);
});
