import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../../app/errors.js";
import { AgentConflictError } from "../agent.store.js";
import { SessionInteractionApplication } from "./session-interaction-application.js";
import type { SessionInteractionApplicationDependencies } from "./session-interaction-ports.js";

type TestSession = {
  id: string;
  workspaceId: string;
  title: string;
  kind: "primary" | "subtask";
  createdAt: number;
  updatedAt: number;
  forkedFromSessionId: string | null;
  forkedFromItemId: number | null;
  headItemId: number | null;
};

const primary: TestSession = {
  id: "session-primary",
  workspaceId: "workspace",
  title: "Primary",
  kind: "primary" as const,
  createdAt: 1,
  updatedAt: 1,
  forkedFromSessionId: null,
  forkedFromItemId: null,
  headItemId: 5
};

function createDependencies(params?: {
  session?: typeof primary | null;
  workspaceExists?: boolean;
  dedup?: { messageItemId: number; runId: string } | null;
  runStatus?: "idle" | "running";
  lifecycleError?: unknown;
  moveError?: unknown;
  cancelError?: unknown;
}) {
  const calls: unknown[][] = [];
  const sessions = new Map<string, TestSession>([[primary.id, params?.session === undefined ? primary : params.session].filter(Boolean) as [string, TestSession]]);
  const dependencies: SessionInteractionApplicationDependencies = {
    store: {
      workspaceExists: () => params?.workspaceExists ?? true,
      getSession: (id) => sessions.get(id) ?? null,
      listSessions: (workspaceId) => {
        calls.push(["list", workspaceId]);
        return [...sessions.values()];
      },
      createSession: (input) => {
        calls.push(["create", input]);
        sessions.set(input.id, { ...primary, ...input, updatedAt: input.createdAt, headItemId: null });
      },
      cloneSession: async (input) => {
        calls.push(["clone", input]);
        return { ...primary, id: input.id, kind: input.targetKind, headItemId: input.fromItemId };
      },
      findClientRequestDedup: (input) => {
        calls.push(["dedup", input]);
        return params?.dedup ?? null;
      },
      getRunState: (workspaceId, sessionId) => {
        calls.push(["run-state", workspaceId, sessionId]);
        return { status: params?.runStatus ?? "idle" };
      },
      getControlRunState: () => ({
        sessionId: primary.id,
        status: "idle",
        activeRunId: null,
        activeAssistantItemId: null,
        lastResponseTotalTokens: null,
        nonTerminalItemIds: [],
        runNoticeText: "",
        updatedAt: 8,
        appliedItemId: 0,
        lastTerminalStatus: null,
        lastRun: null,
        contextWindowTokens: null,
        contextTokenRatio: null
      }),
      getTranscriptItem: (_sessionId, _workspaceId, itemId) => ({
        id: itemId,
        workspaceId: primary.workspaceId,
        sessionId: primary.id,
        runId: null,
        turnId: null,
        step: null,
        prevId: null,
        kind: "user" as const,
        status: "completed" as const,
        output: { type: "user_text" as const, text: "target" },
        boundaryReason: null,
        archiveAt: null,
        createdAt: 1,
        updatedAt: 1
      }),
      hasNonTerminalItems: () => false,
      moveHead: (input) => {
        calls.push(["move-head", input]);
        if (params?.moveError) throw params.moveError;
      }
    },
    profileReader: {
      resolveUser: (input) => {
        calls.push(["profile", input]);
        return { agentId: "agent", providerId: "provider", modelId: "model" };
      }
    },
    lifecycleStarter: {
      startUserRun: async (input) => {
        calls.push(["start", input]);
        if (params?.lifecycleError) throw params.lifecycleError;
        return { sessionId: input.sessionId, messageItemId: 7, runId: "run", deduplicated: false };
      }
    },
    clock: { nowMs: () => 123 },
    ids: { newSessionId: () => "session-created" },
    logger: { warn: (bindings, message) => calls.push(["warn", bindings, message]) },
    normalizeUiLocale: (value) => value === "zh-CN" || value === "en-US" ? value : null,
    isConflict: (error) => error instanceof AgentConflictError,
    toConflictHttpError: (error) => new HttpError(409, "session head conflict", `conflict_head:${String((error as AgentConflictError).currentHeadItemId)}`)
  };
  return { calls, application: new SessionInteractionApplication(dependencies) };
}

test("SessionInteractionApplication creates primary sessions and delegates public forks through the narrow store", async () => {
  const { calls, application } = createDependencies();
  const created = application.createPrimarySession({ workspaceId: "workspace", title: "  named  " });
  assert.equal(created.id, "session-created");
  assert.deepEqual(calls[0], ["create", {
    id: "session-created", workspaceId: "workspace", title: "named", kind: "primary", createdAt: 123, forkedFromSessionId: null, forkedFromItemId: null
  }]);

  const forked = await application.forkPrimarySession({ fromSessionId: primary.id, fromItemId: 5, mode: "visible_only", title: "fork" });
  assert.equal(forked.id, "session-created");
  assert.deepEqual(calls[1], ["clone", {
    id: "session-created", createdAt: 123, archiveAt: 123, fromSession: primary, fromItemId: 5, mode: "visible_only", title: "fork", targetKind: "primary", boundaryPolicy: "public-user-assistant"
  }]);
});

test("SessionInteractionApplication preserves send validation order, non-authoritative dedup, raw/trim text, and lifecycle conflict mapping", async () => {
  const { calls, application } = createDependencies({ dedup: { messageItemId: 4, runId: "run-existing" } });
  const dedup = await application.sendMessage({
    sessionId: primary.id,
    body: { workspaceId: "workspace", text: " ignored ", clientRequestId: "request" },
    runtime: { enqueueRun() {}, cancelSession() {} }
  });
  assert.deepEqual(dedup, { sessionId: primary.id, messageItemId: 4, runId: "run-existing", deduplicated: true });
  assert.deepEqual(calls.map(([kind]) => kind), ["dedup"]);

  const active = createDependencies();
  const result = await active.application.sendMessage({
    sessionId: primary.id,
    body: { workspaceId: "workspace", text: "  raw text  ", clientRequestId: "request", uiLocale: "zh-CN" },
    runtime: { enqueueRun() {}, cancelSession() {} }
  });
  assert.equal(result.deduplicated, false);
  assert.deepEqual(active.calls.map(([kind]) => kind), ["dedup", "run-state", "profile", "start"]);
  const start = active.calls[3]?.[1] as Record<string, unknown>;
  assert.equal(start.text, "raw text");
  assert.equal(start.inputText, "  raw text  ");
  assert.equal(start.uiLocale, "zh-CN");

  const conflict = createDependencies({ lifecycleError: new AgentConflictError(9) });
  await assert.rejects(
    () => conflict.application.sendMessage({ sessionId: primary.id, body: { workspaceId: "workspace", text: "text", clientRequestId: "request" }, runtime: { enqueueRun() {}, cancelSession() {} } }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.code === "conflict_head:9"
  );
});

test("SessionInteractionApplication validates before its fast paths", async () => {
  const { calls, application } = createDependencies({ session: null, dedup: { messageItemId: 1, runId: "run" } });
  await assert.rejects(
    () => application.sendMessage({ sessionId: "missing", body: { workspaceId: "workspace", text: "text", clientRequestId: "request" }, runtime: { enqueueRun() {}, cancelSession() {} } }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404
  );
  assert.deepEqual(calls, []);
});

test("SessionInteractionApplication reverts before best-effort runtime cancellation and preserves success after a runtime failure", async () => {
  const { calls, application } = createDependencies();
  const runtime = {
    async cancelSession(sessionId: string) {
      calls.push(["cancel", sessionId]);
      throw new Error("future runtime failure");
    }
  };
  const result = await application.revertSession({ sessionId: primary.id, body: { workspaceId: "workspace", itemId: 3 }, runtime });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["run-state", "move-head", "cancel", "warn"]);
  assert.deepEqual(calls[1], ["move-head", { workspaceId: "workspace", sessionId: primary.id, expectedHeadItemId: 5, nextHeadItemId: 3, updatedAt: 123 }]);
  assert.equal(calls[3]?.[2], "cancel session runtime after revert failed");
});
