import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "./agent.runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("等待运行时完成超时");
}

test("本地 fallback 对 active runId 去重，并在终态后释放该标记", async () => {
  const firstContext = deferred<ReturnType<typeof promptContext>>();
  let promptContextCalls = 0;
  let completedRuns = 0;
  const runtime = new AgentRuntime(
    {
      async getPromptContextForRun() {
        promptContextCalls += 1;
        return promptContextCalls === 1 ? await firstContext.promise : promptContext();
      },
      createStreamingAssistantFromWorker() {
        return { message: {} as any };
      },
      flushAssistantPartsFromWorker() {
        return { result: "updated" };
      },
      resumeStreamingAssistantFromWorker() {
        return { result: "updated" };
      },
      replaceStreamingAssistantFromWorker() {
        return { result: "updated", message: {} as any };
      },
      completeAssistantFromWorker() {
        return { result: "updated" };
      },
      completeTerminalAssistantFromWorker() {
        return { result: "updated" };
      },
      async updateToolExecutionFromWorker() {
        return { result: "updated" };
      },
      updateRunNoticeFromWorker() {
        return { result: "updated" };
      },
      convergeRunTerminalFromWorker() {
        completedRuns += 1;
      },
      getSession() {
        return null;
      },
    } as any,
    { error() {} } as any,
    1,
  );
  const run = {
    workspaceId: "ws_runtime",
    sessionId: "sess_runtime",
    runId: "run_runtime",
    workspacePath: "/workspace",
    workspaceRepoDirNames: [],
  };

  runtime.enqueueRun(run);
  await waitUntil(() => promptContextCalls === 1);
  runtime.enqueueRun(run);
  firstContext.resolve(promptContext());

  await waitUntil(() => completedRuns === 1);
  assert.equal(promptContextCalls, 1, "active 阶段的重复 enqueue 不应启动第二次执行");

  runtime.enqueueRun(run);
  await waitUntil(() => completedRuns === 2);
  assert.equal(promptContextCalls, 2, "finally 应释放 active runId，使后续合法 enqueue 可执行");
});

test("本地 fallback cancel-and-wait 对运行中的 Session 超时而不误报 idle", async () => {
  const contextGate = deferred<ReturnType<typeof promptContext>>();
  const runtime = new AgentRuntime(
    {
      async getPromptContextForRun() { return await contextGate.promise; },
      createStreamingAssistantFromWorker() { return { message: {} as any }; },
      flushAssistantPartsFromWorker() { return { result: "updated" }; },
      resumeStreamingAssistantFromWorker() { return { result: "updated" }; },
      replaceStreamingAssistantFromWorker() { return { result: "updated", message: {} as any }; },
      completeAssistantFromWorker() { return { result: "updated" }; },
      async updateToolExecutionFromWorker() { return { result: "updated" }; },
      updateRunNoticeFromWorker() { return { result: "updated" }; },
      convergeRunTerminalFromWorker() {},
      getSession() { return null; },
    } as any,
    { error() {} } as any,
    1,
  );
  runtime.enqueueRun({ workspaceId: "ws", sessionId: "sess", runId: "run", workspacePath: "/workspace", workspaceRepoDirNames: [] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await runtime.cancelSessionAndWait({ sessionId: "sess", timeoutMs: 10 }), false);
  contextGate.resolve(promptContext());
});

test("M5: resume claim 非 updated 时仍成对结束本地 Analytics execution", async () => {
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const runtime = new AgentRuntime({
    async getPromptContextForRun() { return promptContext(); },
    resumeStreamingAssistantFromWorker() { return { result: "ignored" }; },
    createStreamingAssistantFromWorker() { throw new Error("不应创建新 Assistant"); },
    flushAssistantPartsFromWorker() { throw new Error("不应 flush"); },
    replaceStreamingAssistantFromWorker() { return { result: "updated", message: {} as any }; },
    completeAssistantFromWorker() { return { result: "updated" }; },
    completeTerminalAssistantFromWorker() { return { result: "updated" }; },
    async updateToolExecutionFromWorker() { return { result: "updated" }; },
    updateRunNoticeFromWorker() { return { result: "updated" }; },
    convergeRunTerminalFromWorker() { throw new Error("非 updated claim 不应改变业务 Run"); },
    getSession() { return null; },
  } as any, { error() {} } as any, 1, {
    emitExecution(payload: Record<string, unknown>, eventType: string) { events.push({ eventType, payload }); }
  } as any);
  runtime.enqueueRun({ workspaceId: "ws", sessionId: "sess", runId: "run", workspacePath: "/workspace", workspaceRepoDirNames: [], resumeAssistantMessageId: "message" });
  await waitUntil(() => events.length === 2);
  assert.deepEqual(events.map((event) => event.eventType), ["execution_started", "execution_finished"]);
  assert.equal(events[1]?.payload.endReason, "other");
  assert.notEqual(events[1]?.payload.endedAt, null);
});

function promptContext() {
  return {
    headMessageId: null,
    sessionRevision: 0,
    system: "",
    messages: [],
    tools: [],
    pendingTools: [],
    lastResponseTotalTokens: null,
    uiLocale: null,
    externalSkillRoots: [],
  };
}
