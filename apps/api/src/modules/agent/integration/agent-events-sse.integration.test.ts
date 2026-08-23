import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunRecord } from "../agent.store.js";
import { newSortableId } from "../../../utils/ids.js";
import { createAgentIntegrationFixture, createPrimarySession } from "../testkit/agent-integration-testkit.js";

test("internal events/sse 返回 run-complete 事件 chunk", async (t) => {
  const fixture = await createAgentIntegrationFixture();
  t.after(async () => {
    await fixture.dispose();
  });

  await fixture.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = fixture.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  assert.ok(port > 0, "listen should allocate a port");

  const session = await createPrimarySession(fixture);

  const sseAbort = new AbortController();
  let sseReader: any = null;
  let sseBody: any = null;
  let sseReady = false;

  const ssePromise = (async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/agent/events/sse`, {
      method: "GET",
      headers: { "x-awb-agent-internal-token": fixture.internalToken },
      signal: sseAbort.signal
    });
    assert.equal(res.status, 200);
    assert.equal(String(res.headers.get("content-type") || "").includes("text/event-stream"), true);
    const body = res.body;
    if (!body) throw new Error("sse body missing");
    sseBody = body;
    const reader = body.getReader();
    sseReader = reader;
    const decoder = new TextDecoder();
    let text = "";
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes(": connected")) sseReady = true;

      if (text.includes("event: agent.run.completed.v1") && text.includes("data: {")) {
        return text;
      }
    }
    throw new Error(`sse chunk timeout: ${text}`);
  })();

  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });

  const readyStart = Date.now();
  while (!sseReady && Date.now() - readyStart < 3_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!sseReady) {
    throw new Error("sse ready timeout");
  }

  try {
    const complete = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId,
      status: "completed"
    }
  });
    assert.equal(complete.statusCode, 200, `run-complete for sse failed: ${complete.body}`);

    const sseText = await ssePromise;

    assert.equal(sseText.includes("event: agent.run.completed.v1"), true);
    assert.equal(sseText.includes(`\"runId\":\"${runId}\"`), true);
    assert.equal(sseText.includes("data: {"), true);
    assert.equal(sseText.includes("\"eventType\":\"agent.run.completed.v1\""), true);
    assert.equal(sseText.includes("id: evt_"), true);
  } finally {
    sseAbort.abort();
    if (sseReader) {
      try {
        await sseReader.cancel();
      } catch {
        // ignore
      }
      sseReader = null;
    }
    if (sseBody) {
      try {
        await sseBody.cancel();
      } catch {
        // ignore
      }
      sseBody = null;
    }
    await ssePromise.catch(() => {
      // ignore: teardown path may abort reader/fetch
    });
  }
});
