import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AGENT_QUEUE_INPUT_POLICY_VERSION } from "@agent-workbench/shared";
import type { AgentApiPromptContextResponse, AgentInteractiveInputBinding } from "@agent-workbench/shared/internal-contracts/agent-api";
import { appendStreamingAssistant, flushStreamingParts, completeAssistantWithExecutions, replaceStreamingAssistant, resumeStreamingAssistant, updateToolExecution, getToolExecution, getMessageSessionHead, getMessage, getRunRecord, createMessageSession, getMessageSession, commitCompactionMessageWithRunFence, convergeRunTerminal, persistRunTerminalIntent, updateMessageRunNotice } from "../agent-message.store.js";
import { ModelContextResolver, projectModelContextToPrompt } from "../read-side/model-context-resolver.js";
import { RuntimeTranscriptProjector, UNKNOWN_TOOL_EXECUTION_RESULT } from "../read-side/runtime-transcript-projector.js";
import { AgentRuntime } from "../agent.runtime.js";
import type { LocalAgentRuntimeExecutionPort } from "../agent.runtime-port.js";
import { AgentInteractiveInputService } from "./interactive-input.service.js";
import { workspaceDeletingFence } from "../lifecycle/workspace-deleting-fence.js";
import { AgentQueueRecoveryStore } from "./queue-recovery.store.js";
import { queuePayloadHash, toQueueReceipt } from "./message-queue.store.js";
import { queueFixture, scope, identity, errorIs } from "./message-queue.testkit.js";

async function fixture(t: TestContext) {
  const f = await queueFixture(t);
  const resolver = new ModelContextResolver(f.db);
  const getContext = async (input: typeof scope & { runId: string }): Promise<AgentApiPromptContextResponse> => {
    const resolved = resolver.resolve(input);
    const projected = projectModelContextToPrompt({ workspaceId: input.workspaceId, triggerMessageId: resolved.run!.triggerMessageId, resolved,
      projector: new RuntimeTranscriptProjector(), stopBeforeAssistantMessageIds: resolved.pendingAssistantMessageIds, includeReplayOnlyAssistants: true });
    return { headMessageId: resolved.headMessageId, sessionRevision: resolved.sessionRevision, system: "trusted test system", messages: projected.messages as AgentApiPromptContextResponse["messages"],
      providerReplay: projected.providerReplay, interactiveInput: resolved.interactiveInput, workspaceRepoNames: [], tools: [], pendingTools: resolved.pendingTools,
      lastResponseTotalTokens: resolved.lastResponseTotalTokens, uiLocale: null, externalSkills: [] };
  };
  const inputs = new AgentInteractiveInputService(f.db, getContext);
  const first = await f.accept("trigger", "initial");
  await f.dispatcher.dispatchSession(scope);
  const runId = f.enqueued[0]!.runId;
  const run = { ...scope, runId };
  const binding = async (): Promise<AgentInteractiveInputBinding> => {
    const context = await getContext(run);
    return { inputReceiptIds: context.interactiveInput!.inputReceiptIds, effectiveInputPolicyVersion: AGENT_QUEUE_INPUT_POLICY_VERSION,
      snapshotHash: queuePayloadHash(context.messages), inputRevision: context.sessionRevision };
  };
  const assistant = async (id = "assistant") => {
    const head = getMessageSessionHead(f.db, scope)!;
    const inputBinding = await binding();
    appendStreamingAssistant(f.db, { ...run, id, expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision, createdAt: Date.now(), inputBinding });
    return { id, inputBinding };
  };
  const text = (messageId = "assistant") => flushStreamingParts(f.db, { ...run, messageId, parts: [{ id: `${messageId}-text`, position: 0, type: "text", text: "done" }], updatedAt: Date.now() });
  const finishFailure = () => { f.finish(runId, "failed"); return f.runtimeStore.retireAdmission({ ...run, runtimeInstanceId: f.runtimeInstanceId }); };
  return { ...f, inputs, run, runId, first: { ...first, receipt: toQueueReceipt(f.store.get(scope, first.receipt.id)) }, getContext, resolver, binding, assistant, text, finishFailure };
}

test("interactive create and input binding commit together; a stale input set/revision rolls back", async t => {
  const f = await fixture(t), head = getMessageSessionHead(f.db, scope)!, original = await f.binding();
  for (const bad of [{ ...original, inputReceiptIds: [] }, { ...original, inputRevision: original.inputRevision + 1 }]) {
    assert.throws(() => appendStreamingAssistant(f.db, { ...f.run, id: "bad", expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision, createdAt: Date.now(), inputBinding: bad }), errorIs(409));
    assert.equal(getMessage(f.db, "bad"), null); assert.deepEqual(getMessageSessionHead(f.db, scope), head);
    assert.equal(f.store.snapshot(scope).unconfirmedInputCount, 1);
  }
  const a = await f.assistant();
  assert.ok(f.db.prepare("select 1 from agent_queue_input_binding where assistant_message_id=? and state='active'").get(a.id));
  assert.equal(resumeStreamingAssistant(f.db, { ...f.run, messageId: a.id, inputBinding: a.inputBinding }), "updated");
  assert.equal(resumeStreamingAssistant(f.db, { ...f.run, messageId: a.id, inputBinding: { ...a.inputBinding, snapshotHash: "0".repeat(64) } }), "ignored");
});

test("two-tool round remains closed to injection until every result; legal completion confirms the bound input atomically", async t => {
  const f = await fixture(t); await f.assistant();
  flushStreamingParts(f.db, { ...f.run, messageId: "assistant", parts: [0, 1].map(position => ({ id: `call-${position}`, position, type: "tool_call" as const, toolName: "read", input: { path: "x" }, providerToolCallId: `provider-${position}` })), updatedAt: Date.now() });
  completeAssistantWithExecutions(f.db, { ...f.run, messageId: "assistant", executions: [0, 1].map(index => ({ id: `execution-${index}`, callPartId: `call-${index}`, originSessionId: scope.sessionId, originRunId: f.runId, status: "queued" as const })), updatedAt: Date.now() });
  assert.equal(f.store.get(scope, f.first.receipt.id).confirmation_state, "confirmed");
  assert.equal(f.store.get(scope, f.first.receipt.id).confirmation_source, "worker_model");
  const snapshot = f.store.snapshot(scope);
  assert.equal(snapshot.pendingCount, 0); assert.equal(snapshot.unconfirmedInputCount, 0);
  assert.deepEqual(snapshot.inputIdentity, identity, "confirmed running Run retains its authoritative input identity");
  const queued = await f.accept("during-tool", "next");
  await assert.rejects(f.inputs.prepare({ ...f.run, operationId: "before-results" }), errorIs(409));
  updateToolExecution(f.db, { ...f.run, executionId: "execution-0", status: "running", updatedAt: Date.now() });
  updateToolExecution(f.db, { ...f.run, executionId: "execution-0", status: "completed", resultPreview: "ok", updatedAt: Date.now() });
  await assert.rejects(f.inputs.prepare({ ...f.run, operationId: "one-result" }), errorIs(409));
  assert.equal(f.store.get(scope, queued.receipt.id).status, "queued");
  updateToolExecution(f.db, { ...f.run, executionId: "execution-1", status: "failed", error: "legal failure", updatedAt: Date.now() });
  const prepared = await f.inputs.prepare({ ...f.run, operationId: "all-results" }); assert.equal(prepared.decision, "prepare");
  assert.deepEqual(prepared.context.messages.map(message => message.role), ["user", "assistant", "tool"]);
  const injected = f.inputs.inject({ ...f.run, operationId: "inject", expectedHeadMessageId: prepared.context.headMessageId, expectedRevision: prepared.context.sessionRevision,
    receiptIds: [queued.receipt.id], preparationSnapshotHash: prepared.preparationSnapshotHash, estimatorVersion: prepared.estimatorVersion });
  assert.equal(injected.receipts[0]!.runId, f.runId);
  assert.deepEqual((await f.getContext(f.run)).messages.map(message => message.role), ["user", "assistant", "tool", "user"]);
});

test("prepare freezes at most eight FIFO candidates; inject replay does not consume later arrivals or duplicate formal users", async t => {
  const f = await fixture(t); for (let index = 0; index < 10; index++) await f.accept(`queued-${index}`, `text-${index}`);
  const prepared = await f.inputs.prepare({ ...f.run, operationId: "prepare" }); assert.equal(prepared.decision, "prepare"); assert.equal(prepared.candidates.length, 8);
  await f.accept("after-snapshot");
  const request = { ...f.run, operationId: "inject", expectedHeadMessageId: prepared.context.headMessageId, expectedRevision: prepared.context.sessionRevision,
    receiptIds: prepared.candidates.map(item => item.receipt.id), preparationSnapshotHash: prepared.preparationSnapshotHash, estimatorVersion: prepared.estimatorVersion };
  const injected = f.inputs.inject(request); assert.equal(injected.queue.pendingCount, 3); assert.equal(injected.queue.unconfirmedInputCount, 9);
  await f.accept("after-commit"); assert.deepEqual(f.inputs.inject(request), { ...injected, queue: f.store.snapshot(scope) });
  assert.throws(() => f.inputs.inject({ ...request, receiptIds: request.receiptIds.slice(1) }), errorIs(409));
  assert.equal((f.db.prepare("select count(*) as n from agent_message where type='user'").get() as { n: number }).n, 9);
});

test("continue is durable; cancellation of every candidate makes prepare finish without an extra model request", async t => {
  const f = await fixture(t); await f.assistant(); f.text(); const queued = await f.accept("before-complete");
  const request = { ...f.run, operationId: "complete", messageId: "assistant", updatedAt: Date.now() };
  const result = f.inputs.complete(request); assert.equal(result.decision, "continue"); assert.equal(getRunRecord(f.db, f.runId)!.executionPhase, "work_pending");
  f.service.cancel(scope, queued.receipt.id);
  assert.deepEqual(f.inputs.complete(request), { ...result, queue: f.store.snapshot(scope) });
  const prepared = await f.inputs.prepare({ ...f.run, operationId: "next-prepare" }); assert.equal(prepared.decision, "finish");
  assert.equal(getRunRecord(f.db, f.runId)!.intendedTerminalStatus, "completed");
  await f.accept("after-finish"); assert.deepEqual(await f.inputs.prepare({ ...f.run, operationId: "next-prepare" }), { ...prepared, queue: f.store.snapshot(scope) });
});

test("finish replay cannot turn into continue when a message arrives after commit", async t => {
  const f = await fixture(t); await f.assistant(); f.text();
  const request = { ...f.run, operationId: "finish", messageId: "assistant", updatedAt: Date.now() };
  const finished = f.inputs.complete(request); assert.equal(finished.decision, "finish");
  await f.accept("later"); assert.deepEqual(f.inputs.complete(request), { ...finished, queue: f.store.snapshot(scope) });
  assert.equal(f.store.snapshot(scope).pendingCount, 1); assert.equal(f.store.snapshot(scope).unconfirmedInputCount, 0);
});

test("retry replacement inherits binding, superseded late completion cannot confirm, replacement replay is strict", async t => {
  const f = await fixture(t), a = await f.assistant();
  const head = getMessageSessionHead(f.db, scope)!;
  const request = { ...f.run, oldMessageId: a.id, newMessageId: "replacement", expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
    inputBinding: { ...a.inputBinding, mode: "retry_same_input" as const }, runNoticeText: "retry", retryCount: 1, nextRetryAt: null, createdAt: Date.now() };
  assert.equal(replaceStreamingAssistant(f.db, request).result, "updated"); assert.equal(replaceStreamingAssistant(f.db, request).result, "updated");
  assert.throws(() => replaceStreamingAssistant(f.db, { ...request, inputBinding: { ...request.inputBinding, snapshotHash: "0".repeat(64) } }), errorIs(409));
  assert.equal(completeAssistantWithExecutions(f.db, { ...f.run, messageId: a.id, executions: [], updatedAt: Date.now() }), "ignored");
  assert.equal(f.store.snapshot(scope).unconfirmedInputCount, 1);
  f.text("replacement"); f.inputs.complete({ ...f.run, operationId: "replacement-complete", messageId: "replacement", updatedAt: Date.now() });
  assert.equal(f.store.snapshot(scope).unconfirmedInputCount, 0);
});

test("resume requires physical retirement, reuses the earliest original User and associates every unconfirmed receipt", async t => {
  const f = await fixture(t); const original = getMessage(f.db, f.first.receipt.messageId!)!;
  f.finish(f.runId, "failed"); const recovery = new AgentQueueRecoveryStore(f.db);
  const input = { ...scope, operationId: "resume", expectedQueueVersion: f.store.snapshot(scope).queueVersion };
  assert.throws(() => recovery.resume(input, "continued", Date.now()), errorIs(409));
  f.runtimeStore.retireAdmission({ ...f.run, runtimeInstanceId: f.runtimeInstanceId });
  const result = recovery.resume(input, "continued", Date.now()); assert.equal(result.activated, true); assert.equal(result.response.action, "continued_unconfirmed");
  assert.equal(getRunRecord(f.db, "continued")!.triggerMessageId, original.id); assert.deepEqual(getMessage(f.db, original.id), original);
  assert.equal(getMessageSession(f.db, scope.workspaceId, scope.sessionId)!.headMessageId, original.id);
  assert.equal(recovery.resume(input, "must-not-exist", Date.now()).activated, false); assert.equal(getRunRecord(f.db, "must-not-exist"), null);
});

test("abandon is full-set/version CAS, does not depend on old profile, preserves Timeline but excludes input in forks", async t => {
  const f = await fixture(t); const queued = await f.accept("still-queued"); f.finishFailure(); f.setProfileError(new Error("profile removed"));
  const snapshot = f.store.snapshot(scope), recovery = new AgentQueueRecoveryStore(f.db);
  const input = { ...scope, operationId: "abandon", expectedQueueVersion: snapshot.queueVersion, expectedUnconfirmedInputSetHash: snapshot.unconfirmedInputSetHash!, confirmIrreversible: true as const };
  assert.throws(() => recovery.abandon({ ...input, expectedUnconfirmedInputSetHash: "0".repeat(64) }), errorIs(409, "AGENT_UNCONFIRMED_SET_CONFLICT"));
  const result = f.service.abandon(scope.sessionId, input); assert.deepEqual(result.abandonedReceiptIds, [f.first.receipt.id]);
  assert.equal(result.queue.pauseCode, "inputs_abandoned"); assert.equal(result.queue.pendingCount, 1); assert.equal(f.store.get(scope, queued.receipt.id).status, "queued");
  assert.ok(getMessage(f.db, f.first.receipt.messageId!));
  createMessageSession(f.db, { id: "fork", ...scope, title: "fork", kind: "primary", createdAt: Date.now(), forkedFromSessionId: scope.sessionId,
    forkedFromMessageId: f.first.receipt.messageId, headMessageId: f.first.receipt.messageId });
  assert.deepEqual(f.resolver.resolve({ workspaceId: scope.workspaceId, sessionId: "fork" }).messages, []);
  f.service.stop(scope, "new-stop");
  const replay = recovery.abandon(input); assert.deepEqual(replay.abandonedReceiptIds, result.abandonedReceiptIds);
  assert.deepEqual(replay.queue, f.store.snapshot(scope)); assert.ok(replay.queue.queueVersion > result.queue.queueVersion);
  assert.equal(replay.queue.pauseCode, "user_stop");
});


test("service resume uses lifecycle admission, links every unconfirmed user without re-insertion, and replay cannot undo a later Stop", async t => {
  const f = await fixture(t);
  const second = await f.accept("unconfirmed-2"), third = await f.accept("unconfirmed-3");
  const prepared = await f.inputs.prepare({ ...f.run, operationId: "prepare-extra" }); assert.equal(prepared.decision, "prepare");
  f.inputs.inject({ ...f.run, operationId: "inject-extra", expectedHeadMessageId: prepared.context.headMessageId,
    expectedRevision: prepared.context.sessionRevision, receiptIds: [second.receipt.id, third.receipt.id],
    preparationSnapshotHash: prepared.preparationSnapshotHash, estimatorVersion: prepared.estimatorVersion });
  f.finishFailure();
  const snapshot = f.store.snapshot(scope), request = { workspaceId: scope.workspaceId, operationId: "resume-service", expectedQueueVersion: snapshot.queueVersion };
  const response = await f.service.resume(scope.sessionId, request);
  assert.equal(response.action, "continued_unconfirmed"); assert.ok(response.runId); assert.notEqual(response.runId, f.runId);
  assert.equal(f.enqueued.length, 2); assert.equal(f.enqueued[1]!.runId, response.runId);
  assert.equal(getRunRecord(f.db, response.runId!)!.triggerMessageId, f.first.receipt.messageId);
  assert.equal((f.db.prepare("select count(*) as n from agent_message where type='user'").get() as { n: number }).n, 3);
  assert.equal((f.db.prepare("select count(*) as n from agent_interactive_run_input where run_id=?").get(response.runId) as { n: number }).n, 3);
  assert.equal(f.store.get(scope, second.receipt.id).injected_run_id, f.runId);
  f.service.stop(scope, "stop-after-resume");
  await f.runtime.reconcileStops();
  const stoppedVersion = f.store.snapshot(scope).queueVersion;
  const replay = await f.service.resume(scope.sessionId, request);
  assert.equal(replay.action, response.action); assert.equal(replay.runId, response.runId);
  assert.deepEqual(replay.queue, f.store.snapshot(scope)); assert.ok(replay.queue.queueVersion > response.queue.queueVersion);
  assert.equal(f.enqueued.length, 2); assert.equal(f.store.snapshot(scope).mode, "paused"); assert.equal(f.store.snapshot(scope).queueVersion, stoppedVersion);
});

for (const winner of ["resume", "abandon"] as const) test(`same-version recovery competition: ${winner} wins and the other operation cannot change it`, async t => {
  const f = await fixture(t); f.finishFailure(); const snapshot = f.store.snapshot(scope);
  const resume = { workspaceId: scope.workspaceId, operationId: "resume-race", expectedQueueVersion: snapshot.queueVersion };
  const abandon = { ...scope, operationId: "abandon-race", expectedQueueVersion: snapshot.queueVersion,
    expectedUnconfirmedInputSetHash: snapshot.unconfirmedInputSetHash!, confirmIrreversible: true as const };
  if (winner === "resume") {
    await f.service.resume(scope.sessionId, resume);
    assert.throws(() => f.service.abandon(scope.sessionId, abandon), errorIs(409));
    assert.equal(f.store.get(scope, f.first.receipt.id).confirmation_state, "unconfirmed");
  } else {
    f.service.abandon(scope.sessionId, abandon);
    await assert.rejects(f.service.resume(scope.sessionId, resume), errorIs(409));
    assert.equal(f.enqueued.length, 1); assert.equal(f.store.get(scope, f.first.receipt.id).confirmation_state, "abandoned");
  }
});

test("service recovery chooses queued-only or unpause-only without creating an empty continuation Run", async t => {
  const f = await queueFixture(t); await f.accept("only-queued"); f.store.pause(scope, "run_failed");
  const queued = await f.service.resume(scope.sessionId, { workspaceId: scope.workspaceId, operationId: "resume-queued", expectedQueueVersion: f.store.snapshot(scope).queueVersion });
  assert.equal(queued.action, "dispatch_queued"); assert.equal(queued.runId, null); assert.equal(f.enqueued.length, 0);
  const pending = f.store.listQueued(scope)[0]!; f.service.cancel(scope, pending.id); f.service.stop(scope, "stop-empty");
  const empty = await f.service.resume(scope.sessionId, { workspaceId: scope.workspaceId, operationId: "resume-empty", expectedQueueVersion: f.store.snapshot(scope).queueVersion });
  assert.equal(empty.action, "unpaused_only"); assert.equal(empty.runId, null); assert.equal(f.enqueued.length, 0);
});

test("profile removal blocks resume but abandon keeps published image retention charged", async t => {
  const f = await queueFixture(t); const image = await f.upload();
  const accepted = await f.service.accept(scope.sessionId, { workspaceId: scope.workspaceId, clientRequestId: "image-trigger", text: "image", images: [image] });
  const activated = await f.dispatcher.dispatchSession(scope); assert.ok(activated);
  f.finish(activated.runId, "failed"); f.runtimeStore.retireAdmission({ ...scope, runId: activated.runId, runtimeInstanceId: f.runtimeInstanceId });
  const snapshot = f.store.snapshot(scope); f.setProfileError(new Error("profile removed"));
  await assert.rejects(f.service.resume(scope.sessionId, { workspaceId: scope.workspaceId, operationId: "missing-profile", expectedQueueVersion: snapshot.queueVersion }), /profile removed/);
  const before = f.db.prepare("select state,byte_size from agent_attachment_publication_intent where receipt_id=?").get(accepted.receipt.id);
  f.service.abandon(scope.sessionId, { workspaceId: scope.workspaceId, operationId: "abandon-image", expectedQueueVersion: snapshot.queueVersion,
    expectedUnconfirmedInputSetHash: snapshot.unconfirmedInputSetHash!, confirmIrreversible: true });
  const after = f.db.prepare("select state,byte_size from agent_attachment_publication_intent where receipt_id=?").get(accepted.receipt.id) as { state: string; byte_size: number };
  assert.ok(before); assert.equal(after.state, "retained"); assert.ok(after.byte_size > 0);
  assert.equal(f.store.get(scope, accepted.receipt.id).confirmation_state, "abandoned");
});

test("persisted interactive operation replay still respects Workspace deletion fencing", async t => {
  const f = await fixture(t); const request = { ...f.run, operationId: "prepare-before-delete" }; await f.inputs.prepare(request);
  workspaceDeletingFence.begin(scope.workspaceId);
  try { await assert.rejects(f.inputs.prepare(request), errorIs(409, "WORKSPACE_DELETING")); }
  finally { workspaceDeletingFence.end(scope.workspaceId); }
});


test("real local fallback continues the same Run and confirms echo-only input as local_fallback", { timeout: 10_000 }, async t => {
  const f = await fixture(t); let reads = 0; const decisions: string[] = []; let queuedId: string | undefined;
  const image = await f.upload();
  const port: Pick<LocalAgentRuntimeExecutionPort, "getPromptContextForRun" | "prepareInteractiveInputFromWorker" | "injectInteractiveInputFromWorker" | "completeInteractiveAssistantFromWorker" | "createStreamingAssistantFromWorker" | "flushAssistantPartsFromWorker" | "persistRunTerminalIntentFromWorker" | "convergeRunTerminalFromWorker" | "updateRunNoticeFromWorker"> = {
    async getPromptContextForRun(input) {
      if (++reads === 2) queuedId = (await f.service.accept(scope.sessionId, { workspaceId: scope.workspaceId, clientRequestId: "fallback-next", text: "echo second", images: [image] })).receipt.id;
      return f.getContext(input);
    },
    prepareInteractiveInputFromWorker: input => f.inputs.prepare(input),
    injectInteractiveInputFromWorker: input => f.inputs.inject(input),
    completeInteractiveAssistantFromWorker: input => { const result = f.inputs.complete(input, "local_fallback"); decisions.push(result.decision); return result; },
    createStreamingAssistantFromWorker(input) {
      const head = getMessageSessionHead(f.db, scope)!;
      const message = appendStreamingAssistant(f.db, { ...input, id: input.messageId, expectedHeadMessageId: head.headMessageId,
        expectedRevision: head.revision, inputSource: "local_fallback" });
      return { message };
    },
    flushAssistantPartsFromWorker: input => ({ result: flushStreamingParts(f.db, input) }),
    persistRunTerminalIntentFromWorker: input => persistRunTerminalIntent(f.db, input),
    convergeRunTerminalFromWorker: input => convergeRunTerminal(f.db, input),
    updateRunNoticeFromWorker: input => ({ result: updateMessageRunNotice(f.db, input) }),
  };
  const runtime = new AgentRuntime(port as LocalAgentRuntimeExecutionPort, { error() {} } as never, 1);
  runtime.enqueueRun({ ...f.enqueued[0]!, runtimeInstanceId: undefined });
  assert.equal(await runtime.drain(5_000), true);
  assert.deepEqual(decisions, ["continue", "finish"]);
  assert.equal(getRunRecord(f.db, f.runId)!.status, "completed");
  assert.ok(queuedId);
  for (const id of [f.first.receipt.id, queuedId]) {
    const receipt = f.store.get(scope, id); assert.equal(receipt.confirmation_state, "confirmed"); assert.equal(receipt.confirmation_source, "local_fallback"); assert.equal(receipt.injected_run_id, f.runId);
  }
  assert.equal((f.db.prepare("select count(*) as n from agent_run").get() as { n: number }).n, 1);
  const resolved = f.resolver.resolve(scope); const echo = resolved.messages.filter(message => message.type === "assistant").at(-1)!;
  const text = echo.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("");
  assert.match(text, /echo second/); assert.match(text, /本地回退仅回显，不执行模型识图/); assert.ok(!text.includes("[object Object]"));
});


test("compaction commit cannot omit or move its retained anchor past the earliest unconfirmed input", async t => {
  const f = await fixture(t); const second = await f.accept("second-unconfirmed");
  const prepared = await f.inputs.prepare({ ...f.run, operationId: "prepare-for-compact" }); assert.equal(prepared.decision, "prepare");
  const injected = f.inputs.inject({ ...f.run, operationId: "inject-for-compact", expectedHeadMessageId: prepared.context.headMessageId,
    expectedRevision: prepared.context.sessionRevision, receiptIds: [second.receipt.id], preparationSnapshotHash: prepared.preparationSnapshotHash, estimatorVersion: prepared.estimatorVersion });
  const input = { ...f.run, id: "illegal-compaction", expectedHeadMessageId: injected.headMessageId, expectedRevision: injected.revision,
    textPartId: "summary", text: "must not hide protected inputs", createdAt: Date.now() };
  assert.equal(commitCompactionMessageWithRunFence(f.db, input), null);
  assert.equal(commitCompactionMessageWithRunFence(f.db, { ...input, retainedFromMessageId: injected.headMessageId }), null);
  assert.equal(getMessage(f.db, input.id), null); assert.equal(f.store.snapshot(scope).unconfirmedInputCount, 2);
});

test("pending or unknown runtime Stop evidence blocks both recovery exits even after DB convergence", async t => {
  const f = await fixture(t); f.service.stop(scope, "stop-before-exits"); await f.runtime.reconcileStops();
  const snapshot = f.store.snapshot(scope); assert.notEqual(snapshot.stop.state, "quiescent");
  await assert.rejects(f.service.resume(scope.sessionId, { workspaceId: scope.workspaceId, operationId: "resume-pending", expectedQueueVersion: snapshot.queueVersion }), errorIs(409));
  assert.throws(() => f.service.abandon(scope.sessionId, { workspaceId: scope.workspaceId, operationId: "abandon-pending", expectedQueueVersion: snapshot.queueVersion,
    expectedUnconfirmedInputSetHash: snapshot.unconfirmedInputSetHash!, confirmIrreversible: true }), errorIs(409));
  assert.equal(f.enqueued.length, 1); assert.equal(f.store.get(scope, f.first.receipt.id).confirmation_state, "unconfirmed");
});


test("only an empty streaming continuation offers reusable recovery metadata; partial Parts require replacement", async t => {
  const f = await fixture(t); const assistant = await f.assistant();
  assert.deepEqual((await f.getContext(f.run)).interactiveInput!.activeAssistantBinding, { messageId: assistant.id, inputBinding: assistant.inputBinding });
  f.text();
  assert.equal((await f.getContext(f.run)).interactiveInput!.activeAssistantBinding, undefined);
  // The claim transaction also fences Parts flushed after an earlier empty-context read.
  assert.equal(resumeStreamingAssistant(f.db, { ...f.run, messageId: assistant.id, inputBinding: assistant.inputBinding }), "ignored");
  assert.ok(f.db.prepare("select 1 from agent_queue_input_binding where assistant_message_id=? and state='active'").get(assistant.id));
});

for (const first of ["inject", "stop"] as const) test(`inject and Stop preserve their committed order: ${first} first`, async t => {
  const f = await fixture(t); const queued = await f.accept("stop-race-input");
  const prepared = await f.inputs.prepare({ ...f.run, operationId: "prepare-stop-race" }); assert.equal(prepared.decision, "prepare");
  const request = { ...f.run, operationId: "inject-stop-race", expectedHeadMessageId: prepared.context.headMessageId,
    expectedRevision: prepared.context.sessionRevision, receiptIds: [queued.receipt.id], preparationSnapshotHash: prepared.preparationSnapshotHash, estimatorVersion: prepared.estimatorVersion };
  if (first === "inject") {
    const injected = f.inputs.inject(request); f.service.stop(scope, "stop-after-inject");
    assert.deepEqual(f.inputs.inject(request), { ...injected, queue: f.store.snapshot(scope) });
    assert.equal(f.store.get(scope, queued.receipt.id).status, "injected"); assert.equal(f.store.get(scope, queued.receipt.id).confirmation_state, "unconfirmed");
  } else {
    f.service.stop(scope, "stop-before-inject"); assert.throws(() => f.inputs.inject(request), errorIs(409));
    assert.equal(f.store.get(scope, queued.receipt.id).status, "cancelled"); assert.equal(f.store.snapshot(scope).pendingCount, 0);
  }
  assert.equal(f.store.snapshot(scope).mode, "paused");
});

test("closing input admission fences an awaited preparation and new injections but keeps completion drain open", async t => {
  const f = await fixture(t), queued = await f.accept("shutdown-input");
  const prepared = await f.inputs.prepare({ ...f.run, operationId: "prepare-before-close" }); assert.equal(prepared.decision, "prepare");
  const injection = { ...f.run, operationId: "inject-after-close", expectedHeadMessageId: prepared.context.headMessageId,
    expectedRevision: prepared.context.sessionRevision, receiptIds: [queued.receipt.id], preparationSnapshotHash: prepared.preparationSnapshotHash, estimatorVersion: prepared.estimatorVersion };
  const context = await f.getContext(f.run);
  let release!: () => void, contextCalls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const inputs = new AgentInteractiveInputService(f.db, async () => { contextCalls++; await gate; return context; });
  const pending = inputs.prepare({ ...f.run, operationId: "prepare-awaiting-shutdown" });
  const assistant = await f.assistant(); f.text();
  const head = getMessageSessionHead(f.db, scope), before = f.store.snapshot(scope);
  const operationCount = f.db.prepare("select count(*) as count from agent_queue_operation").get();
  inputs.closeAdmission(); inputs.closeAdmission();
  await assert.rejects(inputs.prepare({ ...f.run, operationId: "prepare-after-close" }), errorIs(503));
  assert.throws(() => inputs.inject(injection), errorIs(503)); assert.equal(contextCalls, 1);
  release(); await assert.rejects(pending, errorIs(503));
  assert.deepEqual(getMessageSessionHead(f.db, scope), head); assert.deepEqual(f.store.snapshot(scope), before);
  assert.deepEqual(f.db.prepare("select count(*) as count from agent_queue_operation").get(), operationCount);
  assert.equal(f.store.get(scope, queued.receipt.id).status, "queued");
  const completion = { ...f.run, operationId: "complete-during-drain", messageId: assistant.id, updatedAt: Date.now() };
  assert.equal(inputs.complete(completion).decision, "continue");
  assert.equal(f.store.get(scope, f.first.receipt.id).confirmation_state, "confirmed");
  assert.equal(f.store.get(scope, queued.receipt.id).status, "queued");
});


test("resume replay reports later confirmation with the original action/run and no new lifecycle admission", async t => {
  const f = await fixture(t); f.finishFailure();
  const request = { workspaceId: scope.workspaceId, operationId: "resume-before-confirm", expectedQueueVersion: f.store.snapshot(scope).queueVersion };
  const original = await f.service.resume(scope.sessionId, request); assert.ok(original.runId);
  const resumed = { ...scope, runId: original.runId }, context = await f.getContext(resumed);
  const inputBinding: AgentInteractiveInputBinding = { inputReceiptIds: context.interactiveInput!.inputReceiptIds, effectiveInputPolicyVersion: AGENT_QUEUE_INPUT_POLICY_VERSION,
    snapshotHash: queuePayloadHash(context.messages), inputRevision: context.sessionRevision };
  appendStreamingAssistant(f.db, { ...resumed, id: "confirmed-after-resume", expectedHeadMessageId: context.headMessageId, expectedRevision: context.sessionRevision, createdAt: Date.now(), inputBinding });
  flushStreamingParts(f.db, { ...resumed, messageId: "confirmed-after-resume", parts: [{ id: "confirm-text", position: 0, type: "text", text: "done" }], updatedAt: Date.now() });
  f.inputs.complete({ ...resumed, operationId: "confirm-after-resume", messageId: "confirmed-after-resume", updatedAt: Date.now() });
  const before = f.store.snapshot(scope), admissions = f.enqueued.length;
  const replay = await f.service.resume(scope.sessionId, request);
  assert.equal(replay.action, original.action); assert.equal(replay.runId, original.runId);
  assert.deepEqual(replay.queue, before); assert.equal(replay.queue.unconfirmedInputCount, 0); assert.ok(before.queueVersion > original.queue.queueVersion);
  assert.equal(f.enqueued.length, admissions); assert.deepEqual(f.store.snapshot(scope), before);
});

test("prepare singleflight preserves frozen contents with fresh queue and stores no prompt, body or path", async t => {
  const f = await fixture(t); let reads = 0;
  const system = "private-system-" + "x".repeat(64 * 1024);
  const service = new AgentInteractiveInputService(f.db, async input => { reads++; return {...await f.getContext(input),system}; });
  t.after(() => service.closeAdmission());
  const image = await f.upload("frozen-marker-image.png");
  await f.service.accept(scope.sessionId,{workspaceId:scope.workspaceId,clientRequestId:"secret-receipt",text:"private-receipt-body",images:[image]});
  const input = {...f.run,operationId:"frozen"};
  const [first, second] = await Promise.all([service.prepare(input),service.prepare(input)]);
  assert.equal(first.decision,"prepare"); assert.equal(second.decision,"prepare"); assert.equal(reads,1);
  assert.deepEqual(second,first);
  assert.ok(first.candidates[0]!.attachments[0]!.path);
  await f.accept("fresh-arrival","later-body");
  const replay = await service.prepare(input); assert.equal(replay.decision,"prepare");
  assert.deepEqual(replay.context,first.context); assert.deepEqual(replay.candidates,first.candidates);
  assert.equal(replay.queue.pendingCount,2); assert.equal(reads,1);
  for(let index=0;index<6;index++) await service.prepare({...input,operationId:`new-${index}`});
  const rows = f.db.prepare("select result_json from agent_queue_operation").all() as {result_json:string}[];
  for(const row of rows) { assert.ok(row.result_json.length<4000); for(const text of [system,"private-receipt-body","later-body",first.candidates[0]!.attachments[0]!.path,'"context"','"queue"','"candidates"','"path"']) assert.ok(!row.result_json.includes(text),text); }
  assert.equal((await service.prepare(input)).decision,"expired");
});
test("inject replay uses metadata after cache loss and old replay never frees a newer boundary", async t => {
  const f = await fixture(t); await f.accept("to-inject");
  const input = {...f.run,operationId:"prepare-minimal"};
  const prepared = await f.inputs.prepare(input); assert.equal(prepared.decision,"prepare");
  f.inputs.releaseRun(f.run);
  assert.equal((await f.inputs.prepare(input)).decision,"expired");
  const request = {...f.run,operationId:"inject-minimal",expectedHeadMessageId:prepared.context.headMessageId,expectedRevision:prepared.context.sessionRevision,
    receiptIds:prepared.candidates.map(c=>c.receipt.id),preparationSnapshotHash:prepared.preparationSnapshotHash,estimatorVersion:prepared.estimatorVersion};
  const injected = f.inputs.inject(request); // Only authoritative receipts + persistent minimum are required.
  const next = {...f.run,operationId:"next-boundary"};
  const newer = await f.inputs.prepare(next); assert.equal(newer.decision,"prepare");
  assert.deepEqual(f.inputs.inject(request),{...injected,queue:f.store.snapshot(scope)});
  assert.equal((await f.inputs.prepare(next)).decision,"prepare");
  assert.equal((await f.inputs.prepare(input)).decision,"expired");
});
test("no-candidate successful Assistant binding releases frozen preparation; late async prepare cannot publish", async t => {
  const f = await fixture(t), input = {...f.run,operationId:"no-candidates"};
  const prepared = await f.inputs.prepare(input); assert.equal(prepared.decision,"prepare"); assert.equal(prepared.candidates.length,0);
  const assistant = await f.assistant(); f.inputs.releaseBound(f.run,assistant.inputBinding.inputRevision);
  assert.equal((await f.inputs.prepare(input)).decision,"expired");
  const clean = await fixture(t);
  let release!: () => void; const gate = new Promise<void>(resolve => {release=resolve;});
  const service = new AgentInteractiveInputService(clean.db,async request => {const context=await clean.getContext(request);await gate;return context;}); t.after(()=>service.closeAdmission());
  const old = service.prepare({...clean.run,operationId:"late-old"});
  await Promise.resolve(); service.releaseRun(clean.run);
  await assert.rejects(service.prepare({...clean.run,operationId:"new-while-old-pending"}),errorIs(409));
  release(); await assert.rejects(old,errorIs(409));
  assert.equal(clean.db.prepare("select 1 from agent_queue_operation where operation_id='late-old'").get(),undefined);
  assert.equal((await service.prepare({...clean.run,operationId:"new-valid-boundary"})).decision,"prepare");
});
test("finish metadata survives process cache loss, while ordinary legacy prepare is minimized and expired", async t => {
  const f = await fixture(t); const input={...f.run,operationId:"legacy-prepare"};
  const prepared=await f.inputs.prepare(input); assert.equal(prepared.decision,"prepare");
  f.db.prepare("update agent_queue_operation set result_json=? where operation_id=?").run(JSON.stringify({runId:f.runId,response:prepared}),input.operationId);
  const restart=new AgentInteractiveInputService(f.db,f.getContext); t.after(()=>restart.closeAdmission());
  assert.equal((await restart.prepare(input)).decision,"expired");
  assert.ok(!(f.db.prepare("select result_json as json from agent_queue_operation where operation_id=?").get(input.operationId) as {json:string}).json.includes('"context"'));
  await f.assistant(); f.text(); const queued=await f.accept("cancel-before-finish");
  f.inputs.complete({...f.run,operationId:"continue-cache-loss",messageId:"assistant",updatedAt:Date.now()}); f.service.cancel(scope,queued.receipt.id);
  const finishInput={...f.run,operationId:"finish-cache-loss"}; assert.equal((await f.inputs.prepare(finishInput)).decision,"finish");
  await f.accept("after-finish-cache-loss"); const result=await restart.prepare(finishInput);
  assert.equal(result.decision,"finish"); assert.equal(result.queue.pendingCount,1); assert.equal("context" in result,false);
});
test("a failed preparation commit publishes no slot and same operation can retry", async t => {
  const f=await fixture(t), input={...f.run,operationId:"rollback-prepare"};
  f.db.exec("create temp trigger reject_prepare before insert on agent_queue_operation when new.kind='prepare' begin select raise(abort,'test commit failure'); end");
  await assert.rejects(f.inputs.prepare(input),/test commit failure/);
  assert.equal(f.db.prepare("select 1 from agent_queue_operation where operation_id=?").get(input.operationId),undefined);
  f.db.exec("drop trigger reject_prepare");
  assert.equal((await f.inputs.prepare(input)).decision,"prepare");
});

test("cache loss and a new prepare respect Stop; old ordinary operation only replays expired",async t=>{
  const f=await fixture(t),request={...f.run,operationId:"old-before-stop"};
  assert.equal((await f.inputs.prepare(request)).decision,"prepare");f.inputs.releaseRun(f.run);
  f.runtime.stopSession({...scope,rootSessionId:scope.sessionId,operationId:"stop-after-cache-loss"});
  const replay=await f.inputs.prepare(request);assert.equal(replay.decision,"expired");assert.equal(replay.queue.stop.state,"pending");
  await assert.rejects(f.inputs.prepare({...request,operationId:"new-after-stop"}),errorIs(409));
  assert.equal(f.db.prepare("select 1 from agent_queue_operation where operation_id='new-after-stop'").get(),undefined);
});

test("fallback real finally retries a failed local retirement without retaining execution or losing the queued wake",async t=>{
  const f=await fixture(t);let attempts=0,executions=0;
  const local=new AgentRuntime({} as LocalAgentRuntimeExecutionPort,{error(){},warn(){}} as any,1,undefined,{
    runtimeInstanceId:f.runtimeInstanceId,bindingMatches:()=>true,admissionAllowed:()=>true,
    onRunQuiescent:run=>{if(++attempts<=3) throw new Error("local SQLite temporarily busy");return f.runtimeStore.retireAdmission({...run,runtimeInstanceId:f.runtimeInstanceId});},
  });
  let exited!:()=>void; const exitGate=new Promise<void>(resolve=>{exited=resolve;});
  (local as any).processRun=async()=>{
    executions++; const assistant=await f.assistant(); f.text();
    f.inputs.complete({...f.run,operationId:"fallback-test-finish",messageId:assistant.id,updatedAt:Date.now()});
    f.finish(f.runId); exited();
  };
  await f.accept("arrived-before-fallback-finally");
  local.enqueueRun({...f.run,workspacePath:f.workspacePath,workspaceRepoDirNames:[],inputText:"initial"});
  await exitGate;
  await assert.rejects(f.accept("arrived-after-fallback-finally"),errorIs(409,"AGENT_QUEUE_EXECUTION_NOT_DRAINED"));
  assert.equal(await local.drain(3000),true);assert.equal(attempts,4);assert.equal(executions,1);assert.equal(local.quiescent,true);
  assert.ok(await f.dispatcher.dispatchSession(scope));assert.equal(f.enqueued.length,2);
});

test("oversized prepare persists only a stable rejected tombstone; replay is fresh and survives restart", async t => {
  const f = await fixture(t); let reads = 0;
  const service = new AgentInteractiveInputService(f.db, async input => { reads++; return { ...await f.getContext(input), system: "x".repeat(16 * 1024 * 1024) }; });
  t.after(() => service.closeAdmission());
  const request = { ...f.run, operationId: "oversized" }, rejected = await service.prepare(request);
  assert.equal(rejected.decision, "rejected"); if (rejected.decision !== "rejected") assert.fail();
  assert.equal(rejected.reason, "snapshot_too_large"); assert.equal("context" in rejected, false);
  const queued = await f.accept("after-rejection");
  for (let i = 0; i < 8; i++) assert.equal((await service.prepare(request)).queue.pendingCount, 1);
  assert.equal(reads, 1); assert.equal((service as any).frozen.bytes, 0);
  const row = f.db.prepare("select result_json as json from agent_queue_operation where operation_id=?").get(request.operationId) as { json: string };
  assert.deepEqual(JSON.parse(row.json), { runId: f.runId, response: { operationId: request.operationId, decision: "rejected", reason: "snapshot_too_large" } });
  const restarted = new AgentInteractiveInputService(f.db, async () => { throw new Error("must not rebuild rejected content"); });
  t.after(() => restarted.closeAdmission()); assert.deepEqual(await restarted.prepare(request), await service.prepare(request));
  assert.equal(f.store.get(scope, f.first.receipt.id).confirmation_state, "unconfirmed");
  assert.equal(f.store.get(scope, queued.receipt.id).status, "queued");
});

test("capacity rejection rolls back on failed COMMIT, preserves old preparation and never overwrites tombstones", async t => {
  const f = await fixture(t), oldRequest = { ...f.run, operationId: "old-frozen" };
  const original = await f.inputs.prepare(oldRequest); let reads = 0;
  // Use this very cache so a rejected replacement must preserve its previous slot.
  (f.inputs as any).getContext = async (input: typeof f.run) => { reads++; return { ...await f.getContext(input), system: "x".repeat(16 * 1024 * 1024) }; };
  const request = { ...f.run, operationId: "rejected-rollback" };
  // Deferred FK checks fail at COMMIT, after the rejected record was successfully inserted.
  f.db.exec(`create temp table rejected_commit_parent(id integer primary key);
    create temp table rejected_commit_child(id integer references rejected_commit_parent(id) deferrable initially deferred);
    create temp trigger reject_capacity after insert on agent_queue_operation when new.operation_id='rejected-rollback'
    begin insert into rejected_commit_child values(1); end`);
  await assert.rejects(f.inputs.prepare(request), /FOREIGN KEY constraint failed/);
  assert.equal(f.db.prepare("select 1 from agent_queue_operation where operation_id=?").get(request.operationId), undefined);
  assert.deepEqual(await f.inputs.prepare(oldRequest), original); assert.equal(reads, 1);
  f.db.exec("drop trigger reject_capacity");
  assert.equal((await f.inputs.prepare(request)).decision, "rejected");
  assert.deepEqual(await f.inputs.prepare(oldRequest), original); assert.equal(reads, 2);
  f.inputs.releaseRun(f.run); assert.equal((await f.inputs.prepare(oldRequest)).decision, "expired");
  assert.equal((await f.inputs.prepare(request)).decision, "rejected"); assert.equal(reads, 2);
});

test("global cache backpressure persists minimal rejection, keeps 128MiB slots and finish replay", async t => {
  const f = await fixture(t), cache = (f.inputs as any).frozen;
  const request = { ...f.run, operationId: "before-full" }, prepared = await f.inputs.prepare(request);
  (f.inputs as any).releaseEndedRuns = () => {};
  const max = 16 * 1024 * 1024, value = "x".repeat(max - 2);
  // Seven full slots plus the exact remaining space fill the real cache, without evicting this Run.
  for (let index = 0; index < 7; index++) cache.stage(`other-${index}`, "op", value)();
  cache.stage("remainder", "op", "x".repeat(128 * 1024 * 1024 - cache.bytes - 2))();
  assert.equal(cache.bytes, 128 * 1024 * 1024);
  // A replacement is charged net of its own old slot; make the new payload larger than that slot.
  (f.inputs as any).getContext = async (input: typeof f.run) => ({ ...await f.getContext(input), system: "larger".repeat(1000) });
  const rejected = await f.inputs.prepare({ ...f.run, operationId: "global-full" });
  assert.equal(rejected.decision, "rejected"); if (rejected.decision !== "rejected") assert.fail();
  assert.equal(rejected.reason, "cache_capacity"); assert.equal(cache.bytes, 128 * 1024 * 1024);
  assert.equal(cache.get("other-0", "op"), value); assert.deepEqual(await f.inputs.prepare(request), prepared);
  // Finish bypasses snapshot capacity and its tombstone continues to replay even after cache loss.
  await f.assistant(); f.text(); const next = await f.accept("cancel-for-finish");
  f.inputs.complete({ ...f.run, operationId: "continue-full", messageId: "assistant", updatedAt: Date.now() }); f.service.cancel(scope, next.receipt.id);
  const finish = { ...f.run, operationId: "finish-full" };
  assert.equal((await f.inputs.prepare(finish)).decision, "finish");
  cache.stage("refill", "op", "x".repeat(128 * 1024 * 1024 - cache.bytes - 2))();
  assert.equal((await f.inputs.prepare(finish)).decision, "finish");
  assert.equal((await f.inputs.prepare(request)).decision, "expired");
  assert.equal((await f.inputs.prepare({ ...f.run, operationId: "global-full" })).decision, "rejected");
});

test("in-flight admission cap yields durable cache_capacity without reading context", async t => {
  const f = await fixture(t), flights = (f.inputs as any).flights;
  for (let i = 0; i < 1024; i++) flights.set(`placeholder-${i}`, { invalid: false });
  // Avoid manufacturing invalid run-key cleanup entries: only the count matters for this boundary.
  (f.inputs as any).releaseEndedRuns = () => {};
  (f.inputs as any).getContext = async () => { throw new Error("must not assemble over admission cap"); };
  const request = { ...f.run, operationId: "flights-full" }, result = await f.inputs.prepare(request);
  assert.equal(result.decision, "rejected"); if (result.decision !== "rejected") assert.fail();
  assert.equal(result.reason, "cache_capacity"); flights.clear();
  assert.deepEqual(await f.inputs.prepare(request), result);
});

for (const reason of ["snapshot_too_large", "cache_capacity"] as const) test(`fallback ${reason} pauses and fails once, preserving unconfirmed/queued inputs`, async t => {
  const f = await fixture(t), queued = await f.accept("fallback-rejected-queued"); let prepares = 0, creates = 0, retired = 0;
  const service = new AgentInteractiveInputService(f.db, async input => ({ ...await f.getContext(input), system: "x".repeat(16 * 1024 * 1024) }));
  t.after(() => service.closeAdmission());
  if (reason === "cache_capacity") {
    (service as any).releaseEndedRuns = () => {};
    for (let i = 0; i < 1024; i++) (service as any).flights.set(`placeholder-${i}`, { invalid: false });
  }
  const port = {
    getPromptContextForRun: (input: typeof f.run) => f.getContext(input),
    prepareInteractiveInputFromWorker: (input: Parameters<typeof service.prepare>[0]) => { prepares++; return service.prepare(input); },
    injectInteractiveInputFromWorker: () => { throw new Error("no injection expected"); },
    completeInteractiveAssistantFromWorker: () => { throw new Error("no completion expected"); },
    createStreamingAssistantFromWorker: () => { creates++; throw new Error("no Assistant should be created"); },
    updateRunNoticeFromWorker: (input: Parameters<typeof updateMessageRunNotice>[1]) => ({ result: updateMessageRunNotice(f.db, input) }),
    persistRunTerminalIntentFromWorker: (input: Parameters<typeof persistRunTerminalIntent>[1]) => persistRunTerminalIntent(f.db, input),
    convergeRunTerminalFromWorker: (input: Parameters<typeof convergeRunTerminal>[1]) => convergeRunTerminal(f.db, input),
  };
  const runtime = new AgentRuntime(port as unknown as LocalAgentRuntimeExecutionPort, { error() {}, warn() {} } as never, 1, undefined, {
    runtimeInstanceId: f.runtimeInstanceId, bindingMatches: () => true, admissionAllowed: () => true,
    onRunQuiescent: run => { retired++; service.releaseRun(run); return f.runtimeStore.retireAdmission({ ...run, runtimeInstanceId: f.runtimeInstanceId }); },
  });
  runtime.enqueueRun({ ...f.enqueued[0]!, runtimeInstanceId: undefined });
  assert.equal(await runtime.drain(5000), true); assert.equal(runtime.quiescent, true);
  assert.equal(prepares, 1); assert.equal(creates, 0); assert.equal(retired, 1);
  assert.equal(getRunRecord(f.db, f.runId)!.status, "failed");
  const snapshot = f.store.snapshot(scope); assert.equal(snapshot.mode, "paused");
  assert.equal(snapshot.pauseCode, reason === "snapshot_too_large" ? "prepare_snapshot_too_large" : "prepare_cache_capacity");
  assert.equal(f.store.get(scope, f.first.receipt.id).confirmation_state, "unconfirmed");
  assert.equal(f.store.get(scope, queued.receipt.id).status, "queued");
  assert.equal(await f.dispatcher.dispatchSession(scope), null);
});

test("oversized content at a stale head cannot mint a rejected operation", async t => {
  const f = await fixture(t); let staleHead = true;
  const service = new AgentInteractiveInputService(f.db, async input => ({ ...await f.getContext(input),
    ...(staleHead ? { headMessageId: "stale-head" } : {}), system: "x".repeat(16 * 1024 * 1024) }));
  t.after(() => service.closeAdmission()); const request = { ...f.run, operationId: "capacity-stale-head" };
  await assert.rejects(service.prepare(request), errorIs(409, "AGENT_INTERACTIVE_INPUT_STALE"));
  assert.equal(f.db.prepare("select 1 from agent_queue_operation where operation_id=?").get(request.operationId), undefined);
  staleHead = false; assert.equal((await service.prepare(request)).decision, "rejected");
});

for (const ending of ["failed", "stopped"] as const) for (const action of ["send", "resume"] as const)
test(`${action} after ${ending} Run preserves unknown tool outcomes and requires physical retirement`, async t => {
  const f = await fixture(t); await f.assistant();
  flushStreamingParts(f.db, { ...f.run, messageId: "assistant", parts: [{ id: "interrupted-call", position: 0, type: "tool_call", toolName: "bash", input: { command: "fixture" } }], updatedAt: Date.now() });
  completeAssistantWithExecutions(f.db, { ...f.run, messageId: "assistant", executions: [{ id: "interrupted-execution", callPartId: "interrupted-call", originSessionId: scope.sessionId, originRunId: f.runId, status: "queued" }], updatedAt: Date.now() });
  updateToolExecution(f.db, { ...f.run, executionId: "interrupted-execution", status: "running", updatedAt: Date.now() });
  const recover = () => action === "send" ? f.accept("after-interruption") : f.service.resume(scope.sessionId, {
    workspaceId: scope.workspaceId, operationId: "resume-after-interruption", expectedQueueVersion: f.store.snapshot(scope).queueVersion,
  });
  const assertBlocked = async (code: string) => {
    const before = f.store.snapshot(scope);
    await assert.rejects(recover(), errorIs(409, code));
    assert.deepEqual(f.store.snapshot(scope), before); assert.equal(f.enqueued.length, 1);
  };
  if (ending === "stopped") {
    const { record } = f.runtime.stopSession({ workspaceId: scope.workspaceId, rootSessionId: scope.sessionId, operationId: "stop-tool", clearQueued: true });
    await assertBlocked("AGENT_SESSION_STOP_PENDING");
    f.runtimeStore.markGroupUnknown(record, f.runtimeInstanceId, "transport_unavailable");
    await assertBlocked("AGENT_SESSION_STOP_UNKNOWN");
    f.runtimeStore.confirmStopGroup(record, f.runtimeInstanceId, {
      workspaceId: scope.workspaceId, rootSessionId: scope.sessionId, operationId: record.operationId,
      runtimeInstanceId: f.runtimeInstanceId, targetsHash: record.targetsHash, state: "quiescent", proofId: "tool-stop-proof", code: null,
    });
    assert.equal(f.store.snapshot(scope).stop.state, "quiescent");
  } else {
    f.finish(f.runId, "failed");
    await assertBlocked("AGENT_QUEUE_EXECUTION_NOT_DRAINED");
    assert.equal(f.runtimeStore.retireAdmission({ ...f.run, runtimeInstanceId: f.runtimeInstanceId }).retired, true);
  }
  assert.equal(getToolExecution(f.db, "interrupted-execution")!.status, "unknown");
  assert.equal(f.store.hasUndrainedExecution(scope), false);
  await recover();
  if (action === "resume") await f.accept("after-interruption");
  assert.equal(f.store.snapshot(scope).mode, "active");
  assert.ok(await f.dispatcher.dispatchSession(scope));
  assert.equal(f.enqueued.length, 2);
  const next = f.enqueued[1]!; assert.notEqual(next.runId, f.runId);
  const context = await f.getContext(next);
  assert.deepEqual(context.pendingTools, []);
  assert.ok(JSON.stringify(context.messages).includes(JSON.stringify(UNKNOWN_TOOL_EXECUTION_RESULT)));
  const execution = getToolExecution(f.db, "interrupted-execution")!;
  assert.equal(updateToolExecution(f.db, { ...f.run, executionId: execution.id, status: "completed", resultPreview: "late result", updatedAt: Date.now() }), "ignored");
  assert.deepEqual(getToolExecution(f.db, execution.id), execution);
});

test("send continuation binds every unconfirmed input in chain order and cannot change their identity", async t => {
  const f = await fixture(t), second = await f.accept("second-original");
  const prepared = await f.inputs.prepare({ ...f.run, operationId: "multi-original-prepare" }); assert.equal(prepared.decision, "prepare");
  const injected = f.inputs.inject({ ...f.run, operationId: "multi-original-inject", expectedHeadMessageId: prepared.context.headMessageId,
    expectedRevision: prepared.context.sessionRevision, receiptIds: [second.receipt.id], preparationSnapshotHash: prepared.preparationSnapshotHash, estimatorVersion: prepared.estimatorVersion });
  const originals = [f.first.receipt.id, injected.receipts[0]!.id];
  f.finishFailure(); const before = f.store.snapshot(scope);
  await assert.rejects(f.service.accept(scope.sessionId, { ...scope, clientRequestId: "conflicting-recovery-send", text: "wrong identity", agentId: "different-agent" }), errorIs(409, "AGENT_QUEUE_AGENT_CONFLICT"));
  assert.deepEqual(f.store.snapshot(scope), before);
  const next = await f.accept("send-after-two-unconfirmed"), continuation = f.enqueued.at(-1)!;
  assert.notEqual(continuation.runId, f.runId); assert.equal(next.receipt.status, "queued");
  assert.deepEqual(f.db.prepare("select i.receipt_id from agent_interactive_run_input i join agent_user_message_receipt r on r.id=i.receipt_id where i.run_id=? order by r.sequence").all(continuation.runId), originals.map(receipt_id => ({ receipt_id })));
  assert.equal((f.db.prepare("select count(*) as n from agent_message where type='user'").get() as { n: number }).n, 2);
  assert.equal(getRunRecord(f.db, continuation.runId)!.triggerMessageId, f.first.receipt.messageId);
});
