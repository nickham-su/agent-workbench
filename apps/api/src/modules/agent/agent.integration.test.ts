import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../app/createApp.js";
import { openDb } from "../../infra/db/db.js";
import type { Db } from "../../infra/db/db.js";
import { ensureDir, rmrf } from "../../infra/fs/fs.js";
import { agentArchiveSessionDir, compactionSnippetPath, workspaceRoot } from "../../infra/fs/paths.js";
import { setSettingJson } from "../settings/settings.store.js";
import { insertWorkspace } from "../workspaces/workspace.store.js";
import {
  appendContextItem,
  createAgentSession,
  createRunRecord,
  getAgentSession,
  getRunRecord,
  getRunState as getRunStateRow,
  getSessionTranscriptItems,
  updateRunState
} from "./agent.store.js";
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
    logLevel: "error",
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
    agentApiOrigin: "http://127.0.0.1:0",
    agentStartupRecoveryMode: "recover"
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

test("agent startup recovery mode=fail 会终止 in-flight run 并回收 run-state", async () => {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "agent-startup-fail-it-"));
  const internalToken = "test-internal-token";

  const db = await openDb(dataDir);
  let app: FastifyInstance | null = null;
  try {
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

  // 构造一个 in-flight run: run-state=running + run record=running + context items 含 streaming/tool。
  const sessionId = newSortableId("sess");
  createAgentSession(db, {
    id: sessionId,
    workspaceId,
    title: "startup-fail-session",
    kind: "primary",
    createdAt: ts,
    forkedFromSessionId: null,
    forkedFromItemId: null
  });
  const runId = newSortableId("run");

  const user = appendContextItem(db, {
    workspaceId,
    sessionId,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "hello" },
    createdAt: ts
  });
  const assistantItem = appendContextItem(db, {
    workspaceId,
    sessionId,
    runId,
    turnId: newSortableId("turn"),
    step: 1,
    prevId: user.id,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "" },
    createdAt: ts
  });
  const toolItem = appendContextItem(db, {
    workspaceId,
    sessionId,
    runId,
    turnId: null,
    step: null,
    prevId: assistantItem.id,
    kind: "tool",
    status: "awaiting_permission",
    output: { type: "tool", toolName: "bash", toolCallId: "call_1", args: { command: "echo hi" }, text: "" } as any,
    createdAt: ts
  });

  createRunRecord(db, {
    runId,
    workspaceId,
    sessionId,
    triggerItemId: user.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: ts
  });
  updateRunState(db, {
    workspaceId,
    sessionId,
    status: "waiting_permission",
    activeRunId: runId,
    activeAssistantItemId: assistantItem.id,
    waitingToolItemId: toolItem.id,
    runNoticeText: "",
    updatedAt: ts,
    appliedItemId: toolItem.id
  });

  // 脏数据：in-flight 但 active_run_id 为空。
  const dirtySessionId = newSortableId("sess");
  createAgentSession(db, {
    id: dirtySessionId,
    workspaceId,
    title: "startup-fail-dirty-session",
    kind: "primary",
    createdAt: ts,
    forkedFromSessionId: null,
    forkedFromItemId: null
  });
  updateRunState(db, {
    workspaceId,
    sessionId: dirtySessionId,
    status: "running",
    activeRunId: null,
    activeAssistantItemId: null,
    waitingToolItemId: null,
    runNoticeText: "",
    updatedAt: ts,
    appliedItemId: 0
  });

  // 注意：fail 模式会在模块注册阶段执行清理逻辑，因此 in-flight 数据必须在 createApp 之前写入。
  app = await createApp({
    db,
    repoRoot,
    dataDir,
    fileMaxBytes: 1024 * 1024,
    version: "test",
    logLevel: "error",
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
    agentWorkerConcurrency: 1,
    agentInternalToken: internalToken,
    agentApiOrigin: "http://127.0.0.1:0",
    agentStartupRecoveryMode: "fail"
  });

  await app.ready();

  // 断言：run record 由 running -> failed
  const run = getRunRecord(db, runId);
  assert.ok(run, "run record should exist");
  assert.equal(run?.status, "failed");

  // 断言：run-state 回收为 idle
  const state = getRunStateRow(db, workspaceId, sessionId);
  assert.equal(state.status, "idle");
  assert.equal(state.activeRunId, null);

  // 断言：streaming/awaiting_permission 等未终态 items 被置为 failed
  const items = getSessionTranscriptItems(db, workspaceId, sessionId);
  assert.ok(items.some((it) => it.kind === "assistant" && it.status === "failed"));
  assert.ok(items.some((it) => it.kind === "tool" && it.status === "failed"));

  // 断言：脏 run-state 也会被回收
  const dirty = getRunStateRow(db, workspaceId, dirtySessionId);
  assert.equal(dirty.status, "idle");
  } finally {
    await app?.close();
    db.close();
    await rmrf(dataDir);
  }
});

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
              name: "gpt-5.2",
              contextWindowTokens: 128000
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
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
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

test("GET /api/settings/agent/agents 返回每个 agent 的 resolvedModel", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const providersRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "global_provider", modelId: "global_model" },
      providers: [
        {
          id: "global_provider",
          name: "Global Provider",
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://example.com/v1", apiKey: "sk-global" },
          models: [{ id: "global_model", name: "Global Model", contextWindowTokens: 128000 }]
        },
        {
          id: "agent_provider",
          name: "Agent Provider",
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://example.com/v1", apiKey: "sk-agent" },
          models: [{ id: "agent_model", name: "Agent Model", contextWindowTokens: 128000 }]
        }
      ]
    }
  });
  assert.equal(providersRes.statusCode, 200, `configure providers failed: ${providersRes.body}`);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      default: { agentId: "default" },
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
          permissions: { allowRead: true, allowWrite: true, allowBash: true },
          defaultModel: null
        },
        {
          id: "custom",
          name: "custom",
          summary: "",
          prompt: "Use a custom model.",
          tools: ["bash", "read"],
          mcpServers: [],
          permissions: { allowRead: true, allowWrite: false, allowBash: true },
          defaultModel: { providerId: "agent_provider", modelId: "agent_model" }
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);

  const getRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/agents" });
  assert.equal(getRes.statusCode, 200, `get agent settings failed: ${getRes.body}`);
  const body = getRes.json() as any;
  const defaultAgent = body.agents.find((item: any) => item.id === "default");
  const customAgent = body.agents.find((item: any) => item.id === "custom");

  assert.deepEqual(defaultAgent?.resolvedModel, {
    providerId: "global_provider",
    providerName: "Global Provider",
    contextWindowTokens: 128000,
    modelId: "global_model",
    modelName: "Global Model",
    source: "global_default"
  });
  assert.deepEqual(customAgent?.resolvedModel, {
    providerId: "agent_provider",
    providerName: "Agent Provider",
    contextWindowTokens: 128000,
    modelId: "agent_model",
    modelName: "Agent Model",
    source: "agent_default"
  });
});

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
  return res.json() as {
    status: "idle" | "running" | "waiting_permission";
    activeRunId: string | null;
    runNoticeText: string;
  };
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
    items: Array<{
      id: number;
      kind: string;
      status: string;
      output: Record<string, any>;
      prevId: number | null;
      archiveAt: number | null;
      boundaryReason: string | null;
    }>;
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

async function updateContextItemInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  itemId: number;
  status?: "streaming" | "queued" | "running" | "awaiting_permission" | "completed" | "failed" | "denied" | "cancelled";
  output?: Record<string, unknown>;
}) {
  const res = await params.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${params.itemId}`,
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      ...(Object.prototype.hasOwnProperty.call(params, "status") ? { status: params.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(params, "output") ? { output: params.output } : {})
    }
  });
  assert.equal(res.statusCode, 200, `update internal context-item failed: ${res.body}`);
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
  runNoticeText?: string | null;
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
      waitingToolItemId: params.waitingToolItemId,
      ...(Object.prototype.hasOwnProperty.call(params, "runNoticeText") ? { runNoticeText: params.runNoticeText } : {})
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
    system: string;
    tools: Array<{ name: string }>;
    messages: Array<{ role: string; content: unknown }>;
    pendingTools: Array<{ itemId: number; approved?: boolean; status: string; toolName: string }>;
  };
}

async function compactContextInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  expectedHeadItemId: number | null;
  summaryText: string;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/context/compact",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId,
      expectedHeadItemId: params.expectedHeadItemId,
      summaryText: params.summaryText
    }
  });
  assert.equal(res.statusCode, 200, `compact context failed: ${res.body}`);
  return res.json() as { compacted: boolean; summaryItemId: number | null; archivedCount: number };
}

async function archiveSearchInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  query: string;
  beforePos?: number;
  maxHits?: number;
  maxChars?: number;
  snippet?: boolean;
  regex?: boolean;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/archive/search",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      query: params.query,
      ...(params.beforePos != null ? { beforePos: params.beforePos } : {}),
      ...(params.maxHits ? { maxHits: params.maxHits } : {}),
      ...(params.maxChars ? { maxChars: params.maxChars } : {}),
      ...(params.snippet === true ? { snippet: true } : {}),
      ...(params.regex === true ? { regex: true } : {})
    }
  });
  assert.equal(res.statusCode, 200, `archive search failed: ${res.body}`);
  return res.json() as { text: string };
}

async function archiveReadInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  beforePos?: number;
  lineCount?: number;
  maxChars?: number;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/archive/read",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      ...(params.beforePos != null ? { beforePos: params.beforePos } : {}),
      ...(params.lineCount ? { lineCount: params.lineCount } : {}),
      ...(params.maxChars ? { maxChars: params.maxChars } : {})
    }
  });
  assert.equal(res.statusCode, 200, `archive read failed: ${res.body}`);
  return res.json() as { text: string };
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
  assert.ok(
    delta.items.every((item) => item.id > lastId),
    `unexpected delta items; lastId=${String(lastId)} ids=${delta.items.map((i) => i.id).join(",")}`
  );
});

test("agent context-items 支持 assistant reasoning 字段的创建与读取", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "hello"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_reasoning_1",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "结论正文",
      reasoning: {
        text: "先分析上下文,再给结论"
      }
    }
  });

  const full = await getContextItems(fixture.app, session.id);
  const assistant = full.items.find((item) => item.id === assistantItem.item.id);
  assert.ok(assistant);
  assert.equal(assistant?.kind, "assistant");
  assert.equal(assistant?.output.type, "assistant_text");
  assert.equal(assistant?.output.text, "结论正文");
  assert.deepEqual((assistant?.output as any).reasoning, { text: "先分析上下文,再给结论" });

  const single = await getContextItem(fixture.app, session.id, assistantItem.item.id);
  assert.equal(single.output.type, "assistant_text");
  assert.deepEqual((single.output as any).reasoning, { text: "先分析上下文,再给结论" });
});

test("agent context-items 支持 assistant reasoning 字段的更新", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_reasoning_update",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "初始正文"
    }
  });

  await updateContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: assistantItem.item.id,
    status: "completed",
    output: {
      type: "assistant_text",
      text: "最终正文",
      reasoning: { text: "补充后的思考内容" }
    }
  });

  const single = await getContextItem(fixture.app, session.id, assistantItem.item.id);
  assert.equal(single.output.type, "assistant_text");
  assert.equal(single.output.text, "最终正文");
  assert.deepEqual((single.output as any).reasoning, { text: "补充后的思考内容" });
});

test("assistant reasoning 不应进入 prompt-context", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 0,
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
    output: { type: "user_text", text: "继续" }
  });
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_reasoning_prompt",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "正式回答", reasoning: { text: "隐藏思考" } }
  });

  const prompt = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId });
  assert.ok(JSON.stringify(prompt.messages).includes("正式回答"));
  assert.equal(JSON.stringify(prompt.messages).includes("隐藏思考"), false);
});

test("assistant reasoning 不应进入 archive line", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "用户消息" }
  });
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_reasoning_archive",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "正式回答", reasoning: { text: "不应归档的思考" } }
  });

  const clearRes = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/clear`, payload: { workspaceId: fixture.workspaceId, reason: "切换新任务" } });
  assert.equal(clearRes.statusCode, 200, `clear session failed: ${clearRes.body}`);

  const archiveFilePath = path.join(agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id), "00000001.log");
  const archiveText = await fs.readFile(archiveFilePath, "utf-8");
  assert.ok(archiveText.includes("正式回答"));
  assert.equal(archiveText.includes("不应归档的思考"), false);
});

test("非 system item 写入 boundaryReason 会被忽略", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const appended = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    boundaryReason: "should-not-be-stored",
    output: {
      type: "user_text",
      text: "hello"
    },
    createdAt: Date.now()
  });

  assert.equal(appended.boundaryReason, null);

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.items[0]?.kind, "user");
  assert.equal(context.items[0]?.boundaryReason, null);
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

test("agent runtime settings 可通过 execution-profile 下发", async () => {
  const fixture = await createFixture();

  const runtimeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: {
      modelIdleTimeoutMs: 1234,
      modelTotalTimeoutMs: 5678,
      modelRequestMaxRetries: 4
    }
  });
  assert.equal(runtimeRes.statusCode, 200, `update agent runtime settings failed: ${runtimeRes.body}`);

  const session = await createSession(fixture.app, fixture.workspaceId);
  const msg = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hi",
    clientRequestId: "req_runtime_settings"
  });

  const runRecord = getRunRecord(fixture.db, msg.runId);
  assert.ok(runRecord, "run record should exist");
  assert.equal(runRecord?.uiLocale, null, "missing uiLocale should be stored as null");

  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: msg.runId
    }
  });
  assert.equal(profileRes.statusCode, 200, `get execution profile failed: ${profileRes.body}`);
  const profile = profileRes.json() as any;
  assert.equal(profile.runtime?.modelIdleTimeoutMs, 1234);
  assert.equal(profile.runtime?.modelTotalTimeoutMs, 5678);
  assert.equal(profile.runtime?.modelRequestMaxRetries, 4);
  assert.equal(typeof profile.runtime?.autoCompactThresholdPct, "number");
  assert.equal(typeof profile.model?.contextWindowTokens, "number");
});

test("agent prompt-context 根据 run uiLocale 注入语言与时间运行时约束", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    payload: {
      workspaceId: fixture.workspaceId,
      text: "hello",
      clientRequestId: "req_locale_prompt",
      uiLocale: "en-US"
    }
  });
  assert.equal(res.statusCode, 201, `send message failed: ${res.body}`);
  const body = res.json() as { runId: string };

  const runRecord = getRunRecord(fixture.db, body.runId);
  assert.ok(runRecord, "run record should exist");
  assert.equal(runRecord?.uiLocale, "en-US");

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: body.runId
  });
  assert.ok(prompt.system.includes("## Runtime Constraints"), "system should include runtime constraints section");
  assert.ok(prompt.system.includes("Language requirement: use English consistently for this run."));
  assert.ok(prompt.system.includes("If you call todolist, the goal and todos[].content must also be in English."));
  assert.ok(prompt.system.includes("Current system time:"));
  assert.ok(prompt.system.includes("Time zone:"));
});

test("agent compact 在 worker 不可用时仍接受 uiLocale 参数", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/compact`, payload: { workspaceId: fixture.workspaceId, clientRequestId: "req_compact_locale", uiLocale: "zh-CN" } });
  assert.equal(res.statusCode, 503, `compact should fail when worker disabled: ${res.body}`);
  assert.equal(res.json().code, "AGENT_WORKER_UNAVAILABLE");
});

test("agent compact 在 worker 不可用时返回 503", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/compact`,
    payload: {
      workspaceId: fixture.workspaceId,
      clientRequestId: newSortableId("req")
    }
  });
  assert.equal(res.statusCode, 503, `compact should fail when worker disabled: ${res.body}`);
  assert.equal(res.json().code, "AGENT_WORKER_UNAVAILABLE");
});

test("agent clear 会归档当前可见上下文并插入 clear 边界 marker", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "旧任务: 先完成接口改造"
    }
  });
  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "旧任务答复: 可以先做字段迁移。"
    }
  });

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId,
      reason: "切换新任务"
    }
  });
  assert.equal(clearRes.statusCode, 200, `clear session failed: ${clearRes.body}`);
  const clearBody = clearRes.json() as { sessionId: string; headItemId: number | null };
  assert.equal(clearBody.sessionId, session.id);
  assert.ok((clearBody.headItemId ?? 0) > assistantItem.item.id);

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.items.length, 3);
  assert.equal(context.items[0]?.archiveAt == null, false);
  assert.equal(context.items[1]?.archiveAt == null, false);
  assert.equal(context.items[2]?.kind, "system");
  assert.equal(context.items[2]?.boundaryReason, "clear");
  assert.equal(context.items[2]?.archiveAt, null);
  assert.ok(String(context.items[2]?.output?.text || "").includes("archive_search"));

  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: clearBody.headItemId || context.items[2]!.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });
  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const oldUserLeak = promptContext.messages.find((item) => String(item.content || "").includes("旧任务: 先完成接口改造"));
  assert.equal(oldUserLeak, undefined);
  const clearSummary = promptContext.messages.find((item) => item.role === "system" && String(item.content || "").includes("已开始新任务"));
  assert.ok(clearSummary);

  const archiveFilePath = path.join(
    agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id),
    "00000001.log"
  );
  const archiveContent = await fs.readFile(archiveFilePath, "utf-8");
  assert.ok(archiveContent.includes("旧任务: 先完成接口改造"));
  assert.ok(archiveContent.includes("旧任务答复: 可以先做字段迁移。"));

  const clearAgainRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(clearAgainRes.statusCode, 400, `clear should be no-op when only marker visible: ${clearAgainRes.body}`);
  assert.equal(clearAgainRes.json().code, "AGENT_CLEAR_NOT_NEEDED");
});

test("agent clear 对 subtask 会话返回只读错误", async () => {
  const fixture = await createFixture();
  const createSubtaskRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions",
    payload: {
      workspaceId: fixture.workspaceId,
      title: "it-subtask-session",
      kind: "subtask"
    }
  });
  assert.equal(createSubtaskRes.statusCode, 201, `create subtask session failed: ${createSubtaskRes.body}`);
  const subtaskSession = createSubtaskRes.json() as { id: string };

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${subtaskSession.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(clearRes.statusCode, 400, `clear subtask should fail: ${clearRes.body}`);
  assert.equal(clearRes.json().code, "AGENT_SUBTASK_READONLY");
});

test("agent prompt-context 对 subtask 会话隐藏 subtask 工具", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      default: { agentId: "default" },
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write", "subtask"],
          mcpServers: [],
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
  assert.equal(agentsRes.statusCode, 200, `configure agents with subtask failed: ${agentsRes.body}`);

  const sessionRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions",
    payload: {
      workspaceId: fixture.workspaceId,
      title: "it-subtask-session",
      kind: "subtask"
    }
  });
  assert.equal(sessionRes.statusCode, 201, `create subtask session failed: ${sessionRes.body}`);
  const session = sessionRes.json() as { id: string };

  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "en-US",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const toolNames = promptContext.tools.map((item) => item.name);
  assert.equal(toolNames.includes("subtask"), false, "subtask tool should be hidden for subtask sessions");
  assert.equal(toolNames.includes("bash"), true, "other enabled tools should remain visible");
});

test("agent subtask fork 在复制历史与子任务 prompt 之间插入 system 提示", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      default: { agentId: "default" },
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write", "subtask"],
          mcpServers: [],
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
  assert.equal(agentsRes.statusCode, 200, `configure agents with subtask failed: ${agentsRes.body}`);

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const createdAt = Date.now();
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "en-US",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "请调用 subtask 把任务交给另一个 agent。"
    }
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_fork",
    step: 1,
    prevId: userItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_subtask_fork",
      args: {
        description: "研究问题",
        prompt: "请直接完成这个子任务",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const startRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId: parentRunId,
      parentToolItemId: toolItem.item.id,
      description: "研究问题",
      prompt: "请直接完成这个子任务",
      agentId: "default",
      session: { mode: "fork" }
    }
  });
  assert.equal(startRes.statusCode, 200, `start subtask failed: ${startRes.body}`);
  const started = startRes.json() as { sessionId: string; runId: string };

  const items = getSessionTranscriptItems(fixture.db, fixture.workspaceId, started.sessionId);
  assert.equal(items.length >= 3, true, "forked subtask session should contain copied user, system guard and prompt user");

  const copiedUser = items[0];
  const systemItem = items[1];
  const promptUser = items[2];
  assert.equal(copiedUser?.kind, "user");
  assert.equal(copiedUser?.output.type, "user_text");
  assert.equal((copiedUser?.output as { text?: string }).text, "请调用 subtask 把任务交给另一个 agent。");
  assert.equal(systemItem?.kind, "system");
  assert.equal(systemItem?.output.type, "system_text");
  assert.equal(
    String((systemItem?.output as { text?: string }).text || "").includes("在本条系统消息之前的全部历史内容，均来自父会话复制"),
    true
  );
  assert.equal(promptUser?.kind, "user");
  assert.equal(promptUser?.output.type, "user_text");
  assert.equal((promptUser?.output as { text?: string }).text, "请直接完成这个子任务");

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: started.sessionId,
    runId: started.runId
  });
  assert.equal(
    promptContext.messages.some((message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.includes("在本条系统消息之前的全部历史内容，均来自父会话复制")
    ),
    true,
    "prompt-context should include fork guard system message"
  );
  assert.equal(
    promptContext.tools.some((tool) => tool.name === "subtask"),
    false,
    "forked subtask session should not expose subtask tool"
  );
  assert.ok(promptContext.system.includes("## Runtime Constraints"));
  assert.ok(promptContext.system.includes("Language requirement: use English consistently for this run."));
  assert.ok(promptContext.system.includes("Current system time:"));
  assert.ok(promptContext.system.includes("Time zone:"));
});

test("agent prompt-context 对 primary 会话保留 subtask 工具", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      default: { agentId: "default" },
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write", "subtask"],
          mcpServers: [],
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
  assert.equal(agentsRes.statusCode, 200, `configure agents with subtask failed: ${agentsRes.body}`);

  const primarySession = await createSession(fixture.app, fixture.workspaceId);
  const seedRunId = newSortableId("run");
  const seedUser = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: primarySession.id,
    runId: seedRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "primary 会话内容" }
  });
  const forkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: primarySession.id,
      fromItemId: seedUser.item.id,
      mode: "with_archive"
    }
  });
  assert.equal(forkRes.statusCode, 201, `fork primary session failed: ${forkRes.body}`);
  const forkedPrimary = forkRes.json() as { id: string };

  for (const sessionId of [primarySession.id, forkedPrimary.id]) {
    const runId = newSortableId("run");
    createRunRecord(fixture.db, {
      runId,
      workspaceId: fixture.workspaceId,
      sessionId,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      status: "running",
      createdAt: Date.now()
    });
    const promptContext = await getPromptContextInternal({
      app: fixture.app,
      internalToken: fixture.internalToken,
      workspaceId: fixture.workspaceId,
      sessionId,
      runId
    });
    assert.equal(promptContext.tools.some((tool) => tool.name === "subtask"), true, "primary session should keep subtask tool");
  }
});

test("delete workspace 会清理 dataDir 下的 agent 归档目录", async () => {
  const fixture = await createFixture();
  const archiveSessionPath = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, "sess_cleanup");
  const archiveWorkspacePath = path.dirname(archiveSessionPath);
  await fs.mkdir(archiveSessionPath, { recursive: true });
  await fs.writeFile(path.join(archiveSessionPath, "00000001.log"), "line\n", "utf-8");

  const deleteRes = await fixture.app.inject({
    method: "DELETE",
    url: `/api/workspaces/${fixture.workspaceId}`
  });
  assert.equal(deleteRes.statusCode, 204, `delete workspace failed: ${deleteRes.body}`);

  const archiveWorkspaceExists = await fs
    .stat(archiveWorkspacePath)
    .then(() => true)
    .catch(() => false);
  assert.equal(archiveWorkspaceExists, false, "workspace archive directory should be removed");
});

test("agent clear 在空会话返回 AGENT_CLEAR_EMPTY", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(clearRes.statusCode, 400, `clear empty session should fail: ${clearRes.body}`);
  assert.equal(clearRes.json().code, "AGENT_CLEAR_EMPTY");
});

test("agent clear 在会话运行中返回 AGENT_CLEAR_NOT_IDLE", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "测试 clear 运行中校验"
    }
  });

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: newSortableId("run"),
    activeAssistantItemId: null,
    waitingToolItemId: null
  });

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(clearRes.statusCode, 409, `clear running session should fail: ${clearRes.body}`);
  assert.equal(clearRes.json().code, "AGENT_CLEAR_NOT_IDLE");
});

test("agent clear 并发请求会串行执行且不会重复归档", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userText = "并发清空测试-用户消息";
  const assistantText = "并发清空测试-助手消息";
  const userItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: userText
    }
  });
  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: assistantText
    }
  });

  const [r1, r2] = await Promise.all([
    fixture.app.inject({
      method: "POST",
      url: `/api/agent/sessions/${session.id}/clear`,
      payload: { workspaceId: fixture.workspaceId }
    }),
    fixture.app.inject({
      method: "POST",
      url: `/api/agent/sessions/${session.id}/clear`,
      payload: { workspaceId: fixture.workspaceId }
    })
  ]);

  const statuses = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 400]);
  const failed = r1.statusCode === 400 ? r1 : r2;
  assert.equal(failed.json().code, "AGENT_CLEAR_NOT_NEEDED");

  const archiveFilePath = path.join(
    agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id),
    "00000001.log"
  );
  const archiveContent = await fs.readFile(archiveFilePath, "utf-8");
  const userHits = archiveContent.split(userText).length - 1;
  const assistantHits = archiveContent.split(assistantText).length - 1;
  assert.equal(userHits, 1);
  assert.equal(assistantHits, 1);
});

test("agent providers settings 要求 contextWindowTokens 必填且合法", async () => {
  const fixture = await createFixture();

  const missingFieldRes = await fixture.app.inject({
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
  assert.equal(missingFieldRes.statusCode, 400);

  const tooLargeRes = await fixture.app.inject({
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
              name: "gpt-5.2",
              contextWindowTokens: 10000001
            }
          ]
        }
      ]
    }
  });
  assert.equal(tooLargeRes.statusCode, 400);
});

test("run-state 支持 runNoticeText 更新与 idle 自动清空", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    waitingToolItemId: null,
    runNoticeText: "Request failed, retrying in 2s (1/3): timeout"
  });

  const runningState = await getRunState(fixture.app, session.id);
  assert.equal(runningState.status, "running");
  assert.equal(runningState.runNoticeText, "Request failed, retrying in 2s (1/3): timeout");

  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    waitingToolItemId: null
  });

  const idleState = await getRunState(fixture.app, session.id);
  assert.equal(idleState.status, "idle");
  assert.equal(idleState.runNoticeText, "");
});

test("single-call model profile 始终使用全局默认模型", async () => {
  const fixture = await createFixture();

  const providersRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: {
        providerId: "global_provider",
        modelId: "global_model"
      },
      providers: [
        {
          id: "global_provider",
          name: "global_provider",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://code.ppchat.vip/v1",
            apiKey: "sk-global"
          },
          models: [
            {
              id: "global_model",
              name: "global_model",
              contextWindowTokens: 128000
            }
          ]
        },
        {
          id: "agent_provider",
          name: "agent_provider",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://code.ppchat.vip/v1",
            apiKey: "sk-agent"
          },
          models: [
            {
              id: "agent_model",
              name: "agent_model",
              contextWindowTokens: 128000
            }
          ]
        }
      ]
    }
  });
  assert.equal(providersRes.statusCode, 200, `configure providers failed: ${providersRes.body}`);

  const agentsRes = await fixture.app.inject({
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
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
          permissions: {
            allowRead: true,
            allowWrite: true,
            allowBash: true
          },
          defaultModel: {
            providerId: "agent_provider",
            modelId: "agent_model"
          }
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);

  const session = await createSession(fixture.app, fixture.workspaceId);
  const sent = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hi",
    clientRequestId: "req_single_call_model_profile"
  });

  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/single-call-model-profile",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: sent.runId
    }
  });
  assert.equal(profileRes.statusCode, 200, `get single-call model profile failed: ${profileRes.body}`);
  const profile = profileRes.json() as any;
  assert.equal(profile.resolved?.source, "global_default");
  assert.equal(profile.provider?.id, "global_provider");
  assert.equal(profile.model?.id, "global_model");
});

test("agent context 压缩后会归档并支持 archive_search/read", async () => {
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
    turnId: "turn_archive_1",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "历史问题: 请整理最近的变更"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_archive_1",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "已完成: 新增归档与压缩方案草稿"
    }
  });

  const compact = await compactContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: assistantItem.item.id,
    summaryText: "压缩摘要: 已归档旧上下文,后续从本摘要继续。"
  });
  assert.equal(compact.compacted, true);
  assert.equal(compact.archivedCount, 2);
  assert.ok((compact.summaryItemId ?? 0) > 0);

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.items.length, 3, "transcript should keep archived items visible in UI");
  assert.equal(context.items[0]?.archiveAt == null, false);
  assert.equal(context.items[1]?.archiveAt == null, false);
  assert.equal(context.items[2]?.kind, "system");
  assert.equal(context.items[2]?.boundaryReason, "compaction");
  assert.ok(String(context.items[2]?.output?.text || "").includes("压缩摘要"));

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const compactSummaryMessage = promptContext.messages.find(
    (item) => item.role === "system" && String(item.content || "").includes("压缩摘要")
  );
  assert.ok(compactSummaryMessage, "compaction summary should participate in prompt messages");

  const summaryIndex = promptContext.messages.findIndex(
    (item) => item.role === "system" && String(item.content || "").includes("压缩摘要")
  );
  const snippetIndex = promptContext.messages.findIndex(
    (item) => item.role === "system" && String(item.content || "").includes("压缩前尾部摘录")
  );
  assert.ok(snippetIndex >= 0, "compaction snippet should be injected after summary");
  assert.ok(summaryIndex >= 0 && snippetIndex === summaryIndex + 1, "snippet should appear right after compaction summary");

  const snippetMessage = promptContext.messages[snippetIndex] as any;
  assert.ok(String(snippetMessage?.content || "").includes("pos="), "snippet should include pos lines");
  assert.ok(String(snippetMessage?.content || "").includes("archive_read"), "snippet should remind archive_read");
  const archivedUserLeak = promptContext.messages.find(
    (item) => item.role === "user" && String(item.content || "").includes("历史问题")
  );
  assert.equal(archivedUserLeak, undefined, "archived transcript items should not be included in model prompt");

  const forkArchivedVisibleOnlyRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: userItem.item.id,
      mode: "visible_only"
    }
  });
  assert.equal(
    forkArchivedVisibleOnlyRes.statusCode,
    400,
    `fork archived item in visible_only mode should fail: ${forkArchivedVisibleOnlyRes.body}`
  );
  assert.equal(forkArchivedVisibleOnlyRes.json().code, "AGENT_ARCHIVED_ITEM_IMMUTABLE");

  const summaryItemId = context.items[2]?.id ?? 0;
  assert.ok(summaryItemId > 0);

  const forkSystemRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: summaryItemId,
      mode: "with_archive"
    }
  });
  assert.equal(forkSystemRes.statusCode, 400, `fork from system should fail: ${forkSystemRes.body}`);
  assert.equal(forkSystemRes.json().code, "AGENT_FORK_ITEM_KIND_INVALID");

  const afterSummaryUser = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_archive_2",
    step: 1,
    prevId: summaryItemId,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "后续问题: 这个方案需要怎么落地?"
    }
  });

  const afterSummaryAssistant = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_archive_2",
    step: 1,
    prevId: afterSummaryUser.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "后续答复: 先做字段与路由改造,再补充测试。"
    }
  });

  const forkArchivedWithArchiveRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: userItem.item.id,
      mode: "with_archive"
    }
  });
  assert.equal(forkArchivedWithArchiveRes.statusCode, 201, `fork archived item in with_archive mode should succeed: ${forkArchivedWithArchiveRes.body}`);
  const forkArchivedWithArchiveSession = forkArchivedWithArchiveRes.json() as { id: string };
  const forkArchivedWithArchiveContext = await getContextItems(fixture.app, forkArchivedWithArchiveSession.id);
  assert.equal(forkArchivedWithArchiveContext.items.length, 1);
  assert.equal(forkArchivedWithArchiveContext.items[0]?.archiveAt, null);

  const forkWithArchiveRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromItemId: afterSummaryAssistant.item.id,
      mode: "with_archive"
    }
  });
  assert.equal(forkWithArchiveRes.statusCode, 201, `fork with archive should succeed: ${forkWithArchiveRes.body}`);
  const forkWithArchiveSession = forkWithArchiveRes.json() as { id: string };
  const forkWithArchiveContext = await getContextItems(fixture.app, forkWithArchiveSession.id);
  assert.equal(forkWithArchiveContext.items.length, 5);
  assert.equal(forkWithArchiveContext.items[0]?.archiveAt == null, false);
  assert.equal(forkWithArchiveContext.items[1]?.archiveAt == null, false);
  assert.equal(forkWithArchiveContext.items[2]?.kind, "system");
  assert.equal(forkWithArchiveContext.items[3]?.kind, "user");
  assert.equal(forkWithArchiveContext.items[4]?.kind, "assistant");

  const forkArchiveFilePath = path.join(
    agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, forkWithArchiveSession.id),
    "00000001.log"
  );
  const forkArchiveContent = await fs.readFile(forkArchiveFilePath, "utf-8");
  assert.ok(forkArchiveContent.includes("历史问题"));
  assert.ok(forkArchiveContent.includes("新增归档与压缩方案草稿"));

  const revertArchivedRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/revert`,
    payload: {
      workspaceId: fixture.workspaceId,
      toItemId: userItem.item.id,
      reason: "manual_revert"
    }
  });
  assert.equal(revertArchivedRes.statusCode, 400, `revert archived item should fail: ${revertArchivedRes.body}`);
  assert.equal(revertArchivedRes.json().code, "AGENT_ARCHIVED_ITEM_IMMUTABLE");

  const archiveFilePath = path.join(
    agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id),
    "00000001.log"
  );
  const archiveContent = await fs.readFile(archiveFilePath, "utf-8");
  assert.ok(archiveContent.includes("历史问题"));
  assert.ok(archiveContent.includes("新增归档与压缩方案草稿"));

  const search = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "归档"
  });
  const searchLines = search.text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  assert.ok(searchLines.length >= 1);
  assert.ok(/^pos=\d+ \| /.test(searchLines[0] || ""), "search output should include pos prefix");

  const searchPage1 = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "item=",
    maxHits: 1
  });
  const searchPage1Line = searchPage1.text.trim();
  assert.ok(searchPage1Line.length > 0);
  const searchPage1PosMatch = /^pos=(\d+) \| /.exec(searchPage1Line);
  assert.ok(searchPage1PosMatch, "search page 1 should include pos prefix");
  const searchPage1Pos = Number(searchPage1PosMatch?.[1] || "0");
  assert.ok(searchPage1Pos > 0);

  const searchPage2 = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "item=",
    maxHits: 1,
    beforePos: searchPage1Pos
  });
  const searchPage2Line = searchPage2.text.trim();
  const searchPage2PosMatch = /^pos=(\d+) \| /.exec(searchPage2Line);
  assert.ok(searchPage2PosMatch, "search page 2 should include pos prefix");
  const searchPage2Pos = Number(searchPage2PosMatch?.[1] || "0");
  assert.ok(searchPage2Pos > 0 && searchPage2Pos < searchPage1Pos, "beforePos should continue to older hits");

  const optionLikeQuery = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "--glob"
  });
  assert.equal(typeof optionLikeQuery.text, "string");

  const readLatest = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    lineCount: 5
  });
  const readLatestLines = readLatest.text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  assert.ok(readLatestLines.length >= 2);
  const latestFirstPos = Number(/^pos=(\d+) \| /.exec(readLatestLines[0] || "")?.[1] || "0");
  const latestSecondPos = Number(/^pos=(\d+) \| /.exec(readLatestLines[1] || "")?.[1] || "0");
  assert.ok(latestFirstPos > 0 && latestSecondPos > latestFirstPos, "read should be old->new order");

  const readOlder = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    beforePos: latestSecondPos,
    lineCount: 5
  });
  const readOlderLine = readOlder.text.trim();
  const readOlderPos = Number(/^pos=(\d+) \| /.exec(readOlderLine)?.[1] || "0");
  assert.ok(readOlderPos > 0 && readOlderPos < latestSecondPos, "archive_read.beforePos should only return older lines");

  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: afterSummaryAssistant.item.id,
    kind: "system",
    status: "completed",
    output: {
      type: "system_text",
      text: "[run] max steps exceeded"
    }
  });

  const promptContextAfterRunSystem = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const leakedRunSystemMessage = promptContextAfterRunSystem.messages.find(
    (item) => item.role === "system" && String(item.content || "").includes("[run] max steps exceeded")
  );
  assert.equal(leakedRunSystemMessage, undefined, "runtime run-status system text should not leak into model prompt");
});

test("agent prompt-context 未发生 compaction 时不应注入 compaction snippet", async () => {
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
    turnId: "turn_nocompact_1",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "hi"
    }
  });
  assert.ok(userItem.item.id > 0);

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.equal(
    context.messages.some((m) => m.role === "system" && String(m.content || "").includes("压缩前尾部摘录")),
    false
  );
});

test("agent prompt-context compaction snippet 缓存缺失时应即时重建", async () => {
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
    turnId: "turn_compact_cache_1",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "历史问题: cache miss"
    }
  });
  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_compact_cache_1",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "ok"
    }
  });

  const compact = await compactContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: assistantItem.item.id,
    summaryText: "压缩摘要: cache test"
  });
  assert.equal(compact.compacted, true);
  assert.ok((compact.summaryItemId ?? 0) > 0);
  const summaryItemId = compact.summaryItemId as number;

  // 首次调用触发生成并写入缓存.
  const ctx1 = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.ok(ctx1.messages.some((m) => m.role === "system" && String(m.content || "").includes("压缩前尾部摘录")));

  const cachePath = compactionSnippetPath(fixture.dataDir, fixture.workspaceId, session.id, summaryItemId);
  await fs.rm(cachePath, { force: true });

  // 删除缓存后再次调用,应即时重建并注入.
  const ctx2 = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.ok(ctx2.messages.some((m) => m.role === "system" && String(m.content || "").includes("压缩前尾部摘录")));
});

test("archive v2 边界行为: 校验/大小写/跨文件pos/截断/半行过滤", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const archiveDir = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id);
  await fs.mkdir(archiveDir, { recursive: true });

  const file1Lines = Array.from({ length: 100 }, (_, idx) => {
    const n = idx + 1;
    const tail = n === 100 ? "BoundaryToken" : `line-${n}`;
    return `item=${n} ts=${n} kind=user status=completed tool=- | ${tail}`;
  });
  const longText = `LONG-${"x".repeat(1300)}`;
  const file2Line1 = `item=101 ts=101 kind=assistant status=completed tool=- | ${longText}`;
  const file2PartialLine = "item=102 ts=102 kind=assistant status=completed tool=- | PartialOnlyToken";

  await fs.writeFile(path.join(archiveDir, "00000001.log"), `${file1Lines.join("\n")}\n`, "utf-8");
  await fs.writeFile(path.join(archiveDir, "00000002.log"), `${file2Line1}\n${file2PartialLine}`, "utf-8");

  const invalidBeforePosRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/archive/search",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      query: "token",
      beforePos: 1
    }
  });
  assert.equal(invalidBeforePosRes.statusCode, 400, "beforePos<2 should be rejected");

  const caseInsensitiveSearch = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "boundarytoken",
    maxHits: 1
  });
  assert.ok(caseInsensitiveSearch.text.startsWith("pos=100 |"), "search should be case-insensitive and return pos=100");

  const readLatest = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    lineCount: 1
  });
  assert.ok(readLatest.text.startsWith("pos=101 |"), "latest line should come from file2 line1 with pos=101");

  const readOlder = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    beforePos: 101,
    lineCount: 1
  });
  assert.ok(readOlder.text.startsWith("pos=100 |"), "beforePos should read strictly older line across file boundary");

  const halfLineSearch = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "PartialOnlyToken"
  });
  assert.equal(halfLineSearch.text.trim(), "", "search should ignore unfinished last line without trailing newline");

  const truncatedRead = await archiveReadInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    lineCount: 1,
    maxChars: 1000
  });
  assert.ok(truncatedRead.text.startsWith("pos=101 |"), "truncated output should keep pos prefix");
  assert.ok(
    truncatedRead.text.includes("[超过最大字符数限制,从此处截断内容]"),
    "truncated output should include truncation marker"
  );
});

test("archive_search snippet 模式返回命中窗口并限制单行窗口数量", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const archiveDir = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id);
  await fs.mkdir(archiveDir, { recursive: true });

  const repeatedText = `${Array.from({ length: 7 }, (_, idx) => `seg${idx + 1}-${"x".repeat(140)} KEYWORD`).join(" ")} TAILMARK`;
  const line = `item=1 ts=1 kind=user status=completed tool=- | ${repeatedText}`;
  await fs.writeFile(path.join(archiveDir, "00000001.log"), `${line}\n`, "utf-8");

  const fullLineSearch = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "keyword",
    maxHits: 1
  });
  const fullLineOutput = fullLineSearch.text.trim();
  assert.ok(fullLineOutput.startsWith("pos=1 | item=1 ts=1 kind=user status=completed tool=- |"));
  assert.equal((fullLineOutput.match(/KEYWORD/g) || []).length, 7, "default search should keep full line by default");

  const regexZeroWidth = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "\\b",
    regex: true,
    maxHits: 1
  });
  assert.ok(regexZeroWidth.text.startsWith("pos=1 | item=1 ts=1 kind=user status=completed tool=- |"));

  const regexZeroWidthSnippet = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "$",
    regex: true,
    maxHits: 1,
    snippet: true
  });
  assert.ok(regexZeroWidthSnippet.text.includes("TAILMARK"), "snippet+regex zero-width should include tail window");

  const snippetSearch = await archiveSearchInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    query: "keyword",
    maxHits: 1,
    snippet: true
  });
  const snippetOutput = snippetSearch.text.trim();
  assert.ok(snippetOutput.startsWith("pos=1 | item=1 ts=1 kind=user status=completed tool=- |"));
  const keywordCount = (snippetOutput.match(/KEYWORD/g) || []).length;
  assert.ok(keywordCount > 0, "snippet search should include keyword windows");
  assert.ok(keywordCount <= 5, "snippet mode should cap windows per line to 5");
  assert.ok(snippetOutput.includes("..."), "snippet mode should include omission marker between windows");
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
    "text",
    "tool-result output should be ai-sdk structured output"
  );
});

test("agent prompt-context 对 apply_patch 保留 patchText 输入,并使用文本结果", async () => {
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
      text: "请应用补丁"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_apply_patch",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "开始应用补丁"
    }
  });

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_apply_patch",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_1",
      args: {
        patchText: "*** Begin Patch\n*** Update File: foo.ts\n@@\n-console.log('a')\n+console.log('b')\n*** End Patch"
      },
      text: "apply_patch queued"
    }
  });

  await updateContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "completed",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_1",
      args: {
        patchText: "*** Begin Patch\n*** Update File: foo.ts\n@@\n-console.log('a')\n+console.log('b')\n*** End Patch"
      },
      result: {
        text: "Success. Updated the following files:\nM foo.ts",
        summary: {
          fileCount: 1,
          additions: 1,
          deletions: 1
        },
        files: [
          {
            type: "update",
            path: "foo.ts",
            before: "console.log('a')\n",
            after: "console.log('b')\n",
            additions: 1,
            deletions: 1
          }
        ]
      },
      text: "Success. Updated the following files:\nM foo.ts"
    }
  });

  const storedTool = await getContextItem(fixture.app, session.id, toolItem.item.id);
  const storedResult = (storedTool.output?.result ?? {}) as Record<string, unknown>;
  const storedFiles = Array.isArray(storedResult.files) ? storedResult.files : [];
  const first = (storedFiles[0] ?? {}) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(first, "before"), false, "DB apply_patch result should strip before");
  assert.equal(Object.prototype.hasOwnProperty.call(first, "after"), false, "DB apply_patch result should strip after");

  const artifactRes = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/context-items/${toolItem.item.id}/apply-patch-artifact`
  });
  assert.equal(artifactRes.statusCode, 200, `apply_patch artifact fetch failed: ${artifactRes.body}`);
  const artifact = artifactRes.json() as { files?: Array<Record<string, unknown>> };
  const artifactFiles = Array.isArray(artifact.files) ? artifact.files : [];
  const artifactFirst = artifactFiles[0] ?? {};
  assert.equal(typeof artifactFirst.before, "string");
  assert.equal(typeof artifactFirst.after, "string");

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

  const toolCallPart = Array.isArray(assistantWithToolCall?.content)
    ? assistantWithToolCall.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "apply_patch";
      })
    : null;
  assert.ok(toolCallPart && typeof toolCallPart === "object", "apply_patch tool-call should exist");
  assert.equal(
    typeof (toolCallPart as { input?: { patchText?: unknown } }).input?.patchText,
    "string",
    "apply_patch tool-call input should keep patchText"
  );

  const toolResultMessage = context.messages.find((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-result" &&
        (part as { toolName?: string }).toolName === "apply_patch";
    });
  });
  assert.ok(toolResultMessage, "tool message should include apply_patch tool-result part");

  const toolResultPart = Array.isArray(toolResultMessage?.content)
    ? toolResultMessage.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-result" &&
          (part as { toolName?: string }).toolName === "apply_patch";
      })
    : null;
  assert.ok(toolResultPart && typeof toolResultPart === "object", "apply_patch tool-result part should exist");

  const output = (toolResultPart as { output?: { type?: string; value?: string } }).output;
  assert.equal(String(output?.type || ""), "text");
  assert.equal(String(output?.value || "").includes("Success. Updated the following files"), true);
});

test("agent prompt-context 支持 todolist 工具输入输出", async () => {
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
      text: "请维护任务清单"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "更新任务清单"
    }
  });

  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "todolist",
      toolCallId: "call_todolist_1",
      args: {
        goal: "完成 todolist goal 增强与展示",
        todos: [
          { content: "梳理需求", status: "completed" },
          { content: "实现功能", status: "in_progress" }
        ]
      },
      result: {
        goal: "完成 todolist goal 增强与展示",
        summary: {
          total: 2,
          pending: 0,
          inProgress: 1,
          completed: 1,
          cancelled: 0
        },
        todos: [
          { content: "梳理需求", status: "completed" },
          { content: "实现功能", status: "in_progress" }
        ]
      },
      text: "Todo list updated: total=2"
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
      return (part as { type?: string; toolName?: string }).type === "tool-call" &&
        (part as { toolName?: string }).toolName === "todolist";
    });
  });
  assert.ok(assistantWithToolCall, "assistant message should include todolist tool-call part");

  const toolCallPart = Array.isArray(assistantWithToolCall?.content)
    ? assistantWithToolCall.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "todolist";
      })
    : null;
  const input = (toolCallPart as { input?: Record<string, unknown> } | null)?.input ?? {};
  assert.equal(String(input.goal || ""), "完成 todolist goal 增强与展示");
  assert.equal(Array.isArray(input.todos), true, "todolist tool-call input should include todos");

  const toolResultMessage = context.messages.find((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-result" &&
        (part as { toolName?: string }).toolName === "todolist";
    });
  });
  assert.ok(toolResultMessage, "tool message should include todolist tool-result part");

  const toolResultPart = Array.isArray(toolResultMessage?.content)
    ? toolResultMessage.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-result" &&
          (part as { toolName?: string }).toolName === "todolist";
      })
    : null;
  const output = (toolResultPart as { output?: { type?: string; value?: string } } | null)?.output;
  assert.equal(String(output?.type || ""), "text", "todolist tool-result output should be text");
  assert.equal(String(output?.value || "").includes("Todo list updated"), true, "todolist tool-result should be summary text");

  const updatedSession = getAgentSession(fixture.db, session.id);
  assert.ok(updatedSession, "updated session should exist");
  assert.equal(updatedSession?.title, "完成 todolist goal 增强与展示");
});

test("agent prompt-context: todolist goal 超长时自动截断并更新 session title", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const longGoal = "这是一个非常长的 todolist goal，用来验证超过五十个字符后会被自动截断而不是直接报错失败，需要继续追加更多文字";
  const normalizedGoal = "这是一个非常长的 todolist goal，用来验证超过五十个字符后会被自动截断而不是直接报错失…";
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
    output: { type: "user_text", text: "请维护任务清单" }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist_goal_truncate",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "更新任务清单" }
  });

  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist_goal_truncate",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "todolist",
      toolCallId: "call_todolist_goal_truncate",
      args: { goal: longGoal, todos: [{ content: "实现功能", status: "in_progress" }] },
      result: { goal: longGoal, summary: { total: 1, pending: 0, inProgress: 1, completed: 0, cancelled: 0 }, todos: [{ content: "实现功能", status: "in_progress" }] }
    }
  });

  const updatedSession = getAgentSession(fixture.db, session.id);
  assert.ok(updatedSession, "updated session should exist");
  assert.equal(updatedSession?.title, normalizedGoal);
});

test("agent prompt-context: todolist goal 为空白时不更新 session title", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerItemId: 1, agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", status: "running", createdAt
  });

  await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist_goal_blank",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "todolist",
      toolCallId: "call_todolist_goal_blank",
      args: { goal: "   ", todos: [{ content: "实现功能", status: "in_progress" }] },
      result: { goal: "   ", summary: { total: 1, pending: 0, inProgress: 1, completed: 0, cancelled: 0 }, todos: [{ content: "实现功能", status: "in_progress" }] }
    }
  });

  const updatedSession = getAgentSession(fixture.db, session.id);
  assert.ok(updatedSession, "updated session should exist");
  assert.equal(updatedSession?.title, "it-session");
});

test("agent internal: 禁止 append completed apply_patch(必须走 update 写 artifact)", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: null,
      turnId: null,
      step: null,
      prevId: null,
      kind: "tool",
      status: "completed",
      output: {
        type: "tool",
        toolName: "apply_patch",
        toolCallId: "call_apply_patch_1",
        args: { patchText: "*** Begin Patch\n*** End Patch" },
        result: { text: "ok", summary: { fileCount: 0, additions: 0, deletions: 0 }, files: [] },
        text: "ok"
      }
    }
  });
  assert.equal(res.statusCode, 400);
});

test("apply_patch artifact 文件缺失时返回 404", async () => {
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

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_apply_patch",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_1",
      args: { patchText: "*** Begin Patch\n*** End Patch" },
      text: "queued"
    }
  });

  await updateContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "completed",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_1",
      args: { patchText: "*** Begin Patch\n*** End Patch" },
      result: {
        text: "ok",
        summary: { fileCount: 1, additions: 1, deletions: 0 },
        files: [
          {
            type: "add",
            path: "foo.ts",
            before: "",
            after: "console.log(1)\n",
            additions: 1,
            deletions: 0
          }
        ]
      },
      text: "ok"
    }
  });

  const artifactPath = path.join(
    fixture.dataDir,
    "tmp",
    "agent",
    "ui-artifacts",
    "apply_patch",
    fixture.workspaceId,
    "call_apply_patch_1.json"
  );
  await fs.rm(artifactPath, { force: true });

  const artifactRes = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/context-items/${toolItem.item.id}/apply-patch-artifact`
  });
  assert.equal(artifactRes.statusCode, 404);
});

test("write completed 后瘦身 args/result 并支持 artifact 拉取", async () => {
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
      text: "请写入文件"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "开始写文件"
    }
  });

  const writeContent = "hello\nworld\n";
  const writeBytes = Buffer.byteLength(writeContent, "utf8");

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: {
        filePath: "foo.txt",
        content: writeContent
      },
      text: "write queued"
    }
  });

  await updateContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "completed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: {
        filePath: "foo.txt",
        content: writeContent
      },
      result: {
        summary: "写入文件 foo.txt",
        filePath: "foo.txt",
        bytesWritten: writeBytes,
        existedBefore: false,
        before: {
          available: false,
          truncated: false,
          bytes: 0,
          reason: "missing_file"
        },
        after: {
          available: true,
          text: writeContent,
          truncated: false,
          bytes: writeBytes
        }
      },
      text: "ok: wrote file"
    }
  });

  const storedTool = await getContextItem(fixture.app, session.id, toolItem.item.id);
  const storedOutput = storedTool.output as { args?: Record<string, unknown>; result?: Record<string, unknown> };
  const storedArgs = storedOutput.args || {};
  assert.equal(Object.prototype.hasOwnProperty.call(storedArgs, "content"), false, "write args should strip content");
  assert.equal(Number(storedArgs.contentBytes), writeBytes);

  const storedResult = storedOutput.result || {};
  assert.equal(Object.prototype.hasOwnProperty.call(storedResult, "before"), false, "write result should strip before");
  assert.equal(Object.prototype.hasOwnProperty.call(storedResult, "after"), false, "write result should strip after");

  const artifactRes = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/context-items/${toolItem.item.id}/write-artifact`
  });
  assert.equal(artifactRes.statusCode, 200, `write artifact fetch failed: ${artifactRes.body}`);
  const artifact = artifactRes.json() as { before?: Record<string, unknown>; after?: Record<string, unknown> };
  assert.equal(artifact.before?.available, false);
  assert.equal(artifact.after?.available, true);
  assert.equal(typeof artifact.after?.text, "string");

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
      return (part as { type?: string; toolName?: string }).type === "tool-call" &&
        (part as { toolName?: string }).toolName === "write";
    });
  });
  assert.ok(assistantWithToolCall, "assistant message should include write tool-call part");

  const toolCallPart = Array.isArray(assistantWithToolCall?.content)
    ? assistantWithToolCall.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "write";
      })
    : null;
  const input = (toolCallPart as { input?: Record<string, unknown> } | null)?.input ?? {};
  assert.equal(typeof input.filePath, "string");
  assert.equal(typeof input.contentBytes, "number");
  assert.equal(Object.prototype.hasOwnProperty.call(input, "content"), false, "write tool-call input should strip content");
});

test("write artifact 文件缺失时返回 404", async () => {
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

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: { filePath: "foo.txt", content: "hello" },
      text: "queued"
    }
  });

  await updateContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "completed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: { filePath: "foo.txt", content: "hello" },
      result: {
        summary: "写入文件 foo.txt",
        filePath: "foo.txt",
        bytesWritten: 5,
        existedBefore: false,
        before: { available: false, truncated: false, bytes: 0, reason: "missing_file" },
        after: { available: true, text: "hello", truncated: false, bytes: 5 }
      },
      text: "ok"
    }
  });

  const artifactPath = path.join(
    fixture.dataDir,
    "tmp",
    "agent",
    "ui-artifacts",
    "write",
    fixture.workspaceId,
    "call_write_1.json"
  );
  await fs.rm(artifactPath, { force: true });

  const artifactRes = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/context-items/${toolItem.item.id}/write-artifact`
  });
  assert.equal(artifactRes.statusCode, 404);
});

test("write 在 deny 终态会瘦身 args.content", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "awaiting_permission",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_deny",
      args: {
        filePath: "deny.txt",
        content: "secret deny payload"
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
    waitingToolItemId: toolItem.item.id
  });

  const denyRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/tool-permission`,
    payload: {
      workspaceId: fixture.workspaceId,
      toolItemId: toolItem.item.id,
      decision: "deny"
    }
  });
  assert.equal(denyRes.statusCode, 200, `deny write permission failed: ${denyRes.body}`);

  const deniedItem = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(deniedItem.status, "denied");
  const args = (deniedItem.output as { args?: Record<string, unknown> }).args || {};
  assert.equal(Object.prototype.hasOwnProperty.call(args, "content"), false);
  assert.equal(typeof args.contentBytes, "number");
});

test("write 在 cancel 终态会瘦身 args.content", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_write_cancel",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_cancel",
      args: {
        filePath: "cancel.txt",
        content: "secret cancel payload"
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
    activeAssistantItemId: null,
    waitingToolItemId: null
  });

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel write run failed: ${cancelRes.body}`);

  const cancelledItem = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(cancelledItem.status, "cancelled");
  const args = (cancelledItem.output as { args?: Record<string, unknown> }).args || {};
  assert.equal(Object.prototype.hasOwnProperty.call(args, "content"), false);
  assert.equal(typeof args.contentBytes, "number");
});

test("agent tool 字符串结果保持原始字符串语义", async () => {
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
      text: "测试字符串结果"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_string_result",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "调用工具获取字符串"
    }
  });

  const rawString = '{"ok":true}';
  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_string_result",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "bash",
      toolCallId: "call_string_result",
      args: {
        command: "echo test"
      },
      result: rawString
    }
  });

  const detail = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(detail.output.type, "tool");
  assert.equal(typeof detail.output.result, "string");
  assert.equal(String(detail.output.result || ""), rawString);
});

test("agent 兼容部分迁移数据: tool_call_json 缺失时回退 legacy output", async () => {
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
      text: "请读取文件"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_legacy_fallback",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "准备调用 read"
    }
  });

  const legacyToolOutput = {
    type: "tool",
    toolName: "read",
    toolCallId: "call_legacy_read",
    args: {
      filePath: "README.md"
    },
    approved: true
  };

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_legacy_fallback",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "awaiting_permission",
    output: legacyToolOutput
  });

  fixture.db
    .prepare(
      `
        update agent_context_item
        set tool_name = @toolName,
            tool_call_id = null,
            tool_call_json = null,
            tool_result_json = null,
            output_text = '',
            output_json = @outputJson
        where id = @id
      `
    )
    .run({
      id: toolItem.item.id,
      toolName: "read",
      outputJson: JSON.stringify(legacyToolOutput)
    });

  const detail = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(detail.output.type, "tool");
  assert.equal(String(detail.output.toolName || ""), "read");
  assert.equal(String(detail.output.toolCallId || ""), "call_legacy_read");
  assert.equal(String((detail.output.args as { filePath?: string } | undefined)?.filePath || ""), "README.md");
  assert.equal(detail.output.approved, true);

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.equal(promptContext.pendingTools.length, 1);
  assert.equal(promptContext.pendingTools[0]?.approved, true);
});

test("agent 兼容早期拆分数据: 缺少 resultFormat 时保留结构化工具结果", async () => {
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
      text: "测试结构化兼容"
    }
  });

  const assistantItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_compat_result",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "调用 todolist"
    }
  });

  const structuredResult = {
    summary: { total: 1, pending: 0, inProgress: 0, completed: 1, cancelled: 0 },
    todos: [{ content: "完成兼容", status: "completed" }]
  };

  const toolItem = await createContextItemInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_compat_result",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "todolist",
      toolCallId: "call_compat_todolist",
      args: {
        todos: [{ content: "完成兼容", status: "completed" }]
      },
      result: structuredResult
    }
  });

  fixture.db
    .prepare(
      `
        update agent_context_item
        set output_text = @outputText,
            tool_result_json = @toolResultJson,
            output_json = '{}'
        where id = @id
      `
    )
    .run({
      id: toolItem.item.id,
      outputText: JSON.stringify(structuredResult),
      toolResultJson: JSON.stringify({ status: "completed" })
    });

  const detail = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(detail.output.type, "tool");
  assert.equal(typeof detail.output.result, "object");
  assert.equal(
    Array.isArray((detail.output.result as { todos?: unknown[] } | undefined)?.todos),
    true,
    "result should remain structured object"
  );

  const sessionAfterCompat = getAgentSession(fixture.db, session.id);
  assert.ok(sessionAfterCompat, "compat session should exist");
  assert.equal(sessionAfterCompat?.title, "it-session", "compat todolist without goal should not change session title");
});

test("agent settings 兼容缺省 globalPromptIds", async () => {
  const fixture = await createFixture();
  const res = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      default: { agentId: "default" },
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
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
  assert.equal(res.statusCode, 200, `update agent settings failed: ${res.body}`);
  const body = res.json() as { agents: Array<{ globalPromptIds?: string[] }> };
  assert.deepEqual(body.agents[0]?.globalPromptIds ?? [], []);
});

test("agent prompt-context 全局提示词按列表顺序注入(方案A)", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  const initialGlobalPrompts = await fixture.app.inject({
    method: "GET",
    url: "/api/settings/agent/global-prompts"
  });
  assert.equal(initialGlobalPrompts.statusCode, 200, `get global prompts failed: ${initialGlobalPrompts.body}`);
  const seededItems = (initialGlobalPrompts.json() as { items: Array<{ id: string; title: string; prompt: string }> }).items;
  const seededSystemPrompt = seededItems.find((item) => item.id === "global_system_prompt");
  assert.ok(seededSystemPrompt, "seeded global system prompt should exist");
  assert.equal(seededSystemPrompt?.title, "Global System Prompt");
  assert.ok(String(seededSystemPrompt?.prompt || "").trim().length > 0, "seeded global system prompt should be non-empty");

  const globalPromptsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "global_system_prompt", title: "ignored", prompt: "CUSTOM_SYSTEM_BASE" },
        { id: "gp_a", title: "A", prompt: "PROMPT_A" },
        { id: "gp_b", title: "B", prompt: "PROMPT_B" }
      ]
    }
  });
  assert.equal(globalPromptsRes.statusCode, 200, `update global prompts failed: ${globalPromptsRes.body}`);
  const updatedItems = (globalPromptsRes.json() as { items: Array<{ id: string; title: string; prompt: string }> }).items;
  assert.equal(updatedItems.find((item) => item.id === "global_system_prompt")?.title, "Global System Prompt");

  const omitSystemPromptRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "gp_a", title: "A", prompt: "PROMPT_A" },
        { id: "gp_b", title: "B", prompt: "PROMPT_B" }
      ]
    }
  });
  assert.equal(omitSystemPromptRes.statusCode, 200, `update global prompts failed: ${omitSystemPromptRes.body}`);
  const omitSystemPromptItems = (omitSystemPromptRes.json() as { items: Array<{ id: string; title: string; prompt: string }> }).items;
  assert.equal(omitSystemPromptItems.filter((item) => item.id === "global_system_prompt").length, 1);
  assert.equal(omitSystemPromptItems.find((item) => item.id === "global_system_prompt")?.prompt, "CUSTOM_SYSTEM_BASE");

  const emptySystemPromptRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "global_system_prompt", title: "whatever", prompt: "   " }
      ]
    }
  });
  assert.equal(emptySystemPromptRes.statusCode, 400, `empty system prompt should be rejected: ${emptySystemPromptRes.body}`);

  const emptyPromptRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "global_system_prompt", title: "whatever", prompt: "CUSTOM_SYSTEM_BASE" },
        { id: "gp_empty", title: "Empty", prompt: "   " }
      ]
    }
  });
  assert.equal(emptyPromptRes.statusCode, 400, `empty prompt should be rejected: ${emptyPromptRes.body}`);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      default: { agentId: "default" },
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "AGENT_PROMPT",
          globalPromptIds: ["global_system_prompt", "gp_b", "gp_a"],
          tools: ["bash", "read", "write"],
          mcpServers: [],
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
  assert.equal(agentsRes.statusCode, 200, `update agents failed: ${agentsRes.body}`);

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

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const idxA = context.system.indexOf("PROMPT_A");
  const idxB = context.system.indexOf("PROMPT_B");
  const idxAgent = context.system.indexOf("AGENT_PROMPT");
  const idxCore = context.system.indexOf("CUSTOM_SYSTEM_BASE");
  assert.ok(idxA >= 0, "system should include PROMPT_A");
  assert.ok(idxB >= 0, "system should include PROMPT_B");
  assert.ok(idxAgent >= 0, "system should include AGENT_PROMPT");
  assert.ok(idxCore >= 0, "system should include global workflow prompt");
  assert.ok(idxCore < idxA, "global workflow prompt should be prepended before global prompts");
  assert.ok(idxA < idxB, "global prompts should follow global list order, not selected id order");
  assert.equal((context.system.match(/CUSTOM_SYSTEM_BASE/g) || []).length, 1, "system prompt base should only appear once");
  assert.ok(idxB < idxAgent, "agent prompt should be appended after global prompts");
});

test("agent prompt-context 同时存在 global/workspace/agent 时按既定顺序拼接", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  await fs.writeFile(path.join(fixture.workspacePath, "AGENTS.md"), "WORKSPACE_RULE", "utf-8");

  const globalPromptsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "gp_a", title: "A", prompt: "PROMPT_A" },
        { id: "gp_b", title: "B", prompt: "PROMPT_B" }
      ]
    }
  });
  assert.equal(globalPromptsRes.statusCode, 200, `update global prompts failed: ${globalPromptsRes.body}`);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      default: { agentId: "default" },
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "AGENT_PROMPT",
          globalPromptIds: ["gp_b", "gp_a"],
          tools: ["bash", "read", "write"],
          mcpServers: [],
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
  assert.equal(agentsRes.statusCode, 200, `update agents failed: ${agentsRes.body}`);

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

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const idxCore = context.system.indexOf("# 工作方式与流程(全局)");
  const idxA = context.system.indexOf("PROMPT_A");
  const idxB = context.system.indexOf("PROMPT_B");
  const idxWorkspace = context.system.indexOf("## Workspace Instructions: AGENTS.md");
  const idxAgent = context.system.indexOf("AGENT_PROMPT");

  assert.ok(idxCore >= 0, "system should include global workflow prompt");
  assert.ok(idxA >= 0, "system should include PROMPT_A");
  assert.ok(idxB >= 0, "system should include PROMPT_B");
  assert.ok(idxWorkspace >= 0, "system should include workspace instructions section");
  assert.ok(idxAgent >= 0, "system should include AGENT_PROMPT");

  assert.ok(idxCore < idxA, "order: core before global prompts");
  assert.ok(idxA < idxB, "order: global prompts follow global list order");
  assert.ok(idxB < idxWorkspace, "order: global prompts before workspace instructions");
  assert.ok(idxWorkspace < idxAgent, "order: workspace instructions before agent prompt");
});

test("agent prompt-context 在 workspace 根 AGENTS.md 缺失时忽略", async () => {
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

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  assert.ok(context.system.includes("# 工作方式与流程(全局)"), "system should include global workflow prompt");
  assert.ok(context.system.includes("## Agent Prompt: default"), "system should include agent section");
  assert.ok(
    context.system.includes("You are a helpful coding assistant."),
    "system should include agent prompt content"
  );
  assert.equal(
    context.system.includes("## Workspace Instructions: AGENTS.md"),
    false,
    "system should ignore missing workspace AGENTS.md"
  );
});

test("agent startup seed 会修复脏的 global prompts settings", async () => {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "agent-seed-repair-it-"));
  const internalToken = "test-internal-token";

  const db = await openDb(dataDir);
  let app: FastifyInstance | null = null;
  try {
    setSettingJson(db, "agent_global_prompts_v1", {
      items: [
        null,
        { id: "global_system_prompt", title: "Broken", prompt: "   " },
        { id: "global_system_prompt", title: "Dup", prompt: "dup" },
        { id: "gp_empty", title: "Empty", prompt: "   " },
        { id: "gp_ok", title: "OK", prompt: "PROMPT_OK" }
      ]
    }, Date.now());

    app = await createApp({
      db,
      repoRoot,
      dataDir,
      fileMaxBytes: 1024 * 1024,
      version: "test",
      logLevel: "error",
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
      agentWorkerConcurrency: 0,
      agentInternalToken: internalToken,
      agentApiOrigin: "http://127.0.0.1:0",
      agentStartupRecoveryMode: "recover"
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/settings/agent/global-prompts" });
    assert.equal(res.statusCode, 200);
    const items = (res.json() as { items: Array<{ id: string; title: string; prompt: string }> }).items;
    assert.equal(items.filter((item) => item.id === "global_system_prompt").length, 1);
    assert.equal(items.find((item) => item.id === "global_system_prompt")?.title, "Global System Prompt");
    assert.ok(String(items.find((item) => item.id === "global_system_prompt")?.prompt || "").trim().length > 0);
    assert.equal(items.some((item) => item.id === "gp_empty"), false);
    assert.equal(items.some((item) => item.id === "gp_ok" && item.prompt === "PROMPT_OK"), true);
  } finally {
    await app?.close().catch(() => undefined);
    db.close();
    await rmrf(dataDir);
  }
});

test("agent prompt-context 在 agent prompt 为空且无 workspace/global 时仅注入全局系统提示词", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      default: { agentId: "default" },
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "",
          tools: ["bash", "read", "write"],
          mcpServers: [],
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
  assert.equal(agentsRes.statusCode, 200, `update agents failed: ${agentsRes.body}`);

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

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  assert.ok(context.system.includes("# 工作方式与流程(全局)"), "system should include global workflow prompt");
  assert.equal(context.system.includes("## Global Prompt:"), false, "system should not include global prompt sections");
  assert.equal(
    context.system.includes("## Workspace Instructions:"),
    false,
    "system should not include workspace instructions when missing"
  );
  assert.equal(context.system.includes("## Agent Prompt:"), false, "system should not include agent prompt section when empty");
});

test("agent prompt-context 对 workspace AGENTS.md 做 32KB 截断并追加标记", async () => {
  const fixture = await createFixture({ agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();
  const agentsPath = path.join(fixture.workspacePath, "AGENTS.md");
  await fs.writeFile(agentsPath, `RULE\n${"A".repeat(40 * 1024)}`, "utf-8");

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

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  assert.ok(
    context.system.includes("## Workspace Instructions: AGENTS.md"),
    "system should include workspace section with relative path"
  );
  assert.ok(
    context.system.includes("[workspace AGENTS.md truncated: first 32KB]"),
    "system should include truncation marker"
  );
  assert.ok(context.system.includes("## Agent Prompt: default"), "system should include agent section when workspace section exists");
});
