import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import { isCanonicalAnalyticsSignal, type AnalyticsControlSignal, type AnalyticsGenerationControlSignal, type AnalyticsSignal, type AnalyticsSignalResult } from "@agent-workbench/shared";
import { AgentWorkerProcessManager } from "./agent.worker-manager.js";
import { openAnalyticsDb, closeAnalyticsDb } from "../analytics/analytics-db.js";
import { acceptAnalyticsSignal, analyticsFingerprint } from "../analytics/signal-store.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(t: TestContext) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-worker-lifecycle-store-"));
  const db = await openAnalyticsDb(dataDir);
  assert.equal(acceptAnalyticsSignal(db, {
    kind: "expected_slots_config", sentAt: 0, requestId: "enable-worker", sourceConfigVersion: 1, effectiveAt: 0,
    enabledFactDomains: ["run", "session", "message", "tool", "execution", "model", "worker"],
    slots: [
      { domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager" },
      { domain: "execution", producerNamespace: "agent_worker", producerId: "agent_runner" },
      { domain: "model", producerNamespace: "agent_worker", producerId: "agent_runner" },
    ],
  }).accepted, true);
  const managers: AgentWorkerProcessManager[] = [];
  const history: AnalyticsSignal[] = [];
  const children: Array<EventEmitter & { generation: string; unref(): void; kill(signal?: string): boolean }> = [];
  let failTransport: "none" | "mismatch" | "unavailable" = "none";
  const transport = async (signal: AnalyticsSignal): Promise<AnalyticsSignalResult> => {
    assert.equal(isCanonicalAnalyticsSignal(signal), true);
    history.push(signal);
    if (failTransport === "unavailable") return { accepted: false, receipt: null };
    const result = acceptAnalyticsSignal(db, signal);
    if (failTransport === "mismatch" && signal.kind === "event") {
      return { accepted: true, receipt: { eventId: "different", fingerprint: "a".repeat(64) } };
    }
    return result;
  };
  function childControl(generation: string, domain: "execution" | "model", kind: "register" | "closing" | "closed" = "register", sequence = 1) {
    const signal: AnalyticsControlSignal = {
      kind, domain, producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: generation,
      sentAt: Date.now(), controlSequence: sequence, finalSequence: kind === "register" ? null : 0,
      committedSequence: 0, maxObservedAt: null, earliestOpenStartedAt: null,
      openExecutionCount: 0, openModelCount: 0, knownDrop: false, droppedSinceSequence: null,
      outboxPending: 0, oldestPendingAt: null, lossEpoch: 0,
    };
    assert.equal(acceptAnalyticsSignal(db, signal).accepted, true);
  }
  const createManager = (options: { onReady?: () => Promise<void>; waitForWorkerReady?: () => Promise<void>; exitOnKill?: boolean; registerOnSpawn?: boolean; dispatch?: typeof transport } = {}) => {
    const manager = new AgentWorkerProcessManager({
      repoRoot: process.cwd(), dataDir, workerHost: "127.0.0.1", workerPort: 1, socketPath: "", workerConcurrency: 1,
      apiOrigin: "http://unused.invalid", internalToken: "test", responseValidation: "strict", pidFilePath: path.join(dataDir, "worker.pid"),
      logger: { info() {}, warn() {}, error() {} } as any,
      dispatchAnalyticsSignal: options.dispatch ?? transport,
      onReady: options.onReady,
      waitForWorkerReady: options.waitForWorkerReady ?? (async () => undefined),
      childExitTimeoutMs: 30,
      spawnWorker: ((_command: unknown, _args: unknown, spawnOptions: any) => {
        const generation = spawnOptions.env.AWB_AGENT_ANALYTICS_GENERATION;
        assert.match(generation, /^[0-9a-f-]{36}$/);
        const child = new EventEmitter() as typeof children[number];
        child.generation = generation;
        child.unref = () => undefined;
        child.kill = () => {
          if (options.exitOnKill !== false) queueMicrotask(() => child.emit("exit", 0, null));
          return options.exitOnKill !== false;
        };
        children.push(child);
        if (options.registerOnSpawn !== false) {
          childControl(generation, "execution");
          childControl(generation, "model");
        }
        return child;
      }) as any,
    });
    // A snapshot is deliberately unavailable: identity must come from spawn.
    (manager as any).readWorkerSnapshot = async () => null;
    (manager as any).handleUnexpectedExit = () => undefined;
    managers.push(manager);
    return manager;
  };
  const lifecycle = (generation: string, domain: string) => (db.prepare("SELECT lifecycle FROM analytics_producer_generation WHERE producer_generation=? AND domain=?").get(generation, domain) as { lifecycle: string } | undefined)?.lifecycle;
  const observer = () => (history.find((signal) => signal.kind === "register" && signal.domain === "worker") as AnalyticsGenerationControlSignal).producerGeneration;
  t.after(async () => {
    for (const manager of managers) await manager.stop().catch(() => undefined);
    await Promise.all(managers.map((manager) => (manager as any).drainLifecycleTasks()));
    closeAnalyticsDb(db);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, db, history, children, createManager, lifecycle, observer, childControl, transport,
    setFailure: (value: typeof failTransport) => { failTransport = value; } };
}

test("direct app.close hands off child lifecycle internally after HTTP closes and before Analytics closes", async (t) => {
  const f = await fixture(t);
  const app = Fastify();
  let analyticsClosed = false;
  app.addHook("onClose", async () => { analyticsClosed = true; });
  const manager = f.createManager({ dispatch: async (signal) => {
    assert.equal(analyticsClosed, false, "Analytics must outlive producer handoff");
    if (signal.kind === "event" && signal.eventType === "worker_controlled_stop") {
      assert.equal(app.server.listening, false, "final handoff must work without HTTP");
    }
    return f.transport(signal);
  } });
  app.addHook("onClose", async () => { await manager.stop(); });
  await manager.start();
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  await app.close();
  const child = f.children[0]!;
  assert.equal(f.lifecycle(child.generation, "execution"), "abandoned");
  assert.equal(f.lifecycle(child.generation, "model"), "abandoned");
  assert.equal(f.lifecycle(f.observer(), "worker"), "closed");
  assert.equal(analyticsClosed, true);
  const lastEvent = f.history.findIndex((s) => s.kind === "event" && s.eventType === "worker_controlled_stop");
  const closing = f.history.findIndex((s) => s.kind === "closing" && s.domain === "worker");
  const closed = f.history.findIndex((s) => s.kind === "closed" && s.domain === "worker");
  assert.ok(lastEvent >= 0 && lastEvent < closing && closing < closed);
  const gaps = f.db.prepare("SELECT domain, cause FROM analytics_signal_coverage_gap WHERE producer_generation=?").all(child.generation);
  assert.deepEqual(gaps, [{ domain: "execution", cause: "abandoned_exit" }, { domain: "model", cause: "abandoned_exit" }]);
});

test("child unexpected exit terminates only its exact generations, not observer or replacement", async (t) => {
  const f = await fixture(t);
  const manager = f.createManager();
  await manager.start();
  const old = f.children[0]!;
  old.emit("exit", 1, null);
  await (manager as any).drainLifecycleTasks();
  assert.equal(f.lifecycle(old.generation, "execution"), "abandoned");
  assert.equal(f.lifecycle(old.generation, "model"), "abandoned");
  assert.equal(f.lifecycle(f.observer(), "worker"), "registered");
  await manager.start();
  const replacement = f.children[1]!;
  old.emit("exit", 1, null);
  await flush();
  assert.equal(f.lifecycle(replacement.generation, "execution"), "registered");
  (manager as any).tryEmitWorkerControl("checkpoint");
  await (manager as any).drainLifecycleTasks();
  assert.equal(f.lifecycle(f.observer(), "worker"), "registered");
  for (const signal of f.history) {
    if (signal.kind === "event" && signal.eventType === "worker_unexpected_exit") {
      assert.equal((signal.payload as any).targetIdentityQuality, "exact");
      assert.equal((signal.payload as any).targets.some((target: any) => target.domain === "worker"), false);
    }
  }
});

for (const phase of ["health", "onReady"] as const) {
  test(`${phase} failure before snapshot records the spawn-bound generation only after confirmed exit`, async (t) => {
    const f = await fixture(t);
    f.setFailure("unavailable");
    const manager = f.createManager(phase === "health"
      ? { waitForWorkerReady: async () => { throw new Error("ready failed"); } }
      : { onReady: async () => { throw new Error("ready failed"); } });
    await assert.rejects(manager.start(), /ready failed/);
    const generation = f.children[0]!.generation;
    const intentRoot = path.join(f.dataDir, "analytics", "lifecycle-intents");
    const names = await fs.readdir(intentRoot);
    assert.equal(names.length, 1);
    const intent = JSON.parse(await fs.readFile(path.join(intentRoot, names[0]!), "utf8"));
    assert.equal(intent.signal.payload.targetIdentityQuality, "exact");
    assert.deepEqual(intent.signal.payload.targets.map((target: any) => target.producerGeneration), [generation, generation]);
    f.setFailure("none");
    // Register the observer on this restored transport before replaying events.
    (manager as any).tryEmitWorkerControl("register");
    await (manager as any).drainLifecycleTasks();
    await (manager as any).replayWorkerLifecycleIntents();
    assert.equal(f.lifecycle(generation, "execution"), "abandoned");
    assert.equal(f.lifecycle(generation, "model"), "abandoned");
    assert.deepEqual(await fs.readdir(intentRoot), []);
  });
}

test("ACK mismatch retains exact two-target intent across observer replacement and replay is idempotent", async (t) => {
  const f = await fixture(t);
  const manager = f.createManager();
  await manager.start();
  f.setFailure("mismatch");
  f.children[0]!.emit("exit", 1, null);
  await (manager as any).drainLifecycleTasks();
  const intentRoot = path.join(f.dataDir, "analytics", "lifecycle-intents");
  const names = await fs.readdir(intentRoot);
  assert.equal(names.length, 1);
  const gapCount = f.db.prepare("SELECT COUNT(*) AS n FROM analytics_signal_coverage_gap").get() as { n: number };
  f.setFailure("none");
  const replacementObserver = f.createManager();
  await replacementObserver.start();
  assert.deepEqual(await fs.readdir(intentRoot), []);
  assert.equal(f.lifecycle(f.children[0]!.generation, "execution"), "abandoned");
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM analytics_signal_coverage_gap").get() as { n: number }).n, gapCount.n);
  const replayed = f.history.filter((s) => s.kind === "event" && s.eventType === "worker_unexpected_exit");
  assert.equal(replayed.length, 2);
  assert.equal((replayed[1]!.payload as any).targetIdentityQuality, "exact");
  assert.equal((replayed[1]!.payload as any).targets.length, 2);
});

test("stop is idempotent and preserves already clean closed child generations", async (t) => {
  const f = await fixture(t);
  const manager = f.createManager();
  await manager.start();
  const generation = f.children[0]!.generation;
  for (const domain of ["execution", "model"] as const) {
    f.childControl(generation, domain, "closing", 2);
    f.childControl(generation, domain, "closed", 3);
  }
  const first = manager.stop();
  assert.equal(manager.stop(), first);
  await first;
  assert.equal(f.lifecycle(generation, "execution"), "closed");
  assert.equal(f.lifecycle(generation, "model"), "closed");
  assert.equal(f.lifecycle(f.observer(), "worker"), "closed");
  assert.deepEqual(f.db.prepare("SELECT cause FROM analytics_signal_coverage_gap WHERE producer_generation=?").all(generation), []);
});

test("unconfirmed kill fails boundedly without false lifecycle evidence", async (t) => {
  const f = await fixture(t);
  const manager = f.createManager({ exitOnKill: false });
  await manager.start();
  const before = Date.now();
  await assert.rejects(manager.stop());
  assert.ok(Date.now() - before < 500);
  assert.equal(f.lifecycle(f.children[0]!.generation, "execution"), "registered");
  assert.equal(f.history.some((s) => s.kind === "event" && s.eventType === "worker_controlled_stop"), false);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, "analytics", "lifecycle-intents")), []);
  // Allow fixture cleanup to drain an actual late exit, without falsely certifying it early.
  f.children[0]!.emit("exit", 0, null);
  await (manager as any).drainLifecycleTasks();
});

test("failed shutdown retains child and independent observer evidence, recovered by a new observer", async (t) => {
  const f = await fixture(t);
  const manager = f.createManager();
  await manager.start();
  const oldObserver = f.observer();
  const childGeneration = f.children[0]!.generation;
  f.setFailure("unavailable");
  await manager.stop();
  const intentRoot = path.join(f.dataDir, "analytics", "lifecycle-intents");
  const names = await fs.readdir(intentRoot);
  assert.equal(names.length, 2);
  const intents = await Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(intentRoot, name), "utf8"))));
  const targetGroups = intents.map((intent) => intent.signal.payload.targets);
  assert.equal(targetGroups.some((targets) => targets.length === 1 && targets[0].producerGeneration === oldObserver && targets[0].domain === "worker"), true);
  assert.equal(targetGroups.some((targets) => targets.length === 2 && targets.every((target: any) => target.producerGeneration === childGeneration)), true);
  f.setFailure("none");
  const restarted = f.createManager();
  await restarted.start();
  assert.equal(f.lifecycle(oldObserver, "worker"), "abandoned");
  assert.equal(f.lifecycle(childGeneration, "execution"), "abandoned");
  assert.equal(f.lifecycle(childGeneration, "model"), "abandoned");
  assert.equal(f.lifecycle((restarted as any).analyticsGeneration, "worker"), "registered");
  assert.deepEqual(await fs.readdir(intentRoot), []);
});

test("optional internal transport is authoritative on failure and never falls back to HTTP", async (t) => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { assert.fail("internal producer transport must not use HTTP fallback"); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const manager = f.createManager({ dispatch: async () => { throw new Error("IPC unavailable"); } });
  await manager.start();
  await manager.stop();
  assert.equal((await fs.readdir(path.join(f.dataDir, "analytics", "lifecycle-intents"))).length, 2);
});

test("confirmed exit replays model outbox over the internal transport before abandoning child", async (t) => {
  const f = await fixture(t);
  const manager = f.createManager();
  await manager.start();
  const generation = f.children[0]!.generation;
  const directory = path.join(f.dataDir, "analytics", "model-outbox", "agent_worker", "agent_runner", generation);
  await fs.mkdir(directory, { recursive: true });
  const unsigned = {
    kind: "event" as const, domain: "model" as const, producerNamespace: "agent_worker" as const, producerId: "agent_runner",
    producerGeneration: generation, sequence: 1, eventId: "outbox-at-exit", payloadVersion: 1 as const,
    eventType: "model_invoked" as const, subjectIdentity: "model:exit", observedAt: Date.now(),
    payload: {
      modelCallId: "model-exit", executionId: "execution-exit", runId: "run-exit", attemptNo: 1,
      providerId: "provider", modelId: "model", startedAt: Date.now(), endedAt: null, status: "running",
      completionQuality: "unknown", timeoutKind: null, inputTokens: null, outputTokens: null, totalTokens: null,
      totalSource: "unavailable", cacheReadTokens: null, cacheWriteTokens: null, cacheComparable: false,
      cacheWriteVerified: false, failureKind: null,
    },
  };
  const event = { ...unsigned, fingerprint: analyticsFingerprint(unsigned as any) };
  await fs.writeFile(path.join(directory, "1-exit.json"), JSON.stringify(event));
  await manager.stop();
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal((f.db.prepare("SELECT event_id FROM analytics_event_receipt WHERE event_id=?").get(event.eventId) as { event_id: string }).event_id, event.eventId);
  const modelEvent = f.history.findIndex((s) => s.kind === "event" && s.domain === "model");
  const exitEvent = f.history.findIndex((s) => s.kind === "event" && s.eventType === "worker_controlled_stop");
  assert.ok(modelEvent >= 0 && modelEvent < exitEvent);
});

test("legacy v1 exit evidence stays unknown even when its payload claims exact identity", async (t) => {
  const f = await fixture(t);
  const manager = f.createManager();
  await manager.start();
  const generation = f.children[0]!.generation;
  const signal = (manager as any).createWorkerEvent("unexpected_exit", null, {
    occurredAt: Date.now(), targetIdentityQuality: "exact",
    targets: [{ domain: "execution", producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: generation }],
  });
  const directory = path.join(f.dataDir, "analytics", "lifecycle-intents");
  await fs.writeFile(path.join(directory, "legacy.json"), JSON.stringify({ version: 1, signal }));
  await (manager as any).replayWorkerLifecycleIntents();
  const delivered = f.history.filter((s) => s.kind === "event" && s.eventType === "worker_unexpected_exit").at(-1)!;
  assert.equal((delivered.payload as any).targetIdentityQuality, "unknown");
  assert.equal(f.lifecycle(generation, "execution"), "registered");
});

test("parent exit ACK before any child register persists terminal guards before deleting its intent", async (t) => {
  const f = await fixture(t);
  const manager = f.createManager({ registerOnSpawn: false });
  await manager.start();
  const generation = f.children[0]!.generation;
  assert.equal(f.lifecycle(generation, "execution"), undefined);
  assert.equal(f.lifecycle(generation, "model"), undefined);
  await manager.stop();
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, "analytics", "lifecycle-intents")), []);
  assert.equal(f.lifecycle(generation, "execution"), "abandoned");
  assert.equal(f.lifecycle(generation, "model"), "abandoned");
  for (const domain of ["execution", "model"] as const) {
    const late: AnalyticsControlSignal = {
      kind: "register", domain, producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: generation,
      sentAt: Date.now(), controlSequence: 100, finalSequence: null, committedSequence: 0,
      maxObservedAt: null, earliestOpenStartedAt: null, openExecutionCount: 0, openModelCount: 0,
      knownDrop: false, droppedSinceSequence: null, outboxPending: 0, oldestPendingAt: null, lossEpoch: 0,
    };
    assert.equal(acceptAnalyticsSignal(f.db, late).accepted, false);
    assert.equal(acceptAnalyticsSignal(f.db, { ...late, kind: "checkpoint", controlSequence: 101 }).accepted, false);
    assert.equal(f.lifecycle(generation, domain), "abandoned");
  }
  const exit = f.history.find((signal) => signal.kind === "event" && signal.eventType === "worker_controlled_stop")!;
  assert.equal(acceptAnalyticsSignal(f.db, exit).accepted, true, "repeat receipt remains idempotent");
});
