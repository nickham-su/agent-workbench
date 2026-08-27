import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentContextItemRecord } from "@agent-workbench/shared";
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

function createApplication(params?: { headItemId?: number | null; item?: AgentContextItemRecord | null; transcriptItems?: AgentContextItemRecord[]; profileError?: unknown; subtaskRuns?: unknown[] }) {
  const calls: unknown[][] = [];
  const transcriptItems = params?.transcriptItems ?? [item];
  const dependencies: ContextQueryApplicationDependencies = {
    store: {
      getSession: (id) => id === session.id ? { ...session, headItemId: params?.headItemId === undefined ? session.headItemId : params.headItemId } : null,
      getWorkspace: () => ({ title: "Workspace", dirName: "workspace" }),
      listTranscript: (workspaceId, sessionId) => { calls.push(["all", workspaceId, sessionId]); return transcriptItems as any; },
      listAfterWindow: (input) => { calls.push(["after", input]); return transcriptItems as any; },
      getTailWindow: (workspaceId, sessionId, tailLimit) => { calls.push(["tail", workspaceId, sessionId, tailLimit]); return { items: transcriptItems as any, hasMoreBefore: true }; },
      getBeforeWindow: (input) => { calls.push(["before", input]); return { items: transcriptItems as any, hasMoreBefore: false }; },
      getTranscriptItem: (_workspaceId, _sessionId, itemId) => itemId === item.id ? params?.item === undefined ? item as any : params.item as any : null,
      getRunState: () => ({ sessionId: session.id, status: "idle" as const, activeRunId: null, activeAssistantItemId: null, lastResponseTotalTokens: 20, runNoticeText: "", updatedAt: 10, appliedItemId: 5 }),
      getRun: () => null,
      getLatestTerminalRun: () => ({ runId: "run-1", workspaceId: session.workspaceId, sessionId: session.id, triggerItemId: 1, agentId: "agent", providerId: "provider", modelId: "model", uiLocale: null, subtaskDepth: 0, parentRunId: null, parentToolItemId: null, status: "completed" as const, createdAt: 2, updatedAt: 10 }),
      listSubtaskRunProjectionsByParentTools: (input) => { calls.push(["subtask-runs", input]); return (params?.subtaskRuns ?? []) as any; },
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
    logger: { warn: (bindings, message) => calls.push(["warn", bindings, message]), error: (bindings, message) => calls.push(["error", bindings, message]) }
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

test("ContextQueryApplication projects child subtask runs for list and single reads", () => {
  const subtaskItem = {
    ...item,
    runId: "parent-run",
    output: { type: "tool" as const, toolName: "subtask" as const, text: "" }
  };
  const { application, calls } = createApplication({
    item: subtaskItem,
    subtaskRuns: [{ runId: "child-run", parentRunId: "parent-run", parentToolItemId: item.id, status: "completed", createdAt: 10, updatedAt: 35 }], transcriptItems: [subtaskItem]
  });
  const single = application.getContextItem(session.id, item.id);
  assert.deepEqual(single.subtaskRun, { runId: "child-run", status: "completed", startedAt: 10, endedAt: 35, durationMs: 25 });
  const listed = application.getContextItems(session.id).items[0]!;
  assert.deepEqual(listed.subtaskRun, { runId: "child-run", status: "completed", startedAt: 10, endedAt: 35, durationMs: 25 });
  assert.equal(calls.filter((call) => call[0] === "subtask-runs").length, 2);
});

test("ContextQueryApplication skips child-run reads when no subtask parent exists", () => {
  const { application, calls } = createApplication({ transcriptItems: [item] });
  const listed = application.getContextItems(session.id).items;
  const single = application.getContextItem(session.id, item.id);

  assert.equal(listed[0]?.subtaskRun, undefined);
  assert.equal(single.subtaskRun, undefined);
  assert.equal(calls.some((call) => call[0] === "subtask-runs"), false);
});

test("ContextQueryApplication clamps terminal duration when child terminal time precedes start", () => {
  const subtaskItem = { ...item, runId: "parent-run", output: { type: "tool" as const, toolName: "subtask" as const, text: "" } };
  const result = createApplication({ item: subtaskItem, subtaskRuns: [{ runId: "child-run", parentRunId: "parent-run", parentToolItemId: item.id, status: "failed", createdAt: 20, updatedAt: 10 }] })
    .application.getContextItem(session.id, item.id);
  assert.deepEqual(result.subtaskRun, { runId: "child-run", status: "failed", startedAt: 20, endedAt: 10, durationMs: 0 });
});

test("ContextQueryApplication skips null and blank subtask parent run ids", () => {
  const nullRunId = {
    ...item,
    runId: null,
    output: { type: "tool" as const, toolName: "subtask" as const, text: "" }
  };
  const blankRunId = { ...nullRunId, id: item.id + 1, runId: "   " };
  const { application, calls } = createApplication({ item: nullRunId, transcriptItems: [nullRunId, blankRunId] });

  const listed = application.getContextItems(session.id).items;
  const single = application.getContextItem(session.id, item.id);
  assert.equal(listed[0]?.subtaskRun, undefined);
  assert.equal(listed[1]?.subtaskRun, undefined);
  assert.equal(single.subtaskRun, undefined);
  assert.equal(calls.some((call) => call[0] === "subtask-runs"), false);
});

test("ContextQueryApplication keeps zero duration when terminal time equals start", () => {
  const subtaskItem = { ...item, runId: "parent-run", output: { type: "tool" as const, toolName: "subtask" as const, text: "" } };
  const result = createApplication({ item: subtaskItem, subtaskRuns: [{ runId: "child-run", parentRunId: "parent-run", parentToolItemId: item.id, status: "completed", createdAt: 20, updatedAt: 20 }] })
    .application.getContextItem(session.id, item.id);
  assert.deepEqual(result.subtaskRun, { runId: "child-run", status: "completed", startedAt: 20, endedAt: 20, durationMs: 0 });
});

test("ContextQueryApplication keeps running child elapsed fields null and fails open on duplicate children", () => {
  const subtaskItem = {
    ...item,
    runId: "parent-run",
    output: { type: "tool" as const, toolName: "subtask" as const, text: "" }
  };
  const running = createApplication({
    item: subtaskItem,
    subtaskRuns: [{ runId: "child-run", parentRunId: "parent-run", parentToolItemId: item.id, status: "running", createdAt: 10, updatedAt: 999 }]
  }).application.getContextItem(session.id, item.id);
  assert.deepEqual(running.subtaskRun, { runId: "child-run", status: "running", startedAt: 10, endedAt: null, durationMs: null });

  const { application, calls } = createApplication({
    item: subtaskItem,
    subtaskRuns: [
      { runId: "child-b", parentRunId: "parent-run", parentToolItemId: item.id, status: "completed", createdAt: 10, updatedAt: 20 },
      { runId: "child-a", parentRunId: "parent-run", parentToolItemId: item.id, status: "completed", createdAt: 10, updatedAt: 20 }
    ]
  });
  const projected = application.getContextItem(session.id, item.id);
  assert.equal(projected.subtaskRun, undefined);
  const diagnostic = calls.find((call) => call[0] === "error");
  assert.deepEqual(diagnostic, ["error", {
    diagnosticCode: "AGENT_SUBTASK_RUN_PARENT_CONFLICT", workspaceId: session.workspaceId, parentRunId: "parent-run", parentToolItemId: item.id, runIds: ["child-a", "child-b"], matchCount: 2
  }, "multiple subtask runs matched one parent tool"]);
});

test("ContextQueryApplication batches full transcripts larger than public page limits", () => {
  const largeTranscript = Array.from({ length: 1001 }, (_, index) => ({
    ...item,
    id: index + 1,
    runId: `parent-run-${index + 1}`,
    output: { type: "tool" as const, toolName: "subtask" as const, text: "" }
  }));
  const { application, calls } = createApplication({ transcriptItems: largeTranscript });
  const result = application.getContextItems(session.id);
  assert.equal(result.items.length, 1001);
  const subtaskQueries = calls.filter((call) => call[0] === "subtask-runs");
  assert.equal(subtaskQueries.length, 1);
  assert.equal(((subtaskQueries[0]![1] as { parents: unknown[] }).parents).length, 1001);
});
