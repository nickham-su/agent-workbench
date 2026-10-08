import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AnalyticsSignalProducer } from "./analyticsSignals.js";

async function waitForOutbox(dataDir: string) {
  const root = path.join(dataDir, "analytics", "model-outbox");
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const names = await fs.readdir(root, { recursive: true }).catch(() => [] as string[]);
    const file = names.find((name) => name.endsWith(".json"));
    if (file) return path.join(root, file);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("durable model outbox was not written");
}

test("model outbox survives false, throw, hanging, and mismatched Analytics acknowledgements", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-model-outbox-dispatch-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  for (const [name, response] of [
    ["false", async () => new Response(JSON.stringify({ accepted: false, receipt: null }), { status: 200 })],
    ["mismatched", async () => new Response(JSON.stringify({ accepted: true, receipt: { eventId: "wrong", fingerprint: "b".repeat(64) } }), { status: 200 })],
    ["throw", async () => { throw new Error("transport unavailable"); }],
    ["hang", async () => await new Promise<Response>(() => undefined)]
  ] as const) {
    globalThis.fetch = response as typeof fetch;
    await fs.mkdir(path.join(dataDir, name), { mode: 0o700 });
    const producer = new AnalyticsSignalProducer({ apiOrigin: "http://analytics.invalid", internalToken: "test", dataDir: path.join(dataDir, name), namespace: "agent_worker", producerId: "agent_runner" });
    producer.emitModel({ modelCallId: `model-${name}`, executionId: "run", runId: "run", attemptNo: 1, providerId: "provider", modelId: "model", startedAt: 1, endedAt: null, status: "running", completionQuality: "unknown", timeoutKind: null, inputTokens: null, outputTokens: null, totalTokens: null, totalSource: "unavailable", cacheReadTokens: null, cacheWriteTokens: null, cacheComparable: false, cacheWriteVerified: false, failureKind: null }, "model_invoked");
    const file = await waitForOutbox(path.join(dataDir, name));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await fs.stat(file).then(() => true, () => false), true, `${name} acknowledgement must not delete durable event`);
  }
});

test("model-outbox child symlink drops durable Analytics evidence without blocking worker emission or writing outside", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-model-outbox-symlink-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-model-outbox-outside-"));
  t.after(() => Promise.all([fs.rm(dataDir, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  await fs.mkdir(path.join(dataDir, "analytics"));
  await fs.symlink(outside, path.join(dataDir, "analytics", "model-outbox"));
  const producer = new AnalyticsSignalProducer({ apiOrigin: "http://analytics.invalid", internalToken: "test", dataDir, namespace: "agent_worker", producerId: "agent_runner" });
  assert.doesNotThrow(() => producer.emitModel({ modelCallId: "unsafe-model", executionId: "run", runId: "run", attemptNo: 1, providerId: "provider", modelId: "model", startedAt: 1, endedAt: null, status: "running", completionQuality: "unknown", timeoutKind: null, inputTokens: null, outputTokens: null, totalTokens: null, totalSource: "unavailable", cacheReadTokens: null, cacheWriteTokens: null, cacheComparable: false, cacheWriteVerified: false, failureKind: null }, "model_invoked"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(await fs.readdir(outside), []);
});

test("model-outbox generation symlink is rejected without blocking worker emission or writing outside", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-model-generation-symlink-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-model-generation-outside-"));
  t.after(() => Promise.all([fs.rm(dataDir, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  const producer = new AnalyticsSignalProducer({ apiOrigin: "http://analytics.invalid", internalToken: "test", dataDir, namespace: "agent_worker", producerId: "agent_runner" });
  await fs.mkdir(path.join(dataDir, "analytics", "model-outbox", "agent_worker", "agent_runner"), { recursive: true });
  await fs.symlink(outside, path.join(dataDir, "analytics", "model-outbox", "agent_worker", "agent_runner", producer.producerGeneration));
  assert.doesNotThrow(() => producer.emitModel({ modelCallId: "unsafe-generation", executionId: "run", runId: "run", attemptNo: 1, providerId: "provider", modelId: "model", startedAt: 1, endedAt: null, status: "running", completionQuality: "unknown", timeoutKind: null, inputTokens: null, outputTokens: null, totalTokens: null, totalSource: "unavailable", cacheReadTokens: null, cacheWriteTokens: null, cacheComparable: false, cacheWriteVerified: false, failureKind: null }, "model_invoked"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(await fs.readdir(outside), []);
});

test("one hundred model-outbox child symlink failures do not linearly retain FDs", { skip: process.platform !== "linux" }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-model-outbox-fd-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-model-outbox-fd-outside-"));
  t.after(() => Promise.all([fs.rm(dataDir, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  await fs.mkdir(path.join(dataDir, "analytics"));
  await fs.symlink(outside, path.join(dataDir, "analytics", "model-outbox"));
  const emit = (producer: AnalyticsSignalProducer, modelCallId: string) => producer.emitModel({ modelCallId, executionId: "run", runId: "run", attemptNo: 1, providerId: "provider", modelId: "model", startedAt: 1, endedAt: null, status: "running", completionQuality: "unknown", timeoutKind: null, inputTokens: null, outputTokens: null, totalTokens: null, totalSource: "unavailable", cacheReadTokens: null, cacheWriteTokens: null, cacheComparable: false, cacheWriteVerified: false, failureKind: null }, "model_invoked");
  const warmup = new AnalyticsSignalProducer({ apiOrigin: "http://analytics.invalid", internalToken: "test", dataDir, namespace: "agent_worker", producerId: "agent_runner" });
  emit(warmup, "warmup");
  assert.equal(await warmup.waitForIdle(), true, "warmup outbox operation must settle before baseline");
  const before = (await fs.readdir("/proc/self/fd")).length;
  const producers: AnalyticsSignalProducer[] = [];
  for (let index = 0; index < 100; index += 1) {
    const producer = new AnalyticsSignalProducer({ apiOrigin: "http://analytics.invalid", internalToken: "test", dataDir, namespace: "agent_worker", producerId: "agent_runner" });
    producers.push(producer);
    emit(producer, `fd-${index}`);
  }
  assert.equal((await Promise.all(producers.map((producer) => producer.waitForIdle()))).every(Boolean), true, "all 100 persistOutbox operations must settle before measuring FDs");
  const after = (await fs.readdir("/proc/self/fd")).length;
  assert.ok(after <= before + 5, `FD count grew from ${before} to ${after}`);
});

test("model outbox recovery has a single owner and deletes only acknowledged events", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-model-outbox-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const event = { kind: "event", domain: "model", producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: "g1", eventId: "e1", sequence: 1, fingerprint: "a".repeat(64), payloadVersion: 1, eventType: "model_invoked", subjectIdentity: "model:m1", observedAt: 1, payload: { modelCallId: "m1", executionId: "r1", runId: "r1", attemptNo: 1, providerId: "provider", modelId: "model", startedAt: 1, endedAt: null, status: "running", completionQuality: "unknown", timeoutKind: null, inputTokens: null, outputTokens: null, totalTokens: null, totalSource: "unavailable", cacheReadTokens: null, cacheWriteTokens: null, cacheComparable: false, cacheWriteVerified: false, failureKind: null } };
  await fs.writeFile(path.join(dir, "1-e1.json"), JSON.stringify(event));
  await fs.writeFile(path.join(dir, "bad.json"), "not json");
  let calls = 0;
  await Promise.all(Array.from({ length: 2 }, () => AnalyticsSignalProducer.recoverModelOutbox({ directory: dir, dispatch: async () => { calls += 1; return true; } })));
  assert.equal(calls, 1);
  assert.equal(await fs.stat(path.join(dir, "1-e1.json")).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(dir, "bad.json")).then(() => true, () => false), true);
});
