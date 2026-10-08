import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunner, FencedWriteIgnoredError } from "./runner.js";

function pendingTool(id: string, status: "queued" | "running", toolName = "read") {
  return {
    toolExecutionId: id, callPartId: `part_${id}`, assistantMessageId: "assistant",
    status, toolName, toolCallId: `call_${id}`, args: { filePath: "test.md", tag: id },
  };
}

type Tool = ReturnType<typeof pendingTool>;
type Context = ReturnType<typeof contextFor>;

function contextFor(tools: Tool[], revision = 0) {
  return {
    pendingTools: tools.map((tool) => ({ ...tool, args: { ...tool.args } })), tools: [],
    headMessageId: null, sessionRevision: revision, system: "", messages: [],
    lastResponseTotalTokens: null, uiLocale: null, externalSkills: [],
  };
}

function createHarness(tools: Tool[], options: {
  leaveRunningOnCompletion?: boolean;
  getContext?: (call: number, context: Context) => Context;
  execute?: (id: string) => Promise<unknown>;
} = {}) {
  const controller = new AbortController();
  const run = {
    workspaceId: "workspace", sessionId: "session", runId: "run",
    workspacePath: process.cwd(), workspaceRepoDirNames: [], inputText: "test",
  };
  const profile = {
    model: "openai:gpt-4o-mini", provider: { npm: "@ai-sdk/openai", options: {} },
    agent: { tools: [], pluginTools: [], mcpServers: [] }, runtime: {},
  };
  const terminal: Array<{ status: string; code: string; detail: null }> = [];
  const writes: Array<{ toolExecutionId: string; status: string }> = [];
  const errors: string[] = [];
  const providerCalls: string[] = [];
  let revision = 0;
  let promptCalls = 0;
  let modelCalls = 0;
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" }; },
    async getExecutionProfile() { return profile; },
    async getPromptContext() {
      assert.ok(++promptCalls <= 12, "orphaned running must not cause unbounded polling");
      const context = contextFor(tools.filter((tool) => tool.status === "queued" || tool.status === "running"), revision);
      return options.getContext?.(promptCalls, context) ?? context;
    },
    async updateRunNotice() { return { result: "updated" }; },
    async updateToolExecution(input: { toolExecutionId: string; status: string }) {
      writes.push({ toolExecutionId: input.toolExecutionId, status: input.status });
      const tool = tools.find((item) => item.toolExecutionId === input.toolExecutionId)!;
      // Simulates a legacy/missing terminal update, not an in-flight local job.
      if (!(options.leaveRunningOnCompletion && input.status === "completed")) {
        Object.assign(tool, { status: input.status });
        revision += 1;
      }
      return { result: "updated" };
    },
    async persistRunTerminalIntent(input: { status: string; code: string; detail: null }) {
      terminal.push({ status: input.status, code: input.code, detail: input.detail });
      return { result: "updated" };
    },
    async convergeRunTerminal() { return { kind: "transitioned", finalStatus: terminal.at(-1)?.status }; },
  };
  const runner = new AgentRunner(apiClient as any, {} as any, {
    info() {}, warn() {}, error(message: string) { errors.push(message); },
  }, 1);
  (runner as any).toolRegistry = {
    async listTools() { return [{ name: "read" }, { name: "bash" }]; },
    async isToolEnabled(name: string) { return name === "read" || name === "bash"; },
    async execute(_name: string, args: { tag: string }) {
      providerCalls.push(args.tag);
      return options.execute ? await options.execute(args.tag) : { text: "read complete" };
    },
  };
  (runner as any).runModelStep = async () => {
    modelCalls += 1;
    return { aborted: false, toolCallCount: 0, assistantMessageId: "assistant", hasVisibleText: true };
  };
  return {
    runner, run, apiClient, controller, terminal, writes, errors, providerCalls,
    get promptCalls() { return promptCalls; }, get modelCalls() { return modelCalls; },
    async process(runKind: "user" | "subtask" = "user") {
      await (runner as any).processRun({ ...run, runKind }, controller.signal);
    },
  };
}

for (const runKind of ["user", "subtask"] as const) {
  test(`processRun: ${runKind} only-running confirms once, never re-executes, and fails`, async () => {
    const harness = createHarness([pendingTool("orphan", "running", "disabled_tool")]);
    await harness.process(runKind);
    assert.equal(harness.promptCalls, 2);
    assert.equal(harness.modelCalls, 0);
    assert.deepEqual(harness.providerCalls, []);
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.terminal, [{ status: "failed", code: runKind === "subtask" ? "subtask_failed" : "run_failed", detail: null }]);
    assert.equal(harness.errors.length, 1);
    assert.match(harness.errors[0]!, /orphaned running.*orphan/);
    assert.doesNotMatch(harness.errors[0]!, /test\.md|filePath/);
  });
}

test("processRun: a queued job left running after its batch settles is not retried", async () => {
  const harness = createHarness([pendingTool("leaked", "queued")], { leaveRunningOnCompletion: true });
  await harness.process();
  assert.equal(harness.promptCalls, 3);
  assert.deepEqual(harness.providerCalls, ["leaked"]);
  assert.deepEqual(harness.writes.map((write) => write.status), ["running", "completed"]);
  assert.equal(harness.terminal[0]?.status, "failed");
  assert.equal(harness.modelCalls, 0);
});

test("processRun: mixed queued/running executes queued first, preserves unknown side effects", async () => {
  const harness = createHarness([pendingTool("orphan", "running", "disabled_tool"), pendingTool("queued", "queued")]);
  await harness.process();
  assert.deepEqual(harness.providerCalls, ["queued"]);
  assert.deepEqual(harness.writes.map((write) => write.toolExecutionId), ["queued", "queued"]);
  assert.equal(harness.promptCalls, 3);
  assert.equal(harness.terminal[0]?.status, "failed");
  assert.equal(harness.modelCalls, 0);
});

for (const progress of ["finished", "new_queued", "changed_ids", "revision"] as const) {
  test(`processRun: refreshed ${progress} progress is not diagnosed from the old context`, async () => {
    const tools = [pendingTool("old", "running")];
    const harness = createHarness(tools, {
      getContext(call, context) {
        if (call === 1) return context;
        if (progress === "new_queued") {
          if (call === 2) tools.splice(0, 1, pendingTool("new", "queued"));
          return contextFor(tools.filter((tool) => tool.status === "queued" || tool.status === "running"), 1);
        }
        if (call === 2 && progress === "changed_ids") return contextFor([pendingTool("new", "running")]);
        if (call === 2 && progress === "revision") return contextFor(tools, context.sessionRevision + 1);
        return contextFor([]);
      },
    });
    await harness.process();
    assert.equal(harness.terminal[0]?.status, "completed");
    assert.deepEqual(harness.errors, []);
    assert.equal(harness.modelCalls, 1);
    assert.deepEqual(harness.providerCalls, progress === "new_queued" ? ["new"] : []);
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const mode of ["serial", "parallel"] as const) {
  test(`processRun: never probes or fails a slow ${mode} batch until every local tool settles`, { timeout: 5_000 }, async () => {
    const started = deferred();
    const first = deferred();
    const second = deferred();
    let active = 0;
    const tools = mode === "serial" ? [pendingTool("second", "queued")] :
      [pendingTool("first", "queued", "bash"), pendingTool("second", "queued", "bash")];
    const harness = createHarness(tools, {
      async execute(id) {
        if (++active === tools.length) started.resolve();
        await (id === "first" ? first : second).promise;
        return { text: "finished" };
      },
    });
    const processing = harness.process();
    try {
      await started.promise;
      assert.equal(harness.promptCalls, 1);
      assert.equal(harness.terminal.length, 0);
      first.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(harness.promptCalls, 1);
      assert.equal(harness.terminal.length, 0);
    } finally {
      first.resolve();
      second.resolve();
      await processing;
    }
    assert.deepEqual(harness.providerCalls, tools.map((tool) => tool.toolExecutionId));
    assert.equal(harness.terminal[0]?.status, "completed");
    assert.deepEqual(harness.errors, []);
  });
}

test("processRun: cancellation during fresh confirmation wins over orphan failure", async () => {
  const harness = createHarness([pendingTool("orphan", "running")], {
    getContext(call, context) {
      if (call === 2) harness.controller.abort();
      return context;
    },
  });
  await harness.process();
  assert.deepEqual(harness.terminal, [{ status: "cancelled", code: "run_cancelled", detail: null }]);
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.writes, []);
});

test("processRun: lost fence during confirmation stops without selecting a new terminal intent", async () => {
  const harness = createHarness([pendingTool("orphan", "running")], {
    getContext(call, context) {
      if (call === 2) throw new FencedWriteIgnoredError("prompt context");
      return context;
    },
  });
  await harness.process();
  assert.equal(harness.promptCalls, 2);
  assert.deepEqual(harness.terminal, []);
  assert.deepEqual(harness.writes, []);
});

test("processRun: paused pending tools skip orphan confirmation and terminal selection", async () => {
  const harness = createHarness([pendingTool("orphan", "running")]);
  (harness.runner as any).executePendingTools = async () => ({ paused: true });
  await harness.process();
  assert.equal(harness.promptCalls, 1);
  assert.deepEqual(harness.terminal, []);
});

test("processRun: pending tools refreshed after proactive compaction use the same orphan guard", async () => {
  const harness = createHarness([pendingTool("orphan", "running")], {
    getContext(call, context) { return call === 1 ? contextFor([]) : context; },
  });
  (harness.runner as any).shouldAutoCompact = () => true;
  (harness.runner as any).executeCompaction = async () => ({ kind: "skipped", reason: "no_prefix" });
  await harness.process();
  assert.equal(harness.promptCalls, 3);
  assert.equal(harness.terminal[0]?.status, "failed");
  assert.equal(harness.modelCalls, 0);
  assert.deepEqual(harness.providerCalls, []);
});
