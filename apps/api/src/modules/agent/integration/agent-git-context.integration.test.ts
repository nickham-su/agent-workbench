import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { AgentApiEndpoints, AgentApiPromptContextResponseSchema } from "@agent-workbench/shared/internal-contracts/agent-api";
import { createP4Fixture } from "./p4-fixture.helpers.js";
import { createSession } from "./context-writeback.helpers.js";
import { createTestRepository, createTestWorkspace } from "../testkit/agent-testkit.js";
import { appendMessage, createMessageRunRecord, getMessageSessionHead } from "../agent-message.store.js";
import { getWorkspace, insertWorkspaceRepo } from "../../workspaces/workspace.store.js";
import { insertRepo } from "../../repos/repo.store.js";
import { newSortableId } from "../../../utils/ids.js";

type Fixture = Awaited<ReturnType<typeof createP4Fixture>>;

async function startContextRun(fixture: Fixture, workspaceId: string) {
  const session = await createSession(fixture.app, workspaceId);
  const head = getMessageSessionHead(fixture.db, { workspaceId, sessionId: session.id });
  assert(head);
  const now = Date.now();
  const triggerMessageId = newSortableId("msg");
  const runId = newSortableId("run");
  appendMessage(fixture.db, {
    id: triggerMessageId, workspaceId, sessionId: session.id,
    expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
    type: "user", status: "completed", originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "context trigger" }], createdAt: now,
  });
  createMessageRunRecord(fixture.db, {
    runId, workspaceId, sessionId: session.id, triggerMessageId,
    agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", status: "running", createdAt: now,
  });
  const changed = fixture.db.prepare(`
    update session_run_state set status = 'running', active_run_id = @runId, updated_at = @now
    where workspace_id = @workspaceId and session_id = @sessionId
  `).run({ workspaceId, sessionId: session.id, runId, now });
  assert.equal(changed.changes, 1);
  return { workspaceId, sessionId: session.id, runId };
}

async function readContext(fixture: Fixture, owner: Awaited<ReturnType<typeof startContextRun>>) {
  const response = await fixture.app.inject({
    method: AgentApiEndpoints.getPromptContext.method, url: AgentApiEndpoints.getPromptContext.path,
    headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: owner,
  });
  assert.equal(response.statusCode, 200);
  const body: unknown = response.json();
  assert(Value.Check(AgentApiPromptContextResponseSchema, body));
  return body;
}

test("same-run API prompt context refreshes registered names without static-cache pollution or 100-item truncation", async (t) => {
  const fixture = await createP4Fixture(t);
  const workspace = getWorkspace(fixture.db, fixture.workspaceId);
  assert(workspace);
  const owner = await startContextRun(fixture, workspace.id);
  await createTestRepository(fixture, { workspace, dirName: "old-repo" });
  await fs.mkdir(path.join(workspace.path, "unregistered-on-disk"));
  const first = await readContext(fixture, owner);
  assert.deepEqual(first.workspaceRepoNames, ["old-repo"]);
  fixture.db.prepare("delete from workspace_repos where workspace_id = ? and dir_name = ?").run(workspace.id, "old-repo");
  const names = Array.from({ length: 101 }, (_, i) => `repo-${i}`);
  for (const dirName of names) await createTestRepository(fixture, { workspace, dirName });
  const corruptId = newSortableId("repo");
  insertRepo(fixture.db, {
    id: corruptId, url: "https://example.test/corrupt.git", credentialId: null, defaultBranch: "main",
    mirrorPath: path.join(fixture.dataDir, "fake-mirror"), syncStatus: "idle", syncError: null,
    lastSyncAt: null, createdAt: 1, updatedAt: 1,
  });
  insertWorkspaceRepo(fixture.db, {
    workspaceId: workspace.id, repoId: corruptId, dirName: "bad\tname",
    path: path.join(workspace.path, "not-scanned"), createdAt: 1, updatedAt: 1,
  });
  const second = await readContext(fixture, owner);
  assert.deepEqual(second.workspaceRepoNames, names);
  assert.deepEqual(second.tools, first.tools);
  assert.equal(second.system, first.system);
  assert(!second.workspaceRepoNames.includes("unregistered-on-disk"));
  assert(!second.workspaceRepoNames.includes("old-repo"));
  fixture.db.prepare("delete from workspace_repos where workspace_id = ?").run(workspace.id);
  assert.deepEqual((await readContext(fixture, owner)).workspaceRepoNames, []);
});

test("dynamic prompt repositories stay Workspace-scoped and foreign run/session ownership is rejected before projection", async (t) => {
  const fixture = await createP4Fixture(t);
  const a = getWorkspace(fixture.db, fixture.workspaceId);
  assert(a);
  const b = await createTestWorkspace(fixture, { title: "another workspace" });
  for (const workspace of [a, b]) await createTestRepository(fixture, { workspace, dirName: "shared-name" });
  await createTestRepository(fixture, { workspace: a, dirName: "only-a" });
  await createTestRepository(fixture, { workspace: b, dirName: "only-b" });
  const ownerA = await startContextRun(fixture, a.id);
  const ownerB = await startContextRun(fixture, b.id);
  assert.deepEqual((await readContext(fixture, ownerA)).workspaceRepoNames, ["shared-name", "only-a"]);
  assert.deepEqual((await readContext(fixture, ownerB)).workspaceRepoNames, ["shared-name", "only-b"]);
  for (const payload of [
    { ...ownerB, workspaceId: a.id },
    { ...ownerA, runId: ownerB.runId },
  ]) {
    const response = await fixture.app.inject({
      method: AgentApiEndpoints.getPromptContext.method, url: AgentApiEndpoints.getPromptContext.path,
      headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload,
    });
    assert([400, 404].includes(response.statusCode));
    assert(!response.body.includes("only-b"));
    assert(!response.body.includes("workspaceRepoNames"));
  }
});
