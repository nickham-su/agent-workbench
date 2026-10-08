import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";
import {
  AgentRunner,
  getNestedChildrenForTest,
  getNestedParentForTest,
  getRegisteredControllerForTest,
  executeToolForTest,
  executeToolSafelyForTest,
  processNestedRunWithControllerForTest,
  processRunForTest,
} from "./runner.js";
import { AgentApiClient, InternalRpcHttpError, InternalRpcTimeoutError } from "./apiClient.js";

function baseProfile() {
  return {
    model: "openai:gpt-4o-mini",
    provider: { npm: "@ai-sdk/openai", options: {} },
    agent: {
      tools: [],
      pluginTools: [],
      mcpServers: []
    },
    runtime: { modelRequestRetryBackoffMaxMs: 60_000 }
  };
}

test("cancelSessionAndWait 取消队列并等待运行 Session 退出", async () => {
  const runner = new AgentRunner({} as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  const runningController = new AbortController();
  (runner as any).queue.push(makeRun("sess_queued", "run_queued"));
  (runner as any).queuedRunIds.add("run_queued");
  (runner as any).runningSessions.add("sess_running");
  (runner as any).controllers.set("sess_running", runningController);

  assert.equal(await runner.cancelSessionAndWait({ sessionId: "sess_queued", timeoutMs: 10 }), true);
  assert.equal((runner as any).queue.length, 0);

  const waiting = runner.cancelSessionAndWait({ sessionId: "sess_running", timeoutMs: 100 });
  assert.equal(runningController.signal.aborted, true);
  setTimeout(() => {
    (runner as any).runningSessions.delete("sess_running");
    (runner as any).controllers.delete("sess_running");
  }, 10);
  assert.equal(await waiting, true);
});

function baseContext() {
  return {
    pendingTools: [],
    tools: [],
    headMessageId: null,
    sessionRevision: 0,
    system: "",
    messages: [],
    lastResponseTotalTokens: null,
    uiLocale: null,
    externalSkills: []
  };
}

function makeRun(sessionId: string, runId: string) {
  return {
    workspaceId: "ws_test",
    sessionId,
    runId,
    workspacePath: process.cwd(),
    workspaceRepoDirNames: [],
    inputText: "hello"
  };
}

test("processRun cancellation persists and converges one cancelled terminal tuple", async () => {
  const intents: string[] = [];
  const convergences: number[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async updateRunNotice() { return; },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent(input: { status: string }) { intents.push(input.status); return { result: "updated" }; },
    async convergeRunTerminal() { convergences.push(1); return { kind: "transitioned", finalStatus: "cancelled" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  const controller = new AbortController();
  (runner as any).runModelStep = async () => { controller.abort(); return { aborted: true as const, assistantMessageId: "m" }; };
  await processRunForTest(runner, makeRun("sess_test", "run_test"), controller.signal);
  assert.deepEqual(intents, ["cancelled"]);
  assert.equal(convergences.length, 1);
});

test("user and subtask terminal Assistant commits take precedence over a later cancel", async () => {
  for (const runKind of ["user", "subtask"] as const) {
    const controller = new AbortController();
    const intents: string[] = [];
    const convergences: string[] = [];
    const apiClient = {
      async markRunWorkInProgress() { return { result: "updated" }; },
      async getExecutionProfile() { return baseProfile(); },
      async getPromptContext() { return baseContext(); },
      async persistRunTerminalIntent(input: { status: string }) { intents.push(input.status); },
      async convergeRunTerminal() { convergences.push(runKind); return { kind: "transitioned", finalStatus: "completed" }; },
    };
    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    (runner as any).runModelStep = async () => {
      // The terminal Assistant transaction has already atomically persisted
      // completed when cancellation arrives before processRun sees its result.
      controller.abort();
      return { aborted: false, toolCallCount: 0, hasVisibleText: true, terminalIntentPersisted: true };
    };

    await processRunForTest(runner, { ...makeRun(`sess_${runKind}`, `run_${runKind}`), runKind }, controller.signal);
    assert.deepEqual(intents, [], `${runKind} must not write a conflicting cancelled intent`);
    assert.deepEqual(convergences, [runKind]);
  }
});

test("terminal intent success only retries convergence and preserves completed tuple", async () => {
  const intents: string[] = [];
  let convergences = 0;
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async updateRunNotice() { return; },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent(input: { status: string }) { intents.push(input.status); return { result: "updated" }; },
    async convergeRunTerminal() {
      convergences += 1;
      if (convergences === 1) {
        throw new InternalRpcHttpError({ method: "POST", endpoint: "/runs/converge-terminal", status: 503 });
      }
      return { kind: "transitioned", finalStatus: "completed" };
    },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => ({ aborted: false as const, toolCallCount: 0, assistantMessageId: "m", hasVisibleText: true });
  await processRunForTest(runner, makeRun("sess_test", "run_test"), new AbortController().signal);
  assert.deepEqual(intents, ["completed"]);
  assert.equal(convergences, 2);
});

test("terminal-control 对非瞬态 HTTP 错误不重试且不重选 tuple", async () => {
  let intentCalls = 0;
  const statuses: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async updateRunNotice() { return; },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent(input: { status: string }) {
      intentCalls += 1;
      statuses.push(input.status);
      throw new InternalRpcHttpError({ method: "POST", endpoint: "/runs/terminal-intent", status: 400 });
    },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => ({ aborted: false as const, toolCallCount: 0, assistantMessageId: "m", hasVisibleText: true });

  await processRunForTest(runner, makeRun("sess_test", "run_test"), new AbortController().signal);
  assert.equal(intentCalls, 1);
  assert.deepEqual(statuses, ["completed"]);
});

test("长业务后首次 terminal-control 仍获得完整十秒预算", async () => {
  let now = 0;
  const timeoutBudgets: number[] = [];
  let convergenceCalls = 0;
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async updateRunNotice() { return; },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent(_: unknown, options: { timeoutMs: number }) { timeoutBudgets.push(options.timeoutMs); return { result: "updated" }; },
    async convergeRunTerminal(_: unknown, options: { timeoutMs: number }) { timeoutBudgets.push(options.timeoutMs); convergenceCalls += 1; return { kind: "transitioned", finalStatus: "completed" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1, {
    nowMs: () => now,
  });
  (runner as any).runModelStep = async () => {
    now = 60_000;
    return { aborted: false as const, toolCallCount: 0, assistantMessageId: "m", hasVisibleText: true };
  };

  await processRunForTest(runner, makeRun("sess_test", "run_test"), new AbortController().signal);
  assert.deepEqual(timeoutBudgets, [10_000, 10_000]);
  assert.equal(convergenceCalls, 1);
});

test("intent 第三次成功后 convergence 使用同一 deadline 的剩余预算", async () => {
  let now = 0;
  let intentCalls = 0;
  const convergenceBudgets: number[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async updateRunNotice() { return; },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent() {
      intentCalls += 1;
      now += 100;
      if (intentCalls < 3) throw new InternalRpcTimeoutError({ method: "POST", endpoint: "/runs/terminal-intent", timeoutMs: 1 });
      return { result: "updated" };
    },
    async convergeRunTerminal(_: unknown, options: { timeoutMs: number }) {
      convergenceBudgets.push(options.timeoutMs);
      return { kind: "transitioned", finalStatus: "completed" };
    },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1, { nowMs: () => now });
  (runner as any).runModelStep = async () => ({ aborted: false as const, toolCallCount: 0, assistantMessageId: "m", hasVisibleText: true });
  await processRunForTest(runner, makeRun("sess_test", "run_test"), new AbortController().signal);
  assert.equal(intentCalls, 3);
  assert.deepEqual(convergenceBudgets, [9_700]);
});

test("convergence 第三次成功时复用 terminal deadline 的累计剩余预算", async () => {
  let now = 0;
  let convergenceCalls = 0;
  const convergenceBudgets: number[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async updateRunNotice() { return; },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent() { return { result: "updated" }; },
    async convergeRunTerminal(_: unknown, options: { timeoutMs: number }) {
      convergenceCalls += 1;
      convergenceBudgets.push(options.timeoutMs);
      now += 100;
      if (convergenceCalls < 3) {
        throw new InternalRpcTimeoutError({ method: "POST", endpoint: "/runs/converge-terminal", timeoutMs: 1 });
      }
      return { kind: "transitioned", finalStatus: "completed" };
    },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1, { nowMs: () => now });
  (runner as any).runModelStep = async () => ({ aborted: false as const, toolCallCount: 0, assistantMessageId: "m", hasVisibleText: true });

  await processRunForTest(runner, makeRun("sess_test", "run_test"), new AbortController().signal);

  assert.equal(convergenceCalls, 3);
  assert.deepEqual(convergenceBudgets, [10_000, 9_900, 9_800]);
});

test("proactive compaction commit outcome 无法确认时不会继续旧 context 的模型调用", async () => {
  const terminalCodes: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async updateRunNotice() { return { result: "updated" }; },
    async getPromptContext() { return { ...baseContext(), lastResponseTotalTokens: 1 }; },
    async persistRunTerminalIntent(input: { code: string }) { terminalCodes.push(input.code); return { result: "updated" }; },
    async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "failed" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).shouldAutoCompact = () => true;
  (runner as any).executeCompaction = async () => ({ kind: "failed", reason: "commit_outcome_uncertain" });
  (runner as any).runModelStep = async () => {
    assert.fail("未确认的 commit outcome 不得继续旧 context 的 runModelStep");
  };

  await processRunForTest(runner, makeRun("sess_uncertain", "run_uncertain"), new AbortController().signal);

  assert.deepEqual(terminalCodes, [], "an unconfirmed write may still persist a completed artifact");
});

test("manual committed intent wins over a cancellation arriving with the commit response", async () => {
  const caller = new AbortController();
  const intents: string[] = [];
  const convergences: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async persistRunTerminalIntent(input: { status: string }) { intents.push(input.status); return { result: "updated" }; },
    async convergeRunTerminal() { convergences.push("completed"); return { kind: "transitioned", finalStatus: "completed" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).executeCompaction = async () => {
    caller.abort();
    return { kind: "committed", summaryMessageId: "summary", plan: {} };
  };
  await processRunForTest(runner, { ...makeRun("sess_manual", "run_manual"), runKind: "manual_compaction" }, caller.signal);
  assert.deepEqual(intents, []);
  assert.deepEqual(convergences, ["completed"]);
});

test("cancelled caller with uncertain manual commit does not select a conflicting terminal tuple", async () => {
  const caller = new AbortController();
  const intents: string[] = [];
  let convergences = 0;
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async persistRunTerminalIntent(input: { status: string }) { intents.push(input.status); return { result: "updated" }; },
    async convergeRunTerminal() { convergences += 1; return { kind: "transitioned", finalStatus: "cancelled" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).executeCompaction = async () => { caller.abort(); return { kind: "failed", reason: "commit_outcome_uncertain" }; };
  await processRunForTest(runner, { ...makeRun("sess_manual", "run_manual"), runKind: "manual_compaction" }, caller.signal);
  assert.deepEqual(intents, []);
  assert.equal(convergences, 0);
});

test("ignored proactive commit stops the old Run without entering a model step", async () => {
  const intents: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async getPromptContext() { return { ...baseContext(), lastResponseTotalTokens: 1 }; },
    async persistRunTerminalIntent(input: { status: string }) { intents.push(input.status); return { result: "updated" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).shouldAutoCompact = () => true;
  (runner as any).executeCompaction = async () => ({ kind: "failed", reason: "commit_outcome_uncertain" });
  (runner as any).runModelStep = async () => assert.fail("ignored commit must not issue a model request");
  await processRunForTest(runner, makeRun("sess_ignore", "run_ignore"), new AbortController().signal);
  assert.deepEqual(intents, []);
});

test("proactive CAS skip refreshes prompt and execution profile without auto-compacting again", async () => {
  let contextReads = 0;
  let profileReads = 0;
  let compactions = 0;
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { profileReads += 1; return baseProfile(); },
    async getPromptContext() {
      contextReads += 1;
      return { ...baseContext(), headMessageId: contextReads === 1 ? "old" : "new", sessionRevision: contextReads, lastResponseTotalTokens: 1 };
    },
    async persistRunTerminalIntent() { return { result: "updated" }; },
    async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "completed" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).shouldAutoCompact = () => true;
  (runner as any).executeCompaction = async () => { compactions += 1; return { kind: "skipped", reason: "profile_changed" }; };
  (runner as any).runModelStep = async ({ context }: { context: ReturnType<typeof baseContext> }) => {
    assert.equal(context.headMessageId, "new");
    assert.equal(context.sessionRevision, 2);
    return { aborted: false, toolCallCount: 0, hasVisibleText: true };
  };
  await processRunForTest(runner, makeRun("sess_cas", "run_cas"), new AbortController().signal);
  assert.equal(contextReads, 2);
  assert.equal(profileReads, 2);
  assert.equal(compactions, 1);
});

test("fresh pending tools after a proactive skip are processed before any model request", async () => {
  let reads = 0;
  let pendingCalls = 0;
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async getPromptContext() {
      reads += 1;
      return { ...baseContext(), lastResponseTotalTokens: 1, pendingTools: reads === 1 ? [] : [{ id: "pending" }] };
    },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).shouldAutoCompact = () => true;
  (runner as any).executeCompaction = async () => ({ kind: "skipped", reason: "cas_conflict" });
  (runner as any).executePendingTools = async ({ context }: { context: ReturnType<typeof baseContext> }) => {
    assert.equal(context.pendingTools.length, 1);
    pendingCalls += 1;
    return { paused: true };
  };
  (runner as any).runModelStep = async () => assert.fail("pending tools must run first");
  await processRunForTest(runner, makeRun("sess_tools", "run_tools"), new AbortController().signal);
  assert.equal(reads, 2);
  assert.equal(pendingCalls, 1);
});

test("proactive skip followed by successfully executed pending tools does not compact again before the model", async () => {
  let reads = 0;
  let pending = true;
  let compactions = 0;
  let pendingCalls = 0;
  let modelCalls = 0;
  const intents: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async getPromptContext() {
      reads += 1;
      return { ...baseContext(), lastResponseTotalTokens: 1, pendingTools: reads > 1 && pending ? [{ id: "pending" }] : [] };
    },
    async persistRunTerminalIntent(input: { status: string }) { intents.push(input.status); },
    async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "completed" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).shouldAutoCompact = () => true;
  (runner as any).executeCompaction = async () => {
    compactions += 1;
    return { kind: "skipped", reason: "cas_conflict" };
  };
  (runner as any).executePendingTools = async ({ context }: { context: ReturnType<typeof baseContext> }) => {
    assert.equal(context.pendingTools.length, 1);
    pendingCalls += 1;
    pending = false;
    return { paused: false };
  };
  (runner as any).runModelStep = async ({ context, step }: { context: ReturnType<typeof baseContext>; step: number }) => {
    assert.equal(context.pendingTools.length, 0);
    assert.equal(step, 1);
    modelCalls += 1;
    return { aborted: false, toolCallCount: 0, hasVisibleText: true };
  };

  await processRunForTest(runner, makeRun("sess_tools", "run_tools"), new AbortController().signal);
  assert.equal(reads, 3);
  assert.equal(pendingCalls, 1);
  assert.equal(compactions, 1);
  assert.equal(modelCalls, 1);
  assert.deepEqual(intents, ["completed"]);
});

test("proactive 非摘要控制面暂不可用可跳过并继续主模型", async () => {
  for (const compacted of [
    { kind: "unavailable", reason: "transient" },
  ] as const) {
    let modelCalls = 0;
    const terminalCodes: string[] = [];
    const apiClient = {
      async markRunWorkInProgress() { return { result: "updated" }; },
      async getExecutionProfile() { return baseProfile(); },
      async updateRunNotice() { return { result: "updated" }; },
      async getPromptContext() { return { ...baseContext(), lastResponseTotalTokens: 1 }; },
      async persistRunTerminalIntent(input: { code: string }) { terminalCodes.push(input.code); return { result: "updated" }; },
      async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "completed" }; },
    };
    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    (runner as any).shouldAutoCompact = () => true;
    (runner as any).executeCompaction = async () => compacted;
    (runner as any).runModelStep = async () => {
      modelCalls += 1;
      return { aborted: false as const, toolCallCount: 0, assistantMessageId: "assistant", hasVisibleText: true };
    };

    await processRunForTest(runner, makeRun("sess_proactive", `run_${compacted.reason}`), new AbortController().signal);
    assert.equal(modelCalls, 1);
    assert.deepEqual(terminalCodes, ["run_completed"]);
  }
});

test("proactive 摘要重试耗尽和整体 deadline 均使普通 Run 失败", async () => {
  for (const compacted of [
    { kind: "failed", reason: "provider" },
    { kind: "unavailable", reason: "deadline" },
  ] as const) {
    const terminalCodes: string[] = [];
    const apiClient = {
      async markRunWorkInProgress() { return { result: "updated" }; },
      async getExecutionProfile() { return baseProfile(); },
      async updateRunNotice() { return { result: "updated" }; },
      async getPromptContext() { return { ...baseContext(), lastResponseTotalTokens: 1 }; },
      async persistRunTerminalIntent(input: { code: string }) { terminalCodes.push(input.code); return { result: "updated" }; },
      async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "failed" }; },
    };
    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    (runner as any).shouldAutoCompact = () => true;
    (runner as any).executeCompaction = async () => compacted;
    (runner as any).runModelStep = async () => assert.fail("摘要失败不得继续使用旧上下文请求主模型");

    await processRunForTest(runner, makeRun("sess_failed", `run_${compacted.reason}`), new AbortController().signal);
    assert.deepEqual(terminalCodes, ["run_failed"]);
  }
});

test("manual unavailable/deadline 与 oversized tail 使用稳定 compaction 终态码", async () => {
  for (const [compacted, expectedCode] of [
    [{ kind: "unavailable", reason: "transient" }, "compaction_provider_unavailable"],
    [{ kind: "unavailable", reason: "deadline" }, "compaction_provider_unavailable"],
    [{ kind: "skipped", reason: "oversized_tail" }, "compaction_oversized_tail"],
  ] as const) {
    const terminalCodes: string[] = [];
    const apiClient = {
      async markRunWorkInProgress() { return { result: "updated" }; },
      async getExecutionProfile() { return baseProfile(); },
      async updateRunNotice() { return { result: "updated" }; },
      async persistRunTerminalIntent(input: { code: string }) { terminalCodes.push(input.code); return { result: "updated" }; },
      async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "failed" }; },
    };
    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    (runner as any).executeCompaction = async () => compacted;
    (runner as any).runModelStep = async () => assert.fail("manual compaction 不得进入主模型");

    await processRunForTest(runner, { ...makeRun("sess_manual", `run_${expectedCode}`), runKind: "manual_compaction" }, new AbortController().signal);
    assert.deepEqual(terminalCodes, [expectedCode]);
  }
});

test("manual 将 M6 CAS replan 后的 pre-send deadline 映射为 compaction_provider_unavailable", async () => {
  const terminalCodes: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async updateRunNotice() { return { result: "updated" }; },
    async persistRunTerminalIntent(input: { code: string }) { terminalCodes.push(input.code); return { result: "updated" }; },
    async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "failed" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  // Executor M6 regression test covers the preceding CAS/replan details; Runner
  // owns only the terminal tuple translation of its resulting deadline outcome.
  (runner as any).executeCompaction = async () => ({ kind: "unavailable", reason: "deadline" });
  (runner as any).runModelStep = async () => assert.fail("manual compaction 不得进入主模型");

  await processRunForTest(runner, { ...makeRun("sess_m6", "run_m6"), runKind: "manual_compaction" }, new AbortController().signal);

  assert.deepEqual(terminalCodes, ["compaction_provider_unavailable"]);
});

test("取消进入 terminal-control 后重入不会重置 intent 累计次数", async () => {
  let intentCalls = 0;
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async updateRunNotice() { return; },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent() {
      intentCalls += 1;
      throw new InternalRpcTimeoutError({ method: "POST", endpoint: "/runs/terminal-intent", timeoutMs: 1 });
    },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  const controller = new AbortController();
  (runner as any).runModelStep = async () => {
    controller.abort();
    return { aborted: true as const, assistantMessageId: "m" };
  };
  await processRunForTest(runner, makeRun("sess_test", "run_test"), controller.signal);
  assert.equal(intentCalls, 3);
});

test("enqueueRun 的 finally 在 persistRunTerminalIntent 全失败后释放槽位和 session", async () => {
  let intentCalls = 0;
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunNotice() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async persistRunTerminalIntent() {
      intentCalls += 1;
      throw new InternalRpcTimeoutError({ method: "POST", endpoint: "/runs/terminal-intent", timeoutMs: 1 });
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => {
    return { aborted: false as const, toolCallCount: 0, assistantMessageId: 1, hasVisibleText: true };
  };

  runner.enqueueRun(makeRun("sess_slot", "run_slot"));
  for (let i = 0; i < 140 && (runner as any).activeCount !== 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(intentCalls, 3, "terminal control exhausts its bounded intent retry budget");
  assert.equal((runner as any).activeCount, 0);
  assert.equal((runner as any).runningSessions.has("sess_slot"), false);
  assert.equal(getRegisteredControllerForTest(runner, "sess_slot"), undefined);
});

test("同一 runId 在运行期间重复 enqueue 不创建第二个 Worker 实例", async () => {
  let modelCalls = 0;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async updateRunNotice() { return; },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent() { return { result: "updated" }; },
    async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "completed" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => {
    modelCalls += 1;
    await entered;
    return { aborted: false as const, toolCallCount: 0, assistantMessageId: "message", hasVisibleText: true };
  };

  const run = makeRun("sess_dedup", "run_dedup");
  runner.enqueueRun(run);
  for (let index = 0; index < 40 && modelCalls === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  runner.enqueueRun(run);
  assert.equal(modelCalls, 1);
  assert.equal((runner as any).activeRunIds.has("run_dedup"), true);
  release();
  for (let index = 0; index < 40 && (runner as any).activeCount !== 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((runner as any).activeRunIds.has("run_dedup"), false);
});

const cancellationLikeErrors = [
  { label: "正文含 Abort", create: () => new Error("Nearby actual lines: Abort controller"), runCancelled: false },
  { label: "正文含 aborted", create: () => new Error("document says request aborted"), runCancelled: false },
  { label: "名称含 Abort 子串", create: () => Object.assign(new Error("provider failed"), { name: "Provider Abort failure" }), runCancelled: false },
  { label: "明确 AbortError", create: () => Object.assign(new Error("provider stopped"), { name: "AbortError" }), runCancelled: true },
  { label: "明确 ABORT_ERR", create: () => Object.assign(new Error("provider stopped"), { code: "ABORT_ERR" }), runCancelled: true },
  { label: "DOMException AbortError", create: () => new DOMException("provider stopped", "AbortError"), runCancelled: true },
];

for (const fixture of cancellationLikeErrors) test(`processRun ${fixture.label} 仅使用明确类型或信号判断取消`, async () => {
  const completed: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunNotice() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async persistRunTerminalIntent(input: { status: string }) {
      completed.push(input.status);
      return { result: "updated" };
    },
    async convergeRunTerminal() { return { kind: "transitioned", finalStatus: fixture.runCancelled ? "cancelled" : "failed" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => {
    throw fixture.create();
  };

  const signal = new AbortController().signal;
  await processRunForTest(runner, makeRun("sess_test", "run_test"), signal);

  assert.equal(signal.aborted, false);
  assert.deepEqual(completed, [fixture.runCancelled ? "cancelled" : "failed"]);
});

for (const outer of [false, true]) for (const fixture of cancellationLikeErrors) test(`${outer ? "executeToolSafely 外层" : "executeTool 内层"} ${fixture.label} 在信号未取消时回写 failed`, async () => {
  const updates: Array<{ status: string; error?: string }> = [];
  const apiClient = {
    async updateToolExecution(input: { status: string; error?: string }) {
      updates.push(input);
      return { result: "updated" };
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).toolRegistry = {
    async isToolEnabled() {
      return true;
    },
    async execute() {
      throw fixture.create();
    }
  };
  if (outer) {
    (runner as any).executeTool = async () => { throw fixture.create(); };
  }
  const signal = new AbortController().signal;

  const execute = outer ? executeToolSafelyForTest : executeToolForTest;
  const result = await execute(runner, {
    profile: baseProfile(),
    run: makeRun("sess_parent", "run_parent"),
    tool: {
      toolExecutionId: "execution-1",
      callPartId: "part-call-1",
      assistantMessageId: "message-assistant-1",
      status: "queued",
      toolName: "bash",
      toolCallId: "call_abort_tool",
      args: { command: "sleep 1" }
    },
    parentSessionId: "sess_parent",
    signal,
    promptContext: baseContext()
  });

  assert.equal(signal.aborted, false);
  assert.deepEqual(result, { paused: false });
  assert.deepEqual(updates.map((update) => update.status), outer ? ["failed"] : ["running", "failed"]);
  assert.equal(updates.at(-1)?.error, fixture.create().message);
});

test("executeToolSafely 外层真实 signal 取消时不回写 failed", async () => {
  const statuses: string[] = [];
  const controller = new AbortController();
  const runner = new AgentRunner({
    async updateToolExecution(input: { status: string }) {
      statuses.push(input.status);
      return { result: "updated" };
    }
  } as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).executeTool = async () => {
    controller.abort();
    throw new Error("provider failed during cancellation");
  };

  const result = await executeToolSafelyForTest(runner, {
    profile: baseProfile(),
    run: makeRun("sess_parent", "run_parent"),
    tool: {
      toolExecutionId: "execution-outer-cancel", callPartId: "part-outer-cancel",
      assistantMessageId: "message-outer-cancel", status: "queued", toolName: "bash",
      toolCallId: "call_outer_cancel", args: { command: "fixture" }
    },
    parentSessionId: "sess_parent", signal: controller.signal, promptContext: baseContext()
  });

  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(result, { paused: false });
  assert.deepEqual(statuses, []);
});

test("read probe 期间 signal abort 时不会把根路径错误写成 failed", async () => {
  const statuses: string[] = [];
  const controller = new AbortController();
  const apiClient = {
    async updateToolExecution(input: { status: string }) {
      statuses.push(input.status);
      return;
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).toolRegistry = {
    async isToolEnabled() {
      return true;
    },
    async execute() {
      controller.abort();
      throw new Error("ENOENT: no such file or directory, lstat '/workspace/src/a.ts'");
    }
  };

  await executeToolForTest(runner, {
    profile: baseProfile(),
    run: makeRun("sess_parent", "run_parent"),
    tool: {
      toolExecutionId: "execution-2",
      callPartId: "part-call-2",
      assistantMessageId: "message-assistant-2",
      status: "queued",
      toolName: "read",
      toolCallId: "call_abort_read",
      args: { filePath: "src/a.ts" }
    },
    parentSessionId: "sess_parent",
    signal: controller.signal,
    promptContext: baseContext()
  });

  assert.deepEqual(statuses, ["running"]);
});
