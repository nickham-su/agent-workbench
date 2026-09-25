import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentWorkerProcessManager, buildAgentWorkerSpawnEnv, completeAgentWorkerReady } from "./agent.worker-manager.js";
import { AgentStartupCoordinator } from "./startup/agent-startup-coordinator.js";
import { analyticsModelOutboxRoot } from "../../infra/fs/paths.js";
import { closeAnalyticsDb, openAnalyticsDb } from "../analytics/analytics-db.js";
import { acceptAnalyticsSignal, diagnoseOutboxCorrupt } from "../analytics/signal-store.js";

const waitFor = async (predicate: () => boolean, timeoutMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(predicate(), true, "condition did not become true before timeout");
};

async function createLoopbackServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server has no TCP address");
  return {
    apiOrigin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function writeModelOutboxEvent(directory: string, generation: string, sequence: number, eventId = `event-${sequence}`) {
  await fs.writeFile(path.join(directory, `${sequence}-event.json`), JSON.stringify({
    kind: "event", domain: "model", producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: generation,
    eventId, sequence, fingerprint: "a".repeat(64), payloadVersion: 1, eventType: "model_invoked", subjectIdentity: `model:${sequence}`, observedAt: 1,
    payload: { modelCallId: `model-${sequence}`, executionId: "run", runId: "run", attemptNo: 1, providerId: "provider", modelId: "model", startedAt: 1, endedAt: null, status: "running", completionQuality: "unknown", timeoutKind: null, inputTokens: null, outputTokens: null, totalTokens: null, totalSource: "unavailable", cacheReadTokens: null, cacheWriteTokens: null, cacheComparable: false, cacheWriteVerified: false, failureKind: null }
  }));
}

function createFakeWorkerChild() {
  const child = new EventEmitter() as EventEmitter & { unref(): void; kill(): boolean; stdout?: null; stderr?: null };
  child.unref = () => undefined;
  child.kill = () => { queueMicrotask(() => child.emit("exit", 0, null)); return true; };
  return child;
}

test("normalized AppContext response validation is explicitly propagated to worker spawn env", () => {
  const env = buildAgentWorkerSpawnEnv(
    {
      parentEnv: { AWB_DATA_DIR: "/wrong-data", AWB_INTERNAL_RPC_RESPONSE_VALIDATION: "invalid", OTHER: "keep" },
      dataDir: "/resolved/api-data",
      workerHost: "127.0.0.1",
      workerPort: 4312,
      socketPath: "worker.sock",
      workerConcurrency: 2,
      apiOrigin: "http://api",
      internalToken: "TOKEN",
      responseValidation: "warn",
      pidFilePath: "worker.pid",
      repoRoot: "/repo"
    }
  );

  assert.equal(env.AWB_INTERNAL_RPC_RESPONSE_VALIDATION, "warn");
  assert.equal(env.OTHER, "keep");
  assert.equal(env.AWB_DATA_DIR, "/resolved/api-data");
});

test("Worker onReady 失败时不重置 restart backoff，成功后才重置", async () => {
  let resets = 0;
  await assert.rejects(
    completeAgentWorkerReady({
      generation: 3,
      onReady: async () => { throw new Error("recovery failed"); },
      resetRestartState: () => { resets += 1; },
    }),
    /recovery failed/,
  );
  assert.equal(resets, 0);

  await completeAgentWorkerReady({
    generation: 4,
    onReady: async () => undefined,
    resetRestartState: () => { resets += 1; },
  });
  assert.equal(resets, 1);
});

test("runtime ready recovery is coalesced across initial ready and replacement Worker generation", async () => {
  let entered = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new AgentStartupCoordinator({
    cleanupOrphans: () => undefined,
    cleanupAttachmentTemps: () => undefined,
    recoverRuns: async () => {
      entered += 1;
      await blocked;
    },
    logger: { warn: () => undefined },
  });
  const runtime = { enqueueRun: () => undefined, cancelSession: () => undefined };
  const first = coordinator.recoverWhenRuntimeReady(runtime);
  const second = coordinator.recoverWhenRuntimeReady(runtime);
  await Promise.resolve();
  assert.equal(entered, 1);
  release();
  await Promise.all([first, second]);
  await coordinator.recoverWhenRuntimeReady(runtime);
  assert.equal(entered, 2);
});

test("hung Analytics outbox recovery is bounded and cannot block Worker startup", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-worker-manager-hung-analytics-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const generation = "hung-generation";
  const directory = path.join(analyticsModelOutboxRoot(dataDir), "agent_worker", "agent_runner", generation);
  await fs.mkdir(directory, { recursive: true });
  for (const sequence of [1, 2, 3]) await fs.writeFile(path.join(directory, `${sequence}-event.json`), JSON.stringify({
    kind: "event", domain: "model", producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: generation,
    eventId: `hung-event-${sequence}`, sequence, fingerprint: "a".repeat(64), payloadVersion: 1, eventType: "model_invoked", subjectIdentity: `model:hung-${sequence}`, observedAt: 1,
    payload: { modelCallId: "hung", executionId: "run", runId: "run", attemptNo: 1, providerId: "provider", modelId: "model", startedAt: 1, endedAt: null, status: "running", completionQuality: "unknown", timeoutKind: null, inputTokens: null, outputTokens: null, totalTokens: null, totalSource: "unavailable", cacheReadTokens: null, cacheWriteTokens: null, cacheComparable: false, cacheWriteVerified: false, failureKind: null }
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => await new Promise<unknown>(() => undefined) }) as Response) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const child = new EventEmitter() as EventEmitter & { unref(): void; kill(): boolean; stdout?: null; stderr?: null };
  child.unref = () => undefined;
  child.kill = () => { queueMicrotask(() => child.emit("exit", 0, null)); return true; };
  let spawns = 0;
  const manager = new AgentWorkerProcessManager({
    repoRoot: process.cwd(), dataDir, workerHost: "127.0.0.1", workerPort: 1, socketPath: "", workerConcurrency: 1,
    apiOrigin: "http://analytics.invalid", internalToken: "test", responseValidation: "strict", pidFilePath: path.join(dataDir, "worker.pid"),
    logger: { info() {}, warn() {}, error() {} } as any,
    spawnWorker: (() => { spawns += 1; return child as any; }) as any,
    waitForWorkerReady: async () => undefined
  });
  const startedAt = Date.now();
  await manager.start();
  assert.equal(Date.now() - startedAt < 1_400, true, "three hanging files must share one recovery budget");
  assert.equal(spawns, 1);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort(), ["1-event.json", "2-event.json", "3-event.json"]);
  await manager.stop();
  // The recovery lock is released after the bounded round, allowing another owner to retry later.
  assert.equal(await fs.stat(path.join(directory, ".recovery.lock")).then(() => true, () => false), false);
});

test("ProcessManager waits for startup recovery, diagnoses corrupt terminal outbox, preserves it, and emits observed snapshots", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-worker-manager-analytics-"));
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const db = await openAnalyticsDb(dataDir, 10);
  t.after(() => closeAnalyticsDb(db));

  const generation = "terminal-corrupt-generation";
  assert.equal(acceptAnalyticsSignal(db, {
    kind: "expected_slots_config", sentAt: 10, requestId: "enable-model-fixture", sourceConfigVersion: 1, effectiveAt: 10,
    enabledFactDomains: ["run", "session", "message", "tool", "execution", "model", "worker"],
    slots: [
      { domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager" },
      { domain: "execution", producerNamespace: "agent_worker", producerId: "agent_runner" },
      { domain: "model", producerNamespace: "agent_worker", producerId: "agent_runner" },
    ],
  }, 10).accepted, true);
  const register = {
    kind: "register" as const, domain: "model" as const, producerNamespace: "agent_worker" as const,
    producerId: "agent_runner", producerGeneration: generation, sentAt: 10, controlSequence: 1,
    finalSequence: null, committedSequence: 0, maxObservedAt: null, earliestOpenStartedAt: null,
    openExecutionCount: 0, openModelCount: 0, knownDrop: false, droppedSinceSequence: null,
    outboxPending: 0, oldestPendingAt: null, lossEpoch: 0,
  };
  assert.equal(acceptAnalyticsSignal(db, register, 10).accepted, true);
  const checkpoint = {
    ...register,
    kind: "checkpoint" as const,
    sentAt: 12,
    controlSequence: 2,
    maxObservedAt: 12,
  };
  assert.equal(acceptAnalyticsSignal(db, checkpoint, 12).accepted, true);
  assert.deepEqual(
    db.prepare("SELECT collection_started_at, reconciled_through FROM analytics_domain_state WHERE domain='model'").get(),
    { collection_started_at: 10, reconciled_through: 12 },
  );
  const closed = {
    ...checkpoint,
    kind: "closed" as const,
    sentAt: 13,
    controlSequence: 3,
    finalSequence: 0,
  };
  assert.equal(acceptAnalyticsSignal(db, closed, 13).accepted, true);
  assert.deepEqual(
    db.prepare("SELECT lifecycle FROM analytics_producer_generation WHERE domain='model' AND producer_generation=?").get(generation),
    { lifecycle: "closed" },
  );

  const outboxDir = path.join(analyticsModelOutboxRoot(dataDir), "agent_worker", "agent_runner", generation);
  await fs.mkdir(outboxDir, { recursive: true });
  const corruptFile = path.join(outboxDir, "corrupt.json");
  await fs.writeFile(corruptFile, "not json");

  let releaseDiagnostic!: () => void;
  const diagnosticBlocked = new Promise<void>((resolve) => { releaseDiagnostic = resolve; });
  let diagnosticEntered = false;
  const diagnosticGenerations: string[] = [];
  let spawnCount = 0;
  const dispatched: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/_internal/analytics-snapshot")) {
      return new Response(JSON.stringify({ snapshotAt: 50, activeCount: 1, queueLength: 2, concurrency: 3, runnerMode: "agent_worker" }), { status: 200 });
    }
    if (init?.body) dispatched.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ accepted: true, receipt: null }), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const fakeChild = new EventEmitter() as EventEmitter & { unref(): void; kill(signal?: NodeJS.Signals): boolean; stdout?: null; stderr?: null };
  fakeChild.unref = () => undefined;
  fakeChild.kill = () => { queueMicrotask(() => fakeChild.emit("exit", 0, null)); return true; };
  const manager = new AgentWorkerProcessManager({
    repoRoot: process.cwd(), dataDir, workerHost: "127.0.0.1", workerPort: 1, socketPath: "", workerConcurrency: 3,
    apiOrigin: "http://api.test", internalToken: "token", responseValidation: "strict", pidFilePath: path.join(dataDir, "worker.pid"),
    logger: { info() {}, warn() {}, error() {} } as any,
    spawnWorker: (() => { spawnCount += 1; return fakeChild as any; }) as any,
    waitForWorkerReady: async () => undefined,
    diagnoseOutboxCorrupt: async (input) => {
      diagnosticEntered = true;
      diagnosticGenerations.push(input.producerGeneration);
      await diagnosticBlocked;
      return diagnoseOutboxCorrupt(db, { producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: input.producerGeneration, recordedAt: 20 });
    },
  });

  const starting = manager.start();
  await waitFor(() => diagnosticEntered);
  assert.equal(spawnCount, 0, "startup must not spawn before recovery diagnostics finish");
  releaseDiagnostic();
  await starting;
  assert.equal(spawnCount, 1);
  assert.deepEqual(diagnosticGenerations, [generation]);
  assert.equal(await fs.stat(corruptFile).then(() => true, () => false), true, "corrupt durable evidence must be retained");
  assert.equal((db.prepare("SELECT cause FROM analytics_signal_coverage_gap WHERE producer_generation=?").get(generation) as { cause: string }).cause, "outbox_corrupt");

  await waitFor(() => dispatched.some((signal) => signal.eventType === "worker_snapshot"));
  const snapshot = dispatched.find((signal) => signal.eventType === "worker_snapshot")!;
  assert.deepEqual(snapshot.payload, { snapshotAt: 50, activeCount: 1, queueLength: 2, concurrency: 3, runnerMode: "agent_worker", lastReadyAt: (snapshot.payload as Record<string, unknown>).lastReadyAt });
  await manager.stop();
});

test("real loopback delayed ACK body within the shared recovery budget deletes only the exact outbox event", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-worker-manager-delayed-body-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const generation = "delayed-body-generation";
  const directory = path.join(analyticsModelOutboxRoot(dataDir), "agent_worker", "agent_runner", generation);
  await fs.mkdir(directory, { recursive: true });
  await writeModelOutboxEvent(directory, generation, 1, "delayed-ack-event");
  let sentHeaders = false;
  let sentBody = false;
  const loopback = await createLoopbackServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const signal = JSON.parse(raw) as { eventId?: string };
      if (signal.eventId !== "delayed-ack-event") {
        response.end(JSON.stringify({ accepted: false, receipt: null }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      sentHeaders = true;
      setTimeout(() => {
        sentBody = true;
        response.end(JSON.stringify({ accepted: true, receipt: { eventId: "delayed-ack-event", fingerprint: "a".repeat(64) } }));
      }, 50);
    });
  });
  t.after(() => loopback.close());
  const child = createFakeWorkerChild();
  let spawns = 0;
  const manager = new AgentWorkerProcessManager({
    repoRoot: process.cwd(), dataDir, workerHost: "127.0.0.1", workerPort: 1, socketPath: "", workerConcurrency: 1,
    apiOrigin: loopback.apiOrigin, internalToken: "test", responseValidation: "strict", pidFilePath: path.join(dataDir, "worker.pid"),
    logger: { info() {}, warn() {}, error() {} } as any,
    spawnWorker: (() => { spawns += 1; return child as any; }) as any,
    waitForWorkerReady: async () => undefined
  });

  await manager.start();
  assert.equal(sentHeaders, true);
  assert.equal(sentBody, true, "response body must finish before its recovery controller is released");
  assert.equal(await fs.stat(path.join(directory, "1-event.json")).then(() => true, () => false), false);
  assert.equal(spawns, 1);
  await manager.stop();
});

test("real loopback headers without a response body exhaust the shared budget, retain evidence, and release the recovery lock", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-worker-manager-never-body-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const generation = "never-body-generation";
  const directory = path.join(analyticsModelOutboxRoot(dataDir), "agent_worker", "agent_runner", generation);
  await fs.mkdir(directory, { recursive: true });
  await writeModelOutboxEvent(directory, generation, 1, "never-body-event");
  let sentHeaders = false;
  const loopback = await createLoopbackServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const signal = JSON.parse(raw) as { eventId?: string };
      if (signal.eventId !== "never-body-event") {
        response.end(JSON.stringify({ accepted: false, receipt: null }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      sentHeaders = true;
      // Deliberately leave the body open. The manager must abort this exact
      // fetch/body operation at the single recovery deadline.
    });
  });
  t.after(() => loopback.close());
  const child = createFakeWorkerChild();
  let spawns = 0;
  const manager = new AgentWorkerProcessManager({
    repoRoot: process.cwd(), dataDir, workerHost: "127.0.0.1", workerPort: 1, socketPath: "", workerConcurrency: 1,
    apiOrigin: loopback.apiOrigin, internalToken: "test", responseValidation: "strict", pidFilePath: path.join(dataDir, "worker.pid"),
    logger: { info() {}, warn() {}, error() {} } as any,
    spawnWorker: (() => { spawns += 1; return child as any; }) as any,
    waitForWorkerReady: async () => undefined
  });

  const startedAt = Date.now();
  await manager.start();
  assert.equal(Date.now() - startedAt >= 500, true, "headers alone must remain in-flight until the recovery deadline");
  assert.equal(sentHeaders, true);
  assert.equal(await fs.stat(path.join(directory, "1-event.json")).then(() => true, () => false), true);
  assert.equal(await fs.stat(path.join(directory, ".recovery.lock")).then(() => true, () => false), false);
  assert.equal(spawns, 1);
  await manager.stop();
});

test("multiple corrupt or legacy outbox diagnostics share one recovery deadline and cannot delay Worker spawn", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-worker-manager-hung-diagnostic-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const generation = "hung-diagnostic-generation";
  const directory = path.join(analyticsModelOutboxRoot(dataDir), "agent_worker", "agent_runner", generation);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "1-legacy.json"), JSON.stringify({ kind: "event", domain: "model", eventType: "model_started", producerGeneration: generation }));
  await fs.writeFile(path.join(directory, "2-corrupt.json"), "not json");
  await fs.writeFile(path.join(directory, "3-corrupt.json"), "still not json");
  let diagnosticCalls = 0;
  const child = createFakeWorkerChild();
  let spawns = 0;
  const manager = new AgentWorkerProcessManager({
    repoRoot: process.cwd(), dataDir, workerHost: "127.0.0.1", workerPort: 1, socketPath: "", workerConcurrency: 1,
    apiOrigin: "http://analytics.invalid", internalToken: "test", responseValidation: "strict", pidFilePath: path.join(dataDir, "worker.pid"),
    logger: { info() {}, warn() {}, error() {} } as any,
    spawnWorker: (() => { spawns += 1; return child as any; }) as any,
    waitForWorkerReady: async () => undefined,
    diagnoseOutboxCorrupt: async () => {
      diagnosticCalls += 1;
      return await new Promise<boolean>(() => undefined);
    }
  });

  const startedAt = Date.now();
  await manager.start();
  assert.equal(Date.now() - startedAt >= 500, true, "the hanging diagnostic must consume the shared recovery budget");
  assert.equal(diagnosticCalls, 1, "budget exhaustion must stop before another corrupt or legacy diagnostic");
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort(), ["1-legacy.json", "2-corrupt.json", "3-corrupt.json"]);
  assert.equal(await fs.stat(path.join(directory, ".recovery.lock")).then(() => true, () => false), false);
  assert.equal(spawns, 1);
  await manager.stop();
});

function lifecycleManager(dataDir: string, apiOrigin: string) {
  return new AgentWorkerProcessManager({
    repoRoot: process.cwd(), dataDir, workerHost: "127.0.0.1", workerPort: 1, socketPath: "", workerConcurrency: 1,
    apiOrigin, internalToken: "test", responseValidation: "strict", pidFilePath: path.join(dataDir, "worker.pid"),
    logger: { info() {}, warn() {}, error() {} } as any,
    spawnWorker: (() => createFakeWorkerChild()) as any,
    waitForWorkerReady: async () => undefined,
  });
}

test("lifecycle-intents child symlink never blocks manager start or stop and never writes outside", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-lifecycle-symlink-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-lifecycle-outside-"));
  t.after(() => Promise.all([fs.rm(dataDir, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  await fs.mkdir(path.join(dataDir, "analytics"));
  await fs.symlink(outside, path.join(dataDir, "analytics", "lifecycle-intents"));
  const server = await createLoopbackServer((_request, response) => {
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ accepted: true }));
  });
  t.after(() => server.close());
  const manager = lifecycleManager(dataDir, server.apiOrigin) as any;
  await manager.start();
  await manager.persistAndDispatchWorkerLifecycle("controlled_stop", {
    occurredAt: 1, targetIdentityQuality: "unknown", targets: [],
  });
  await manager.stop();
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(manager.stopping, true);
});

test("repeated lifecycle symlink start, stop and replay does not linearly retain FDs", { skip: process.platform !== "linux" }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-lifecycle-fd-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-lifecycle-fd-outside-"));
  t.after(() => Promise.all([fs.rm(dataDir, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  await fs.mkdir(path.join(dataDir, "analytics"));
  await fs.symlink(outside, path.join(dataDir, "analytics", "lifecycle-intents"));
  const server = await createLoopbackServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ accepted: true })); });
  t.after(() => server.close());
  const before = (await fs.readdir("/proc/self/fd")).length;
  for (let index = 0; index < 100; index += 1) {
    const manager = lifecycleManager(dataDir, server.apiOrigin) as any;
    await manager.start();
    await manager.replayWorkerLifecycleIntents();
    await manager.stop();
  }
  const after = (await fs.readdir("/proc/self/fd")).length;
  assert.ok(after <= before + 12, `FD count grew from ${before} to ${after}`);
});

test("Analytics lifecycle failure logs expose only stable safe codes", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-lifecycle-log-"));
  const sentinel = "/absolute/sentinel/private-stack-source.ts";
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, "analytics"));
  await fs.symlink(sentinel, path.join(dataDir, "analytics", "lifecycle-intents"));
  const entries: unknown[] = [];
  const manager = lifecycleManager(dataDir, "http://analytics.invalid") as any;
  manager.params.logger = { info() {}, error() {}, warn: (value: unknown, message: string) => entries.push({ value, message }) };
  await manager.persistAndDispatchWorkerLifecycle("controlled_stop", { occurredAt: 1, targetIdentityQuality: "unknown", targets: [] });
  await manager.replayWorkerLifecycleIntents();
  manager.trackLifecycle(Promise.reject(Object.assign(new Error(`boom ${sentinel}`), { stack: `stack ${sentinel}` })));
  await new Promise((resolve) => setImmediate(resolve));
  const encoded = JSON.stringify(entries);
  assert.match(encoded, /ANALYTICS_LIFECYCLE_(INTENT_PERSIST|INTENT_REPLAY|TASK)_FAILED/);
  assert.equal(encoded.includes(sentinel), false);
  assert.equal(encoded.includes(dataDir), false);
  assert.equal(encoded.includes("/proc/self/fd"), false);
  assert.equal(encoded.includes("stack "), false);
});

test("child epochs discard a delayed A snapshot and classify snapshotless B exit as unknown", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-worker-epoch-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const manager = lifecycleManager(dataDir, "http://analytics.invalid") as any;
  const a = createFakeWorkerChild() as any;
  const b = createFakeWorkerChild() as any;
  let resolveSnapshot!: (value: unknown) => void;
  manager.readWorkerSnapshot = () => new Promise((resolve) => { resolveSnapshot = resolve; });
  manager.child = a; manager.childEpoch = 1; manager.lastLiveSnapshot = null;
  const pendingA = manager.emitWorkerSnapshot(a, 1);
  // This is the spawn boundary: B begins with no inherited snapshot.
  manager.child = b; manager.childEpoch = 2; manager.lastLiveSnapshot = null;
  resolveSnapshot({ snapshotAt: 1, activeCount: 0, queueLength: 0, concurrency: 1, runnerMode: "agent_worker", analyticsProducerGeneration: "generation-a" });
  await pendingA;
  assert.equal(manager.lastLiveSnapshot, null);
  const lifecycle = manager.captureWorkerLifecycle(2, b, 2);
  assert.equal(lifecycle.targetIdentityQuality, "unknown");
  assert.equal(lifecycle.targets.some((target: { producerGeneration: string }) => target.producerGeneration === "generation-a"), false);
});

test("lifecycle retry after an ACK loss resends the original canonical signal and remains idempotent", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-worker-lifecycle-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let loseAck = true;
  const received: any[] = [];
  const server = await createLoopbackServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const signal = JSON.parse(body);
      received.push(signal);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(loseAck
        ? { accepted: false, receipt: null }
        : { accepted: true, receipt: { eventId: signal.eventId, fingerprint: signal.fingerprint } }));
    });
  });
  t.after(() => server.close());
  const manager = lifecycleManager(dataDir, server.apiOrigin) as any;
  await manager.persistAndDispatchWorkerLifecycle("controlled_stop", {
    occurredAt: 5, targetIdentityQuality: "unknown",
    targets: [{ domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager", producerGeneration: "observer-at-exit" }],
  });
  assert.equal(received.length, 1);
  const directory = path.join(dataDir, "analytics", "lifecycle-intents");
  assert.equal((await fs.readdir(directory)).length, 1, "an ACK mismatch must retain durable evidence");
  loseAck = false;
  await manager.replayWorkerLifecycleIntents();
  assert.equal(received.length, 2);
  assert.deepEqual(
    ["eventId", "fingerprint", "sequence", "producerGeneration"].map((key) => received[1][key]),
    ["eventId", "fingerprint", "sequence", "producerGeneration"].map((key) => received[0][key]),
  );
  assert.deepEqual(await fs.readdir(directory), []);
});

test("restart conversion atomically persists one new observer signal and concurrent replay has one delivery owner", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-worker-lifecycle-restart-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let allowAck = false;
  let releaseResponse!: () => void;
  const waitResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const received: any[] = [];
  const server = await createLoopbackServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      const signal = JSON.parse(body); received.push(signal);
      if (!allowAck) await waitResponse;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(allowAck
        ? { accepted: true, receipt: { eventId: signal.eventId, fingerprint: signal.fingerprint } }
        : { accepted: false, receipt: null }));
    });
  });
  t.after(() => server.close());
  const oldManager = lifecycleManager(dataDir, server.apiOrigin) as any;
  const oldSignal = oldManager.createWorkerEvent("controlled_stop", null, { occurredAt: 3, targetIdentityQuality: "unknown", targets: [{ domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager", producerGeneration: "old-observer" }] });
  const directory = path.join(dataDir, "analytics", "lifecycle-intents");
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "old-intent.json");
  await fs.writeFile(filePath, JSON.stringify({ version: 2, signal: oldSignal }));
  const manager = lifecycleManager(dataDir, server.apiOrigin) as any;
  const first = manager.replayWorkerLifecycleIntents();
  await waitFor(() => received.length === 1);
  const converted = JSON.parse(await fs.readFile(filePath, "utf8")).signal;
  assert.notEqual(converted.producerGeneration, oldSignal.producerGeneration);
  // The direct path and replay path share the file owner while its response is in flight.
  const direct = manager.deliverLifecycleIntent(filePath, { version: 2, signal: converted }, 750);
  releaseResponse();
  await Promise.all([first, direct]);
  assert.equal(received.length, 1);
  const retained = JSON.parse(await fs.readFile(filePath, "utf8")).signal;
  assert.deepEqual([retained.eventId, retained.fingerprint, retained.sequence, retained.producerGeneration], [converted.eventId, converted.fingerprint, converted.sequence, converted.producerGeneration]);
  allowAck = true;
  await manager.replayWorkerLifecycleIntents();
  assert.equal(received.length, 2);
  assert.deepEqual([received[1].eventId, received[1].fingerprint, received[1].sequence, received[1].producerGeneration], [converted.eventId, converted.fingerprint, converted.sequence, converted.producerGeneration]);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("lifecycle intent is private, malformed evidence is retained, and malformed files do not block valid replay", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-worker-lifecycle-files-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const received: any[] = [];
  const server = await createLoopbackServer((request, response) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => { const signal = JSON.parse(body); received.push(signal); response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ accepted: true, receipt: { eventId: signal.eventId, fingerprint: signal.fingerprint } })); }); });
  t.after(() => server.close());
  const manager = lifecycleManager(dataDir, server.apiOrigin) as any;
  const directory = path.join(dataDir, "analytics", "lifecycle-intents");
  await fs.mkdir(directory, { recursive: true });
  const malformed = path.join(directory, "malformed.json"); await fs.writeFile(malformed, "not-json", { mode: 0o600 });
  const signal = manager.createWorkerEvent("controlled_stop", null, { occurredAt: 1, targetIdentityQuality: "unknown", targets: [{ domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager", producerGeneration: manager.analyticsGeneration }] });
  const valid = path.join(directory, "valid.json"); await manager.writeLifecycleIntent(valid, { version: 2, signal });
  assert.equal((await fs.stat(valid)).mode & 0o777, 0o600);
  await manager.replayWorkerLifecycleIntents();
  assert.equal(received.length, 1);
  assert.equal(await fs.stat(malformed).then(() => true, () => false), true);
  assert.equal(await fs.stat(valid).then(() => true, () => false), false);
});

test("checkpoint timer retries a retained lifecycle intent after the first delivery failure", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-worker-lifecycle-timer-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let attempts = 0;
  const server = await createLoopbackServer((request, response) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => { const signal = JSON.parse(body); attempts += 1; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(attempts === 1 ? { accepted: false, receipt: null } : { accepted: true, receipt: { eventId: signal.eventId, fingerprint: signal.fingerprint } })); }); });
  t.after(() => server.close());
  const manager = lifecycleManager(dataDir, server.apiOrigin) as any;
  manager.params.analyticsCheckpointIntervalMs = 10;
  const directory = path.join(dataDir, "analytics", "lifecycle-intents"); await fs.mkdir(directory, { recursive: true });
  const signal = manager.createWorkerEvent("controlled_stop", null, { occurredAt: 1, targetIdentityQuality: "unknown", targets: [{ domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager", producerGeneration: manager.analyticsGeneration }] });
  await manager.writeLifecycleIntent(path.join(directory, "retry.json"), { version: 2, signal });
  await manager.start();
  await waitFor(() => attempts >= 2, 500);
  assert.deepEqual(await fs.readdir(directory), []);
  await manager.stop();
});
