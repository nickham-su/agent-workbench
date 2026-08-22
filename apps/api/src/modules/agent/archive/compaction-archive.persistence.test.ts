import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { newSortableId } from "../../../utils/ids.js";
import {
  AgentConflictError,
  appendContextItem,
  createAgentSession,
  getContextItemById,
  getSessionHead,
  getSessionTranscriptItems,
} from "../agent.store.js";
import { SqliteCompactionArchivePersistence } from "./sqlite-compaction-archive-persistence.js";
import {
  createAgentTestFixture,
  createTestWorkspace,
  type AgentTestFixture,
} from "../testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function createPersistenceFixture() {
  const fixture = await createAgentTestFixture({ agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  const workspace = await createTestWorkspace(fixture, {
    title: "P1 archive persistence",
  });
  const sessionId = newSortableId("sess");
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "archive persistence",
    kind: "primary",
    createdAt: 100,
  });
  return { fixture, workspaceId: workspace.id, sessionId };
}

function appendUser(params: {
  fixture: AgentTestFixture;
  workspaceId: string;
  sessionId: string;
  prevId: number | null;
  text: string;
  createdAt: number;
}) {
  return appendContextItem(params.fixture.db, {
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    runId: null,
    turnId: null,
    step: null,
    prevId: params.prevId,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: params.text },
    createdAt: params.createdAt,
  });
}

test("P2 real SQLite: summary/archive transaction writes summary, archives requested items, moves head, and touches session", async () => {
  const { fixture, workspaceId, sessionId } = await createPersistenceFixture();
  const first = appendUser({
    fixture,
    workspaceId,
    sessionId,
    prevId: null,
    text: "first",
    createdAt: 110,
  });
  const second = appendUser({
    fixture,
    workspaceId,
    sessionId,
    prevId: first.id,
    text: "second",
    createdAt: 120,
  });
  const beforeUpdatedAt = (
    fixture.db
      .prepare("select updated_at as updatedAt from agent_session where id = ?")
      .get(sessionId) as { updatedAt: number }
  ).updatedAt;

  const result = new SqliteCompactionArchivePersistence(
    fixture.db,
  ).appendSummaryAndArchiveItems({
    workspaceId,
    sessionId,
    runId: null,
    expectedHeadItemId: second.id,
    summaryText: "summary",
    boundaryReason: "compaction",
    summaryCreatedAt: 200,
    archiveItemIds: [first.id, second.id, 999_999],
    archiveAt: 201,
  });

  assert.deepEqual(result, {
    summaryItemId: getSessionHead(fixture.db, workspaceId, sessionId),
    archivedCount: 2,
  });
  const summary = getContextItemById(fixture.db, result.summaryItemId);
  assert.ok(summary);
  assert.equal(summary.kind, "system");
  assert.equal(summary.runId, null);
  assert.equal(summary.boundaryReason, "compaction");
  assert.equal((summary.output as { text: string }).text, "summary");
  assert.equal(summary.prevId, second.id);
  assert.equal(getContextItemById(fixture.db, first.id)?.archiveAt, 201);
  assert.equal(getContextItemById(fixture.db, second.id)?.archiveAt, 201);
  assert.equal(
    (
      fixture.db
        .prepare(
          "select updated_at as updatedAt from agent_session where id = ?",
        )
        .get(sessionId) as { updatedAt: number }
    ).updatedAt > beforeUpdatedAt,
    true,
  );
});

test("P2 real SQLite: stale head conflicts before any summary or archive mutation", async () => {
  const { fixture, workspaceId, sessionId } = await createPersistenceFixture();
  const item = appendUser({
    fixture,
    workspaceId,
    sessionId,
    prevId: null,
    text: "current",
    createdAt: 110,
  });
  const beforeItems = getSessionTranscriptItems(
    fixture.db,
    workspaceId,
    sessionId,
  );

  assert.throws(
    () =>
      new SqliteCompactionArchivePersistence(
        fixture.db,
      ).appendSummaryAndArchiveItems({
        workspaceId,
        sessionId,
        runId: null,
        expectedHeadItemId: null,
        summaryText: "stale",
        boundaryReason: "clear",
        summaryCreatedAt: 200,
        archiveItemIds: [item.id],
        archiveAt: 201,
      }),
    AgentConflictError,
  );

  assert.deepEqual(
    getSessionTranscriptItems(fixture.db, workspaceId, sessionId),
    beforeItems,
  );
  assert.equal(getSessionHead(fixture.db, workspaceId, sessionId), item.id);
});

test("P2 real SQLite: a transaction failure rolls back summary insertion and prior archive updates", async () => {
  const { fixture, workspaceId, sessionId } = await createPersistenceFixture();
  const first = appendUser({
    fixture,
    workspaceId,
    sessionId,
    prevId: null,
    text: "first",
    createdAt: 110,
  });
  const second = appendUser({
    fixture,
    workspaceId,
    sessionId,
    prevId: first.id,
    text: "second",
    createdAt: 120,
  });
  fixture.db.exec(`
    create trigger fail_archive_summary_head
    before insert on agent_session_head
    when new.session_id = '${sessionId}'
    begin
      select raise(abort, 'injected summary head failure');
    end;
  `);

  assert.throws(
    () =>
      new SqliteCompactionArchivePersistence(
        fixture.db,
      ).appendSummaryAndArchiveItems({
        workspaceId,
        sessionId,
        runId: null,
        expectedHeadItemId: second.id,
        summaryText: "must rollback",
        boundaryReason: "compaction",
        summaryCreatedAt: 200,
        archiveItemIds: [first.id, second.id],
        archiveAt: 201,
      }),
    /injected summary head failure/,
  );

  assert.equal(getSessionHead(fixture.db, workspaceId, sessionId), second.id);
  assert.equal(getContextItemById(fixture.db, first.id)?.archiveAt, null);
  assert.equal(getContextItemById(fixture.db, second.id)?.archiveAt, null);
  assert.deepEqual(
    getSessionTranscriptItems(fixture.db, workspaceId, sessionId).map(
      (item) => item.id,
    ),
    [first.id, second.id],
  );
});
