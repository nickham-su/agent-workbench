import { listenAgentTestApp } from "../testkit/agent-testkit.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";
import { AgentRunCompletedEventHub, type AgentRunCompletedEvent } from "../run-completed-events.js";
import { appendMessage, createMessageSession, createMessageRunRecord, startMessageRun, getRunRecord } from "../agent-message.store.js";

// A listed event is the ordering barrier for negative assertions: all earlier
// synchronous hub callbacks have already run, rather than relying on a sleep.
test("hidden completions remain internal and directed, but never enter either global SSE subscription", { timeout: 20_000 }, async (t) => {
  const f = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(() => f.dispose());
  const events: AgentRunCompletedEvent[] = [];
  let hub: AgentRunCompletedEventHub | undefined;
  const originalPublish = AgentRunCompletedEventHub.prototype.publish;
  t.mock.method(AgentRunCompletedEventHub.prototype, "publish", function (this: AgentRunCompletedEventHub, event: AgentRunCompletedEvent) {
    events.push(event);
    hub = this;
    originalPublish.call(this, event);
  });
  const origin = await listenAgentTestApp(f.app, 0);
  const streams = await Promise.all([1, 2].map(async () => {
    const abort = new AbortController();
    const response = await fetch(`${origin}/api/internal/agent/events/sse`, {
      headers: { "x-awb-agent-internal-token": f.internalToken }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    t.after(async () => { abort.abort(); await reader.cancel().catch(() => {}); });
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { done, value } = await reader.read();
        if (done) throw new Error("SSE closed before ordering barrier");
        text += decoder.decode(value, { stream: true });
      }
      return text;
    };
    await readUntil(": connected");
    return { readUntil };
  }));

  const complete = async (id: string, visibility: "listed" | "unlisted", opened: boolean) => {
    const now = Date.now();
    createMessageSession(f.db, { id, workspaceId: f.workspaceId, kind: "primary", visibility, title: id, createdAt: now });
    f.db.prepare("update workspace_session_tab_state set visible=? where session_id=?").run(Number(opened), id);
    appendMessage(f.db, { id: `${id}-message`, workspaceId: f.workspaceId, sessionId: id,
      expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", createdAt: now,
      parts: [{ id: `${id}-part`, position: 0, type: "text", text: "SSE fixture" }] });
    createMessageRunRecord(f.db, { runId: `${id}-run`, workspaceId: f.workspaceId, sessionId: id,
      triggerMessageId: `${id}-message`, agentId: "default", providerId: "ppchat", modelId: "gpt-5.2",
      subtaskDepth: 0, status: "running", createdAt: now });
    startMessageRun(f.db, { workspaceId: f.workspaceId, sessionId: id, runId: `${id}-run`, updatedAt: now });
    for (const [route, payload] of [
      ["terminal-intent", { status: "completed", code: "run_completed", detail: null }],
      ["converge-terminal", {}]
    ] as const) {
      const response = await f.app.inject({ method: "POST", url: `/api/internal/agent/runs/${route}`,
        headers: { "x-awb-agent-internal-token": f.internalToken },
        payload: { workspaceId: f.workspaceId, sessionId: id, runId: `${id}-run`, updatedAt: now, ...payload } });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal(getRunRecord(f.db, `${id}-run`)!.status, "completed");
  };
  await complete("hidden-closed", "unlisted", false);
  await complete("hidden-opened", "unlisted", true);
  assert.ok(events.some((event) => event.runId === "hidden-closed-run"));
  assert.ok(events.some((event) => event.runId === "hidden-opened-run"));
  assert.ok(hub);
  const synthetic = (eventId: string, sessionId: string, workspaceId = f.workspaceId): AgentRunCompletedEvent => ({
    eventId, eventType: "agent.run.completed.v1", occurredAt: Date.now(), sessionId, workspaceId, runId: eventId, finalStatus: "completed"
  });
  hub.publish(synthetic("missing-session-event", "missing"));
  hub.publish(synthetic("wrong-workspace-event", "hidden-opened", "missing-workspace"));
  const prepare = f.db.prepare.bind(f.db);
  const brokenLookup = t.mock.method(f.db, "prepare", (sql: string) => {
    if (sql.includes("from agent_session")) throw new Error("private fixture DB detail must not be exported");
    return prepare(sql);
  });
  hub.publish(synthetic("lookup-failed-event", "hidden-opened"));
  brokenLookup.mock.restore();
  await complete("listed-barrier", "listed", true);
  for (const stream of streams) {
    const text = await stream.readUntil('"runId":"listed-barrier-run"');
    assert.equal((text.match(/event: agent.run.completed.v1/g) ?? []).length, 1);
    for (const excluded of ["hidden-closed", "hidden-opened", "missing-session-event", "wrong-workspace-event", "lookup-failed-event", "private fixture"]) {
      assert.equal(text.includes(excluded), false);
    }
  }
  for (const suffix of ["", "/timeline", "/run-state", "/runs/hidden-opened-run"]) {
    const response = await f.app.inject({ method: "GET", url: `/api/agent/sessions/hidden-opened${suffix}?workspaceId=${f.workspaceId}` });
    assert.equal(response.statusCode, 200, response.body);
  }
});
