import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { AnalyticsChildProcess } from "./analytics-supervisor.js";
import { createApp } from "../../app/createApp.js";
import { createAgentTestFixture } from "../agent/testkit/agent-testkit.js";

type FaultMode = "crash" | "hang" | "malformed";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const eventLoopBarrier = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A process-shaped child used only at the API/Analytics boundary. It lets this
 * integration test exercise failures after the real Fastify application and
 * its ordinary business modules have been initialized.
 */
class FaultingAnalyticsChild extends EventEmitter {
  connected = true;
  initialized = false;
  dashboardRequests = 0;
  shutdownRequests = 0;
  expectedSlotsConfigSignals = 0;
  expectedSlotsConfigAcknowledgements = 0;

  constructor(private readonly mode: FaultMode) {
    super();
  }

  send(message: unknown, callback?: (error: Error | null) => void) {
    const envelope = message as { type?: string; requestId?: string };
    if (envelope.type === "initialize" && typeof envelope.requestId === "string") {
      this.initialized = true;
      queueMicrotask(() => this.emit("message", { type: "ready", requestId: envelope.requestId }));
    }
    if (envelope.type === "dashboard_query" && typeof envelope.requestId === "string") {
      this.dashboardRequests += 1;
      if (this.mode === "crash") queueMicrotask(() => this.exit());
      if (this.mode === "malformed") {
        // This deliberately includes a would-be sensitive field. The parent
        // must reject it as malformed IPC instead of reflecting it to HTTP.
        queueMicrotask(() => this.emit("message", {
          type: "dashboard_result",
          requestId: envelope.requestId,
          response: { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE", message: "fault-secret-sentinel" } }
        }));
      }
    }
    // createApp configures expected slots once the child is ready, and the
    // local fallback producer also emits detached control signals. A healthy
    // acknowledgement here keeps the test focused on the requested query
    // fault rather than manufacturing a prior signal-timeout retirement.
    if ((envelope.type === "signal" || envelope.type === "outbox_corrupt") && typeof envelope.requestId === "string") {
      if ((message as { signal?: { kind?: string } }).signal?.kind === "expected_slots_config")
        this.expectedSlotsConfigSignals += 1;
      queueMicrotask(() => {
        this.emit("message", {
          type: "signal_result", requestId: envelope.requestId, result: { accepted: true, receipt: null }
        });
        if ((message as { signal?: { kind?: string } }).signal?.kind === "expected_slots_config")
          this.expectedSlotsConfigAcknowledgements += 1;
      });
    }
    if (envelope.type === "shutdown") {
      this.shutdownRequests += 1;
      queueMicrotask(() => this.exit());
    }
    callback?.(null);
    return true;
  }

  kill() {
    this.exit();
    return true;
  }

  disconnect() {
    this.exit();
  }

  private exit() {
    if (!this.connected) return;
    this.connected = false;
    this.emit("exit", 1, null);
  }
}

async function waitForServing(child: FaultingAnalyticsChild) {
  const deadline = Date.now() + 5_000;
  while (
    (!child.initialized || child.expectedSlotsConfigSignals === 0 || child.expectedSlotsConfigAcknowledgements === 0)
    && Date.now() < deadline
  ) await sleep(10);
  const diagnostic = `initialized=${child.initialized}, connected=${child.connected}, expectedSlotsConfigSignals=${child.expectedSlotsConfigSignals}, expectedSlotsConfigAcknowledgements=${child.expectedSlotsConfigAcknowledgements}`;
  assert.equal(child.initialized, true, `Analytics child did not receive initialize (${diagnostic})`);
  assert.ok(child.expectedSlotsConfigSignals > 0, `Analytics bootstrap config was not sent (${diagnostic})`);
  assert.ok(child.expectedSlotsConfigAcknowledgements > 0, `Analytics bootstrap config ACK was not emitted (${diagnostic})`);
  assert.equal(child.connected, true, `Analytics child exited during bootstrap (${diagnostic})`);
  // The supervisor is intentionally not exposed through the app fixture. The
  // ACK above resolves its bootstrap hook; two macrotask barriers flush that
  // continuation before Dashboard traffic is sent.
  await eventLoopBarrier();
  await eventLoopBarrier();
}

async function assertOrdinaryApiStillWorks(app: Awaited<ReturnType<typeof createApp>>) {
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  const workspaces = await app.inject({ method: "GET", url: "/api/workspaces" });
  assert.equal(workspaces.statusCode, 200);
  assert.deepEqual(workspaces.json(), []);
}

test("Analytics child crash, timeout, and malformed IPC degrade only Dashboard", async (t) => {
  for (const mode of ["crash", "hang", "malformed"] as const) {
    await t.test(mode, async (subtest) => {
      const fixture = await createAgentTestFixture({ dataDirPrefix: `analytics-e2e-${mode}-` });
      const child = new FaultingAnalyticsChild(mode);
      fixture.ctx.analytics = {
        enabled: true,
        workerFactory: () => child as unknown as AnalyticsChildProcess,
        startupTimeoutMs: 5_000,
        queryTimeoutMs: 250,
        shutdownTimeoutMs: 250,
        restartLimit: 0
      };
      const app = await createApp(fixture.ctx);
      subtest.after(async () => {
        await app.close();
        await fixture.dispose();
      });

      await waitForServing(child);
      await assertOrdinaryApiStillWorks(app);

      const dashboard = await app.inject({
        method: "POST",
        url: "/api/analytics/dashboard/query",
        payload: { rangeKind: "preset_7d", timezone: "UTC" }
      });
      assert.equal(dashboard.statusCode, 503);
      assert.deepEqual(dashboard.json(), { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } });
      assert.equal(dashboard.body.includes("fault-secret-sentinel"), false);
      assert.equal(child.dashboardRequests, 1);

      // Local fallback Analytics producers are created as part of createApp;
      // their best-effort signal failures must not alter ordinary API results.
      await assertOrdinaryApiStillWorks(app);
    });
  }
});

test("API shutdown resolves a pending Dashboard query and gracefully reaps its child", async (t) => {
  const fixture = await createAgentTestFixture({ dataDirPrefix: "analytics-e2e-shutdown-" });
  const child = new FaultingAnalyticsChild("hang");
  fixture.ctx.analytics = {
    enabled: true,
    workerFactory: () => child as unknown as AnalyticsChildProcess,
    startupTimeoutMs: 5_000,
    queryTimeoutMs: 5_000,
    shutdownTimeoutMs: 250,
    restartLimit: 0
  };
  const app = await createApp(fixture.ctx);
  t.after(() => fixture.dispose());

  await waitForServing(child);
  const pending = app.inject({
    method: "POST",
    url: "/api/analytics/dashboard/query",
    payload: { rangeKind: "preset_7d", timezone: "UTC" }
  });
  const sentDeadline = Date.now() + 5_000;
  while (child.dashboardRequests === 0 && Date.now() < sentDeadline) await sleep(10);
  assert.equal(child.dashboardRequests, 1, `Dashboard query was not dispatched before shutdown (initialized=${child.initialized}, connected=${child.connected}, expectedSlotsConfigAcknowledgements=${child.expectedSlotsConfigAcknowledgements})`);

  await app.close();
  const dashboard = await pending;
  assert.equal(dashboard.statusCode, 503);
  assert.deepEqual(dashboard.json(), { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } });
  assert.equal(child.shutdownRequests, 1);
  assert.equal(child.connected, false);
});
