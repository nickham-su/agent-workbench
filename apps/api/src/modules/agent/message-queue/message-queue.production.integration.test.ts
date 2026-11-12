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
  assert.equal(accepted.json().receipt.status, "injected");
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
test("production explicit send executes fallback and the timeline reports only local_fallback confirmation", async t => {
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
