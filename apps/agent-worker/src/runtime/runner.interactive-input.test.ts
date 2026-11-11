import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AGENT_QUEUE_INPUT_POLICY_VERSION, projectEffectiveUserContent } from "@agent-workbench/shared";
import type { AgentInteractiveInputBinding } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { ExecutionProfile, PromptContext } from "./apiClient.js";
import { ApiConflictError, InternalRpcNetworkError, InternalRpcInvalidResponseError, InternalRpcHttpError } from "./apiClient.js";
import { QueueInputBudgetError } from "./queue-input-budget.js";
import { AgentRunner } from "./runner.js";
import { runtimeStopTargetsHash } from "@agent-workbench/shared/node/agent-run-stop";
import type { ResolvedToolDefinition } from "./tools/types.js";

type Deps = NonNullable<ConstructorParameters<typeof AgentRunner>[4]>;
const logger = { info() {}, warn() {}, error() {} };
const run = { workspaceId: "w", sessionId: "s", runId: "run", workspacePath: process.cwd(), workspaceRepoDirNames: [], inputText: "initial" };
function context(): PromptContext {
  return { headMessageId: "user", sessionRevision: 1, system: "trusted system", messages: [{ role: "user", content: "initial" }],
    tools: [], pendingTools: [], lastResponseTotalTokens: null, uiLocale: null, externalSkills: [], workspaceRepoNames: [], providerReplay: [],
    interactiveInput: { version: AGENT_QUEUE_INPUT_POLICY_VERSION, interactive: true, inputReceiptIds: ["receipt"],
      inputs: [{ receiptId: "receipt", messageId: "user", state: "unconfirmed", currentRunInput: true, attachments: [] }] } };
}
function profile(npm = "@ai-sdk/anthropic"): ExecutionProfile {
  return { model: { id: "model", contextWindowTokens: 100_000, options: {} }, provider: { id: "provider", npm, options: {} },
    agent: { tools: [], pluginTools: [], mcpServers: [] }, runtime: { modelIdleTimeoutMs: 0, modelTotalTimeoutMs: 0,
      modelRequestMaxRetries: 1, modelRequestRetryBackoffMaxMs: 1 } } as unknown as ExecutionProfile;
}
function fixture(input: { ctx?: PromptContext; failures?: number; providerError?: Error; responseKind?: "text" | "reasoning" | "replay-only" | "empty"; attachmentStorage?: Deps["attachmentStorage"] } = {}) {
  const ctx = input.ctx ?? context();
  const requests: Array<Record<string, unknown>> = [], creates: Array<Record<string, unknown>> = [], replacements: Array<Record<string, unknown>> = [], resumes: Array<Record<string, unknown>> = [];
  let discoveries = 0, prepares = 0, completions = 0, injections = 0;
  const backend = {
    async prepareInteractiveInput() { prepares++; return { decision: "prepare", context: ctx, candidates: [], preparationSnapshotHash: "a".repeat(64), estimatorVersion: "queue-input-estimator-v1" }; },
    async injectInteractiveInput() { injections++; throw new Error("unexpected injection"); },
    async createStreamingAssistant(value: Record<string, unknown>) { creates.push(value); return { result: "created" }; },
    async resumeStreamingAssistant(value: Record<string, unknown>) { resumes.push(value); return { result: "updated" }; },
    async replaceStreamingAssistant(value: Record<string, unknown>) { replacements.push(value); return { result: "updated" }; },
    async flushAssistantParts() { return { result: "updated" }; },
    async completeInteractiveAssistant() { completions++; return { result: "updated", decision: "finish", terminalIntentPersisted: true }; },
    async updateRunNotice() { return { result: "updated" }; },
  };
  const runner = new AgentRunner(backend as unknown as ConstructorParameters<typeof AgentRunner>[0], {} as ConstructorParameters<typeof AgentRunner>[1], logger, 1, {
    preparationRandom: () => 0, modelRetrySleep: async () => true, controlWriteSleep: async () => true,
    ...(input.attachmentStorage ? { attachmentStorage: input.attachmentStorage } : {}),
    streamText: ((request: Record<string, unknown>) => {
      requests.push(request);
      const failed = requests.length <= (input.failures ?? 0);
      return { fullStream: (async function* () {
        if (input.providerError) throw input.providerError;
        if (failed) { yield { type: "text-delta", id: "partial", text: "partial" }; throw new Error("temporary provider failure"); }
        if (input.responseKind === "reasoning") yield { type: "reasoning-delta", id: "reasoning", text: "reasoning only" };
        else if (input.responseKind === "replay-only") {
          yield { type: "reasoning-start", id: "queue-reasoning:0",
            providerMetadata: { openai: { itemId: "queue-reasoning", reasoningEncryptedContent: "queue-opaque-reasoning" } } };
          yield { type: "raw", rawValue: {
            type: "response.completed", response: { output: [
              { type: "reasoning", id: "queue-reasoning", encrypted_content: "queue-opaque-reasoning" },
            ] },
          } };
        }
        else if (input.responseKind !== "empty") yield { type: "text-delta", id: "answer", text: "done" };
        yield { type: "finish-step", finishReason: "stop" };
        yield { type: "finish", finishReason: "stop" };
      })(), usage: Promise.resolve(null), totalUsage: Promise.resolve(null), response: Promise.resolve(null) };
    }) as unknown as NonNullable<Deps["streamText"]>,
  });
  const access = runner as unknown as {
    toolRegistry: { listTools: () => Promise<ResolvedToolDefinition[]> };
    prepareInteractiveModelStep: (input: Record<string, unknown>) => Promise<{ binding: AgentInteractiveInputBinding; budget: { B: number; I: number }; context: PromptContext }>;
    runModelStep: (input: Record<string, unknown>) => Promise<{ interactiveContinue?: boolean; terminalIntentPersisted?: boolean }>;
    executeCompaction: () => Promise<unknown>;
  };
  access.toolRegistry.listTools = async () => { discoveries++; return [{ name: "read", source: "builtin", description: `frozen-${discoveries}`, inputSchema: { type: "object", properties: {} } }]; };
  const prepare = (activeProfile = profile()) => access.prepareInteractiveModelStep({ profile: activeProfile, run, context: ctx, signal: new AbortController().signal, recovering: true });
  const controller = new AbortController();
  const invoke = (activeProfile = profile(), recovering = false, emptyResponseCount = 0) => access.runModelStep({ profile: activeProfile, run, context: ctx, step: 1,
    signal: controller.signal, recoveryContinuation: { messageId: recovering ? "assistant-old" : null }, repeatedToolCallCounter: new Map(), emptyResponseCount });
  return { ctx, backend, access, runner, controller, requests, creates, replacements, resumes, prepare, invoke,
    get discoveries() { return discoveries; }, get prepares() { return prepares; }, get completions() { return completions; }, get injections() { return injections; } };
}

function imageContext(bytes: Uint8Array): PromptContext {
  const ctx = context();
  ctx.messages = [{ role: "user", content: projectEffectiveUserContent({ workspaceId: "w", text: "image", images: [{ attachmentId: "image", filename: "image.png", mediaType: "image/png", path: ".awb/agent/attachments/image.png" }] }) }];
  ctx.interactiveInput!.inputs[0]!.attachments = [{ attachmentId: "image", byteSize: bytes.byteLength, byteSha256: createHash("sha256").update(bytes).digest("hex") }];
  return ctx;
}

test("interactive ordinary retry inherits the binding and uses the same frozen tools and verified image buffer", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  let reads = 0;
  const f = fixture({ ctx: imageContext(bytes), failures: 1, attachmentStorage: { async read() { reads++; return { bytes, mediaType: "image/png" }; } } });
  await f.invoke();
  assert.equal(f.prepares, 1); assert.equal(f.discoveries, 1); assert.equal(reads, 1);
  assert.equal(f.requests.length, 2); assert.equal(f.requests[0]!.messages, f.requests[1]!.messages);
  assert.equal(f.requests[0]!.tools, f.requests[1]!.tools); assert.equal(f.requests[1]!.maxOutputTokens, 4096);
  const binding = f.creates[0]!.inputBinding;
  assert.deepEqual(f.replacements[0]!.inputBinding, { ...(binding as object), mode: "retry_same_input" });
  assert.equal(f.completions, 1);
});

for (const changed of [false, true]) test(`interactive recovery ${changed ? "replaces a changed projection" : "claims the same snapshot and retains the original revision"}`, async () => {
  const f = fixture();
  const prepared = await f.prepare();
  f.ctx.interactiveInput!.activeAssistantBinding = { messageId: "assistant-old", inputBinding: prepared.binding };
  f.ctx.headMessageId = "assistant-old"; f.ctx.sessionRevision = 10;
  // Tool discovery is dynamic, but equal schemas/descriptions must produce an equal snapshot.
  f.access.toolRegistry.listTools = async () => [{ name: "read", source: "builtin", description: "frozen-1", inputSchema: { type: "object", properties: {} } }];
  if (changed) f.ctx.system += " changed";
  await f.invoke(profile(), true);
  assert.equal(f.prepares, 0); assert.equal(f.creates.length, 0);
  if (changed) {
    assert.equal(f.resumes.length, 0); assert.equal(f.replacements.length, 1);
    const binding = f.replacements[0]!.inputBinding as AgentInteractiveInputBinding & { mode: string };
    assert.equal(binding.mode, "recovery_reprepare"); assert.equal(binding.inputRevision, 10);
    assert.notEqual(binding.snapshotHash, prepared.binding.snapshotHash);
  } else {
    assert.equal(f.replacements.length, 0); assert.equal(f.resumes.length, 1);
    assert.deepEqual(f.resumes[0]!.inputBinding, prepared.binding);
  }
});

for (const npm of ["@ai-sdk/moonshotai", "@ai-sdk/deepseek"]) test(`interactive ${npm} recovery replaces partial replay and rebinds the actual snapshot`, async () => {
  const f = fixture();
  const prepared = await f.prepare(profile(npm));
  f.ctx.interactiveInput!.activeAssistantBinding = { messageId: "assistant-old", inputBinding: prepared.binding };
  f.ctx.headMessageId = "assistant-old"; f.ctx.sessionRevision = 10;
  await f.invoke(profile(npm), true);
  assert.equal(f.resumes.length, 0); assert.equal(f.replacements.length, 1);
  assert.equal((f.replacements[0]!.inputBinding as AgentInteractiveInputBinding & { mode: string }).mode, "recovery_reprepare");
  assert.equal((f.replacements[0]!.inputBinding as AgentInteractiveInputBinding).inputRevision, 10);
});

test("interactive provider context limit is finite and never confirms input or retries the model", async () => {
  const error = Object.assign(new Error("context limit"), { code: "context_length_exceeded" });
  const f = fixture({ providerError: error });
  await assert.rejects(f.invoke(), (error: unknown) => error instanceof QueueInputBudgetError && error.pauseCode === "provider_context_too_large");
  assert.equal(f.requests.length, 1); assert.equal(f.replacements.length, 0); assert.equal(f.completions, 0);
});

test("interactive recovery rejects changed image bytes even with the same trusted attachment identity", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const changed = Uint8Array.from(bytes); changed[7] = 11;
  const f = fixture({ ctx: imageContext(bytes), attachmentStorage: { async read() { return { bytes: changed, mediaType: "image/png" }; } } });
  await assert.rejects(f.invoke(profile(), true), (error: unknown) => error instanceof QueueInputBudgetError && error.pauseCode === "attachment_integrity_failed");
  assert.equal(f.requests.length, 0); assert.equal(f.creates.length, 0); assert.equal(f.completions, 0);
});

test("interactive oversized FIFO input is injected in order without estimate-based compaction or rejection", async () => {
  const f = fixture(); let compactions = 0;
  const candidates = [{ receipt: { id: "large" }, text: "x".repeat(100_000), attachments: [] },
    { receipt: { id: "next" }, text: "next", attachments: [] }];
  f.backend.prepareInteractiveInput = async () => ({ decision: "prepare", context: structuredClone(f.ctx), candidates: candidates as never,
    preparationSnapshotHash: "a".repeat(64), estimatorVersion: "queue-input-estimator-v1" });
  Object.assign(f.backend, {
    async injectInteractiveInput(request: { receiptIds: string[]; expectedHeadMessageId: string; expectedRevision: number }) {
      assert.deepEqual(request.receiptIds, ["large", "next"]);
      assert.equal(request.expectedHeadMessageId, "user"); assert.equal(request.expectedRevision, 1);
      f.ctx.messages.push(...candidates.map(candidate => ({ role: "user" as const, content: candidate.text })));
      f.ctx.headMessageId = "message-queued-next"; f.ctx.sessionRevision += candidates.length;
      f.ctx.interactiveInput!.inputReceiptIds.push(...request.receiptIds);
      f.ctx.interactiveInput!.inputs.push(...candidates.map(candidate => ({ receiptId: candidate.receipt.id,
        messageId: `message-queued-${candidate.receipt.id}`, state: "unconfirmed" as const, currentRunInput: true, attachments: [] })));
      return { headMessageId: f.ctx.headMessageId, revision: f.ctx.sessionRevision };
    },
    async getPromptContext() { return f.ctx; },
  });
  f.access.executeCompaction = async () => { compactions++; return { kind: "unavailable" }; };
  const activeProfile = profile(); activeProfile.model.contextWindowTokens = 10_000;
  await f.invoke(activeProfile);
  assert.equal(compactions, 0); assert.equal(f.discoveries, 1);
  assert.equal(f.requests.length, 1); assert.equal(f.creates.length, 1);
  assert.deepEqual((f.creates[0]!.inputBinding as AgentInteractiveInputBinding).inputReceiptIds, ["receipt", "large", "next"]);
});

test("interactive oversized existing context proceeds without input_too_large or compaction", async () => {
  const ctx = context(); ctx.messages = [{ role: "user", content: "x".repeat(100_000) }];
  const f = fixture({ ctx }); let compactions = 0;
  f.access.executeCompaction = async () => { compactions++; return { kind: "unavailable" }; };
  const activeProfile = profile(); activeProfile.model.contextWindowTokens = 10_000;
  await f.invoke(activeProfile);
  assert.equal(compactions, 0); assert.equal(f.requests.length, 1);
});


test("interactive prepare conflicts are retried within a finite preparation budget", async () => {
  const f = fixture(); let calls = 0; const prepare = f.backend.prepareInteractiveInput;
  f.backend.prepareInteractiveInput = async () => { if (++calls === 1) throw new ApiConflictError("head changed"); return prepare(); };
  await f.invoke(); assert.equal(calls, 2); assert.equal(f.requests.length, 1);
  const blocked = fixture(); let blockedCalls = 0;
  blocked.backend.prepareInteractiveInput = async () => { blockedCalls++; throw new ApiConflictError("head keeps changing"); };
  await assert.rejects(blocked.invoke(), /Interactive boundary changed repeatedly/); assert.equal(blockedCalls, 3); assert.equal(blocked.requests.length, 0);
});

test("Stop during prepare response loss never guesses an ordinary model failure", async () => {
  const f = fixture(); f.backend.prepareInteractiveInput = async () => { throw new InternalRpcNetworkError({ method: "POST", endpoint: "/prepare" }); };
  Object.assign(f.access, { controlWriteSleepFn: async () => { f.controller.abort(); return false; } });
  await assert.rejects(f.invoke(), (error: unknown) => error instanceof Error && /completion outcome uncertain/.test(error.message));
  assert.equal(f.creates.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.completions, 0);
});

test("interactive completion response loss replays the exact operation without calling the model again", async () => {
  const f = fixture(); const requests: unknown[] = []; let calls = 0;
  const complete = f.backend.completeInteractiveAssistant;
  Object.assign(f.backend, { async completeInteractiveAssistant(request: unknown) {
    requests.push(request); if (++calls === 1) throw new InternalRpcNetworkError({ method: "POST", endpoint: "/complete" }); return complete();
  } });
  await f.invoke(); assert.equal(calls, 2); assert.deepEqual(requests[0], requests[1]); assert.equal(f.requests.length, 1);
});


for (const same of [true, false]) test(`recovery ${same ? "claim" : "replace"} response loss replays the same identity and binding`, async () => {
  const f = fixture(); const prepared = await f.prepare();
  f.ctx.headMessageId = "assistant-old"; f.ctx.sessionRevision = 10;
  f.ctx.interactiveInput!.activeAssistantBinding = { messageId: "assistant-old", inputBinding: prepared.binding };
  f.access.toolRegistry.listTools = async () => [{ name: "read", source: "builtin", description: "frozen-1", inputSchema: { type: "object", properties: {} } }];
  if (!same) f.ctx.system += " changed";
  const requests: unknown[] = []; let calls = 0;
  const method = same ? "resumeStreamingAssistant" : "replaceStreamingAssistant";
  const original = f.backend[method];
  f.backend[method] = async request => { requests.push(request); if (++calls === 1) throw new InternalRpcNetworkError({ method: "POST", endpoint: "/recovery" }); return original(request); };
  await f.invoke(profile(), true); assert.equal(calls, 2); assert.deepEqual(requests[0], requests[1]); assert.equal(f.requests.length, 1);
});

test("interactive prepare response loss retries the same operation instead of acquiring another candidate snapshot", async () => {
  const f = fixture(); const requests: unknown[] = []; let calls = 0; const prepare = f.backend.prepareInteractiveInput;
  Object.assign(f.backend, { async prepareInteractiveInput(request: unknown) { requests.push(request); if (++calls === 1) throw new InternalRpcNetworkError({ method: "POST", endpoint: "/prepare" }); return prepare(); } });
  await f.invoke(); assert.equal(calls, 2); assert.deepEqual(requests[0], requests[1]); assert.equal(f.requests.length, 1);
});


test("cancelled injection prefix is re-prepared and may finish without a spurious model request", async () => {
  const f = fixture(); let prepares = 0, injections = 0;
  f.backend.prepareInteractiveInput = async () => ({ decision: ++prepares === 1 ? "prepare" : "finish", context: f.ctx,
    candidates: prepares === 1 ? [{ receipt: { id: "cancelled" }, text: "cancelled input", attachments: [] }] as never : [],
    preparationSnapshotHash: "a".repeat(64), estimatorVersion: "queue-input-estimator-v1" });
  f.backend.injectInteractiveInput = async () => { injections++; throw new ApiConflictError("candidate cancelled"); };
  await f.invoke(); assert.equal(prepares, 2); assert.equal(injections, 1); assert.equal(f.requests.length, 0); assert.equal(f.creates.length, 0);
});

test("actual OpenAI opaque replay participates in budget exactly once, not again as a debug copy", async () => {
  const ctx = context(); ctx.messages.push({ role: "assistant", content: "prior answer" });
  const replay = (encryptedContent: string): NonNullable<PromptContext["providerReplay"]> => [{ assistantOrdinal: 1, parts: [{ type: "reasoning", text: "private reasoning", visibleIndex: 0,
    providerReplay: { version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "provider", model: "model" },
      item: { type: "reasoning", itemId: "reasoning-item", encryptedContent } } }] }];
  const opaque = "opaque-original-mark"; ctx.providerReplay = replay(opaque); const f = fixture({ ctx });
  const first = await f.prepare(profile("@ai-sdk/openai"));
  ctx.providerReplay = replay(opaque + "x".repeat(1000)); const second = await f.prepare(profile("@ai-sdk/openai"));
  assert.equal(second.budget.B - first.budget.B, 1000);
  const view = JSON.stringify((first.budget as { view?: unknown }).view);
  assert.equal(view.split(opaque).length - 1, 1);
});


for (const responseKind of ["reasoning", "replay-only"] as const) for (const decision of ["continue", "finish"] as const) {
  test(`interactive ${responseKind === "replay-only" ? "sixth replay-only response without visible text" : "reasoning-only response"} uses atomic ${decision} rather than the legacy terminal path`, async () => {
    const f = fixture({ responseKind });
    const completed: Array<Record<string, unknown>> = [];
    Object.assign(f.backend, { async completeInteractiveAssistant(request: Record<string, unknown>) {
      completed.push(request);
      return { result: "updated", decision, terminalIntentPersisted: decision === "finish" };
    } });
    const result = await f.invoke(profile(responseKind === "replay-only" ? "@ai-sdk/openai" : undefined), false, responseKind === "replay-only" ? 5 : 0);
    assert.equal(result.interactiveContinue, decision === "continue");
    assert.equal(result.terminalIntentPersisted, decision === "finish");
    assert.equal(completed.length, 1); assert.equal(completed[0]!.runId, run.runId);
    assert.equal(typeof completed[0]!.messageId, "string");
    assert.equal(completed[0]!.messageId, f.creates[0]!.messageId);
    assert.equal(f.requests.length, 1); assert.equal(f.creates.length, 1);
    assert.equal(f.replacements.length, 0);
  });
}

test("interactive truly empty response remains a provider failure and cannot confirm input or finish the Run", async () => {
  const f = fixture({ responseKind: "empty" });
  await assert.rejects(f.invoke(profile(), false, 5), /model stream completed without visible text or tool calls/);
  assert.equal(f.completions, 0); assert.equal(f.injections, 0);
  assert.equal(f.ctx.interactiveInput!.inputs[0]!.state, "unconfirmed");
});

for (const decision of ["continue", "finish"] as const) test(`invalid committed ${decision} response replays the original operation without another provider attempt`, async () => {
  const f = fixture(), requests: unknown[] = []; let calls = 0;
  Object.assign(f.backend, { async completeInteractiveAssistant(request: unknown) {
    requests.push(request);
    if (++calls === 1) throw new InternalRpcInvalidResponseError({ method: "POST", endpoint: "/complete", stage: "schema" });
    return { result: "updated", decision, terminalIntentPersisted: decision === "finish" };
  } });
  const result = await f.invoke();
  assert.equal(result.interactiveContinue, decision === "continue"); assert.equal(result.terminalIntentPersisted, decision === "finish");
  assert.equal(calls, 2); assert.deepEqual(requests[0], requests[1]); assert.equal(f.requests.length, 1);
  assert.equal(f.creates.length, 1); assert.equal(f.replacements.length, 0);
});

test("invalid ordinary prepare response replays its operation before any provider/tool budget is consumed", async () => {
  const f = fixture(), requests: unknown[] = []; let calls = 0; const prepare = f.backend.prepareInteractiveInput;
  Object.assign(f.backend, { async prepareInteractiveInput(request: unknown) {
    requests.push(request);
    if (++calls === 1) throw new InternalRpcInvalidResponseError({ method: "POST", endpoint: "/prepare", stage: "body-or-json" });
    return prepare();
  } });
  await f.invoke(); assert.equal(calls, 2); assert.deepEqual(requests[0], requests[1]);
  assert.equal(f.requests.length, 1); assert.equal(f.discoveries, 1); assert.equal(f.creates.length, 1);
});

test("persistent unknown control results outlive finite retry windows with capped backoff and keep one operation", async () => {
  const f = fixture(), requests: unknown[] = [], delays: number[] = []; let calls = 0;
  Object.assign(f.access, { controlWriteSleepFn: async (ms: number) => { delays.push(ms); return true; } });
  Object.assign(f.backend, { async completeInteractiveAssistant(request: unknown) {
    requests.push(request); calls++;
    if (calls === 6) throw new InternalRpcHttpError({ method: "POST", endpoint: "/complete", status: 403 });
    if (calls <= 12) throw calls % 2
      ? new InternalRpcNetworkError({ method: "POST", endpoint: "/complete" })
      : new InternalRpcInvalidResponseError({ method: "POST", endpoint: "/complete", stage: "schema" });
    return { result: "updated", decision: "finish", terminalIntentPersisted: true };
  } });
  await f.invoke(); assert.equal(calls, 13); assert.ok(requests.every(request => JSON.stringify(request) === JSON.stringify(requests[0])));
  assert.deepEqual(delays.slice(0, 7), [100, 200, 400, 800, 1600, 3200, 5000]); assert.ok(delays.every(ms => ms <= 5000));
  assert.equal(f.requests.length, 1); assert.equal(f.replacements.length, 0); assert.equal(f.discoveries, 1);
});


test("exact Stop interrupts an unknown completion in flight and its late continue response cannot revive the tracked Run", async () => {
  const f = fixture();
  let entered!: () => void, release!: (value: { decision: string }) => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const late = new Promise<{ decision: string }>(resolve => { release = resolve; });
  let completions = 0, intents = 0, convergences = 0;
  Object.assign(f.backend, {
    async checkRuntimeAdmission() { return { admitted: true, bindingMatches: true }; },
    async getExecutionProfile() { return profile(); }, async getPromptContext() { return f.ctx; },
    async markRunWorkInProgress() { return { result: "updated" }; },
    async persistRunTerminalIntent() { intents++; },
    async convergeRunTerminal() { convergences++; return { finalStatus: "cancelled" }; },
    async completeInteractiveAssistant() {
      if (++completions === 1) throw new InternalRpcInvalidResponseError({ method: "POST", endpoint: "/complete", stage: "schema" });
      entered(); return late;
    },
  });
  f.runner.enqueueRun(run); await waiting;
  assert.equal(f.runner.analyticsLiveSnapshot().activeCount, 1); assert.equal(f.requests.length, 1);
  const scope = { workspaceId: run.workspaceId, rootSessionId: run.sessionId, operationId: "stop-unknown-completion" };
  const runtimeInstanceId = f.runner.runtimeInstanceId, targets = [{ sessionId: run.sessionId, runId: run.runId }];
  const stop = { ...scope, runtimeInstanceId, targets, timeoutMs: 100,
    targetsHash: runtimeStopTargetsHash({ ...scope, targets: targets.map(target => ({ ...target, runtimeInstanceId })) }) };
  const proof = await f.runner.stopRunsAndWait(stop);
  assert.equal(proof.state, "quiescent"); assert.equal(f.runner.analyticsLiveSnapshot().activeCount, 0);
  assert.equal(intents, 0); assert.equal(convergences, 1);
  release({ decision: "continue" }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1); assert.equal(f.creates.length, 1); assert.equal(completions, 2);
  assert.throws(() => f.runner.enqueueRun(run), /BINDING_MISMATCH/);
  assert.deepEqual(await f.runner.stopRunsAndWait(stop), proof);
});

test("an authoritative expired reply after an unknown prepare switches operation before one model invocation",async()=>{
  const f=fixture();const seen:string[]=[];let calls=0;
  const original=f.backend.prepareInteractiveInput;
  f.backend.prepareInteractiveInput=async (request?:any)=>{
    seen.push(request.operationId);calls++;
    if(calls===1) throw new InternalRpcNetworkError({method:"POST",endpoint:"/prepare"});
    if(calls===2) return {decision:"expired"} as any;
    return original();
  };
  await f.invoke();
  assert.equal(seen.length,3);assert.equal(seen[0],seen[1]);assert.notEqual(seen[1],seen[2]);
  assert.equal(f.requests.length,1);assert.equal(f.completions,1);
});

for (const reason of ["snapshot_too_large", "cache_capacity"] as const) {
  for (const unknown of [false, true]) test(`authoritative rejected ${reason} resolves unknown=${unknown} without invoking a provider`, async () => {
    const f = fixture(), operations: string[] = [];
    Object.assign(f.backend, { async prepareInteractiveInput(request: { operationId: string }) {
      operations.push(request.operationId);
      if (unknown && operations.length === 1) throw new InternalRpcNetworkError({ method: "POST", endpoint: "/prepare" });
      return { operationId: request.operationId, decision: "rejected", reason, queue: {} };
    } });
    await assert.rejects(f.invoke(), error => error instanceof QueueInputBudgetError
      && error.pauseCode === (reason === "snapshot_too_large" ? "prepare_snapshot_too_large" : "prepare_cache_capacity"));
    assert.equal(operations.length, unknown ? 2 : 1);
    assert.ok(operations.every(operation => operation === operations[0]));
    assert.equal(f.requests.length, 0); assert.equal(f.creates.length, 0); assert.equal(f.injections, 0);
  });
}
