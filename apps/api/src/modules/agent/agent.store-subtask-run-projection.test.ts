import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "node:test";
import { insertWorkspace } from "../workspaces/workspace.store.js";
import {
  createAgentSession,
  createRunRecord,
  listSubtaskRunProjectionsByParentTools
} from "./agent.store.js";
import { createAgentTestFixture, type AgentTestFixture } from "./testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];

async function createFixture() {
  const fixture = await createAgentTestFixture({
    dataDirPrefix: "subtask-run-projection-",
    repoRoot: path.resolve(process.cwd(), "../..")
  });
  fixtures.push(fixture);
  insertWorkspace(fixture.db, {
    id: "workspace-a", dirName: "workspace-a", title: "Workspace A", path: path.join(fixture.dataDir, "workspace-a"),
    terminalCredentialId: null, createdAt: 1, updatedAt: 1
  });
  insertWorkspace(fixture.db, {
    id: "workspace-b", dirName: "workspace-b", title: "Workspace B", path: path.join(fixture.dataDir, "workspace-b"),
    terminalCredentialId: null, createdAt: 1, updatedAt: 1
  });
  for (const [id, workspaceId] of [["session-a", "workspace-a"], ["session-b", "workspace-b"]] as const) {
    createAgentSession(fixture.db, {
      id, workspaceId, title: id, kind: "primary", forkedFromSessionId: null, forkedFromItemId: null, createdAt: 1
    });
  }
  return fixture;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

function addRun(fixture: AgentTestFixture, input: {
  runId: string; workspaceId?: "workspace-a" | "workspace-b"; parentRunId: string; parentToolItemId: number;
}) {
  const workspaceId = input.workspaceId ?? "workspace-a";
  createRunRecord(fixture.db, {
    runId: input.runId,
    workspaceId,
    sessionId: workspaceId === "workspace-a" ? "session-a" : "session-b",
    triggerItemId: 1,
    agentId: "agent",
    providerId: "provider",
    modelId: "model",
    parentRunId: input.parentRunId,
    parentToolItemId: input.parentToolItemId,
    status: "running",
    createdAt: 10
  });
}

test("listSubtaskRunProjectionsByParentTools handles empty, partial, duplicate, and two-dimensional keys", async () => {
  const fixture = await createFixture();
  assert.deepEqual(listSubtaskRunProjectionsByParentTools(fixture.db, { workspaceId: "workspace-a", parents: [] }), []);

  addRun(fixture, { runId: "child-1", parentRunId: "parent-a", parentToolItemId: 1 });
  addRun(fixture, { runId: "child-2", parentRunId: "parent-a", parentToolItemId: 2 });
  addRun(fixture, { runId: "child-3", parentRunId: "parent-b", parentToolItemId: 1 });
  const rows = listSubtaskRunProjectionsByParentTools(fixture.db, {
    workspaceId: "workspace-a",
    parents: [
      { parentRunId: "parent-a", parentToolItemId: 1 },
      { parentRunId: "parent-a", parentToolItemId: 1 },
      { parentRunId: "parent-a", parentToolItemId: 2 },
      { parentRunId: "parent-b", parentToolItemId: 1 },
      { parentRunId: "missing", parentToolItemId: 1 }
    ]
  });
  assert.deepEqual(rows.map((row) => [row.runId, row.parentRunId, row.parentToolItemId]).sort(), [
    ["child-1", "parent-a", 1], ["child-2", "parent-a", 2], ["child-3", "parent-b", 1]
  ]);
});

test("listSubtaskRunProjectionsByParentTools preserves raw parent run ids and enforces workspace isolation", async () => {
  const fixture = await createFixture();
  addRun(fixture, { runId: "spaced-child", parentRunId: " parent ", parentToolItemId: 1 });
  addRun(fixture, { runId: "other-workspace-child", workspaceId: "workspace-b", parentRunId: " parent ", parentToolItemId: 2 });

  assert.deepEqual(
    listSubtaskRunProjectionsByParentTools(fixture.db, { workspaceId: "workspace-a", parents: [{ parentRunId: " parent ", parentToolItemId: 1 }] }).map((row) => row.runId),
    ["spaced-child"]
  );
  assert.deepEqual(
    listSubtaskRunProjectionsByParentTools(fixture.db, { workspaceId: "workspace-a", parents: [{ parentRunId: "parent", parentToolItemId: 1 }] }),
    []
  );
  assert.deepEqual(
    listSubtaskRunProjectionsByParentTools(fixture.db, { workspaceId: "workspace-a", parents: [{ parentRunId: " parent ", parentToolItemId: 2 }] }),
    []
  );
  assert.deepEqual(
    listSubtaskRunProjectionsByParentTools(fixture.db, { workspaceId: "workspace-a", parents: [{ parentRunId: "   ", parentToolItemId: 1 }] }),
    []
  );
});

test("listSubtaskRunProjectionsByParentTools supports public-size and full-transcript-size key sets", async () => {
  const fixture = await createFixture();
  const parents = Array.from({ length: 1001 }, (_, index) => ({ parentRunId: `parent-${index}`, parentToolItemId: index + 1 }));
  const insert = fixture.db.transaction(() => {
    for (const [index, parent] of parents.entries()) {
      addRun(fixture, { runId: `child-${index}`, ...parent });
    }
  });
  insert();

  assert.equal(listSubtaskRunProjectionsByParentTools(fixture.db, { workspaceId: "workspace-a", parents: parents.slice(0, 500) }).length, 500);
  assert.equal(listSubtaskRunProjectionsByParentTools(fixture.db, { workspaceId: "workspace-a", parents }).length, 1001);
});
