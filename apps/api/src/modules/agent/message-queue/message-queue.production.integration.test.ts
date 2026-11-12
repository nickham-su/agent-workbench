import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentTestFixture, createTestWorkspace } from "../testkit/agent-testkit.js";
import { configureDefaultAgentSettings } from "../testkit/agent-integration-testkit.js";
import { createMessageSession } from "../agent-message.store.js";
import { waitForAgentRuntimeReadiness } from "../startup/agent-runtime-readiness.js";
import { AgentRuntime } from "../agent.runtime.js";
import { AgentMessageQueueService } from "./message-queue.service.js";
import type { AgentReceiptResponse, AgentTimelineDeltaResponse } from "@agent-workbench/shared";

function createSession(f: Awaited<ReturnType<typeof createAgentTestFixture>>, workspaceId: string, id = "production-queue") {
  createMessageSession(f.db, { id, workspaceId, title: "Queue production test", kind: "primary", createdAt: 1 });
  return `/api/agent/sessions/${id}`;
}
test("production fallback: public receipts remain sealed before real onListen, then accept and expose authoritative queue identity", async t => {
  const f = await createAgentTestFixture({ withApp: true, listen: false, agentWorkerConcurrency: 0 });
  t.after(() => f.dispose()); assert.ok(f.app);
  await configureDefaultAgentSettings(f.app);
  const workspace = await createTestWorkspace(f);
  const base = createSession(f, workspace.id);
  const input = { workspaceId: workspace.id, clientRequestId: "production-stable", text: "queued production message" };
  const before = await f.app.inject({ method: "POST", url: `${base}/receipts`, payload: input });
  assert.equal(before.statusCode, 503); assert.equal(before.json().code, "AGENT_QUEUE_STOPPING");
  assert.equal((f.db.prepare("select count(*) as n from agent_user_message_receipt").get() as { n: number }).n, 0);
  await f.app.listen({ host: "127.0.0.1", port: 0 }); await waitForAgentRuntimeReadiness(f.app);
  const accepted = await f.app.inject({ method: "POST", url: `${base}/receipts`, payload: input });
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json().receipt.status, "queued");
  assert.deepEqual(accepted.json().queue.inputIdentity, { agentId: "default", providerId: "ppchat", modelId: "gpt-5.2" });
  const replay = await f.app.inject({ method: "POST", url: `${base}/receipts`, payload: input });
  assert.equal(replay.statusCode, 202); assert.equal(replay.json().deduplicated, true);
  assert.equal(replay.json().receipt.id, accepted.json().receipt.id);
  const invalid = await f.app.inject({ method: "POST", url: `${base}/message-queue/stop`, payload: { workspaceId: workspace.id, operationId: "stop", expectedQueueVersion: 0 } });
  assert.equal(invalid.statusCode, 400, "production retains the non-stripping queue compiler");
});
test("production routes retain the application authentication boundary", async t => {
  const f = await createAgentTestFixture({ withApp: true, authToken: "queue-test-auth", agentWorkerConcurrency: 0 });
  t.after(() => f.dispose()); assert.ok(f.app);
  const response = await f.app.inject({ method: "POST", url: "/api/agent/sessions/not-authorized/receipts", payload: { workspaceId: "w", clientRequestId: "r", text: "no access" } });
  assert.equal(response.statusCode, 401);
  assert.equal((f.db.prepare("select count(*) as n from agent_user_message_receipt").get() as { n: number }).n, 0);
});
test("production dispatcher executes fallback and the timeline reports only local_fallback confirmation", async t => {
  const f = await createAgentTestFixture({ withApp: true });
  t.after(() => f.dispose()); assert.ok(f.app);
  await configureDefaultAgentSettings(f.app);
  const workspace = await createTestWorkspace(f);
  const base = createSession(f, workspace.id);
  const response = await f.app.inject({ method: "POST", url: `${base}/receipts`, payload: { workspaceId: workspace.id, clientRequestId: "fallback-receipt", text: "production local echo" } });
  assert.equal(response.statusCode, 202);
  let receipt: AgentReceiptResponse | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const lookup: { statusCode: number; json<T>(): T } = await f.app.inject({ method: "GET", url: `${base}/receipts/by-request?workspaceId=${workspace.id}&clientRequestId=fallback-receipt` });
    assert.equal(lookup.statusCode, 200); receipt = lookup.json<AgentReceiptResponse>();
    if (receipt.receipt.status === "injected" && receipt.receipt.confirmationState === "confirmed") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(receipt); assert.equal(receipt.receipt.status, "injected");
  if (receipt.receipt.status !== "injected") return;
  assert.equal(receipt.receipt.confirmationState, "confirmed"); assert.equal(receipt.receipt.confirmationSource, "local_fallback");
  const timeline = await f.app.inject({ method: "GET", url: `${base}/timeline?workspaceId=${workspace.id}&mode=snapshot` });
  assert.equal(timeline.statusCode, 200);
  const message = timeline.json<AgentTimelineDeltaResponse>().messages.find(item => item.id === receipt!.receipt.messageId);
  assert.deepEqual(message?.inputReceipt, { receiptId: receipt.receipt.id, confirmationState: "confirmed", confirmationSource: "local_fallback" });
});
test("production close does not treat close(false) as a drained publisher; it seals and waits again after exact runtime shutdown", async t => {
  const f = await createAgentTestFixture({ withApp: true });
  t.after(() => f.dispose()); assert.ok(f.app);
  const original = AgentMessageQueueService.prototype.close;
  let closes = 0;
  t.mock.method(AgentMessageQueueService.prototype, "close", async function(this: AgentMessageQueueService, timeout?: number) {
    const settled = await original.call(this, timeout);
    return ++closes === 1 ? false : settled;
  });
  const originalDrain = AgentRuntime.prototype.drain;
  let drains = 0;
  t.mock.method(AgentRuntime.prototype, "drain", async function(this: AgentRuntime, timeout?: number) {
    return ++drains === 1 ? false : originalDrain.call(this, timeout);
  });
  await f.app.close();
  assert.equal(closes, 2); assert.equal(drains, 2, "unproven local exit must also be awaited, not treated as drained");
  assert.equal((f.db.prepare("select 1 as n").get() as { n: number }).n, 1, "application close does not own or close the DB");
});

for (const window of ["starting", "exit"] as const) test(`production Worker ${window} callback suspends scans but not durable receipts; trusted ready reopens once`, async t => {
  const [{ createApp }, { AgentWorkerProcessManager }, { AgentWorkerClient }, { AgentMessageQueueDispatcher },
    { AgentRuntimeControlStore }, { persistRunTerminalIntent, convergeRunTerminal }, { randomUUID }] = await Promise.all([
    import("../../../app/createApp.js"), import("../agent.worker-manager.js"), import("../agent.worker-client.js"),
    import("./message-queue.dispatcher.js"), import("../runtime-control/runtime-control.store.js"),
    import("../agent-message.store.js"), import("node:crypto"),
  ]);
  type Callbacks = ConstructorParameters<typeof AgentWorkerProcessManager>[0];
  let callbacks!: Callbacks; let dispatcher!: InstanceType<typeof AgentMessageQueueDispatcher>;
  let currentId = randomUUID(); let sends = 0;
  // Only the process/transport boundary is replaced. The module's actual
  // callbacks, assembly, HTTP receipt service, SQLite and lifecycle run below.
  t.mock.method(AgentWorkerProcessManager.prototype, "start", async function(this: unknown) {
    callbacks = (this as { params: Callbacks }).params;
  });
  t.mock.method(AgentWorkerProcessManager.prototype, "stop", async () => undefined);
  t.mock.method(AgentWorkerClient.prototype, "getRuntimeIdentity", async () => ({ runtimeInstanceId: currentId, stopProtocolVersion: 1 as const }));
  const start = AgentMessageQueueDispatcher.prototype.start;
  t.mock.method(AgentMessageQueueDispatcher.prototype, "start", function(this: InstanceType<typeof AgentMessageQueueDispatcher>) { dispatcher = this; start.call(this); });
  const f = await createAgentTestFixture({ withApp: true, listen: false, appFactory: ctx => createApp({ ...ctx, agentWorkerEnabled: true }) });
  t.after(() => f.dispose()); assert.ok(f.app);
  await configureDefaultAgentSettings(f.app);
  const workspace = await createTestWorkspace(f); const base = createSession(f, workspace.id);
  const spawn = { pid: null, spawnObservedAt: Date.now(), spawnNonce: randomUUID() };
  const ready = { ...spawn, pid: process.pid };
  callbacks.onRuntimeStarting!(currentId, spawn); await callbacks.onRuntimeReady!(currentId, ready); await callbacks.onReady!(1);
  const firstId = currentId;
  const staleReady = callbacks.onReady!(2);
  const nextSpawn = { ...spawn, spawnNonce: randomUUID() };
  if (window === "starting") { currentId = randomUUID(); callbacks.onRuntimeStarting!(currentId, nextSpawn); }
  else callbacks.onRuntimeExit!(firstId, { ...ready, code: 0, signal: null, observedAt: Date.now() });
  const head = f.db.prepare("select head_message_id,revision from agent_session where id='production-queue'").get();
  const accepted = await f.app.inject({ method: "POST", url: `${base}/receipts`, payload: {
    workspaceId: workspace.id, clientRequestId: `worker-${window}`, text: "accepted while Worker unavailable",
  } });
  assert.equal(accepted.statusCode, 202); assert.equal(accepted.json().receipt.status, "queued");
  await staleReady;
  await dispatcher.scanOnce(); await dispatcher.dispatchSession({ workspaceId: workspace.id, sessionId: "production-queue" });
  const paused = await f.app.inject({ method: "GET", url: `${base}/message-queue?workspaceId=${workspace.id}` });
  assert.equal(paused.json().mode, "active"); assert.equal(paused.json().pendingCount, 1); assert.equal(paused.json().unconfirmedInputCount, 0);
  assert.deepEqual(f.db.prepare("select head_message_id,revision from agent_session where id='production-queue'").get(), head);
  assert.equal((f.db.prepare("select count(*) as n from agent_run").get() as { n: number }).n, 0); assert.equal(sends, 0);
  if (window === "exit") { currentId = randomUUID(); callbacks.onRuntimeStarting!(currentId, nextSpawn); }
  t.mock.method(AgentWorkerClient.prototype, "enqueueRun", async (run: Parameters<InstanceType<typeof AgentWorkerClient>["enqueueRun"]>[0]) => {
    sends++;
    // Deterministic trusted transport completion keeps shutdown independent of
    // a live child process; no production activation/storage behavior is mocked.
    persistRunTerminalIntent(f.db, { ...run, status: "completed", code: "run_completed", detail: null, updatedAt: Date.now() });
    convergeRunTerminal(f.db, { ...run, updatedAt: Date.now() });
    new AgentRuntimeControlStore(f.db).retireAdmission({ ...run, runtimeInstanceId: currentId });
  });
  await callbacks.onRuntimeReady!(currentId, { ...nextSpawn, pid: process.pid }); await callbacks.onReady!(3);
  await dispatcher.scanOnce(); await dispatcher.dispatchSession({ workspaceId: workspace.id, sessionId: "production-queue" });
  assert.equal(sends, 1); assert.equal((f.db.prepare("select count(*) as n from agent_run").get() as { n: number }).n, 1);
  assert.equal((f.db.prepare("select status from agent_user_message_receipt").get() as { status: string }).status, "injected");
  await f.app.close(); await callbacks.onReady!(4);
  assert.equal(await dispatcher.dispatchSession({ workspaceId: workspace.id, sessionId: "production-queue" }), null);
  assert.equal(sends, 1, "late ready cannot reopen a closed production assembly");
});
