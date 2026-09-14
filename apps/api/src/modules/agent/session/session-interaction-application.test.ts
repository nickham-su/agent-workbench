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
      setManualTitle: (input) => {
        calls.push(["set-manual-title", input]);
        const existing = sessions.get(input.sessionId);
        if (!existing || existing.workspaceId !== input.workspaceId) return false;
        sessions.set(input.sessionId, { ...existing, title: input.title });
        return true;
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
  return { calls, sessions, application: new SessionInteractionApplication(dependencies) };
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
  assert.deepEqual(active.calls[2], ["profile", { workspaceId: "workspace", sessionId: primary.id, requestedAgentId: undefined }]);
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

test("SessionInteractionApplication accepts an image-only normalized message", async () => {
  const { calls, application } = createDependencies();
  const result = await application.sendMessage({
    sessionId: primary.id,
    body: {
      workspaceId: "workspace",
      text: "   ",
      clientRequestId: "image-only",
      images: [{
        attachmentId: "att_image",
        storageKey: "att_image",
        tempId: "tmp_image",
        filename: "pasted-image.png",
        mediaType: "image/png",
        byteSize: 8,
        position: 0
      }]
    },
    runtime: { enqueueRun() {}, cancelSession() {} }
  });
  assert.equal(result.deduplicated, false);
  const start = calls.find(([kind]) => kind === "start")?.[1] as Record<string, unknown>;
  assert.equal(start.text, "");
  assert.deepEqual(start.images, [{ attachmentId: "att_image", storageKey: "att_image", tempId: "tmp_image", filename: "pasted-image.png", mediaType: "image/png", byteSize: 8, position: 0 }]);
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

test("updateSessionTitle succeeds for primary and subtask sessions and normalizes whitespace", () => {
  const { calls, application } = createDependencies();
  const record = application.updateSessionTitle({
    sessionId: primary.id,
    body: { workspaceId: "workspace", title: "  修复   登录问题  " }
  });
  assert.equal(record.title, "修复 登录问题");
  const setCall = calls.find(([kind]) => kind === "set-manual-title");
  assert.ok(setCall);
  assert.deepEqual(setCall[1], { sessionId: primary.id, workspaceId: "workspace", title: "修复 登录问题" });

  // subtask session 允许更新标题
  const subtask = { ...primary, id: "session-subtask", kind: "subtask" as const };
  const subtaskDeps = createDependencies();
  subtaskDeps.sessions.set(subtask.id, subtask);
  const subtaskRecord = subtaskDeps.application.updateSessionTitle({
    sessionId: subtask.id,
    body: { workspaceId: "workspace", title: "Subtask 标题" }
  });
  assert.equal(subtaskRecord.title, "Subtask 标题");
});

test("updateSessionTitle accepts a 50-character title and rejects 51 characters", () => {
  const { application } = createDependencies();
  const fifty = "a".repeat(50);
  const ok = application.updateSessionTitle({ sessionId: primary.id, body: { workspaceId: "workspace", title: fifty } });
  assert.equal(ok.title, fifty);
  assert.throws(
    () => application.updateSessionTitle({ sessionId: primary.id, body: { workspaceId: "workspace", title: "a".repeat(51) } }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400 && (error as HttpError & { code?: string }).code === "AGENT_SESSION_TITLE_TOO_LONG"
  );
});

test("updateSessionTitle rejects blank titles with AGENT_SESSION_TITLE_EMPTY", () => {
  const { application } = createDependencies();
  assert.throws(
    () => application.updateSessionTitle({ sessionId: primary.id, body: { workspaceId: "workspace", title: "   " } }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400 && (error as HttpError & { code?: string }).code === "AGENT_SESSION_TITLE_EMPTY"
  );
});

test("updateSessionTitle rejects control characters with AGENT_SESSION_TITLE_INVALID_CHARACTERS", () => {
  const { application } = createDependencies();
  assert.throws(
    () => application.updateSessionTitle({ sessionId: primary.id, body: { workspaceId: "workspace", title: "bad\u0007title" } }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400 && (error as HttpError & { code?: string }).code === "AGENT_SESSION_TITLE_INVALID_CHARACTERS"
  );
  // \n 被空白压缩消除后合法
  const ok = application.updateSessionTitle({ sessionId: primary.id, body: { workspaceId: "workspace", title: "a\nb" } });
  assert.equal(ok.title, "a b");
});

test("updateSessionTitle treats saving the identical valid title as manual takeover and stays idempotent", () => {
  const { calls, application } = createDependencies();
  const first = application.updateSessionTitle({ sessionId: primary.id, body: { workspaceId: "workspace", title: "Same" } });
  assert.equal(first.title, "Same");
  const second = application.updateSessionTitle({ sessionId: primary.id, body: { workspaceId: "workspace", title: "Same" } });
  assert.equal(second.title, "Same");
  assert.equal(calls.filter(([kind]) => kind === "set-manual-title").length, 2);
});

test("updateSessionTitle returns 404 for missing session and 400 for workspace mismatch before store mutation", () => {
  const { calls, application } = createDependencies({ session: null });
  assert.throws(
    () => application.updateSessionTitle({ sessionId: "missing", body: { workspaceId: "workspace", title: "x" } }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404
  );
  assert.equal(calls.filter(([kind]) => kind === "set-manual-title").length, 0);

  const mismatch = createDependencies();
  assert.throws(
    () => mismatch.application.updateSessionTitle({ sessionId: primary.id, body: { workspaceId: "other", title: "x" } }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400 && (error as HttpError & { code?: string }).code === undefined
  );
  assert.equal(mismatch.calls.filter(([kind]) => kind === "set-manual-title").length, 0);
});

test("updateSessionTitle returns 404 when the store mutation misses", () => {
  const first = createDependencies();
  const baseStoreCalls = first.calls;
  void baseStoreCalls;
  const disappearingStore: SessionInteractionApplicationDependencies["store"] = {
    workspaceExists: () => true,
    getSession: (id) => (id === "session-primary" ? { ...primary } : null),
    listSessions: () => [],
    createSession: () => undefined,
    cloneSession: async () => { throw new Error("unused"); },
    setManualTitle: () => false,
    findClientRequestDedup: () => null,
    getRunState: () => ({ status: "idle" }),
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
    getTranscriptItem: () => null,
    hasNonTerminalItems: () => false,
    moveHead: () => undefined
  };
  const application = new SessionInteractionApplication({
    store: disappearingStore,
    profileReader: { resolveUser: () => ({ agentId: "a", providerId: "p", modelId: "m" }) },
    lifecycleStarter: { startUserRun: async () => ({ sessionId: primary.id, messageItemId: 1, runId: "r", deduplicated: false }) },
    clock: { nowMs: () => 1 },
    ids: { newSessionId: () => "x" },
    logger: { warn: () => undefined },
    normalizeUiLocale: () => null,
    isConflict: () => false,
    toConflictHttpError: (error) => error as Error
  });
  assert.throws(
    () => application.updateSessionTitle({ sessionId: primary.id, body: { workspaceId: "workspace", title: "x" } }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404
  );
});
