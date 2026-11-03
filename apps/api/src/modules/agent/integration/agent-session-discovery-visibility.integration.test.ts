import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";
import { appendMessage, createMessageSession } from "../agent-message.store.js";

test("HTTP discovery filters before pagination/total/recent while an opened hidden Session remains directly readable and sendable", async (t) => {
  const f = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(() => f.dispose());
  const workspaceId = f.workspaceId;
  const now = Date.now() - 100;
  for (const visibility of ["listed", "unlisted"] as const) {
    for (let i = 0; i < 5; i++) {
      const id = `${visibility}-${i}`;
      createMessageSession(f.db, { workspaceId, id, title: id, kind: "primary", visibility, createdAt: now });
      appendMessage(f.db, { workspaceId, sessionId: id, id: `${id}-message`, expectedHeadMessageId: null, expectedRevision: 0,
        type: "user", status: "completed", createdAt: now + (visibility === "unlisted" ? 10 : 0),
        parts: [{ id: `${id}-part`, position: 0, type: "text", text: "history" }] });
    }
  }
  const open = await f.app.inject({ method: "PUT", url: `/api/workspaces/${workspaceId}/agent-tab-state/unlisted-0`, payload: { visible: true } });
  assert.equal(open.statusCode, 200, open.body);
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const response = await f.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${workspaceId}&scope=continuable&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.items.length, Math.min(2, 5 - ids.length));
    ids.push(...body.items.map((item: { id: string }) => item.id));
    cursor = body.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(ids, ["listed-4", "listed-3", "listed-2", "listed-1", "listed-0"]);
  const activity = await f.app.inject({ method: "GET", url: `/api/agent/sessions/query?workspaceId=${workspaceId}&updatedWithinSeconds=3600&kind=all&status=all` });
  assert.equal(activity.statusCode, 200, activity.body);
  assert.equal(activity.json().total, 5);
  assert.ok(activity.json().items.every((item: { id: string; userMessageCount: number }) => item.id.startsWith("listed-") && item.userMessageCount === 1));
  const recent = await f.app.inject({ method: "POST", url: "/api/internal/agent/sessions/recent", headers: { "x-awb-agent-internal-token": f.internalToken }, payload: { limit: 2, kind: "all" } });
  assert.equal(recent.statusCode, 200, recent.body);
  assert.equal(recent.body.includes("unlisted-"), false);
  const tabs = await f.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${workspaceId}&scope=tabs` });
  assert.equal(tabs.statusCode, 200, tabs.body);
  assert.ok(tabs.json().items.some((item: { id: string; visibility: string }) => item.id === "unlisted-0" && item.visibility === "unlisted"));
  assert.deepEqual(tabs.json().items.map((item: { id: string }) => item.id).sort(), tabs.json().tabState.openedSessionIds);
  // Missing UI state is not a general execution/read gate.
  f.db.prepare("delete from workspace_session_tab_state where session_id='unlisted-0'").run();
  for (const suffix of ["", "/timeline", "/run-state"]) {
    const response = await f.app.inject({ method: "GET", url: `/api/agent/sessions/unlisted-0${suffix}?workspaceId=${workspaceId}` });
    assert.equal(response.statusCode, 200, response.body);
  }
  const sent = await f.app.inject({ method: "POST", url: "/api/agent/sessions/unlisted-0/messages", payload: {
    workspaceId, clientRequestId: "known-hidden-send", agentId: "default", text: "continue by known ID"
  } });
  assert.equal(sent.statusCode, 201, sent.body);
  const status = await f.app.inject({ method: "GET", url: `/api/agent/sessions/unlisted-0/runs/${sent.json().runId}?workspaceId=${workspaceId}` });
  assert.equal(status.statusCode, 200, status.body);
  const wrongWorkspace = await f.app.inject({ method: "GET", url: "/api/agent/sessions/unlisted-0?workspaceId=missing" });
  assert.equal(wrongWorkspace.statusCode, 404);
});
