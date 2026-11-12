import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentComposition } from "../agent.composition.js";
import { createMessageSession } from "../agent-message.store.js";
import { createAgentTestFixture, createTestWorkspace } from "../testkit/agent-testkit.js";
import { configureDefaultAgentSettings } from "../testkit/agent-integration-testkit.js";
import { AgentRuntimeControlStore } from "../runtime-control/runtime-control.store.js";
import { AgentRuntimeControlService } from "../runtime-control/runtime-control.service.js";
import { setSettingJson } from "../../settings/settings.store.js";
import { getAgentProvidersSettingsInternal } from "../../settings/settings.service.js";
import { errorIs } from "./message-queue.testkit.js";

test("production exposes receipts while an independent composition factory stays dormant and revalidates profiles", async t => {
  const f = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  t.after(() => f.dispose()); assert.ok(f.app);
  await configureDefaultAgentSettings(f.app);
  const workspace = await createTestWorkspace(f);
  createMessageSession(f.db, { id: "queue-profile", workspaceId: workspace.id, title: "Profile", kind: "primary", createdAt: 1 });
  const composition = createAgentComposition(f.ctx, f.app.log);
  t.after(() => composition.dispose());
  const runtime = new AgentRuntimeControlService(new AgentRuntimeControlStore(f.db), {
    enqueueRun: () => undefined, cancelSession: () => undefined,
    stopRunsAndWait: async () => { throw new Error("No runtime targets"); },
  });
  t.after(() => runtime.close());
  runtime.ready((f.db.prepare("select runtime_instance_id as id from agent_runtime_instance where state='ready'").get() as { id: string }).id);
  const queue = composition.createMessageQueue(runtime); t.after(() => queue.close());
  const input = { workspaceId: workspace.id, clientRequestId: "profile", text: "hello" };
  await assert.rejects(queue.service.accept("queue-profile", input), errorIs(503));
  // Explicit isolated opt-in only; production is already open after real onListen.
  queue.service.recoverPublications(); queue.service.openAdmission();
  const accepted = await queue.service.accept("queue-profile", input);
  assert.deepEqual(accepted.queue.inputIdentity, { agentId: "default", providerId: "ppchat", modelId: "gpt-5.2" });
  assert.equal((await f.app.inject({ method: "POST", url: "/api/agent/sessions/queue-profile/receipts", payload: input })).statusCode, 202);
  const settings = getAgentProvidersSettingsInternal(f.ctx);
  setSettingJson(f.db, "agent_providers_v1", { ...settings, providers: [] }, Date.now());
  assert.equal((await queue.service.accept("queue-profile", input)).deduplicated, true);
  await assert.rejects(queue.service.accept("queue-profile", { ...input, clientRequestId: "new", targetRunId: accepted.receipt.runId }), errorIs(400));
});

for (const mode of ["cold", "warm", "disposed"] as const) test(`composition closes interactive injection admission without reopening a ${mode} service`, async t => {
  const f = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  t.after(() => f.dispose()); assert.ok(f.app);
  const composition = createAgentComposition(f.ctx, f.app.log); t.after(() => composition.dispose());
  const runtime = new AgentRuntimeControlService(new AgentRuntimeControlStore(f.db), {
    enqueueRun: () => { throw new Error("Shutdown test must not enqueue"); }, cancelSession: () => undefined,
    stopRunsAndWait: async () => { throw new Error("No runtime targets"); },
  });
  t.after(() => runtime.close());
  const request = { workspaceId: "closed-workspace", sessionId: "closed-session", runId: "closed-run", operationId: "closed-prepare" };
  if (mode === "warm") await assert.rejects(composition.service.prepareInteractiveInputFromWorker(request), errorIs(404));
  if (mode === "disposed") composition.dispose();
  else {
    const queue = composition.createMessageQueue(runtime);
    const closing = queue.close();
    // The shared input gate closes synchronously, not after publication/scanner waits.
    await assert.rejects(composition.service.prepareInteractiveInputFromWorker(request), errorIs(503, "AGENT_QUEUE_STOPPING"));
    assert.equal(await closing, true); queue.openAfterRuntimeRecovery();
  }
  await assert.rejects(composition.service.prepareInteractiveInputFromWorker(request), errorIs(503, "AGENT_QUEUE_STOPPING"));
  assert.throws(() => composition.service.injectInteractiveInputFromWorker({ ...request, operationId: "closed-inject", expectedHeadMessageId: null,
    expectedRevision: 0, receiptIds: ["never-injected"], preparationSnapshotHash: "0".repeat(64), estimatorVersion: "queue-input-estimator-v1" }), errorIs(503, "AGENT_QUEUE_STOPPING"));
});
