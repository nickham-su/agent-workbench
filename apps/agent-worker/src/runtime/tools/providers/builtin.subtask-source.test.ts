import assert from "node:assert/strict";
import test from "node:test";
import { AgentSubtaskErrorCode } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { AgentApiClient, ExecutionProfile } from "../../apiClient.js";
import type { ToolExecutionContext } from "../types.js";
import { BuiltinToolProvider } from "./builtin.js";

type FailAt = "start" | "running" | "nested" | "status" | "result";

function harness(options: {
  source?: unknown;
  omitSource?: boolean;
  reused?: boolean;
  terminal?: "completed" | "failed" | "cancelled" | "running";
  failAt?: FailAt;
  failure?: unknown;
  abortNested?: boolean;
  decorateStarted?: (response: Record<string, unknown>) => Record<string, unknown>;
} = {}) {
  const calls = { plan: 0, context: 0, summary: 0, nested: 0, start: 0, status: 0, result: 0 };
  const requests: Array<Record<string, unknown>> = [];
  const updates: Array<Parameters<ToolExecutionContext["updateToolExecution"]>[0]> = [];
  const controller = new AbortController();
  const failure = options.failure ?? new Error(`failure at ${options.failAt}`);
  function fail(stage: FailAt) {
    if (options.failAt === stage) throw failure;
  }
  class SourceProvider extends BuiltinToolProvider {
    protected override async generateSingleCallSummary(): Promise<never> {
      calls.summary++;
      throw new Error("explicit source must not summarize caller");
    }
  }
  const apiClient = {
    async getSubtaskPreforkPlan() {
      calls.plan++;
      return { shouldPrefork: false, thresholdPct: 95, parentLastResponseTotalTokens: 999_999, childContextWindowTokens: 100, thresholdTokens: 95 };
    },
    async getMessagesContext() {
      calls.context++;
      throw new Error("explicit source must not read caller context");
    },
    async startSubtaskRun(input: Record<string, unknown>) {
      calls.start++;
      requests.push(input);
      fail("start");
      const response = {
        sessionId: "child", runId: "child-run", workspacePath: process.cwd(), agentName: "summary", reused: options.reused ?? false,
        ...(options.omitSource ? {} : { sourceSessionId: Object.hasOwn(options, "source") ? options.source : "source" }),
      };
      return options.decorateStarted ? options.decorateStarted(response) : response;
    },
    async getSubtaskStatus() {
      calls.status++;
      fail("status");
      return { status: options.terminal ?? "completed" };
    },
    async getSubtaskResult() {
      calls.result++;
      fail("result");
      return { resultText: "summary result" };
    },
  } as unknown as AgentApiClient;
  const ctx: ToolExecutionContext = {
    apiClient,
    profile: {} as ExecutionProfile,
    run: { workspaceId: "workspace", sessionId: "caller", runId: "caller-run", workspacePath: process.cwd(), workspaceRepoDirNames: [] },
    pendingTool: { toolExecutionId: "tool", callPartId: "part", assistantMessageId: "message", status: "queued", toolName: "subtask", toolCallId: "call", args: {} },
    signal: controller.signal,
    promptContext: { headMessageId: null, sessionRevision: 0, system: "", messages: [], tools: [], pendingTools: [], lastResponseTotalTokens: 999_999, uiLocale: null, externalSkills: [] },
    async processNestedRun() {
      calls.nested++;
      fail("nested");
      if (options.abortNested) controller.abort();
    },
    async updateToolExecution(input) {
      updates.push(input);
      fail("running");
    },
    nowMs: Date.now,
    renderToolText: (input) => [`tool: ${input.toolName}`, `status: ${input.status}`, ...(input.headers ?? []).map(([key, value]) => `${key}: ${value}`), "", input.body ?? ""].join("\n"),
  };
  const provider = new SourceProvider();
  const execute = (session: Record<string, unknown> = { mode: "fork", sourceSessionId: "source" }, extra: Record<string, unknown> = {}) =>
    provider.execute("subtask", { description: "summary", prompt: "only summarize stable history", agentId: "summary-agent", session, ...extra }, ctx);
  return { calls, requests, updates, execute, failure };
}

for (const source of ["source", "caller"]) {
  for (const reused of [false, true]) {
    test(`explicit source ${source}, reused=${reused}: preserve source and bypass every caller prefork operation`, async () => {
      const h = harness({ source, reused });
      const result = await h.execute({ mode: "fork", sourceSessionId: `  ${source}  ` });
      assert.deepEqual(h.requests[0]?.session, { mode: "fork", sourceSessionId: source });
      assert.equal(Object.hasOwn(h.requests[0]!, "preforkSummaryText"), false);
      assert.equal(Object.hasOwn(h.requests[0]!, "preforkMeta"), false);
      assert.deepEqual([h.calls.plan, h.calls.context, h.calls.summary], [0, 0, 0]);
      assert.equal(h.calls.nested, reused ? 0 : 1);
      assert.deepEqual(h.updates[0]?.structuredResult, { subtaskSessionId: "child", subtaskAgentId: "summary-agent", subtaskAgentName: "summary", sourceSessionId: source });
      assert.match(h.updates[0]?.resultPreview ?? "", new RegExp(`source_session_id: "${source}"`));
      assert.deepEqual(result, { subtaskSessionId: "child", subtaskAgentId: "summary-agent", subtaskAgentName: "summary", resultText: "summary result", sourceSessionId: source });
    });
  }
}

for (const invalid of [null, 7, false, [], ["source"], {}, "", " \t\n", undefined]) {
  test(`parser rejects invalid source ${JSON.stringify(invalid)} without calling the API`, async () => {
    const h = harness();
    await assert.rejects(h.execute({ mode: "fork", sourceSessionId: invalid }), { code: AgentSubtaskErrorCode.SourceSessionInvalid });
    assert.equal(h.calls.start, 0);
    assert.equal(h.calls.plan, 0);
  });
}

for (const mode of ["new", "existing"]) {
  for (const source of [null, "source", undefined]) {
    test(`parser rejects ${mode} with present source ${JSON.stringify(source)}`, async () => {
      const h = harness();
      await assert.rejects(h.execute({ mode, sessionId: mode === "existing" ? "existing" : undefined, sourceSessionId: source }), { code: AgentSubtaskErrorCode.SourceSessionNotAllowed });
      assert.equal(h.calls.start, 0);
    });
  }
}

for (const mode of [null, ["fork"], "unknown", " fork "]) {
  test(`source-bearing mode is not coerced: ${JSON.stringify(mode)}`, async () => {
    const h = harness();
    await assert.rejects(h.execute({ mode, sourceSessionId: "source" }), { code: AgentSubtaskErrorCode.SessionModeInvalid });
    assert.equal(h.calls.start, 0);
  });
}

for (const field of ["preforkSummaryText", "preforkMeta"]) {
  for (const value of [null, "", 7, {}]) {
    test(`explicit source rejects present ${field}=${JSON.stringify(value)}`, async () => {
      const h = harness();
      await assert.rejects(h.execute(undefined, { [field]: value }), { code: AgentSubtaskErrorCode.PreforkNotAllowed });
      assert.equal(h.calls.start, 0);
    });
  }
}

for (const session of [{ mode: "new" }, { mode: "fork" }, { mode: "existing", sessionId: "existing" }]) {
  test(`legacy ${session.mode} keeps its output shape even if a response unexpectedly contains display metadata`, async () => {
    const h = harness();
    const result = await h.execute(session);
    assert.equal(h.calls.plan, session.mode === "fork" ? 1 : 0);
    assert.equal(Object.hasOwn(result as object, "sourceSessionId"), false);
    assert.equal(Object.hasOwn(h.updates[0]?.structuredResult as object, "sourceSessionId"), false);
    assert.equal(h.updates[0]?.resultPreview?.includes("source_session_id"), false);
    assert.deepEqual(h.requests[0]?.session, session);
  });
}

for (const source of [null, 3, {}, "", " \t "]) {
  test(`optional response source ${JSON.stringify(source)} is omitted rather than inferred from arguments`, async () => {
    const h = harness({ source });
    const result = await h.execute();
    assert.equal(Object.hasOwn(result as object, "sourceSessionId"), false);
    assert.equal(h.updates[0]?.resultPreview?.includes("source_session_id"), false);
  });
}

test("optional response source is trimmed and safely encoded in a single display header", async () => {
  const source = 'session"\nstatus: forged\u0000';
  const h = harness({ source: ` ${source} ` });
  const result = await h.execute();
  assert.equal((result as { sourceSessionId: string }).sourceSessionId, source);
  assert.ok(h.updates[0]?.resultPreview?.includes(`source_session_id: ${JSON.stringify(source)}`));
  assert.equal(h.updates[0]?.resultPreview?.includes("\nstatus: forged"), false);
});

for (const failAt of ["running", "nested", "status", "result"] as const) {
  test(`post-start ${failAt} failure carries the successful source without changing error identity`, async () => {
    const h = harness({ failAt });
    await assert.rejects(h.execute(), (error: unknown) => {
      assert.equal(error, h.failure);
      assert.equal((error as { sourceSessionId: string }).sourceSessionId, "source");
      assert.equal((error as { subtaskSessionId: string }).subtaskSessionId, "child");
      return true;
    });
    assert.equal(h.calls.plan, 0);
  });
}

for (const terminal of ["failed", "cancelled"] as const) {
  test(`child terminal ${terminal} retains source and partial output without claiming success`, async () => {
    const h = harness({ terminal });
    await assert.rejects(h.execute(), (error: unknown) => {
      assert.equal((error as Error).message, `subtask ${terminal}`);
      assert.equal((error as { sourceSessionId: string }).sourceSessionId, "source");
      assert.equal((error as { subtaskResultText: string }).subtaskResultText, "summary result");
      return true;
    });
  });
}

test("post-start parent abort preserves AbortError and the already available source", async () => {
  const h = harness({ abortNested: true });
  await assert.rejects(h.execute(), (error: unknown) => {
    assert.equal((error as Error).name, "AbortError");
    assert.equal((error as { sourceSessionId: string }).sourceSessionId, "source");
    return true;
  });
  assert.equal(h.calls.status, 0);
});

test("start failure never fabricates response source or child identity", async () => {
  const h = harness({ failAt: "start" });
  await assert.rejects(h.execute(), (error: unknown) => {
    assert.equal(error, h.failure);
    assert.equal(Object.hasOwn(error as object, "sourceSessionId"), false);
    assert.equal(Object.hasOwn(error as object, "subtaskSessionId"), false);
    return true;
  });
  assert.equal(h.updates.length, 0);
});

test("frozen post-start errors retain original identity instead of throwing an annotation failure", async () => {
  const failure = Object.freeze(new Error("original failure"));
  const h = harness({ failAt: "nested", failure });
  await assert.rejects(h.execute(), (error: unknown) => error === failure);
});

test("primitive post-start failure uses the existing error carrier with the available source", async () => {
  const h = harness({ failAt: "nested", failure: "original failure" });
  await assert.rejects(h.execute(), (error: unknown) => {
    assert.equal((error as Error).message, "original failure");
    assert.equal((error as { sourceSessionId: string }).sourceSessionId, "source");
    return true;
  });
});

test("reused-child wait timeout retains source and never executes or cancels the Child", async () => {
  const previousTimeout = process.env.AWB_SUBTASK_REUSED_WAIT_TIMEOUT_MS;
  const previousPoll = process.env.AWB_SUBTASK_REUSED_POLL_INTERVAL_MS;
  process.env.AWB_SUBTASK_REUSED_WAIT_TIMEOUT_MS = "1";
  process.env.AWB_SUBTASK_REUSED_POLL_INTERVAL_MS = "1";
  try {
    const h = harness({ reused: true, terminal: "running" });
    await assert.rejects(h.execute(), (error: unknown) => {
      assert.match((error as Error).message, /reused-child wait timed out/);
      assert.equal((error as { sourceSessionId: string }).sourceSessionId, "source");
      return true;
    });
    assert.equal(h.calls.nested, 0);
    assert.equal(h.calls.result, 0);
  } finally {
    if (previousTimeout === undefined) delete process.env.AWB_SUBTASK_REUSED_WAIT_TIMEOUT_MS;
    else process.env.AWB_SUBTASK_REUSED_WAIT_TIMEOUT_MS = previousTimeout;
    if (previousPoll === undefined) delete process.env.AWB_SUBTASK_REUSED_POLL_INTERVAL_MS;
    else process.env.AWB_SUBTASK_REUSED_POLL_INTERVAL_MS = previousPoll;
  }
});

for (const metadataKind of ["accessor", "frozen-accessor", "descriptor-failure", "frozen-data"] as const) {
  test(`successful start with ${metadataKind} source metadata keeps the original execution path without invoking getters`, async () => {
    let getterCalls = 0;
    const h = harness({ decorateStarted(response) {
      if (metadataKind === "descriptor-failure") {
        return new Proxy(response, { getOwnPropertyDescriptor(target, key) { if (key === "sourceSessionId") throw new Error("source descriptor unavailable"); return Reflect.getOwnPropertyDescriptor(target, key); } });
      }
      if (metadataKind === "frozen-data") return Object.freeze(response);
      Object.defineProperty(response, "sourceSessionId", { get() { getterCalls++; throw new Error("source getter must not execute"); } });
      return metadataKind === "frozen-accessor" ? Object.freeze(response) : response;
    } });
    const result = await h.execute();
    assert.equal(getterCalls, 0);
    assert.equal(h.calls.nested, 1);
    assert.deepEqual([h.calls.plan, h.calls.context, h.calls.summary], [0, 0, 0]);
    const sourceMetadata = metadataKind === "frozen-data" ? { sourceSessionId: "source" } : {};
    assert.deepEqual(result, { subtaskSessionId: "child", subtaskAgentId: "summary-agent", subtaskAgentName: "summary", resultText: "summary result", ...sourceMetadata });
    assert.deepEqual(h.updates[0]?.structuredResult, { subtaskSessionId: "child", subtaskAgentId: "summary-agent", subtaskAgentName: "summary", ...sourceMetadata });
    assert.equal(h.updates[0]?.resultPreview?.includes("source_session_id"), metadataKind === "frozen-data");
  });
}
