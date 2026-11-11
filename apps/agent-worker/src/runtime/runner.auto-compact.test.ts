import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunner, processRunForTest } from "./runner.js";

test("shouldAutoCompact uses the active model context window", () => {
  const runner = new AgentRunner({} as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  const shouldAutoCompact = (runner as any).shouldAutoCompact.bind(runner) as (input: {
    responseTotalTokens: number | null | undefined;
    model: { contextWindowTokens: number };
    runtime: { autoCompactThresholdPct: number };
  }) => boolean;

  assert.equal(shouldAutoCompact({
    responseTotalTokens: 80_000,
    model: { contextWindowTokens: 100_000 },
    runtime: { autoCompactThresholdPct: 80 },
  }), true);
  assert.equal(shouldAutoCompact({
    responseTotalTokens: 79_999,
    model: { contextWindowTokens: 100_000 },
    runtime: { autoCompactThresholdPct: 80 },
  }), false);
  assert.equal(shouldAutoCompact({
    responseTotalTokens: null,
    model: { contextWindowTokens: 100_000 },
    runtime: { autoCompactThresholdPct: 80 },
  }), false);
  assert.equal(shouldAutoCompact({
    responseTotalTokens: 90_000,
    model: { contextWindowTokens: 100_000 },
    runtime: { autoCompactThresholdPct: 95 },
  }), false);
});

test("Runner no longer exposes the legacy messages-context compaction path", () => {
  const runner = new AgentRunner({} as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  assert.equal(typeof (runner as any).generateCompactionSummary, "undefined");
  assert.equal(typeof (runner as any).compactContext, "undefined");
});

type LoopResponse = { toolCallCount: number; responseTotalTokens?: number | null; aborted?: boolean; interactiveContinue?: boolean };

function loopHarness(options: {
  interactive: boolean;
  responses: Array<LoopResponse | Error>;
  compactionKind?: "committed" | "skipped";
  cancelDuringTools?: boolean;
}) {
  const events: string[] = [];
  const controller = new AbortController();
  let pendingToolBatches = 0;
  const profile = { model: { contextWindowTokens: 100_000 }, runtime: { autoCompactThresholdPct: 80 }, provider: {} };
  const runner = new AgentRunner({
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return profile; },
    async getPromptContext() { return { pendingTools: pendingToolBatches ? [{ status: "queued", toolExecutionId: "tool" }] : [],
      sessionRevision: 1, lastResponseTotalTokens: 99_999, interactiveInput: { interactive: options.interactive } }; },
    async persistRunTerminalIntent(input: { status: string }) { events.push(input.status); return { result: "updated" }; },
    async convergeRunTerminal() { return { kind: "transitioned", finalStatus: "completed" }; },
  } as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async (input: { recoveryContinuation: { messageId: string | null } }) => {
    assert.equal(pendingToolBatches, 0);
    events.push(input.recoveryContinuation.messageId ? "recover-model" : "model");
    input.recoveryContinuation.messageId = null;
    const response = options.responses.shift();
    assert.ok(response, "unexpected extra model request");
    if (response instanceof Error) throw response;
    if (!response.aborted && response.toolCallCount > 0) pendingToolBatches = 2;
    return { aborted: false, hasVisibleText: true, terminalIntentPersisted: false, ...response };
  };
  (runner as any).executePendingTools = async () => {
    events.push("tools"); pendingToolBatches--;
    if (options.cancelDuringTools) controller.abort();
    return { paused: false };
  };
  (runner as any).executeCompaction = async () => {
    assert.equal(pendingToolBatches, 0, "tool calls must close before compaction");
    events.push("compact");
    return { kind: options.compactionKind ?? "skipped", reason: "not_needed" };
  };
  const processRun = (recovering = false) => processRunForTest(runner, {
    workspaceId: "w", sessionId: "s", runId: "run", workspacePath: process.cwd(), workspaceRepoDirNames: [],
    ...(recovering ? { resumeAssistantMessageId: "assistant-old" } : {}),
  }, controller.signal);
  return { events, process: processRun };
}

for (const interactive of [false, true]) {
  for (const tokens of [79_999, 80_000, 80_001, null, undefined]) {
    test(`${interactive ? "interactive" : "legacy"} tool loop checks only fresh actual usage: ${tokens}`, async () => {
      const f = loopHarness({ interactive, responses: [
        { toolCallCount: 1, responseTotalTokens: tokens }, { toolCallCount: 0, responseTotalTokens: 99_999 },
      ] });
      await f.process();
      assert.deepEqual(f.events, ["model", "tools", "tools", ...(tokens != null && tokens >= 80_000 ? ["compact"] : []), "model", "completed"]);
    });
  }

  test(`${interactive ? "interactive" : "legacy"} final answer above threshold waits for the next Run's tool response`, async () => {
    const f = loopHarness({ interactive, responses: [
      { toolCallCount: 0, responseTotalTokens: 99_999 },
      { toolCallCount: 1, responseTotalTokens: 80_000 }, { toolCallCount: 0, responseTotalTokens: 99_999 },
    ], compactionKind: "committed" });
    await f.process();
    assert.deepEqual(f.events, ["model", "completed"]);
    await f.process();
    assert.deepEqual(f.events, ["model", "completed", "model", "tools", "tools", "compact", "model", "completed"]);
  });

  test(`${interactive ? "interactive" : "legacy"} recovery does not use the stored high usage before resuming the model`, async () => {
    const f = loopHarness({ interactive, responses: [
      { toolCallCount: 1, responseTotalTokens: 80_000 }, { toolCallCount: 0 },
    ] });
    await f.process(true);
    assert.deepEqual(f.events, ["recover-model", "tools", "tools", "compact", "model", "completed"]);
  });
}

test("queued continuation after a final answer does not trigger compaction", async () => {
  const f = loopHarness({ interactive: true, responses: [
    { toolCallCount: 0, responseTotalTokens: 99_999, interactiveContinue: true }, { toolCallCount: 0 },
  ] });
  await f.process(); assert.deepEqual(f.events, ["model", "model", "completed"]);
});

test("each high-usage tool response consumes at most one compaction attempt even after a skip", async () => {
  const f = loopHarness({ interactive: true, responses: [
    { toolCallCount: 1, responseTotalTokens: 80_000 }, { toolCallCount: 1, responseTotalTokens: 90_000 }, { toolCallCount: 0 },
  ] });
  await f.process();
  assert.deepEqual(f.events, ["model", "tools", "tools", "compact", "model", "tools", "tools", "compact", "model", "completed"]);
});

test("failed or aborted responses never trigger compaction from stored usage", async () => {
  for (const response of [new Error("provider failed"), { aborted: true, toolCallCount: 1, responseTotalTokens: 99_999 }]) {
    const f = loopHarness({ interactive: true, responses: [response] });
    await f.process();
    assert.deepEqual(f.events, ["model", response instanceof Error ? "failed" : "cancelled"]);
  }
});

test("Stop during tool execution cancels the pending compaction", async () => {
  const f = loopHarness({ interactive: true, responses: [{ toolCallCount: 1, responseTotalTokens: 99_999 }], cancelDuringTools: true });
  await f.process(); assert.deepEqual(f.events, ["model", "tools", "cancelled"]);
});
