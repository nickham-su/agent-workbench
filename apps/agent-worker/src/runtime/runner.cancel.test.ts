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
  processNestedRunWithControllerForTest,
  processRunForTest, ModelContextLengthExceededError,
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
    externalSkillRoots: []
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

  assert.deepEqual(terminalCodes, ["run_failed"]);
});

test("recovery full committed 后再次 context-limit 直接 exhausted，不再发起第三次 compaction", async () => {
  const modes: string[] = [];
  const terminalCodes: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async updateRunNotice() { return { result: "updated" }; },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent(input: { code: string }) { terminalCodes.push(input.code); return { result: "updated" }; },
    async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "failed" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => { throw new ModelContextLengthExceededError("assistant", new Error("limit")); };
  (runner as any).executeCompaction = async ({ mode }: { mode: string }) => {
    modes.push(mode);
    return { kind: "committed", summaryMessageId: `summary-${mode}`, plan: {} };
  };

  await processRunForTest(runner, { ...makeRun("sess_recovery", "run_recovery"), runKind: "user" }, new AbortController().signal);

  assert.deepEqual(modes, ["recovery-standard", "recovery-full"]);
  assert.deepEqual(terminalCodes, ["context_limit_recovery_exhausted"]);
});

test("proactive transient/deadline 可跳过并继续主模型", async () => {
  for (const compacted of [
    { kind: "unavailable", reason: "transient" },
    { kind: "unavailable", reason: "deadline" },
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

test("recovery standard 的 no_prefix 与 no_progress 都会进入 full", async () => {
  for (const reason of ["no_prefix", "no_progress"] as const) {
    const modes: string[] = [];
    const terminalCodes: string[] = [];
    const apiClient = {
      async markRunWorkInProgress() { return { result: "updated" }; },
      async getExecutionProfile() { return baseProfile(); },
      async updateRunNotice() { return { result: "updated" }; },
      async getPromptContext() { return baseContext(); },
      async persistRunTerminalIntent(input: { code: string }) { terminalCodes.push(input.code); return { result: "updated" }; },
      async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "failed" }; },
    };
    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    (runner as any).runModelStep = async () => { throw new ModelContextLengthExceededError("assistant", new Error("limit")); };
    (runner as any).executeCompaction = async ({ mode }: { mode: string }) => {
      modes.push(mode);
      return mode === "recovery-standard"
        ? { kind: "skipped", reason }
        : { kind: "skipped", reason: "no_progress" };
    };

    await processRunForTest(runner, { ...makeRun("sess_no_progress", `run_${reason}`), runKind: "user" }, new AbortController().signal);
    assert.deepEqual(modes, ["recovery-standard", "recovery-full"]);
    assert.deepEqual(terminalCodes, ["context_limit_recovery_exhausted"]);
  }
});

test("standard 无进展触发 immediate full 时 CAS conflict 映射为 compaction conflict", async () => {
  const modes: string[] = [];
  const terminalCodes: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return baseProfile(); },
    async updateRunNotice() { return { result: "updated" }; },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent(input: { code: string }) { terminalCodes.push(input.code); return { result: "updated" }; },
    async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "failed" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => { throw new ModelContextLengthExceededError("assistant", new Error("limit")); };
  (runner as any).executeCompaction = async ({ mode }: { mode: string }) => {
    modes.push(mode);
    return mode === "recovery-standard"
      ? { kind: "skipped", reason: "oversized_tail" }
      : { kind: "skipped", reason: "cas_conflict" };
  };

  await processRunForTest(runner, { ...makeRun("sess_conflict", "run_conflict"), runKind: "user" }, new AbortController().signal);

  assert.deepEqual(modes, ["recovery-standard", "recovery-full"]);
  assert.deepEqual(terminalCodes, ["compaction_conflict"]);
});

test("recovery 的 provider/control/data/input 失败直接走通用 run_failed，且不进入 full", async () => {
  for (const result of [
    { kind: "failed", reason: "provider" },
    { kind: "failed", reason: "control" },
    { kind: "failed", reason: "data_invariant" },
    { kind: "summary_input_limit" },
  ] as const) {
    const modes: string[] = [];
    const terminalCodes: string[] = [];
    const apiClient = {
      async markRunWorkInProgress() { return { result: "updated" }; },
      async getExecutionProfile() { return baseProfile(); },
      async updateRunNotice() { return { result: "updated" }; },
      async getPromptContext() { return baseContext(); },
      async persistRunTerminalIntent(input: { code: string }) { terminalCodes.push(input.code); return { result: "updated" }; },
      async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "failed" }; },
    };
    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    (runner as any).runModelStep = async () => { throw new ModelContextLengthExceededError("assistant", new Error("limit")); };
    (runner as any).executeCompaction = async ({ mode }: { mode: string }) => {
      modes.push(mode);
      return result;
    };

    await processRunForTest(runner, { ...makeRun("sess_failure", `run_${result.kind}_${"reason" in result ? result.reason : "input"}`), runKind: "user" }, new AbortController().signal);

    assert.deepEqual(modes, ["recovery-standard"]);
    assert.deepEqual(terminalCodes, ["run_failed"]);
  }
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

test("processRun 遇到 abort-like error 时只提交一次 cancelled", async () => {
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
    async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "cancelled" }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => {
    const err = new Error("request aborted");
    (err as Error & { name: string }).name = "AbortError";
    throw err;
  };

  await processRunForTest(runner, makeRun("sess_test", "run_test"), new AbortController().signal);

  assert.deepEqual(completed, ["cancelled"]);
});

test("executeTool 遇到 AbortError 不会把工具项更新为 failed", async () => {
  const statuses: string[] = [];
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
      const err = new Error("request aborted");
      (err as Error & { name: string }).name = "AbortError";
      throw err;
    }
  };

  const result = await executeToolForTest(runner, {
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
    signal: new AbortController().signal,
    promptContext: baseContext()
  });

  assert.deepEqual(result, { paused: false });
  assert.deepEqual(statuses, ["running"]);
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
