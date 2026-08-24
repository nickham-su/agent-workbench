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

test("P2/P4 Archive wiring: composition root maps legacy faults into extracted adapters", async () => {
  const [contextSource, compositionSource, moduleSource, serviceSource] = await Promise.all([
    fs.readFile(new URL("../../../app/context.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../agent.composition.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../agent.module.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../agent.service.ts", import.meta.url), "utf8")
  ]);
  assert.match(contextSource, /export type AgentTestFaults/);
  assert.match(contextSource, /archiveWrite\?:/);
  assert.match(contextSource, /archiveRollback\?:/);
  assert.match(contextSource, /archiveSidecar\?:/);
  assert.match(compositionSource, /archiveFaultHookFromLegacyTestFaults\(ctx\.agentTestFaults\)/);
  assert.match(compositionSource, /new ArchiveStorage\(/);
  assert.match(compositionSource, /new SqliteCompactionArchivePersistence\(ctx\.db\)/);
  assert.doesNotMatch(moduleSource, /archiveFaultHookFromLegacyTestFaults/);
  assert.doesNotMatch(serviceSource, /archiveStorage/);
  assert.doesNotMatch(serviceSource, /compactionArchivePersistence/);
  assert.doesNotMatch(serviceSource, /agentTestFaults\?\.archive/);
  assert.doesNotMatch(serviceSource, /__archiveTestSupport/);
});
