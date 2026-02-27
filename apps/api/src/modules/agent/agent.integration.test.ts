import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../app/createApp.js";
import { openDb } from "../../infra/db/db.js";
import type { Db } from "../../infra/db/db.js";
import { ensureDir, rmrf } from "../../infra/fs/fs.js";
import { workspaceRoot } from "../../infra/fs/paths.js";
import { insertWorkspace } from "../workspaces/workspace.store.js";
import { createRunRecord } from "./agent.store.js";
import { newSortableId } from "../../utils/ids.js";

type Fixture = {
  app: FastifyInstance;
  db: Db;
  dataDir: string;
  workspaceId: string;
  workspacePath: string;
  internalToken: string;
};

const fixtures = new Set<Fixture>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createFixture(options?: { agentWorkerConcurrency?: number }): Promise<Fixture> {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "agent-it-"));
  const internalToken = "test-internal-token";

  const db = await openDb(dataDir);
  const app = await createApp({
    db,
    repoRoot,
    dataDir,
    fileMaxBytes: 1024 * 1024,
    version: "test",
    serveWeb: false,
    webDistDir: null,
    credentialMasterKey: Buffer.alloc(32, 7),
    credentialMasterKeySource: "generated",
    credentialMasterKeyId: "testkey",
    credentialMasterKeyCreatedAt: Date.now(),
    authToken: null,
    authCookieSecure: false,
    agentWorkerEnabled: false,
    agentWorkerHost: "127.0.0.1",
    agentWorkerPort: 0,
    agentWorkerSocketPath: path.join(dataDir, "agent-worker.sock"),
    agentWorkerConcurrency: options?.agentWorkerConcurrency ?? 2,
    agentInternalToken: internalToken,
    agentApiOrigin: "http://127.0.0.1:0"
  });

  const workspaceId = newSortableId("ws");
  const workspaceDirName = newSortableId("workspace");
  const workspacePath = workspaceRoot(dataDir, workspaceDirName);
  await ensureDir(workspacePath);

  const ts = Date.now();
  insertWorkspace(db, {
    id: workspaceId,
    dirName: workspaceDirName,
    title: "it-workspace",
    path: workspacePath,
    terminalCredentialId: null,
    createdAt: ts,
    updatedAt: ts
  });

  await app.ready();
  await configureAgentDefaults(app);
  const fixture: Fixture = { app, db, dataDir, workspaceId, workspacePath, internalToken };
  fixtures.add(fixture);
  return fixture;
}

async function configureAgentDefaults(app: FastifyInstance) {
  const providersRes = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: {
        providerId: "ppchat",
        modelId: "gpt-5.2"
      },
      providers: [
        {
          id: "ppchat",
          name: "ppchat",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://code.ppchat.vip/v1",
            apiKey: "sk-test"
          },
          models: [
            {
              id: "gpt-5.2",
              name: "gpt-5.2"
            }
          ]
        }
      ]
    }
  });
  assert.equal(providersRes.statusCode, 200, `configure providers failed: ${providersRes.body}`);

  const agentsRes = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      default: {
        agentId: "default"
      },
      agents: [
        {
          id: "default",
          name: "default",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          permissions: {
            allowRead: true,
            allowWrite: true,
            allowBash: true
          },
          defaultModel: null
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);
}

async function closeFixture(fixture: Fixture) {
  fixtures.delete(fixture);
  await fixture.app.close();
  fixture.db.close();
  await rmrf(fixture.dataDir);
}

afterEach(async () => {
  for (const fixture of Array.from(fixtures)) {
    await closeFixture(fixture);
  }
});

async function createSession(app: FastifyInstance, workspaceId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/agent/sessions",
    payload: { workspaceId, title: "it-session" }
  });
  assert.equal(res.statusCode, 201, `create session failed: ${res.body}`);
  return res.json() as { id: string };
}

async function sendMessage(app: FastifyInstance, params: { sessionId: string; workspaceId: string; text: string; clientRequestId: string }) {
  const res = await app.inject({
    method: "POST",
    url: `/api/agent/sessions/${params.sessionId}/messages`,
    payload: {
      workspaceId: params.workspaceId,
      text: params.text,
      clientRequestId: params.clientRequestId
    }
  });
  assert.equal(res.statusCode, 201, `send message failed: ${res.body}`);
  return res.json() as { messageItemId: number; runId: string; deduplicated: boolean };
}

async function getRunState(app: FastifyInstance, sessionId: string) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/run-state` });
  assert.equal(res.statusCode, 200, `get run-state failed: ${res.body}`);
  return res.json() as { status: "idle" | "running" | "waiting_permission"; activeRunId: string | null };
}

async function waitRunIdle(app: FastifyInstance, sessionId: string, timeoutMs = 6_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runState = await getRunState(app, sessionId);
    if (runState.status === "idle") return;
    await sleep(80);
  }
  throw new Error(`wait run idle timeout, sessionId=${sessionId}`);
}

async function getContextItems(app: FastifyInstance, sessionId: string, afterId?: number) {
  const url = afterId ? `/api/agent/sessions/${sessionId}/context-items?afterId=${afterId}` : `/api/agent/sessions/${sessionId}/context-items`;
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, `get context-items failed: ${res.body}`);
  return res.json() as {
    headItemId: number | null;
    items: Array<{ id: number; kind: string; status: string; output: Record<string, any>; prevId: number | null }>;
  };
}

async function getContextItem(app: FastifyInstance, sessionId: string, itemId: number) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/context-items/${itemId}` });
  assert.equal(res.statusCode, 200, `get context-item failed: ${res.body}`);
  return res.json() as { id: number; status: string; output: Record<string, unknown> };
}

async function createContextItemInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  runId: string | null;
  turnId: string | null;
  step: number | null;
  prevId: number | null;
  kind: "user" | "assistant" | "tool" | "system";
  status: "streaming" | "queued" | "running" | "awaiting_permission" | "completed" | "failed" | "denied" | "cancelled";
  output: Record<string, unknown>;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId,
      turnId: params.turnId,
      step: params.step,
      prevId: params.prevId,
      kind: params.kind,
      status: params.status,
      output: params.output
    }
  });
  assert.equal(res.statusCode, 200, `create internal context-item failed: ${res.body}`);
  return res.json() as { item: { id: number } };
}

async function updateRunStateInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  status: "idle" | "running" | "waiting_permission";
  activeRunId: string | null;
  activeAssistantItemId: number | null;
  waitingToolItemId: number | null;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      status: params.status,
      activeRunId: params.activeRunId,
      activeAssistantItemId: params.activeAssistantItemId,
      waitingToolItemId: params.waitingToolItemId
    }
  });
  assert.equal(res.statusCode, 200, `update internal run-state failed: ${res.body}`);
}

async function getPromptContextInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/prompt-context",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId
    }
  });
  assert.equal(res.statusCode, 200, `get prompt-context failed: ${res.body}`);
  return res.json() as {
    messages: Array<{ role: string; content: unknown }>;
  };
}

test("agent 消息去重与上下文项追加", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);
  const clientRequestId = newSortableId("req");

  const first = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hello integration",
    clientRequestId
  });
  const second = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hello integration",
    clientRequestId
  });

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.messageItemId, first.messageItemId);
  assert.equal(second.runId, first.runId);

  await waitRunIdle(fixture.app, session.id);
  const context = await getContextItems(fixture.app, session.id);
  const userItems = context.items.filter((item) => item.kind === "user");
  assert.equal(userItems.length, 1);
  assert.ok(String(userItems[0]?.output?.text || "").includes("hello integration"));
});

test("agent context-items 支持 afterId 增量查询", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "first",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.app, session.id);

  const full = await getContextItems(fixture.app, session.id);
  const lastId = full.items.at(-1)?.id ?? 0;

  await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "second",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.app, session.id);

  const delta = await getContextItems(fixture.app, session.id, lastId);
  assert.ok(delta.items.length > 0);
  assert.ok(delta.items.every((item) => item.id > lastId));
});

test("agent tool-permission 支持 approve/deny 并更新状态", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "need read permission"
    }
  });

  const toolApprove = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_a",
    step: 1,
    prevId: userItem.item.id,
    kind: "tool",
    status: "awaiting_permission",
    output: {
      type: "tool",
      toolName: "read",
      args: {
        filePath: "README.md"
      }
    }
  });

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "waiting_permission",
    activeRunId: runId,
    activeAssistantItemId: null,
    waitingToolItemId: toolApprove.item.id
  });

  const approveRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/tool-permission`,
    payload: {
      workspaceId: fixture.workspaceId,
      toolItemId: toolApprove.item.id,
      decision: "approve"
    }
  });
  assert.equal(approveRes.statusCode, 200, `approve tool permission failed: ${approveRes.body}`);

  const approvedItem = await getContextItem(fixture.app, session.id, toolApprove.item.id);
  assert.equal(approvedItem.status, "queued");

  const runStateAfterApprove = await getRunState(fixture.app, session.id);
  assert.equal(runStateAfterApprove.status, "running");

  const toolDeny = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_b",
    step: 2,
    prevId: toolApprove.item.id,
    kind: "tool",
    status: "awaiting_permission",
    output: {
      type: "tool",
      toolName: "bash",
      args: {
        command: "pwd"
      }
    }
  });

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "waiting_permission",
    activeRunId: runId,
    activeAssistantItemId: null,
    waitingToolItemId: toolDeny.item.id
  });

  const denyRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/tool-permission`,
    payload: {
      workspaceId: fixture.workspaceId,
      toolItemId: toolDeny.item.id,
      decision: "deny"
    }
  });
  assert.equal(denyRes.statusCode, 200, `deny tool permission failed: ${denyRes.body}`);

  const deniedItem = await getContextItem(fixture.app, session.id, toolDeny.item.id);
  assert.equal(deniedItem.status, "denied");
  assert.equal(String(deniedItem.output.error || ""), "permission denied");
});

test("agent cancel 仅终止执行并保留消息,活跃项标记为 cancelled", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "start"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_cancel",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "working..."
    }
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_cancel",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "bash",
      args: {
        command: "sleep 10"
      }
    }
  });

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: assistantItem.item.id,
    waitingToolItemId: null
  });

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel run failed: ${cancelRes.body}`);
  const cancelBody = cancelRes.json() as { sessionId: string; headItemId: number | null };
  assert.equal(cancelBody.sessionId, session.id);
  assert.equal(cancelBody.headItemId, toolItem.item.id);

  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(runState.activeRunId, null);

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.headItemId, toolItem.item.id);
  assert.equal(context.items.length, 3);
  const latestAssistant = context.items.find((item) => item.id === assistantItem.item.id);
  const latestTool = context.items.find((item) => item.id === toolItem.item.id);
  assert.equal(latestAssistant?.status, "cancelled");
  assert.equal(latestTool?.status, "cancelled");
});

test("agent prompt-context 使用结构化 tool-call/tool-result 消息", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "测试结构化工具调用"
    }
  });

  const assistantToolCall = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_structured",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "我先写文件"
    }
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_structured",
    step: 1,
    prevId: assistantToolCall.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: {
        filePath: "tool_test.txt",
        content: "hello"
      },
      result: {
        summary: "写入文件 tool_test.txt",
        content: "ok"
      }
    }
  });

  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_after",
    step: 2,
    prevId: toolItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "写入成功,准备继续"
    }
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const assistantWithToolCall = context.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string }).type === "tool-call";
    });
  });
  assert.ok(assistantWithToolCall, "assistant message should include tool-call part");

  const toolResultMessage = context.messages.find((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string }).type === "tool-result";
    });
  });
  assert.ok(toolResultMessage, "tool message should include tool-result part");

  const toolResultPart = Array.isArray(toolResultMessage?.content)
    ? toolResultMessage.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string }).type === "tool-result";
      })
    : null;
  assert.ok(toolResultPart && typeof toolResultPart === "object", "tool-result part should exist");
  assert.equal(
    String((toolResultPart as { output?: { type?: string } }).output?.type || ""),
    "json",
    "tool-result output should be ai-sdk structured output"
  );
});
