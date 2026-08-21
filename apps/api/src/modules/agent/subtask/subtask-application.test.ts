import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../../app/errors.js";
import { SubtaskApplication } from "./subtask-application.js";
import type {
  SubtaskApplicationDependencies,
  SubtaskChildActivationInput,
  SubtaskRunRecord,
} from "./subtask-ports.js";

const workspaceId = "workspace";
const parentSessionId = "parent-session";
const parentRunId = "parent-run";
const parentToolItemId = 7;

function childRun(overrides: Partial<SubtaskRunRecord> = {}): SubtaskRunRecord {
  return {
    runId: "winner-run",
    workspaceId,
    sessionId: "winner-session",
    triggerItemId: 8,
    agentId: "agent",
    providerId: "provider",
    modelId: "model",
    uiLocale: "zh-CN",
    subtaskDepth: 1,
    parentRunId,
    parentToolItemId,
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    parentSessionId,
    parentRunId,
    parentToolItemId,
    description: "child task",
    prompt: "complete child task",
    agentId: "agent",
    session: { mode: "fork" as const },
    ...overrides,
  };
}

function dependencies(overrides: Partial<SubtaskApplicationDependencies> = {}) {
  const calls: string[] = [];
  let existing: SubtaskRunRecord | null = null;
  const result: SubtaskApplicationDependencies = {
    parentAnchorReader: {
      resolve: () => {
        calls.push("anchor");
        return {
          parentSession: {
            id: parentSessionId,
            workspaceId,
            title: "parent",
            kind: "primary",
            createdAt: 1,
            updatedAt: 1,
            forkedFromSessionId: null,
            forkedFromItemId: null,
            headItemId: null,
          },
          parentRun: {
            ...childRun({
              runId: parentRunId,
              sessionId: parentSessionId,
              subtaskDepth: 0,
              parentRunId: null,
              parentToolItemId: null,
            }),
          },
          parentUiLocale: "zh-CN",
          anchor: {
            id: parentToolItemId,
            workspaceId,
            sessionId: parentSessionId,
            runId: parentRunId,
            turnId: "turn",
            step: 1,
            prevId: 4,
            kind: "tool",
            status: "completed",
            output: {
              type: "tool",
              toolName: "subtask",
              toolCallId: "call",
              args: {},
            },
            createdAt: 1,
            updatedAt: 1,
            archiveAt: null,
            boundaryReason: null,
          },
        };
      },
    },
    lineagePersistence: {
      findChildByParentTool: () => {
        calls.push("lineage");
        return existing;
      },
      isParentToolUniqueConflict: () => false,
    },
    sessionMaterializer: {
      async resolveForStart() {
        calls.push("materialize");
        return {
          session: {
            id: "new-session",
            workspaceId,
            title: "child",
            kind: "subtask",
            createdAt: 1,
            updatedAt: 1,
            forkedFromSessionId: parentSessionId,
            forkedFromItemId: parentToolItemId,
            headItemId: null,
          },
          createdSessionId: "new-session",
        };
      },
      resolveForkBoundary: () => {
        calls.push("boundary");
        return 3;
      },
    },
    executionProfileReader: {
      resolve: () => {
        calls.push("profile");
        return {
          agentId: "agent",
          agentName: "Agent",
          providerId: "provider",
          modelId: "model",
          contextWindowTokens: 100,
        };
      },
      findAgentName: (agentId) => (agentId === "agent" ? "Agent" : null),
      getMaxDepth: () => 2,
    },
    workspaceReader: { get: () => ({ path: "/workspace" }) },
    parentRunStateReader: {
      get: () => ({ status: "idle", lastResponseTotalTokens: 95 }),
    },
    childRunActivator: {
      activate: (input) => {
        calls.push("activate");
        assert.equal(input.seedItems.at(-1)?.attachToRun, true);
        return { kind: "activated", promptItemId: 9 };
      },
    },
    runQuery: {
      findSession: () => null,
      findRunInSession: () => null,
      listVisibleItemsByRun: () => [],
    },
    localCompensationPersistence: {
      deleteNewSessionIfStillEmpty: () => {
        calls.push("compensate");
        return true;
      },
    },
    orphanPersistence: {
      listSuspects: () => [],
      deleteSuspectIfStillEligible: () => false,
    },
    clock: { nowMs: () => 100 },
    ids: { newId: () => "new-run" },
    logger: { warn: () => calls.push("warn"), error: () => undefined },
    forkGuardTextReader: { get: () => "fork guard" },
  };
  Object.assign(result, overrides);
  return {
    result,
    calls,
    setExisting: (value: SubtaskRunRecord | null) => {
      existing = value;
    },
  };
}

function assertHttpError(error: unknown, code: string) {
  assert.ok(error instanceof HttpError);
  assert.equal(error.code, code);
}

test("P3 application: prefork keeps anchor validation, threshold floor/default, and plan values", () => {
  const { result, calls } = dependencies();
  const application = new SubtaskApplication(result);
  const plan = application.getPreforkPlan({
    workspaceId,
    parentSessionId,
    parentRunId,
    parentToolItemId,
    agentId: "agent",
    thresholdPct: 95.9,
  });
  assert.deepEqual(plan, {
    shouldPrefork: true,
    thresholdPct: 95,
    parentLastResponseTotalTokens: 95,
    childContextWindowTokens: 100,
    thresholdTokens: 95,
  });
  assert.deepEqual(calls, ["anchor", "profile"]);
  assert.throws(
    () =>
      application.getPreforkPlan({
        workspaceId,
        parentSessionId,
        parentRunId,
        parentToolItemId,
        agentId: "agent",
        thresholdPct: 49,
      }),
    (error) => {
      assertHttpError(error, "AGENT_SUBTASK_PREFORK_THRESHOLD_INVALID");
      return true;
    },
  );
});

test("P3 application: start materializes and activates fork seeds in summary, guard, prompt order", async () => {
  const captured: SubtaskChildActivationInput[] = [];
  const base = dependencies();
  base.result.childRunActivator = {
    activate(input) {
      captured.push(input);
      base.calls.push("activate");
      return { kind: "activated", promptItemId: 9 };
    },
  };
  const application = new SubtaskApplication(base.result);
  const started = await application.startSubtask(
    request({
      preforkSummaryText: "summary",
      preforkMeta: {
        thresholdPct: 95,
        parentLastResponseTotalTokens: 95,
        childContextWindowTokens: 100,
      },
    }),
  );
  assert.deepEqual(started, {
    sessionId: "new-session",
    runId: "new-run",
    workspacePath: "/workspace",
    agentName: "Agent",
    reused: false,
  });
  assert.deepEqual(captured[0]?.seedItems, [
    { kind: "system", text: "summary", attachToRun: false },
    { kind: "system", text: "fork guard", attachToRun: false },
    { kind: "user", text: "complete child task", attachToRun: true },
  ]);
  assert.deepEqual(base.calls, [
    "anchor",
    "anchor",
    "profile",
    "lineage",
    "boundary",
    "materialize",
    "profile",
    "activate",
  ]);
});

test("P3 application: existing child fast-return avoids materialization and activation", async () => {
  const base = dependencies();
  base.setExisting(childRun());
  const application = new SubtaskApplication(base.result);
  const reused = await application.startSubtask(request());
  assert.equal(reused.reused, true);
  assert.equal(reused.runId, "winner-run");
  assert.deepEqual(base.calls, ["anchor", "lineage"]);
});

test("P3 application: target unique conflict compensates loser then re-queries and returns winner", async () => {
  const base = dependencies();
  let queries = 0;
  base.result.lineagePersistence = {
    findChildByParentTool: () => {
      base.calls.push("lineage");
      queries += 1;
      return queries === 1 ? null : childRun();
    },
    isParentToolUniqueConflict: () => true,
  };
  base.result.childRunActivator = {
    activate: () => {
      throw Object.assign(new Error("unique"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
    },
  };
  const application = new SubtaskApplication(base.result);
  const reused = await application.startSubtask(
    request({ session: { mode: "new" } }),
  );
  assert.equal(reused.reused, true);
  assert.deepEqual(base.calls.slice(-2), ["compensate", "lineage"]);
});

test("P3 application: original failure wins when no race winner; existing sessions are never compensated", async () => {
  const base = dependencies();
  base.result.sessionMaterializer = {
    async resolveForStart() {
      return {
        session: {
          id: "existing",
          workspaceId,
          title: "existing",
          kind: "subtask",
          createdAt: 1,
          updatedAt: 1,
          forkedFromSessionId: null,
          forkedFromItemId: null,
          headItemId: null,
        },
        createdSessionId: null,
      };
    },
    resolveForkBoundary: () => null,
  };
  const original = new Error("activation failed");
  base.result.childRunActivator = {
    activate: () => {
      throw original;
    },
  };
  const application = new SubtaskApplication(base.result);
  await assert.rejects(
    () =>
      application.startSubtask(
        request({ session: { mode: "existing", sessionId: "existing" } }),
      ),
    (error) => error === original,
  );
  assert.equal(base.calls.includes("compensate"), false);
});

test("P3 application: compensation failures never override the race winner or original activation error", async () => {
  const winnerCase = dependencies();
  let queries = 0;
  winnerCase.result.lineagePersistence = {
    findChildByParentTool: () => {
      queries += 1;
      return queries === 1 ? null : childRun();
    },
    isParentToolUniqueConflict: () => true,
  };
  winnerCase.result.childRunActivator = {
    activate: () => {
      throw Object.assign(new Error("unique"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
    },
  };
  winnerCase.result.localCompensationPersistence = {
    deleteNewSessionIfStillEmpty: () => {
      throw new Error("cleanup failed");
    },
  };
  const winner = await new SubtaskApplication(winnerCase.result).startSubtask(
    request({ session: { mode: "new" } }),
  );
  assert.equal(winner.reused, true);
  assert.equal(winnerCase.calls.includes("warn"), true);

  const originalCase = dependencies();
  const original = new Error("activation failed");
  originalCase.result.childRunActivator = {
    activate: () => {
      throw original;
    },
  };
  originalCase.result.localCompensationPersistence = {
    deleteNewSessionIfStillEmpty: () => {
      throw new Error("cleanup failed");
    },
  };
  await assert.rejects(
    () =>
      new SubtaskApplication(originalCase.result).startSubtask(
        request({ session: { mode: "new" } }),
      ),
    (error) => error === original,
  );
  assert.equal(originalCase.calls.includes("warn"), true);
});

test("P4 application: result/status fence ownership and preserve assistant-first partial output", () => {
  const sessionId = "result-session";
  const runId = "result-run";
  const { result } = dependencies({
    runQuery: {
      findSession: (id) => id === sessionId
        ? {
            id: sessionId,
            workspaceId,
            title: "child",
            kind: "subtask",
            createdAt: 1,
            updatedAt: 1,
            forkedFromSessionId: null,
            forkedFromItemId: null,
            headItemId: 3,
          }
        : null,
      findRunInSession: (input) => input.workspaceId === workspaceId && input.sessionId === sessionId && input.runId === runId
        ? childRun({ runId, sessionId, status: "failed" })
        : null,
      listVisibleItemsByRun: (input) => {
        assert.deepEqual(input, { workspaceId, sessionId, runId });
        return [
          {
            id: 1, workspaceId, sessionId, runId, turnId: null, step: null,
            prevId: null, kind: "system", status: "completed",
            output: { type: "system_text", text: "fallback" }, createdAt: 1,
            updatedAt: 1, archiveAt: null, boundaryReason: null,
          },
          {
            id: 2, workspaceId, sessionId, runId, turnId: null, step: null,
            prevId: 1, kind: "assistant", status: "completed",
            output: { type: "assistant_text", text: "partial answer" },
            createdAt: 2, updatedAt: 2, archiveAt: null, boundaryReason: null,
          },
        ];
      },
    },
  });
  const application = new SubtaskApplication(result);

  assert.deepEqual(application.getStatus({ workspaceId, sessionId, runId }), { status: "failed" });
  assert.deepEqual(application.getResult({ workspaceId, sessionId, runId }), { resultText: "partial answer" });
  assert.throws(
    () => application.getResult({ workspaceId, sessionId: "wrong-session", runId }),
    (error) => error instanceof HttpError && error.statusCode === 404,
  );
});

test("P4 application: result falls back to system text, then empty text", () => {
  const sessionId = "fallback-session";
  const runId = "fallback-run";
  const { result } = dependencies({
    runQuery: {
      findSession: () => ({
        id: sessionId, workspaceId, title: "child", kind: "subtask", createdAt: 1,
        updatedAt: 1, forkedFromSessionId: null, forkedFromItemId: null, headItemId: null,
      }),
      findRunInSession: () => childRun({ runId, sessionId, status: "cancelled" }),
      listVisibleItemsByRun: () => [],
    },
  });
  const application = new SubtaskApplication(result);

  assert.deepEqual(application.getResult({ workspaceId, sessionId, runId }), { resultText: "" });
  result.runQuery.listVisibleItemsByRun = () => [{
    id: 1, workspaceId, sessionId, runId, turnId: null, step: null, prevId: null,
    kind: "system", status: "completed", output: { type: "system_text", text: "system fallback" },
    createdAt: 1, updatedAt: 1, archiveAt: null, boundaryReason: null,
  }];
  assert.deepEqual(application.getResult({ workspaceId, sessionId, runId }), { resultText: "system fallback" });
});

test("P5 application: orphan cleanup applies conservative policy, summary, and candidate isolation", () => {
  const calls: string[] = [];
  const now = 100 * 24 * 60 * 60 * 1000;
  const deletableCreatedAt = now - 25 * 60 * 60 * 1000;
  const { result } = dependencies({
    orphanPersistence: {
      listSuspects: ({ olderThan }) => {
        calls.push(`list:${olderThan}`);
        return [
          { workspaceId, sessionId: "retained", createdAt: now - 2 * 60 * 60 * 1000, forkedFromSessionId: "parent", forkedFromItemId: 1 },
          { workspaceId, sessionId: "missing-lineage", createdAt: deletableCreatedAt, forkedFromSessionId: null, forkedFromItemId: null },
          { workspaceId, sessionId: "deleted", createdAt: deletableCreatedAt, forkedFromSessionId: "parent", forkedFromItemId: 1 },
          { workspaceId, sessionId: "skipped", createdAt: deletableCreatedAt, forkedFromSessionId: "parent", forkedFromItemId: 1 },
          { workspaceId, sessionId: "failed", createdAt: deletableCreatedAt, forkedFromSessionId: "parent", forkedFromItemId: 1 },
          { workspaceId, sessionId: "after-failure", createdAt: deletableCreatedAt, forkedFromSessionId: "parent", forkedFromItemId: 1 },
        ];
      },
      deleteSuspectIfStillEligible: ({ sessionId, olderThan }) => {
        calls.push(`delete:${sessionId}:${olderThan}`);
        if (sessionId === "deleted" || sessionId === "after-failure") return true;
        if (sessionId === "skipped") return false;
        throw new Error("injected delete failure");
      },
    },
  });
  const summary = new SubtaskApplication(result).cleanupOrphansOnStartup({ now });

  assert.deepEqual(summary, {
    scanned: 6,
    retained: 2,
    deleted: 2,
    skippedAfterRecheck: 1,
    failed: 1,
  });
  assert.deepEqual(calls, [
    `list:${now - 60 * 60 * 1000}`,
    `delete:deleted:${now - 24 * 60 * 60 * 1000}`,
    `delete:skipped:${now - 24 * 60 * 60 * 1000}`,
    `delete:failed:${now - 24 * 60 * 60 * 1000}`,
    `delete:after-failure:${now - 24 * 60 * 60 * 1000}`,
  ]);
});

test("P5 application: orphan list failure reaches the startup caller", () => {
  const { result } = dependencies({
    orphanPersistence: {
      listSuspects: () => {
        throw new Error("injected list failure");
      },
      deleteSuspectIfStillEligible: () => false,
    },
  });
  assert.throws(
    () => new SubtaskApplication(result).cleanupOrphansOnStartup(),
    /injected list failure/,
  );
});
