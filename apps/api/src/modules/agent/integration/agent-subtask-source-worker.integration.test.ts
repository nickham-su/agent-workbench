import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentApiSubtaskStartRequest, AgentApiSubtaskStartResponse, AgentApiUpdateToolExecutionRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import {
  getMessageRunState, getMessageSession, getRunRecord, getToolExecution,
} from "../agent-message.store.js";
import { ModelContextResolver } from "../read-side/model-context-resolver.js";
import { RuntimeTranscriptProjector } from "../read-side/runtime-transcript-projector.js";
import {
  CANCELLED_TOOL_EXECUTION_RESULT, UNKNOWN_TOOL_EXECUTION_RESULT,
} from "../read-side/runtime-transcript-projector.js";
import {
  createP2Fixture, createSession, createMessageRunForTest, createMessageToolAnchor,
  createSubtaskSessionForTest, startToolExecutionForTest,
} from "./subtask.helpers.js";

// Test-only dynamic imports keep API production dependencies and rootDir unchanged.
// The only replacement below is the model stream; HTTP, graph, lifecycle, Nested Run
// and tool writeback use the production implementations and a real SQLite fixture.
const workerRuntime = new URL("../../../../../agent-worker/src/runtime/", import.meta.url);
const { AgentApiClient } = await import(new URL("apiClient.ts", workerRuntime).href);
const { AgentRunner, executeToolSafelyForTest } = await import(new URL("runner.ts", workerRuntime).href);
const { BuiltinToolProvider } = await import(new URL("tools/providers/builtin.ts", workerRuntime).href);
const { ToolRegistry } = await import(new URL("tools/registry.ts", workerRuntime).href);
const logger = { info() {}, warn() {}, error() {} };

type SessionSelection = { mode: "fork"; sourceSessionId?: string } | { mode: "new" } | { mode: "existing"; sessionId: string };

async function enableSubtask(fixture: Awaited<ReturnType<typeof createP2Fixture>>) {
  const response = await fixture.app.inject({
    method: "PUT", url: "/api/settings/agent/agents",
    payload: { agents: [{ id: "default", name: "default", summary: "", prompt: "Summarize inherited history.",
      tools: ["subtask"], pluginTools: [], mcpServers: [],
      defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "both", order: 0 }] },
  });
  assert.equal(response.statusCode, 200, response.body);
  const runtime = await fixture.app.inject({ method: "PUT", url: "/api/settings/agent/runtime", payload: { maxSubtaskDepth: 2, modelRequestMaxRetries: 0 } });
  assert.equal(runtime.statusCode, 200, runtime.body);
}

for (const mode of ["caller", "other", "new", "existing", "implicit", "implicit-prefork-context-fallback", "window-failure"] as const) {
  test(`real Worker/HTTP/Nested Run/writeback: ${mode} source path and original compatibility`, async (t) => {
    const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    await enableSubtask(fixture);
    // Listening completes fallback startup recovery before we create live Runs.
    // Starting the listener later would correctly recover our fixtures as stale.
    const apiOrigin = await fixture.app.listen({ port: 0, host: "127.0.0.1" });
    const caller = mode === "implicit" ? createSubtaskSessionForTest(fixture) : await createSession(fixture.app, fixture.workspaceId);
    const parentRun = createMessageRunForTest({ fixture, sessionId: caller.id, subtaskDepth: mode === "implicit" ? 1 : 0,
      text: "caller stable history" });
    let sourceSessionId: string | undefined;
    let sourceBoundary: string | null = null;
    let sourceAssistant: string | undefined;
    if (mode === "caller") {
      sourceSessionId = caller.id;
      sourceBoundary = parentRun.triggerMessageId;
    } else if (mode === "other" || mode === "window-failure") {
      const source = await createSession(fixture.app, fixture.workspaceId);
      sourceSessionId = source.id;
      const sourceRun = createMessageRunForTest({ fixture, sessionId: source.id, text: "other stable source history" });
      sourceBoundary = sourceRun.triggerMessageId;
      const anchor = createMessageToolAnchor({ fixture, sessionId: source.id, runId: sourceRun.runId,
        toolName: "bash", input: { command: "not executed source task" } });
      sourceAssistant = anchor.assistantMessageId;
      startToolExecutionForTest({ fixture, sessionId: source.id, runId: sourceRun.runId, toolExecutionId: anchor.toolExecutionId });
    }
    const existing = mode === "existing" ? createSubtaskSessionForTest(fixture) : undefined;
    const session: SessionSelection = sourceSessionId ? { mode: "fork", sourceSessionId: `  ${sourceSessionId}  ` }
      : mode === "new" ? { mode: "new" }
      : existing ? { mode: "existing", sessionId: existing.id }
      : { mode: "fork" };
    const args = { description: "integration summary", prompt: "summarize stable context only", agentId: "default", session };
    const anchor = createMessageToolAnchor({ fixture, sessionId: caller.id, runId: parentRun.runId, toolName: "subtask", input: args });
    if (mode === "caller") sourceAssistant = anchor.assistantMessageId;
    // A large caller context would enter prefork if the new explicit branch were lost.
    const legacyPrefork = mode === "implicit-prefork-context-fallback";
    if (sourceSessionId || legacyPrefork) fixture.db.prepare("update session_run_state set last_response_total_tokens=999999 where session_id=?").run(caller.id);
    const sourceBefore = sourceSessionId ? getMessageSession(fixture.db, fixture.workspaceId, sourceSessionId) : null;
    const counts = { plan: 0, context: 0, summary: 0, model: 0, compact: 0 };
    const started: AgentApiSubtaskStartResponse[] = [];
    const writes: AgentApiUpdateToolExecutionRequest[] = [];
    let startRequest: AgentApiSubtaskStartRequest | undefined;
    let retryChecked = false;
    class ObservedClient extends AgentApiClient {
      constructor(params: { apiOrigin: string; internalToken: string; internalRpcTimeoutMs: number }) {
        super(params);
      }
      async getSubtaskPreforkPlan(input: unknown) { counts.plan++; return super.getSubtaskPreforkPlan(input); }
      async getMessagesContext(input: unknown, options?: unknown) { counts.context++; return super.getMessagesContext(input, options); }
      async getCompactionSource(input: unknown, options?: unknown) { counts.compact++; return super.getCompactionSource(input, options); }
      async startSubtaskRun(input: AgentApiSubtaskStartRequest) {
        startRequest = input;
        const response = await super.startSubtaskRun(input);
        started.push(response);
        return response;
      }
      async updateToolExecution(input: AgentApiUpdateToolExecutionRequest) {
        writes.push(input);
        // Retry while the original parent ToolExecution is still running, after
        // Nested Run reached terminal but before the final parent tool writeback.
        if (input.toolExecutionId === anchor.toolExecutionId && input.status === "completed" && !retryChecked) {
          retryChecked = true;
          const reused = await this.startSubtaskRun(startRequest!);
          assert.equal(reused.reused, true);
          assert.equal(reused.sessionId, started[0]!.sessionId);
          assert.equal(reused.runId, started[0]!.runId);
        }
        return super.updateToolExecution(input);
      }
    }
    class ObservedBuiltin extends BuiltinToolProvider {
      protected async generateSingleCallSummary() {
        counts.summary++;
        return { text: "legacy one-shot prefork summary" };
      }
    }
    const client = new ObservedClient({ apiOrigin, internalToken: fixture.internalToken, internalRpcTimeoutMs: 5000 });
    const requests: Array<{ messages: unknown[] }> = [];
    const runner = new AgentRunner(client, {} as any, logger, 1, {
      streamText: (request: { messages: unknown[] }) => {
        counts.model++;
        requests.push(request);
        const child = started[0]!;
        assert.equal(getMessageRunState(fixture.db, fixture.workspaceId, child.sessionId)?.lastResponseTotalTokens, null);
        if (sourceAssistant) {
          const context = new ModelContextResolver(fixture.db).resolve({ workspaceId: fixture.workspaceId, sessionId: child.sessionId, runId: child.runId });
          assert.ok(!context.messages.some((message) => message.id === sourceAssistant));
          assert.ok(!context.executions.some((execution) => execution.callPartId === anchor.callPartId));
        }
        if (mode === "window-failure") throw new Error("maximum context length exceeded");
        return { fullStream: (async function* () {
          yield { type: "text-delta", id: "summary-text", text: "integration summary completed" };
          yield { type: "raw", rawValue: { type: "response.completed", response: { output: [] } } };
          yield { type: "finish", finishReason: "stop" };
        })(), reasoningText: Promise.resolve(""), usage: Promise.resolve(null), totalUsage: Promise.resolve(null), response: Promise.resolve(null) };
      },
    });
    runner.toolRegistry = new ToolRegistry([new ObservedBuiltin()]);
    const profile = await client.getExecutionProfile({ workspaceId: fixture.workspaceId, sessionId: caller.id, runId: parentRun.runId });
    const promptContext = await client.getPromptContext({ workspaceId: fixture.workspaceId, sessionId: caller.id, runId: parentRun.runId });
    await executeToolSafelyForTest(runner, { profile,
      run: { workspaceId: fixture.workspaceId, sessionId: caller.id, runId: parentRun.runId, workspacePath: fixture.workspacePath, workspaceRepoDirNames: [] },
      parentSessionId: caller.id, signal: new AbortController().signal, promptContext,
      tool: { ...promptContext.pendingTools.find((tool: { toolExecutionId: string }) => tool.toolExecutionId === anchor.toolExecutionId)!, status: "queued" },
    });
    const execution = getToolExecution(fixture.db, anchor.toolExecutionId)!;
    if (mode === "window-failure") {
      assert.equal(execution.status, "failed");
      assert.match(execution.error ?? "", /subtask failed/);
      assert.deepEqual(counts, { plan: 0, context: 0, summary: 0, model: 1, compact: 0 });
      assert.equal(started.length, 1);
      assert.equal(getRunRecord(fixture.db, started[0]!.runId)?.status, "failed");
      assert.ok(getMessageSession(fixture.db, fixture.workspaceId, started[0]!.sessionId), "activated Child is not compensated");
      assert.equal((execution.structuredResult as { sourceSessionId: string }).sourceSessionId, sourceSessionId);
      assert.match(execution.resultPreview ?? "", /source_session_id/);
      assert.deepEqual(getMessageSession(fixture.db, fixture.workspaceId, sourceSessionId!), sourceBefore);
      return;
    }
    assert.equal(execution.status, "completed", execution.error ?? "tool did not complete");
    assert.equal(counts.model, 1);
    assert.equal(retryChecked, true);
    assert.equal(started.length, 2);
    assert.deepEqual(started.map((child) => child.reused), [false, true]);
    assert.equal(getRunRecord(fixture.db, started[0]!.runId)?.status, "completed");
    assert.equal(getRunRecord(fixture.db, started[0]!.runId)?.parentRunId, parentRun.runId);
    const child = getMessageSession(fixture.db, fixture.workspaceId, started[0]!.sessionId)!;
    if (sourceSessionId) {
      assert.deepEqual(counts, { plan: 0, context: 0, summary: 0, model: 1, compact: 0 });
      for (const response of started) {
        assert.equal(response.sourceSessionId, sourceSessionId);
        assert.deepEqual(Object.keys(response).sort(), ["agentName", "reused", "runId", "sessionId", "sourceSessionId", "workspacePath"]);
      }
      assert.equal(child.forkedFromSessionId, sourceSessionId);
      assert.equal(child.forkedFromMessageId, sourceBoundary);
      assert.equal((execution.structuredResult as { sourceSessionId: string }).sourceSessionId, sourceSessionId);
      assert.ok(writes.some((write) => write.status === "running" && (write.structuredResult as { sourceSessionId?: string })?.sourceSessionId === sourceSessionId));
      assert.equal(Object.hasOwn(startRequest!, "preforkSummaryText"), false);
      assert.equal(Object.hasOwn(startRequest!, "preforkMeta"), false);
      if (mode === "other") assert.deepEqual(getMessageSession(fixture.db, fixture.workspaceId, sourceSessionId), sourceBefore);
      assert.match(JSON.stringify(requests[0]!.messages), mode === "other" ? /other stable source history/ : /caller stable history/);
      assert.doesNotMatch(JSON.stringify(requests[0]!.messages), /not executed source task/);
    } else {
      assert.equal(counts.plan, mode === "implicit" || legacyPrefork ? 1 : 0);
      assert.equal(counts.context, legacyPrefork ? 1 : 0);
      // The existing generic messages-context rejects this live pending ToolCall;
      // Builtin preserves its original safe fallback instead of inventing a result.
      // Successful/Provider-failed one-shot summaries remain covered by prefork unit tests.
      assert.equal(counts.summary, 0);
      for (const response of started) assert.equal(Object.hasOwn(response, "sourceSessionId"), false);
      assert.equal(Object.hasOwn(execution.structuredResult as object, "sourceSessionId"), false);
      assert.doesNotMatch(execution.resultPreview ?? "", /source_session_id/);
      if (existing) assert.equal(child.id, existing.id);
      assert.equal(Object.hasOwn(startRequest!, "preforkSummaryText"), false);
      if (legacyPrefork) assert.match(JSON.stringify(requests[0]!.messages), /caller stable history/);
    }
    const resolved = new ModelContextResolver(fixture.db).resolve({ workspaceId: fixture.workspaceId, sessionId: caller.id });
    const transcript = new RuntimeTranscriptProjector().project({ workspaceId: fixture.workspaceId, triggerMessageId: null,
      messages: resolved.messages, executions: resolved.executions });
    assert.match(JSON.stringify(transcript), /integration summary completed/);
    assert.equal(transcript.filter((message) => message.role === "tool").length, 1);
  });
}

for (const status of ["queued", "running"] as const) {
  test(`server-only ${status} subtask convergence replays without Worker preview or source metadata`, async (t) => {
    const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const parent = await createSession(fixture.app, fixture.workspaceId);
    const run = createMessageRunForTest({ fixture, sessionId: parent.id });
    const anchor = createMessageToolAnchor({ fixture, sessionId: parent.id, runId: run.runId, toolName: "subtask",
      input: { description: "summary", prompt: "not started", agentId: "default", session: { mode: "fork", sourceSessionId: "unavailable-source" } } });
    if (status === "running") startToolExecutionForTest({ fixture, sessionId: parent.id, runId: run.runId, toolExecutionId: anchor.toolExecutionId });
    const response = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${parent.id}/cancel`, payload: { workspaceId: fixture.workspaceId } });
    assert.equal(response.statusCode, 200, response.body);
    const execution = getToolExecution(fixture.db, anchor.toolExecutionId)!;
    assert.equal(execution.status, status === "running" ? "unknown" : "cancelled");
    assert.equal(execution.resultPreview, null);
    assert.equal(execution.error, null);
    assert.equal(execution.structuredResult, null);
    const resolved = new ModelContextResolver(fixture.db).resolve({ workspaceId: fixture.workspaceId, sessionId: parent.id });
    const transcript = new RuntimeTranscriptProjector().project({ workspaceId: fixture.workspaceId, triggerMessageId: null, messages: resolved.messages, executions: resolved.executions });
    const tool = transcript.find((message) => message.role === "tool") as { content: Array<{ output: { value: string } }> };
    assert.equal(tool.content[0]!.output.value, status === "running" ? UNKNOWN_TOOL_EXECUTION_RESULT : CANCELLED_TOOL_EXECUTION_RESULT);
    assert.doesNotMatch(JSON.stringify(transcript), /source_session_id|来源 Session/);
  });
}

for (const value of [undefined, null, 7, {}, " ", "different-from-input-source"] as const) {
  test(`ordinary result source=${JSON.stringify(value)} does not become a replay proof or requirement`, async (t) => {
    const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const parent = await createSession(fixture.app, fixture.workspaceId);
    const run = createMessageRunForTest({ fixture, sessionId: parent.id });
    const anchor = createMessageToolAnchor({ fixture, sessionId: parent.id, runId: run.runId, toolName: "subtask",
      input: { description: "summary", prompt: "history", agentId: "default", session: { mode: "fork", sourceSessionId: "unavailable-source-with-no-Child" } } });
    startToolExecutionForTest({ fixture, sessionId: parent.id, runId: run.runId, toolExecutionId: anchor.toolExecutionId });
    const response = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/tool-executions/update",
      headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: {
        workspaceId: fixture.workspaceId, sessionId: parent.id, runId: run.runId, toolExecutionId: anchor.toolExecutionId,
        status: "failed", resultPreview: "preview that must not override the error", error: "original child failure",
        structuredResult: { subtaskSessionId: "missing-Child", ...(value !== undefined ? { sourceSessionId: value } : {}) },
        completedAt: Date.now(), updatedAt: Date.now(),
      } });
    assert.equal(response.statusCode, 200, response.body);
    const resolved = new ModelContextResolver(fixture.db).resolve({ workspaceId: fixture.workspaceId, sessionId: parent.id });
    const transcript = new RuntimeTranscriptProjector().project({ workspaceId: fixture.workspaceId, triggerMessageId: null, messages: resolved.messages, executions: resolved.executions });
    const tool = transcript.find((message) => message.role === "tool")!;
    assert.match(JSON.stringify(tool), /original child failure/);
    assert.doesNotMatch(JSON.stringify(tool), /preview that|source_session_id|different-from-input-source/);
    assert.equal((fixture.db.prepare("select count(*) as count from agent_run where parent_tool_execution_id=?").get(anchor.toolExecutionId) as { count: number }).count, 0);
  });
}
