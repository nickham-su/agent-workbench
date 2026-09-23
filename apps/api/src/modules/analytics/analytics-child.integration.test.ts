import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../../app/createApp.js";
import { analyticsDbPath } from "../../infra/fs/paths.js";
import { closeAnalyticsDb, openAnalyticsDb, ANALYTICS_SCHEMA_VERSION } from "./analytics-db.js";
import { analyticsFingerprint } from "./signal-store.js";
import { createAgentTestFixture } from "../agent/testkit/agent-testkit.js";

async function queryUntilReady(app: Awaited<ReturnType<typeof createApp>>) {
  const startedAt = Date.now();
  const deadline = Date.now() + 8_000;
  let response = await app.inject({ method: "POST", url: "/api/analytics/dashboard/query", payload: { rangeKind: "preset_7d", timezone: "UTC" } });
  while (response.statusCode === 503 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    response = await app.inject({ method: "POST", url: "/api/analytics/dashboard/query", payload: { rangeKind: "preset_7d", timezone: "UTC" } });
  }
  return { response, elapsedMs: Date.now() - startedAt };
}

class NeverReadyChild extends EventEmitter {
  connected = true;
  send(_message: unknown, callback?: (error: Error | null) => void) { callback?.(null); return true; }
  kill() { this.connected = false; this.emit("exit", 1, null); return true; }
  disconnect() { this.connected = false; }
}

test("Analytics child owns an empty store and serves a contract-valid 200 response", async (t) => {
  const fixture = await createAgentTestFixture({ dataDirPrefix: "analytics-child-" });
  fixture.ctx.analytics = { enabled: true, collectorEnabled: false, startupTimeoutMs: 5_000, queryTimeoutMs: 2_000, restartLimit: 0 };
  const app = await createApp(fixture.ctx);
  t.after(async () => {
    await app.close();
    await fixture.dispose();
  });

  const { response, elapsedMs } = await queryUntilReady(app);
  assert.equal(response.statusCode, 200);
  assert.ok(elapsedMs < 2_000, `first Dashboard response exceeded cold-path bound: ${elapsedMs}ms`);
  const body = response.json();
  assert.equal(body.kind, "success");
  assert.equal(typeof body.rangeId, "string");
  assert.equal(body.to > body.from, true);
  assert.equal(body.data.overview.monitoringVolume.status, "unavailable");
  assert.equal(body.data.overview.monitoringVolume.value, null);
  assert.equal(body.data.exceptions.gitHeatmap180d.status, "unavailable");
  assert.equal(body.data.exceptions.workerLiveSnapshot.status, "unavailable");
  assert.equal(body.data.exceptions.domainHealth.status, "available");
  assert.equal(body.data.exceptions.domainHealth.data.length, 9);
  assert.equal(body.data.exceptions.domainHealth.data.every((state: any) => state.collectionStartedAt === null), true);
  assert.deepEqual(body.data.agent.metrics.runCount.requiredDomains, ["run"]);
  assert.deepEqual(body.data.agent.metrics.userMessageCount.requiredDomains, ["message"]);
  assert.deepEqual(body.data.agent.metrics.toolCallCount.requiredDomains, ["tool"]);
  assert.deepEqual(body.data.agent.metrics.manualCompactionCount.requiredDomains, ["message", "run"]);
  assert.deepEqual(body.data.agent.metrics.totalDuration.requiredDomains, ["agent_duration", "execution"]);
  await fs.stat(analyticsDbPath(fixture.dataDir));
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
});

test("a corrupt startup source never starts the supervisor and leaves Dashboard at 503 while API health remains available", async (t) => {
  const fixture = await createAgentTestFixture({ dataDirPrefix: "analytics-corrupt-source-" });
  let launches = 0;
  await fs.mkdir(`${fixture.dataDir}/analytics`, { recursive: true });
  await fs.writeFile(`${fixture.dataDir}/analytics/config-source.json`, "not-json");
  fixture.ctx.analytics = {
    enabled: true, collectorEnabled: false, restartLimit: 0,
    workerFactory: (() => { launches += 1; return new NeverReadyChild() as any; }) as any,
  };
  const app = await createApp(fixture.ctx);
  t.after(async () => { await app.close(); await fixture.dispose(); });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(launches, 0);
  assert.equal((await app.inject({ method: "POST", url: "/api/analytics/dashboard/query", payload: { rangeKind: "preset_7d", timezone: "UTC" } })).statusCode, 503);
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
});

test("Analytics child starts the bounded business collector without involving the API process", async (t) => {
  const fixture = await createAgentTestFixture({ dataDirPrefix: "analytics-collector-child-" });
  fixture.db.prepare("INSERT INTO workspaces (id, dir_name, title, path, created_at, updated_at) VALUES ('ws-collector-child', 'collector-child', 'safe', 'safe', 1, 1)").run();
  fixture.db.prepare("INSERT INTO agent_session (id, workspace_id, title, kind, created_at, updated_at) VALUES ('session-collector-child', 'ws-collector-child', 'safe', 'primary', 2, 2)").run();
  fixture.ctx.analytics = { enabled: true, collectorEnabled: true, collectorIntervalMs: 25, collectorBatchSize: 10, startupTimeoutMs: 5_000, queryTimeoutMs: 2_000, restartLimit: 0 };
  const app = await createApp(fixture.ctx);
  t.after(async () => {
    await app.close();
    await fixture.dispose();
  });

  const readyDeadline = Date.now() + 8_000;
  let initialized = false;
  while (!initialized && Date.now() < readyDeadline) {
    const response = await app.inject({ method: "POST", url: "/api/analytics/dashboard/query", payload: { rangeKind: "preset_7d", timezone: "UTC" } });
    if (response.statusCode === 200) {
      const body = response.json();
      const session = body.data.exceptions.domainHealth.data.find((state: { domain: string }) => state.domain === "session");
      initialized = session?.collectionStartedAt !== null && session?.status === "healthy";
    }
    if (!initialized) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(initialized, true);
  const initialReader = new Database(analyticsDbPath(fixture.dataDir), { readonly: true });
  assert.equal((initialReader.prepare("SELECT COUNT(*) AS count FROM analytics_session_fact").get() as { count: number }).count, 0);
  initialReader.close();

  const now = Date.now();
  fixture.db.prepare("INSERT INTO agent_session (id, workspace_id, title, kind, created_at, updated_at) VALUES ('session-after-enable', 'ws-collector-child', 'safe', 'primary', ?, ?)").run(now, now);
  const collectionDeadline = Date.now() + 8_000;
  let collected = false;
  while (!collected && Date.now() < collectionDeadline) {
    const reader = new Database(analyticsDbPath(fixture.dataDir), { readonly: true });
    collected = (reader.prepare("SELECT COUNT(*) AS count FROM analytics_session_fact WHERE session_id = 'session-after-enable'").get() as { count: number }).count === 1;
    reader.close();
    if (!collected) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(collected, true);
});

test("a slow Analytics launch does not block API creation", async (t) => {
  const fixture = await createAgentTestFixture({ dataDirPrefix: "analytics-async-start-" });
  fixture.ctx.analytics = { enabled: true, workerFactory: () => new NeverReadyChild() as any, startupTimeoutMs: 2_000, restartLimit: 0 };
  const app = await createApp(fixture.ctx);
  t.after(async () => {
    await app.close();
    await fixture.dispose();
  });
  // createApp resolves before the intentionally never-ready child is allowed
  // to reach its startup timeout; this state assertion avoids wall-clock gates.
  assert.ok(app);
  const dashboard = await app.inject({ method: "POST", url: "/api/analytics/dashboard/query", payload: { rangeKind: "preset_7d", timezone: "UTC" } });
  assert.deepEqual(dashboard.json(), { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } });
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
});

test("an incompatible Analytics schema only degrades the Dashboard route", async (t) => {
  const fixture = await createAgentTestFixture({ dataDirPrefix: "analytics-incompatible-" });
  const analyticsDb = await openAnalyticsDb(fixture.dataDir);
  analyticsDb.prepare("UPDATE analytics_schema_meta SET schema_version = ?").run(ANALYTICS_SCHEMA_VERSION + 1);
  closeAnalyticsDb(analyticsDb);
  fixture.ctx.analytics = { enabled: true, startupTimeoutMs: 5_000, queryTimeoutMs: 100, restartLimit: 0 };
  const app = await createApp(fixture.ctx);
  t.after(async () => {
    await app.close();
    await fixture.dispose();
  });

  const dashboard = await app.inject({
    method: "POST", url: "/api/analytics/dashboard/query",
    payload: { rangeKind: "preset_7d", timezone: "UTC" }
  });
  assert.equal(dashboard.statusCode, 503);
  assert.deepEqual(dashboard.json(), { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } });
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
});


test("internal Signal preserves nullable values through Fastify, supervisor IPC and child storage", async (t) => {
  const fixture = await createAgentTestFixture({ dataDirPrefix: "analytics-null-signal-" });
  fixture.ctx.analytics = { enabled: true, collectorEnabled: false, startupTimeoutMs: 5_000, queryTimeoutMs: 2_000, restartLimit: 0 };
  const app = await createApp(fixture.ctx);
  t.after(async () => { await app.close(); await fixture.dispose(); });
  assert.equal((await queryUntilReady(app)).response.statusCode, 200);
  const unsigned = {
    kind: "event" as const, domain: "model" as const, producerNamespace: "agent_worker" as const, producerId: "agent_runner",
    producerGeneration: "null-generation", sequence: 1, eventId: randomUUID(), payloadVersion: 1 as const,
    eventType: "model_invoked" as const, subjectIdentity: "model:null-call", observedAt: 100,
    payload: { modelCallId: "model:null-call", runId: "run-null", executionId: "execution:run-null", attemptNo: 1, providerId: "openai-compatible", modelId: "gpt-4.1", startedAt: 100, endedAt: null, status: "running" as const, completionQuality: "unknown" as const, timeoutKind: null, inputTokens: null, outputTokens: null, totalTokens: null, totalSource: "unavailable" as const, cacheReadTokens: null, cacheWriteTokens: null, cacheComparable: false, cacheWriteVerified: false, failureKind: null }
  };
  const fingerprint = analyticsFingerprint(unsigned as Parameters<typeof analyticsFingerprint>[0]);
  const response = await app.inject({ method: "POST", url: "/api/analytics/internal/signal", headers: { "x-awb-agent-internal-token": fixture.ctx.agentInternalToken }, payload: { ...unsigned, fingerprint } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().accepted, true);
  const stored = new Database(analyticsDbPath(fixture.dataDir), { readonly: true });
  t.after(() => stored.close());
  assert.deepEqual(stored.prepare("SELECT ended_at, input_tokens, output_tokens, cache_read_tokens FROM analytics_model_call_fact WHERE model_call_id='model:null-call'").get(), { ended_at: null, input_tokens: null, output_tokens: null, cache_read_tokens: null });
});
