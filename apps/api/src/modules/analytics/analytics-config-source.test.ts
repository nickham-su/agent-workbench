import assert from "node:assert/strict";
import { access, mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { analyticsConfigSourcePath } from "../../infra/fs/paths.js";
import {
  allocateAnalyticsConfigSource,
  readAnalyticsConfigSource,
  readAnalyticsConfigSourceForTest,
} from "./analytics-config-source.js";

const workerSlots = [
  { domain: "worker" as const, producerNamespace: "worker_observer" as const, producerId: "process_manager" },
  { domain: "execution" as const, producerNamespace: "agent_worker" as const, producerId: "agent_runner" },
  { domain: "model" as const, producerNamespace: "agent_worker" as const, producerId: "agent_runner" },
];
const domains = ["run", "session", "message", "tool", "execution", "model", "worker", "git"] as const;

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "awb-analytics-config-source-"));
  return { dataDir };
}

test("config source rejects an Analytics-root symlink without writing outside", async (t) => {
  const { dataDir } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "awb-config-source-outside-"));
  t.after(() => Promise.all([rm(dataDir, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await symlink(outside, path.join(dataDir, "analytics"));
  assert.equal(await allocateAnalyticsConfigSource(dataDir, { enabledFactDomains: [...domains], slots: workerSlots }, 1), null);
  assert.equal(await readAnalyticsConfigSource(dataDir), null);
  assert.deepEqual(await readdir(outside), []);
});

test("API config source persists stable versions across restart, same-ms updates, and clock rollback", async (t) => {
  const { dataDir } = await fixture();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = await allocateAnalyticsConfigSource(dataDir, { enabledFactDomains: [...domains], slots: workerSlots }, 100);
  assert.deepEqual(first && { version: first.sourceConfigVersion, effectiveAt: first.effectiveAt }, { version: 1, effectiveAt: 100 });
  const replay = await allocateAnalyticsConfigSource(dataDir, { enabledFactDomains: [...domains].reverse(), slots: [...workerSlots].reverse() }, 99);
  assert.deepEqual(replay && { version: replay.sourceConfigVersion, effectiveAt: replay.effectiveAt }, { version: 1, effectiveAt: 100 });
  const second = await allocateAnalyticsConfigSource(dataDir, { enabledFactDomains: ["execution", "model"], slots: workerSlots.slice(1) }, 100);
  assert.deepEqual(second && { version: second.sourceConfigVersion, effectiveAt: second.effectiveAt }, { version: 2, effectiveAt: 100 });
  const third = await allocateAnalyticsConfigSource(dataDir, { enabledFactDomains: ["execution"], slots: workerSlots }, 1);
  assert.deepEqual(third && { version: third.sourceConfigVersion, effectiveAt: third.effectiveAt }, { version: 3, effectiveAt: 100 });
  const stored = await readAnalyticsConfigSourceForTest(dataDir);
  assert.deepEqual(stored && { version: stored.sourceVersion, effectiveAt: stored.effectiveAt }, { version: 3, effectiveAt: 100 });
  const replayable = await readAnalyticsConfigSource(dataDir);
  assert.deepEqual(replayable && { version: replayable.sourceConfigVersion, effectiveAt: replayable.effectiveAt }, { version: 3, effectiveAt: 100 });
  const mode = (await stat(analyticsConfigSourcePath(dataDir))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("concurrent API allocations serialize distinct source content without lock files", async (t) => {
  const { dataDir } = await fixture();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const [first, second] = await Promise.all([
    allocateAnalyticsConfigSource(dataDir, { enabledFactDomains: [...domains], slots: workerSlots }, 100),
    allocateAnalyticsConfigSource(dataDir, { enabledFactDomains: ["execution", "model"], slots: workerSlots.slice(1) }, 100),
  ]);
  assert.deepEqual(first && { version: first.sourceConfigVersion, effectiveAt: first.effectiveAt }, { version: 1, effectiveAt: 100 });
  assert.deepEqual(second && { version: second.sourceConfigVersion, effectiveAt: second.effectiveAt }, { version: 2, effectiveAt: 100 });
  const persisted = await readAnalyticsConfigSourceForTest(dataDir);
  assert.deepEqual(persisted && { sourceVersion: persisted.sourceVersion, effectiveAt: persisted.effectiveAt }, { sourceVersion: 2, effectiveAt: 100 });
  assert.match(persisted?.canonicalHash ?? "", /^[0-9a-f]{64}$/);
  await assert.rejects(() => access(`${analyticsConfigSourcePath(dataDir)}.lock`));
});

test("legacy crash lock files do not block allocation and are removed", async (t) => {
  const { dataDir } = await fixture();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const lockPath = `${analyticsConfigSourcePath(dataDir)}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, "stale");
  assert.equal((await allocateAnalyticsConfigSource(dataDir, { enabledFactDomains: [...domains], slots: workerSlots }, 10))?.sourceConfigVersion, 1);
  await assert.rejects(() => access(lockPath));
});

test("unreadable or corrupt API config source fails Analytics configuration without widening permissions", async (t) => {
  const { dataDir } = await fixture();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const initial = await allocateAnalyticsConfigSource(dataDir, { enabledFactDomains: [...domains], slots: workerSlots }, 10);
  assert.ok(initial);
  await writeFile(analyticsConfigSourcePath(dataDir), "{not-json", { mode: 0o600 });
  // A corrupt durable source is not overwritten, because doing so could reuse
  // a source version after a crash. The caller safely skips Analytics config.
  assert.equal(await allocateAnalyticsConfigSource(dataDir, { enabledFactDomains: ["execution"], slots: workerSlots.slice(1, 2) }, 20), null);
});

test("source publication I/O failures remain Analytics-only", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awb-analytics-config-source-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notADirectory = path.join(root, "data-file");
  await writeFile(notADirectory, "not a directory");
  assert.equal(
    await allocateAnalyticsConfigSource(notADirectory, { enabledFactDomains: [...domains], slots: workerSlots }, 1),
    null,
  );
});
