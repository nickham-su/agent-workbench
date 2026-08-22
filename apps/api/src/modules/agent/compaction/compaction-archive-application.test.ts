import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentContextItemRecord, AgentSessionRecord } from "@agent-workbench/shared";
import type { AgentApiCompactContextRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import { AgentConflictError } from "../agent.store.js";
import { CompactionArchiveApplication } from "./compaction-archive-application.js";
import type {
  CompactionArchiveApplicationDependencies,
  CompactionArchiveRunState,
} from "./compaction-archive-ports.js";

function item(overrides: Partial<AgentContextItemRecord> = {}): AgentContextItemRecord {
  return {
    id: 10,
    workspaceId: "workspace",
    sessionId: "session",
    runId: "run",
    turnId: null,
    step: null,
    prevId: null,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "done" },
    archiveAt: null,
    boundaryReason: null,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

function session(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: "session",
    workspaceId: "workspace",
    title: "Session",
    kind: "primary",
    forkedFromSessionId: null,
    forkedFromItemId: null,
    createdAt: 1,
    updatedAt: 1,
    headItemId: 10,
    ...overrides,
  };
}

function compactRequest(overrides: Partial<AgentApiCompactContextRequest> = {}): AgentApiCompactContextRequest {
  return {
    workspaceId: "workspace",
    sessionId: "session",
    runId: "run",
    expectedHeadItemId: 10,
    summaryText: "summary",
    ...overrides,
  };
}

function createApplication(overrides: Partial<CompactionArchiveApplicationDependencies> = {}) {
  const calls: string[] = [];
  const runState: CompactionArchiveRunState = { status: "idle", activeRunId: "run" };
  const dependencies: CompactionArchiveApplicationDependencies = {
    sessionQuery: {
      get: () => session(),
      getRun: () => ({ runId: "run", workspaceId: "workspace", sessionId: "session" }),
      getVisibleItems: () => [item()],
      getLatestItemId: () => 11,
    },
    persistence: {
      appendSummaryAndArchiveItems: () => {
        calls.push("db");
        return { summaryItemId: 11, archivedCount: 1 };
      },
    },
    archiveStorage: {
      async appendLines() {
        calls.push("append");
        return [{ filePath: "/archive.log", beforeSize: 0, expectedSize: 10 }];
      },
      async rollbackBestEffort() {
        calls.push("rollback");
        return { reverted: 1, skipped: 0, skippedSnapshots: [] };
      },
      async writePendingBestEffort() {
        calls.push("sidecar");
      },
      async reconcilePendingBestEffort() {
        calls.push("reconcile");
        return false;
      },
    },
    runState: {
      get: () => runState,
      clearLastResponseTokensIfActiveRun: () => calls.push("token-cleanup"),
      setIdle: () => calls.push("set-idle"),
      getControlResult: () => ({}) as never,
    },
    clock: { nowMs: () => 100 },
    logger: { warn: () => calls.push("warn") },
    isConflict: (error) => error instanceof AgentConflictError,
    toConflictHttpError: () => new Error("mapped-conflict"),
    isArchivableItem: (value) => value.status === "completed" || value.status === "failed" || value.status === "cancelled",
    isBoundaryMarkerItem: (value) => value.kind === "system" && value.boundaryReason != null,
    buildArchiveLine: (value) => `item:${value.id}`,
    buildClearSummaryText: () => "clear summary",
    ...overrides,
  };
  return { application: new CompactionArchiveApplication(dependencies), calls };
}

test("CompactionArchiveApplication reconciles before compact validation", async () => {
  const { application, calls } = createApplication({
    sessionQuery: {
      get: () => null,
      getRun: () => null,
      getVisibleItems: () => [],
      getLatestItemId: () => 0,
    },
  });

  await assert.rejects(application.applyWorkerCompaction(compactRequest()), /session not found/);
  assert.deepEqual(calls, ["reconcile"]);
});

test("CompactionArchiveApplication preserves compacted:false for empty or non-terminal visible context", async () => {
  for (const visible of [[], [item({ status: "streaming" })]]) {
    const { application, calls } = createApplication({
      sessionQuery: {
        get: () => session(),
        getRun: () => ({ runId: "run", workspaceId: "workspace", sessionId: "session" }),
        getVisibleItems: () => visible,
        getLatestItemId: () => 0,
      },
    });

    assert.deepEqual(await application.applyWorkerCompaction(compactRequest()), {
      compacted: false,
      summaryItemId: null,
      archivedCount: 0,
    });
    assert.deepEqual(calls, ["reconcile"]);
  }
});

test("CompactionArchiveApplication maps compaction conflicts only after rollback", async () => {
  const { application, calls } = createApplication({
    persistence: {
      appendSummaryAndArchiveItems: () => {
        calls.push("db");
        throw new AgentConflictError(99);
      },
    },
  });

  await assert.rejects(application.applyWorkerCompaction(compactRequest()), /mapped-conflict/);
  assert.deepEqual(calls, ["reconcile", "append", "db", "rollback"]);
});

test("CompactionArchiveApplication writes a compaction sidecar before mapping conflict when rollback skips", async () => {
  const { application, calls } = createApplication({
    persistence: {
      appendSummaryAndArchiveItems: () => {
        calls.push("db");
        throw new AgentConflictError(99);
      },
    },
    archiveStorage: {
      async appendLines() {
        calls.push("append");
        return [{ filePath: "/archive.log", beforeSize: 0, expectedSize: 10 }];
      },
      async rollbackBestEffort() {
        calls.push("rollback");
        return { reverted: 0, skipped: 1, skippedSnapshots: [{ filePath: "/archive.log", beforeSize: 0, expectedSize: 10 }] };
      },
      async writePendingBestEffort() {
        calls.push("sidecar");
      },
      async reconcilePendingBestEffort() {
        calls.push("reconcile");
        return false;
      },
    },
  });

  await assert.rejects(application.applyWorkerCompaction(compactRequest()), /mapped-conflict/);
  assert.deepEqual(calls, ["reconcile", "append", "db", "rollback", "sidecar", "warn"]);
});

test("CompactionArchiveApplication does not compensate committed compact archive when token cleanup fails", async () => {
  const { application, calls } = createApplication({
    runState: {
      get: () => ({ status: "idle", activeRunId: "run" }),
      clearLastResponseTokensIfActiveRun: () => {
        calls.push("token-cleanup");
        throw new Error("token cleanup failed");
      },
      setIdle: () => calls.push("set-idle"),
      getControlResult: () => ({}) as never,
    },
  });

  await assert.rejects(application.applyWorkerCompaction(compactRequest()), /token cleanup failed/);
  assert.deepEqual(calls, ["reconcile", "append", "db", "token-cleanup"]);
});

test("CompactionArchiveApplication keeps clear idle-write failure inside compensation and writes clear sidecar", async () => {
  const { application, calls } = createApplication({
    archiveStorage: {
      async appendLines() {
        calls.push("append");
        return [{ filePath: "/archive.log", beforeSize: 0, expectedSize: 10 }];
      },
      async rollbackBestEffort() {
        calls.push("rollback");
        return { reverted: 0, skipped: 1, skippedSnapshots: [{ filePath: "/archive.log", beforeSize: 0, expectedSize: 10 }] };
      },
      async writePendingBestEffort(params) {
        calls.push(`sidecar:${params.operation}`);
      },
      async reconcilePendingBestEffort() {
        calls.push("reconcile");
        return false;
      },
    },
    runState: {
      get: () => ({ status: "idle", activeRunId: null }),
      clearLastResponseTokensIfActiveRun: () => calls.push("token-cleanup"),
      setIdle: () => {
        calls.push("set-idle");
        throw new Error("idle write failed");
      },
      getControlResult: () => ({}) as never,
    },
  });

  await assert.rejects(application.clearSession({ sessionId: "session", workspaceId: "workspace" }), /idle write failed/);
  assert.deepEqual(calls, ["reconcile", "append", "db", "set-idle", "rollback", "sidecar:clear", "warn"]);
});
