import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { registerAgentRoutes } from "./agent.routes.js";

test("POST /api/agent/sessions/:sessionId/messages 返回值符合 shared response schema", async () => {
  const app = Fastify({ logger: false });

  const calls: Array<{ kind: string; payload: unknown }> = [];
  const service = {
    sendMessage: async (params: { sessionId: string; body: any }) => {
      assert.equal(params.sessionId, "sess_1");
      assert.equal(params.body.workspaceId, "ws_1");
      assert.equal(params.body.text, "hello");
      assert.equal(params.body.clientRequestId, "req_1");
      return {
        sessionId: "sess_1",
        messageItemId: 123,
        runId: "run_1",
        deduplicated: false
      };
    },
    getWorkspace: (workspaceId: string) => {
      assert.equal(workspaceId, "ws_1");
      return { path: "/tmp/ws" };
    }
  };
  const runtime = {
    enqueueRun: async (payload: unknown) => {
      calls.push({ kind: "enqueueRun", payload });
    }
  };

  await registerAgentRoutes(app as any, { service: service as any, runtime: runtime as any });

  const res = await app.inject({
    method: "POST",
    url: "/api/agent/sessions/sess_1/messages",
    payload: {
      workspaceId: "ws_1",
      text: "hello",
      clientRequestId: "req_1",
      agentId: "agent_1",
      uiLocale: "zh-CN"
    }
  });

  assert.equal(res.statusCode, 201, `unexpected status: ${res.statusCode} body=${res.body}`);
  const body = res.json() as any;
  assert.deepEqual(body, { sessionId: "sess_1", messageItemId: 123, runId: "run_1", deduplicated: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind, "enqueueRun");
});

test("POST /api/agent/sessions/:sessionId/messages deduplicated=true 时不触发 enqueueRun", async () => {
  const app = Fastify({ logger: false });

  let enqueueCalls = 0;
  const service = {
    sendMessage: async () => {
      return {
        sessionId: "sess_1",
        messageItemId: 123,
        runId: "run_1",
        deduplicated: true
      };
    },
    getWorkspace: (_workspaceId: string) => {
      return { path: "/tmp/ws" };
    }
  };
  const runtime = {
    enqueueRun: async () => {
      enqueueCalls += 1;
    }
  };

  await registerAgentRoutes(app as any, { service: service as any, runtime: runtime as any });

  const res = await app.inject({
    method: "POST",
    url: "/api/agent/sessions/sess_1/messages",
    payload: {
      workspaceId: "ws_1",
      text: "hello",
      clientRequestId: "req_1"
    }
  });
  assert.equal(res.statusCode, 201, `unexpected status: ${res.statusCode} body=${res.body}`);
  assert.equal(enqueueCalls, 0);
});
