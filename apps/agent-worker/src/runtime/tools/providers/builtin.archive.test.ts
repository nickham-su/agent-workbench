import assert from "node:assert/strict";
import test from "node:test";
import type { AgentApiClient } from "../../apiClient.js";
import { BuiltinToolProvider } from "./builtin.js";
import type { ToolExecutionContext } from "../types.js";

function context(apiClient: AgentApiClient): ToolExecutionContext {
  return {
    profile: {} as ToolExecutionContext["profile"],
    run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: "/workspace", workspaceRepoDirNames: [] },
    pendingTool: { toolExecutionId: "execution", callPartId: "part", assistantMessageId: "assistant", status: "queued", toolName: "archive_read", toolCallId: "call", args: {} },
    signal: new AbortController().signal,
    apiClient,
    promptContext: {} as ToolExecutionContext["promptContext"],
    processNestedRun: async () => undefined,
    updateToolExecution: async () => undefined,
    nowMs: () => 1,
    renderToolText: () => "",
  };
}

test("archive builtin tools use current run workspace/session and preserve opaque cursor", async () => {
  const calls: unknown[] = [];
  const apiClient = {
    archiveRead: async (input: unknown) => { calls.push(input); return { items: [], nextCursor: "next" }; },
    archiveSearch: async (input: unknown) => { calls.push(input); return { items: [], nextCursor: null }; },
  } as unknown as AgentApiClient;
  const provider = new BuiltinToolProvider();
  assert.deepEqual(await provider.execute("archive_read", { cursor: "opaque", limit: 2 }, context(apiClient)), { items: [], nextCursor: "next" });
  assert.deepEqual(await provider.execute("archive_search", { query: "中文检索", cursor: "opaque-2", limit: 3 }, context(apiClient)), { items: [], nextCursor: null });
  assert.deepEqual(calls, [
    { workspaceId: "ws", sessionId: "session", cursor: "opaque", limit: 2 },
    { workspaceId: "ws", sessionId: "session", query: "中文检索", cursor: "opaque-2", limit: 3 },
  ]);
  await assert.rejects(() => provider.execute("archive_search", { query: "ab" }, context(apiClient)), /at least 3 characters/);
});
