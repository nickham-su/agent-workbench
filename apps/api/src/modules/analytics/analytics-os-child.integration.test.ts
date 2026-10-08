import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../../app/createApp.js";
import { ensureDir } from "../../infra/fs/fs.js";
import { workspaceRoot } from "../../infra/fs/paths.js";
import { insertWorkspace } from "../workspaces/workspace.store.js";
import type { AnalyticsChildProcess } from "./analytics-supervisor.js";
import { createAgentTestFixture } from "../agent/testkit/agent-testkit.js";

type Mode = "exit_after_ready" | "hang_query" | "malformed_result" | "ignore_shutdown" | "target_signal_hang";
const fixturePath = fileURLToPath(new URL("./test-fixtures/analytics-fault-child.cjs", import.meta.url));
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve()));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("unable to reserve loopback test port");
  return address.port;
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check()) && Date.now() < deadline) await sleep(10);
  assert.equal(await check(), true, message);
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }, `Analytics child ${pid} did not exit`, timeoutMs);
}

function spawnFaultChild(mode: Mode, markerPath: string, children: ChildProcess[]) {
  return () => {
    const child = fork(fixturePath, [], {
      env: { AWB_ANALYTICS_TEST_MODE: mode, AWB_ANALYTICS_TEST_MARKER: markerPath },
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    children.push(child);
    return child as AnalyticsChildProcess;
  };
}

async function createOsChildApp(mode: Mode) {
  const fixture = await createAgentTestFixture({ dataDirPrefix: `analytics-os-${mode}-` });
  const markerPath = path.join(fixture.dataDir, "analytics-child-ready.marker");
  const children: ChildProcess[] = [];
  fixture.ctx.analytics = {
    enabled: true,
    workerFactory: spawnFaultChild(mode, markerPath, children),
    startupTimeoutMs: 500,
    queryTimeoutMs: 50,
    shutdownTimeoutMs: 25,
    restartLimit: 0
  };
  const app = await createApp(fixture.ctx);
  await waitFor(() => existsSync(markerPath), "OS child did not become ready");
  assert.equal(await fs.readFile(markerPath, "utf8"), "ready");
  const child = children[0];
  assert.ok(child?.pid);
  return { fixture, app, child: child!, markerPath };
}

for (const mode of ["exit_after_ready", "hang_query", "malformed_result"] as const) {
  test(`real OS Analytics child ${mode} safely retires pending Dashboard work`, async (t) => {
    const { fixture, app, child } = await createOsChildApp(mode);
    t.after(async () => { await app.close(); await fixture.dispose(); });
    const dashboard = await app.inject({ method: "POST", url: "/api/analytics/dashboard/query", payload: { rangeKind: "preset_7d", timezone: "UTC" } });
    assert.equal(dashboard.statusCode, 503);
    assert.deepEqual(dashboard.json(), { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } });
    assert.equal(dashboard.body.includes("test-only-private-detail"), false);
    await waitForPidExit(child.pid!);
    assert.equal((await app.inject({ method: "GET", url: "/api/workspaces" })).statusCode, 200);
  });
}

test("real OS Analytics child ignoring graceful shutdown is terminated and reaped", async (t) => {
  const { fixture, app, child } = await createOsChildApp("ignore_shutdown");
  t.after(() => fixture.dispose());
  await app.close();
  await waitForPidExit(child.pid!);
});

test("real HTTP local fallback Run completes while a ready Analytics child hangs", async (t) => {
  const fixture = await createAgentTestFixture({ dataDirPrefix: "analytics-os-local-run-" });
  const markerPath = path.join(fixture.dataDir, "analytics-child-ready.marker");
  const children: ChildProcess[] = [];
  const port = await freePort();
  fixture.ctx.agentApiOrigin = `http://127.0.0.1:${port}`;
  fixture.ctx.analytics = {
    enabled: true,
    workerFactory: spawnFaultChild("target_signal_hang", markerPath, children),
    // The real child may be scheduled after other concurrent test processes.
    startupTimeoutMs: 10_000,
    // Keep the target Signal pending across the entire bounded Run assertion.
    signalTimeoutMs: 7_500,
    queryTimeoutMs: 1_500,
    shutdownTimeoutMs: 25,
    restartLimit: 0
  };
  const app = await createApp(fixture.ctx);
  t.after(async () => { await app.close(); await fixture.dispose(); });
  await app.listen({ host: "127.0.0.1", port });
  const baseUrl = fixture.ctx.agentApiOrigin;
  await waitFor(() => existsSync(markerPath), "Analytics child did not reach ready before local Run");
  // The child sends its ready IPC message before the parent has necessarily
  // installed it as the active supervisor child. Establish that boundary over
  // the same loopback HTTP transport used by LocalAnalyticsProducer, so the
  // Run's execution_started signal cannot be dropped in that tiny startup gap.
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/analytics/internal/signal`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-awb-agent-internal-token": fixture.ctx.agentInternalToken },
      body: JSON.stringify({
        kind: "checkpoint", domain: "execution", producerNamespace: "api_local_fallback", producerId: "api_local_fallback", producerGeneration: "test-barrier-generation",
        sentAt: Date.now(), controlSequence: 1, finalSequence: null, committedSequence: 0, maxObservedAt: Date.now(), earliestOpenStartedAt: null,
        openExecutionCount: 0, openModelCount: 0, knownDrop: false, droppedSinceSequence: null, outboxPending: 0, oldestPendingAt: null, lossEpoch: 0
      })
    });
    return response.ok && (await response.json() as { accepted: boolean }).accepted;
  }, "Analytics supervisor did not become ready before local Run", 10_000);

  const workspacePath = workspaceRoot(fixture.dataDir, "analytics-local-run");
  await ensureDir(workspacePath);
  const now = Date.now();
  insertWorkspace(fixture.db, { id: "analytics-local-run-workspace", dirName: "analytics-local-run", title: "Analytics local fallback", path: workspacePath, terminalCredentialId: null, createdAt: now, updatedAt: now });
  const providersResponse = await fetch(`${baseUrl}/api/settings/agent/providers`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      default: { providerId: "ppchat", modelId: "gpt-5.2" },
      providers: [{ id: "ppchat", name: "ppchat", npm: "@ai-sdk/openai", options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "test-only-key" }, models: [{ id: "gpt-5.2", name: "gpt-5.2", contextWindowTokens: 128000 }] }]
    })
  });
  assert.equal(providersResponse.status, 200);
  const agentsResponse = await fetch(`${baseUrl}/api/settings/agent/agents`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      default: { agentId: "default" },
      agents: [{
        id: "default", name: "default", summary: "", prompt: "You are a helpful coding assistant.", tools: ["bash", "read", "write"], pluginTools: [], mcpServers: [],
        defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "both", order: 0
      }]
    })
  });
  const agentsText = await agentsResponse.text();
  if (agentsResponse.status !== 200) assert.fail(agentsText);
  const sessionResponse = await fetch(`${baseUrl}/api/agent/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "analytics-local-run-workspace", title: "local fallback" }) });
  const sessionText = await sessionResponse.text();
  if (sessionResponse.status !== 201) assert.fail(sessionText);
  const session = JSON.parse(sessionText) as { id: string };
  const messageResponse = await fetch(`${baseUrl}/api/agent/sessions/${session.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "analytics-local-run-workspace", text: "complete despite Analytics", clientRequestId: "analytics-local-run-request" }) });
  const messageText = await messageResponse.text();
  if (messageResponse.status !== 201) assert.fail(messageText);
  const message = JSON.parse(messageText) as { runId: string };
  const child = children[0];
  await waitFor(async () => (await fs.readFile(markerPath, "utf8").catch(() => "")) === "target_signal_pending", "execution_started was not pending in the ready Analytics child", 10_000);
  assert.ok(child?.pid);
  process.kill(child.pid!, 0);

  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/agent/sessions/${session.id}/run-state?workspaceId=analytics-local-run-workspace`);
    return response.ok && (await response.json() as { status: string }).status === "idle";
  }, "local fallback Run did not finish", 5_000);
  assert.equal((fixture.db.prepare("SELECT status FROM agent_run WHERE run_id=?").get(message.runId) as { status: string }).status, "completed");
  assert.equal((fixture.db.prepare("SELECT COUNT(*) AS count FROM agent_message WHERE origin_run_id=? AND type='assistant' AND status='completed'").get(message.runId) as { count: number }).count, 1);
  // The business Run completed while its real execution_started Signal remains
  // in-flight in a live Analytics child; no Signal timeout has recovered it.
  assert.equal(await fs.readFile(markerPath, "utf8"), "target_signal_pending");
  process.kill(child.pid!, 0);

  // Deliberately fault Dashboard IPC to initiate child retirement instead of
  // allowing the long Signal timeout to be the mechanism under test.
  const dashboard = await fetch(`${baseUrl}/api/analytics/dashboard/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rangeKind: "preset_7d", timezone: "UTC" }) });
  assert.equal(dashboard.status, 503);
  assert.deepEqual(await dashboard.json(), { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } });
  await waitForPidExit(child.pid!);
});
