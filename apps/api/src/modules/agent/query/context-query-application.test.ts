import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../../app/errors.js";
import { ContextQueryApplication } from "./context-query-application.js";
import type { ContextQueryApplicationDependencies } from "./context-query-ports.js";

const session = {
  id: "session-1", workspaceId: "workspace-1", title: "Session", kind: "primary" as const,
  createdAt: 1, updatedAt: 10, forkedFromSessionId: null, forkedFromItemId: null, headItemId: 5
};
const item = {
  id: 5, workspaceId: session.workspaceId, sessionId: session.id, runId: null, turnId: null, step: null, prevId: 4,
  kind: "tool" as const, status: "completed" as const,
  output: { type: "tool" as const, toolName: "apply_patch" as const, toolCallId: "call-1", text: "" },
  boundaryReason: null, archiveAt: null, createdAt: 5, updatedAt: 5
};

function createApplication(params?: { headItemId?: number | null; item?: typeof item | null; profileError?: unknown }) {
  const calls: unknown[][] = [];
  const dependencies: ContextQueryApplicationDependencies = {
    store: {
      getSession: (id) => id === session.id ? { ...session, headItemId: params?.headItemId === undefined ? session.headItemId : params.headItemId } : null,
      getWorkspace: () => ({ title: "Workspace", dirName: "workspace" }),
      listTranscript: (workspaceId, sessionId) => { calls.push(["all", workspaceId, sessionId]); return [item] as any; },
      listAfterWindow: (input) => { calls.push(["after", input]); return [item] as any; },
      getTailWindow: (workspaceId, sessionId, tailLimit) => { calls.push(["tail", workspaceId, sessionId, tailLimit]); return { items: [item] as any, hasMoreBefore: true }; },
      getBeforeWindow: (input) => { calls.push(["before", input]); return { items: [item] as any, hasMoreBefore: false }; },
      getTranscriptItem: (_workspaceId, _sessionId, itemId) => itemId === item.id ? params?.item === undefined ? item as any : params.item as any : null,
      getRunState: () => ({ sessionId: session.id, status: "idle" as const, activeRunId: null, activeAssistantItemId: null, lastResponseTotalTokens: 20, runNoticeText: "", updatedAt: 10, appliedItemId: 5 }),
      getRun: () => null,
      getLatestTerminalRun: () => ({ runId: "run-1", workspaceId: session.workspaceId, sessionId: session.id, triggerItemId: 1, agentId: "agent", providerId: "provider", modelId: "model", uiLocale: null, subtaskDepth: 0, parentRunId: null, parentToolItemId: null, status: "completed" as const, createdAt: 2, updatedAt: 10 }),
      listNonTerminalVisibleItemIds: () => []
    },
    uiArtifacts: {
      writeApplyPatch: async () => ({ kind: "written" as const, filePath: "" }), writeWrite: async () => ({ kind: "written" as const, filePath: "" }),
      readApplyPatch: async (input) => { calls.push(["apply-artifact", input]); return { artifact: "apply" }; },
      readWrite: async (input) => { calls.push(["write-artifact", input]); return { artifact: "write" }; }
    },
    availableAgentQuery: { findUserDisplayAgent: ({ agentId }) => agentId === "agent" ? { id: "agent", name: "Agent" } : null },
    resolveContextWindowTokens: () => { if (params?.profileError) throw params.profileError; return 100; },
    clock: { nowMs: () => 30 },
    logger: { warn: (bindings, message) => calls.push(["warn", bindings, message]) }
  };
  return { application: new ContextQueryApplication(dependencies), calls };
}

test("ContextQueryApplication preserves transcript modes and head rollback fence", () => {
  const { application, calls } = createApplication();
  assert.deepEqual(application.getContextItems(session.id, { tailLimit: 2 }), {
    sessionId: session.id, headItemId: 5, appliedItemId: 5, hasMoreBefore: true, items: [item]
  });
  application.getContextItems(session.id, { afterId: 3 });
  application.getContextItems(session.id, { beforeId: 5, limit: 7, expectedHeadItemId: 4 });
  assert.deepEqual(calls.slice(0, 3), [["tail", "workspace-1", "session-1", 2], ["after", { workspaceId: "workspace-1", sessionId: "session-1", afterId: 3 }], ["before", { workspaceId: "workspace-1", sessionId: "session-1", beforeId: 5, limit: 7 }]]);
  assert.throws(() => application.getContextItems(session.id, { afterId: 1, tailLimit: 2 }), (error: unknown) => error instanceof HttpError && error.code === "AGENT_CONTEXT_ITEMS_QUERY_INVALID");
  const rolledBack = createApplication({ headItemId: 3 }).application;
  assert.throws(() => rolledBack.getContextItems(session.id, { beforeId: 2, expectedHeadItemId: 4 }), (error: unknown) => error instanceof HttpError && error.code === "AGENT_CONTEXT_ITEMS_HEAD_MOVED");
});

test("ContextQueryApplication authorizes artifacts through the visible transcript item", async () => {
  const { application, calls } = createApplication();
  assert.deepEqual(await application.getApplyPatchUiArtifact({ sessionId: session.id, itemId: item.id }), { artifact: "apply" });
  assert.deepEqual(calls.at(-1), ["apply-artifact", { workspaceId: "workspace-1", toolCallId: "call-1" }]);
  await assert.rejects(
    () => createApplication({ item: { ...item, output: { ...item.output, toolName: "write" } } as any }).application.getApplyPatchUiArtifact({ sessionId: session.id, itemId: item.id }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404
  );
  await assert.rejects(
    () => application.getWriteUiArtifact({ sessionId: session.id, itemId: 999 }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404
  );
});

test("ContextQueryApplication keeps run-state fallback and status agent ownership narrow", () => {
  const { application, calls } = createApplication({ profileError: new Error("profile failed") });
  const runState = application.getRunState(session.id);
  assert.equal(runState.lastTerminalStatus, "completed");
  assert.equal(runState.contextWindowTokens, null);
  assert.equal(calls.some((call) => call[0] === "warn"), true);
  const summary = application.getSessionStatusSummary({ sessionId: session.id, agentId: "agent" });
  assert.equal(summary.agent?.name, "Agent");
  assert.equal(summary.runState.terminalStatus, "completed");
  assert.throws(() => application.getSessionStatusSummary({ sessionId: session.id, selectedAgentId: "missing" }), (error: unknown) => error instanceof HttpError && error.code === "AGENT_NOT_FOUND");
});
