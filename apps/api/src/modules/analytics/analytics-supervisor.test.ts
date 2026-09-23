import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { __analyticsSupervisorInternals, AnalyticsSupervisor } from "./analytics-supervisor.js";

class FakeAnalyticsChild extends EventEmitter {
  connected = true;
  readonly sent: unknown[] = [];
  readonly killSignals: Array<string | undefined> = [];
  respondToInitialize = true;
  respondToShutdown = true;
  failSend = false;
  killEmitsExit = true;
  signalAccepted = true;
  hangSignals = false;
  respondToSignals = false;

  send(message: any, callback?: (error: Error | null) => void) {
    this.sent.push(message);
    if (this.failSend) {
      callback?.(new Error("send failed"));
      return false;
    }
    if (message.type === "initialize" && this.respondToInitialize) queueMicrotask(() => this.emit("message", { type: "ready", requestId: message.requestId }));
    if (message.type === "dashboard_query") queueMicrotask(() => this.emit("message", {
      type: "dashboard_result", requestId: message.requestId,
      response: { kind: "error", error: { code: "ANALYTICS_RANGE_NOT_READY" } }
    }));
    if (message.type === "signal" && this.respondToSignals && !this.hangSignals) queueMicrotask(() => this.emit("message", {
      type: "signal_result", requestId: message.requestId,
      result: { accepted: this.signalAccepted, receipt: null },
    }));
    if (message.type === "shutdown" && this.respondToShutdown) queueMicrotask(() => this.exit());
    callback?.(null);
    return true;
  }

  kill(signal?: string) {
    this.killSignals.push(signal);
    this.connected = false;
    if (this.killEmitsExit) this.exit();
    return true;
  }

  exit() {
    this.connected = false;
    this.emit("exit", 1, null);
  }
}

const request = { rangeKind: "preset_7d", timezone: "UTC" } as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function starts(child: FakeAnalyticsChild, extra: Record<string, unknown> = {}) {
  const supervisor = new AnalyticsSupervisor({ dataDir: "/not-used", workerFactory: () => child as any, startupTimeoutMs: 100, queryTimeoutMs: 100, shutdownTimeoutMs: 10, restartLimit: 0, ...extra });
  assert.equal(await supervisor.start(), true);
  return supervisor;
}

test("bootstrap false or timeout keeps queries unavailable, retires the child, and only a replacement accepting the latest source serves", async (t) => {
  const rejected = new FakeAnalyticsChild(); rejected.signalAccepted = false; rejected.respondToSignals = true;
  const timedOut = new FakeAnalyticsChild(); timedOut.hangSignals = true;
  const accepted = new FakeAnalyticsChild(); accepted.respondToSignals = true;
  const children = [rejected, timedOut, accepted];
  let launches = 0;
  let sourceVersion = 1;
  const supervisor = new AnalyticsSupervisor({
    dataDir: "/not-used", workerFactory: () => children[launches++] as any,
    startupTimeoutMs: 100, signalTimeoutMs: 30, queryTimeoutMs: 50,
    shutdownTimeoutMs: 10, restartLimit: 2, restartDelayMs: 1,
  });
  supervisor.onReady(async () => {
    const source = { kind: "expected_slots_config", sentAt: 1, requestId: `bootstrap-${sourceVersion}`, sourceConfigVersion: sourceVersion, effectiveAt: sourceVersion, enabledFactDomains: ["execution", "model"], slots: [{ domain: "execution", producerNamespace: "api_local_fallback", producerId: "api_local_fallback" }, { domain: "model", producerNamespace: "api_local_fallback", producerId: "api_local_fallback" }] } as any;
    const result = await supervisor.signal(source);
    if (!result.accepted) throw new Error("bootstrap rejected");
  });
  assert.equal(await supervisor.start(), false);
  assert.equal(supervisor.isReady, false);
  assert.equal((await supervisor.query(request)).kind, "error");
  sourceVersion = 2; // changed before the eventual replacement reaches ready.
  const deadline = Date.now() + 1_000;
  while (!supervisor.isReady && Date.now() < deadline) await sleep(5);
  assert.equal(supervisor.isReady, true);
  assert.equal(launches, 3);
  assert.equal(rejected.connected, false);
  assert.equal(timedOut.connected, false);
  const latest = accepted.sent.find((message: any) => message.type === "signal") as any;
  assert.equal(latest.signal.sourceConfigVersion, 2);
  await supervisor.close();
});

test("child launch gets a minimal environment and explicit safe loader args", () => {
  const original = process.env.AWB_TEST_PARENT_SENTINEL;
  process.env.AWB_TEST_PARENT_SENTINEL = "parent-only-secret";
  try {
    const environment = __analyticsSupervisorInternals.createMinimalChildEnv("/analytics-data");
    assert.deepEqual(Object.keys(environment).sort(), Object.keys(environment).filter((key) => [
      "AWB_ANALYTICS_DATA_DIR", "AWB_ANALYTICS_COLLECTOR_ENABLED",
      "AWB_ANALYTICS_COLLECTOR_INTERVAL_MS", "AWB_ANALYTICS_COLLECTOR_BATCH_SIZE", "NODE_ENV", "TZ"
    ].includes(key)).sort());
    assert.equal(environment.AWB_ANALYTICS_DATA_DIR, "/analytics-data");
    assert.equal(environment.AWB_ANALYTICS_COLLECTOR_ENABLED, "1");
    assert.equal("AWB_TEST_PARENT_SENTINEL" in environment, false);
    const sourceArgs = __analyticsSupervisorInternals.createSafeChildExecArgv(true);
    assert.deepEqual(sourceArgs, ["--import", "tsx"]);
    assert.equal(sourceArgs.some((arg) => arg.includes("inspect") || arg.includes("env-file")), false);
    assert.deepEqual(__analyticsSupervisorInternals.createSafeChildExecArgv(false), []);
  } finally {
    if (original === undefined) delete process.env.AWB_TEST_PARENT_SENTINEL;
    else process.env.AWB_TEST_PARENT_SENTINEL = original;
  }
});

test("supervisor sends path-free initialize and forwards valid DTOs", async () => {
  const child = new FakeAnalyticsChild();
  const supervisor = await starts(child);
  assert.deepEqual(await supervisor.query(request), { kind: "error", error: { code: "ANALYTICS_RANGE_NOT_READY" } });
  assert.deepEqual(child.sent.map((message: any) => message.type), ["initialize", "dashboard_query"]);
  assert.equal("dataDir" in (child.sent[0] as object), false);
  await supervisor.close();
});

test("malformed child IPC completes pending work as unavailable and begins retirement", async () => {
  const child = new FakeAnalyticsChild();
  const originalSend = child.send.bind(child);
  child.send = ((message: any, callback?: (error: Error | null) => void) => {
    if (message.type === "dashboard_query") {
      child.sent.push(message);
      callback?.(null);
      return true;
    }
    return originalSend(message, callback);
  }) as any;
  const supervisor = await starts(child);
  const pending = supervisor.query(request);
  child.emit("message", { type: "dashboard_result", requestId: "missing-response" });
  assert.deepEqual(await pending, { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } });
  await supervisor.close();
});

test("ready hooks replay the same Analytics control to replacement after a signal timeout", async () => {
  const first = new FakeAnalyticsChild();
  const second = new FakeAnalyticsChild();
  const secondSend = second.send.bind(second);
  second.send = ((message: any, callback?: (error: Error | null) => void) => {
    const sent = secondSend(message, callback);
    if (message.type === "signal") queueMicrotask(() => second.emit("message", {
      type: "signal_result", requestId: message.requestId,
      result: { accepted: true, receipt: null },
    }));
    return sent;
  }) as any;
  let created = 0;
  const supervisor = new AnalyticsSupervisor({
    dataDir: "/not-used",
    workerFactory: () => (created++ === 0 ? first : second) as any,
    startupTimeoutMs: 100,
    signalTimeoutMs: 10,
    shutdownTimeoutMs: 10,
    restartDelayMs: 1,
    restartLimit: 1,
  });
  const source = {
    kind: "expected_slots_config" as const,
    sentAt: 1,
    requestId: "source-replay",
    sourceConfigVersion: 7,
    effectiveAt: 1,
    enabledFactDomains: ["execution" as const, "model" as const],
    slots: [
      { domain: "execution" as const, producerNamespace: "api_local_fallback" as const, producerId: "api_local_fallback" },
      { domain: "model" as const, producerNamespace: "api_local_fallback" as const, producerId: "api_local_fallback" },
    ],
  };
  const outcomes: boolean[] = [];
  supervisor.onReady(() => { void supervisor.signal(source).then((result) => outcomes.push(result.accepted)); });
  assert.equal(await supervisor.start(), true);
  await sleep(60);
  const firstSignal = first.sent.find((message: any) => message.type === "signal") as any;
  const secondSignal = second.sent.find((message: any) => message.type === "signal") as any;
  assert.deepEqual(firstSignal.signal, secondSignal.signal);
  assert.deepEqual(outcomes, [false, true]);
  await supervisor.close();
});

test("a retiring child without exit blocks replacement and queries", async () => {
  const first = new FakeAnalyticsChild();
  first.respondToShutdown = false;
  first.killEmitsExit = false;
  const second = new FakeAnalyticsChild();
  let creations = 0;
  const supervisor = new AnalyticsSupervisor({
    dataDir: "/not-used",
    workerFactory: () => (creations++ === 0 ? first : second) as any,
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 10,
    restartDelayMs: 1,
    restartLimit: 1
  });
  assert.equal(await supervisor.start(), true);
  first.emit("error", new Error("child error"));
  await sleep(40); // graceful -> TERM -> KILL -> final exit wait
  assert.equal(creations, 1);
  assert.deepEqual(await supervisor.query(request), { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } });
  assert.equal(await supervisor.start(), false);
  assert.equal(creations, 1);

  first.exit();
  await sleep(10);
  assert.equal(creations, 2);
  await supervisor.close();
});

test("replacement is scheduled only once from a confirmed retiring-child exit", async () => {
  const first = new FakeAnalyticsChild();
  first.respondToShutdown = false;
  first.killEmitsExit = false;
  const second = new FakeAnalyticsChild();
  let creations = 0;
  const supervisor = new AnalyticsSupervisor({
    dataDir: "/not-used",
    workerFactory: () => (creations++ === 0 ? first : second) as any,
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 10,
    restartDelayMs: 1,
    restartLimit: 2
  });
  assert.equal(await supervisor.start(), true);
  first.emit("error", new Error("one failure event"));
  first.emit("error", new Error("duplicate failure event"));
  await sleep(5);
  assert.equal(creations, 1);
  first.exit();
  await sleep(10);
  assert.equal(creations, 2);
  await supervisor.close();
});

test("retirement escalates graceful shutdown to SIGTERM then SIGKILL", async () => {
  const child = new FakeAnalyticsChild();
  child.respondToShutdown = false;
  child.killEmitsExit = false;
  const supervisor = await starts(child, { shutdownTimeoutMs: 10 });
  child.emit("error", new Error("stuck child"));
  await sleep(25);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  child.exit();
  await supervisor.close();
});

test("factory and send failures stay unavailable without creating an overlapping replacement", async () => {
  const factoryFailure = new AnalyticsSupervisor({ dataDir: "/not-used", workerFactory: () => { throw new Error("launch failure"); }, restartLimit: 1 });
  assert.equal(await factoryFailure.start(), false);
  await sleep(10);
  assert.deepEqual(await factoryFailure.query(request), { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } });
  await factoryFailure.close();

  const child = new FakeAnalyticsChild();
  child.respondToShutdown = false;
  child.killEmitsExit = false;
  child.failSend = true;
  const sendFailure = new AnalyticsSupervisor({ dataDir: "/not-used", workerFactory: () => child as any, startupTimeoutMs: 100, shutdownTimeoutMs: 10, restartLimit: 1 });
  assert.equal(await sendFailure.start(), false);
  await sleep(40);
  assert.deepEqual(await sendFailure.query(request), { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } });
  await sendFailure.close();
});

test("shutdown has no restart and returns boundedly when exit cannot be confirmed", async () => {
  const child = new FakeAnalyticsChild();
  child.respondToShutdown = false;
  child.killEmitsExit = false;
  let creations = 0;
  const supervisor = new AnalyticsSupervisor({
    dataDir: "/not-used",
    workerFactory: () => { creations += 1; return child as any; },
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 10,
    restartDelayMs: 1,
    restartLimit: 3
  });
  assert.equal(await supervisor.start(), true);
  const startedAt = Date.now();
  await supervisor.close();
  assert.equal(Date.now() - startedAt < 100, true);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  await sleep(20);
  assert.equal(creations, 1);
});
