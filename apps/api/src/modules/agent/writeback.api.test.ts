import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAgentSession, getContextItemById, getSessionHead } from "./agent.store.js";
import { newSortableId } from "../../utils/ids.js";
import {
  createAgentTestFixture,
  createTestWorkspace,
  injectJson,
  type AgentTestFixture
} from "./testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Writeback API fixture cleanup failed");
});

test("P3 real AgentService construction wires create Route through writeback application orchestration to SQLite", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const workspace = await createTestWorkspace(fixture, { title: "writeback API test workspace" });
  const sessionId = newSortableId("sess");
  const createdAt = Date.now();
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "writeback API test session",
    kind: "primary",
    createdAt
  });
  const payload = {
    workspaceId: workspace.id,
    sessionId,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "writeback fixture proof" }
  };

  const created = await injectJson(fixture.app, {
    method: "POST",
    url: "/api/internal/agent/context-items",
    internalToken: fixture.internalToken,
    payload
  });
  assert.equal(created.statusCode, 200, created.body);
  const createdBody = created.json() as { ok: boolean; item: { id: number } };
  assert.equal(createdBody.ok, true);
  assert.equal(getSessionHead(fixture.db, workspace.id, sessionId), createdBody.item.id);

  const stale = await injectJson(fixture.app, {
    method: "POST",
    url: "/api/internal/agent/context-items",
    internalToken: fixture.internalToken,
    payload: { ...payload, output: { type: "user_text", text: "stale head" } }
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.match(String((stale.json() as { code?: unknown }).code), /^conflict_head:/);
  assert.equal(getSessionHead(fixture.db, workspace.id, sessionId), createdBody.item.id);
});

test("P4 real AgentService construction wires update Route through writeback application orchestration to SQLite", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const workspace = await createTestWorkspace(fixture, { title: "writeback update wiring workspace" });
  const sessionId = newSortableId("sess");
  const createdAt = Date.now();
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "writeback update wiring session",
    kind: "primary",
    createdAt
  });

  const created = await injectJson(fixture.app, {
    method: "POST",
    url: "/api/internal/agent/context-items",
    internalToken: fixture.internalToken,
    payload: {
      workspaceId: workspace.id,
      sessionId,
      runId: null,
      turnId: null,
      step: null,
      prevId: null,
      kind: "assistant",
      status: "streaming",
      output: { type: "assistant_text", text: "draft" }
    }
  });
  assert.equal(created.statusCode, 200, created.body);
  const itemId = (created.json() as { item: { id: number } }).item.id;

  const updated = await injectJson(fixture.app, {
    method: "PATCH",
    url: `/api/internal/agent/context-items/${itemId}`,
    internalToken: fixture.internalToken,
    payload: {
      status: "completed",
      output: { type: "assistant_text", text: "final" }
    }
  });
  assert.equal(updated.statusCode, 200, updated.body);
  const updatedBody = updated.json() as { ok: boolean; item: { id: number; status: string; output: unknown } };
  assert.equal(updatedBody.ok, true);
  assert.equal(updatedBody.item.id, itemId);
  assert.equal(updatedBody.item.status, "completed");
  assert.deepEqual(updatedBody.item.output, { type: "assistant_text", text: "final" });
  assert.deepEqual(getContextItemById(fixture.db, itemId)?.output, { type: "assistant_text", text: "final" });
  assert.equal(getContextItemById(fixture.db, itemId)?.status, "completed");
});

test("P4 real update Route returns the stored terminal item without an ignored envelope or SQLite rewrite", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const workspace = await createTestWorkspace(fixture, { title: "writeback terminal unchanged workspace" });
  const sessionId = newSortableId("sess");
  const createdAt = Date.now();
  createAgentSession(fixture.db, {
    id: sessionId,
    workspaceId: workspace.id,
    title: "writeback terminal unchanged session",
    kind: "primary",
    createdAt
  });
  const created = await injectJson(fixture.app, {
    method: "POST",
    url: "/api/internal/agent/context-items",
    internalToken: fixture.internalToken,
    payload: {
      workspaceId: workspace.id,
      sessionId,
      runId: null,
      turnId: null,
      step: null,
      prevId: null,
      kind: "assistant",
      status: "completed",
      output: { type: "assistant_text", text: "stored terminal output" }
    }
  });
  assert.equal(created.statusCode, 200, created.body);
  const itemId = (created.json() as { item: { id: number } }).item.id;
  const storedBefore = getContextItemById(fixture.db, itemId);
  assert.ok(storedBefore);

  const update = await injectJson(fixture.app, {
    method: "PATCH",
    url: `/api/internal/agent/context-items/${itemId}`,
    internalToken: fixture.internalToken,
    payload: {
      status: "failed",
      output: { type: "assistant_text", text: "late output must not persist" }
    }
  });
  assert.equal(update.statusCode, 200, update.body);
  const body = update.json() as { ok: boolean; item: { id: number; status: string; output: unknown; updatedAt: number }; ignored?: unknown };
  assert.equal(body.ok, true);
  assert.equal(body.item.id, storedBefore.id);
  assert.equal(body.item.status, storedBefore.status);
  assert.deepEqual(body.item.output, storedBefore.output);
  assert.equal(body.item.updatedAt, storedBefore.updatedAt);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "ignored"), false);

  const storedAfter = getContextItemById(fixture.db, itemId);
  assert.deepEqual(storedAfter, storedBefore);
});
