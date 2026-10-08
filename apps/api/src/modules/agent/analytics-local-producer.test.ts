import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalAnalyticsProducer } from "./analytics-local-producer.js";

const waitFor = async (predicate: () => Promise<boolean> | boolean, timeout = 1_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for expected local analytics lifecycle state");
};

async function tempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function installAcceptedFetch(t: test.TestContext, received: unknown[] = []) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    received.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ accepted: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
}

function intentPath(dataDir: string, generation: string) {
  return path.join(dataDir, "analytics", "local-fallback-intents", `${generation}.json`);
}

test("normal close removes the local fallback intent only after all close ACKs", async (t) => {
  const dataDir = await tempDir("awb-local-intent-close-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const received: unknown[] = [];
  installAcceptedFetch(t, received);
  const producer = new LocalAnalyticsProducer({ apiOrigin: "http://local.test", internalToken: "test", dataDir });
  await producer.start();
  await fs.access(intentPath(dataDir, producer.producerGeneration));
  await producer.close();
  await assert.rejects(fs.access(intentPath(dataDir, producer.producerGeneration)));
  assert.equal(received.filter((value) => (value as { kind?: string }).kind === "closing" || (value as { kind?: string }).kind === "closed").length, 4);
});

test("malformed local fallback intent is retained during recovery", async (t) => {
  const dataDir = await tempDir("awb-local-intent-malformed-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const malformed = randomUUID();
  await fs.mkdir(path.dirname(intentPath(dataDir, malformed)), { recursive: true });
  await fs.writeFile(intentPath(dataDir, malformed), "{not-json", "utf8");
  installAcceptedFetch(t);
  const abandoned: string[] = [];
  const producer = new LocalAnalyticsProducer({ apiOrigin: "http://local.test", internalToken: "test", dataDir, abandonPriorGeneration: async ({ producerGeneration }) => { abandoned.push(producerGeneration); return true; } });
  await producer.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(abandoned, []);
  assert.equal(await fs.readFile(intentPath(dataDir, malformed), "utf8"), "{not-json");
  await producer.close();
});

test("repeated unsafe local intent opens do not grow process FD ownership", { skip: process.platform !== "linux" }, async (t) => {
  const dataDir = await tempDir("awb-local-intent-fd-");
  const outside = await tempDir("awb-local-intent-fd-outside-");
  t.after(() => Promise.all([fs.rm(dataDir, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  await fs.mkdir(path.join(dataDir, "analytics"));
  await fs.symlink(outside, path.join(dataDir, "analytics", "local-fallback-intents"));
  installAcceptedFetch(t);
  const before = (await fs.readdir("/proc/self/fd")).length;
  for (let index = 0; index < 100; index += 1) {
    const producer = new LocalAnalyticsProducer({ apiOrigin: "http://local.test", internalToken: "test", dataDir, abandonPriorGeneration: async () => true });
    await producer.start();
    await producer.close();
  }
  const after = (await fs.readdir("/proc/self/fd")).length;
  assert.ok(after <= before + 3, `FD count grew from ${before} to ${after}`);
});

test("crash intent on the same data directory is precisely abandoned and removed on restart", async (t) => {
  const dataDir = await tempDir("awb-local-intent-crash-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const crashed = randomUUID();
  await fs.mkdir(path.dirname(intentPath(dataDir, crashed)), { recursive: true });
  await fs.writeFile(intentPath(dataDir, crashed), JSON.stringify({ version: 1, producerGeneration: crashed, createdAt: Date.now() }) + "\n");
  installAcceptedFetch(t);
  const abandoned: string[] = [];
  const producer = new LocalAnalyticsProducer({ apiOrigin: "http://local.test", internalToken: "test", dataDir, abandonPriorGeneration: async ({ producerGeneration }) => { abandoned.push(producerGeneration); return true; } });
  await producer.start();
  await waitFor(async () => !(await fs.stat(intentPath(dataDir, crashed)).then(() => true).catch(() => false)));
  assert.deepEqual(abandoned, [crashed]);
  await fs.access(intentPath(dataDir, producer.producerGeneration));
  await producer.close();
});

test("rejected prior-generation abandonment is retained, retried, and never becomes an unhandled rejection", async (t) => {
  const dataDir = await tempDir("awb-local-intent-reject-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const prior = randomUUID();
  await fs.mkdir(path.dirname(intentPath(dataDir, prior)), { recursive: true });
  await fs.writeFile(intentPath(dataDir, prior), JSON.stringify({ version: 1, producerGeneration: prior, createdAt: Date.now() }) + "\n");
  installAcceptedFetch(t);
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const producer = new LocalAnalyticsProducer({ apiOrigin: "http://local.test", internalToken: "test", dataDir, abandonPriorGeneration: async () => { throw new Error("supervisor offline"); } });
  await producer.start();
  await new Promise((resolve) => setTimeout(resolve, 35));
  await fs.access(intentPath(dataDir, prior));
  assert.deepEqual(unhandled, []);
  await producer.close();
});

test("a delayed recovery rejection settled after close cannot schedule a retry", async (t) => {
  const dataDir = await tempDir("awb-local-intent-close-race-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const prior = randomUUID();
  await fs.mkdir(path.dirname(intentPath(dataDir, prior)), { recursive: true });
  await fs.writeFile(intentPath(dataDir, prior), JSON.stringify({ version: 1, producerGeneration: prior, createdAt: Date.now() }) + "\n");
  installAcceptedFetch(t);
  let rejectAbandon!: (error: Error) => void;
  let calls = 0;
  const pending = new Promise<boolean>((_resolve, reject) => { rejectAbandon = reject; });
  const producer = new LocalAnalyticsProducer({
    apiOrigin: "http://local.test", internalToken: "test", dataDir,
    abandonPriorGeneration: async () => { calls += 1; return pending; },
  });
  await producer.start();
  await waitFor(() => calls === 1);
  await producer.close();
  rejectAbandon(new Error("late supervisor failure"));
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(calls, 1);
  await fs.access(intentPath(dataDir, prior));
});

test("a new generation never abandons itself when old-generation evidence is recovered", async (t) => {
  const dataDir = await tempDir("awb-local-intent-generation-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const oldGeneration = randomUUID();
  await fs.mkdir(path.dirname(intentPath(dataDir, oldGeneration)), { recursive: true });
  await fs.writeFile(intentPath(dataDir, oldGeneration), JSON.stringify({ version: 1, producerGeneration: oldGeneration, createdAt: Date.now() }) + "\n");
  installAcceptedFetch(t);
  const abandoned: string[] = [];
  const producer = new LocalAnalyticsProducer({ apiOrigin: "http://local.test", internalToken: "test", dataDir, abandonPriorGeneration: async ({ producerGeneration }) => { abandoned.push(producerGeneration); return true; } });
  await producer.start();
  await waitFor(() => abandoned.length === 1);
  assert.deepEqual(abandoned, [oldGeneration]);
  assert.notEqual(producer.producerGeneration, oldGeneration);
  await fs.access(intentPath(dataDir, producer.producerGeneration));
  await producer.close();
});

test("an unsafe local intent directory disables Analytics while local execution emission remains non-blocking", async (t) => {
  const dataDir = await tempDir("awb-local-intent-symlink-");
  const outside = await tempDir("awb-local-intent-outside-");
  t.after(() => Promise.all([fs.rm(dataDir, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  await fs.mkdir(path.join(dataDir, "analytics"), { recursive: true });
  await fs.symlink(outside, path.join(dataDir, "analytics", "local-fallback-intents"));
  const received: unknown[] = [];
  installAcceptedFetch(t, received);
  const producer = new LocalAnalyticsProducer({ apiOrigin: "http://local.test", internalToken: "test", dataDir });
  await producer.start();
  assert.doesNotThrow(() => producer.emitExecution({ executionId: "local-run", runId: "local-run", runKind: "agent", parentRunId: null, runtimeKind: "local", queuedAt: null, startedAt: Date.now(), endedAt: null, endTimeQuality: "unknown", endReason: null }, "execution_started"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(received, []);
  await producer.close();
});
