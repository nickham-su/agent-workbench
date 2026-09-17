import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../app/createApp.js";
import type { AppContext } from "../../app/context.js";
import { openDb } from "../../infra/db/db.js";
import type { Db } from "../../infra/db/db.js";
import { ensureDir, rmrf } from "../../infra/fs/fs.js";
import { agentWorkerPidPath, workspaceRoot } from "../../infra/fs/paths.js";
import { newSortableId } from "../../utils/ids.js";
import { insertWorkspace } from "../workspaces/workspace.store.js";
import { createMessageRunRecord, getRunRecord } from "./agent-message.store.js";
import { createAgentService } from "./agent.composition.js";
import { AgentWorkerClient } from "./agent.worker-client.js";
import {
  appendMessage,
  appendStreamingAssistant,
  completeAssistantWithExecutions,
  createMessageSession,
  flushStreamingParts,
  getMessageRunState,
  getMessageSession,
  startMessageRun,
} from "./agent-message.store.js";
import { AgentApiEndpoints } from "@agent-workbench/shared/internal-contracts/agent-api";

type InternalRpcCall = { method: string; url: string; body: unknown; responseBody?: unknown; statusCode?: number };
type LlmStub = {
  server: HttpServer;
  baseURL: string;
  requests: Array<Record<string, unknown>>;
};

type Fixture = {
  app: FastifyInstance;
  db: Db;
  ctx: AppContext;
  dataDir: string;
  workspaceId: string;
  workspacePath: string;
  baseUrl: string;
  workerPidFilePath: string;
  llmStub?: LlmStub;
  internalRpcCalls: InternalRpcCall[];
};

const fixtures = new Set<Fixture>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
  if (!addr || typeof addr === "string") {
    throw new Error("failed to detect free port");
  }
  return addr.port;
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitUntil timeout after ${timeoutMs}ms`);
}

async function requestJson<T>(baseUrl: string, input: { method: string; path: string; body?: unknown; headers?: Record<string, string> }) {
  const response = await fetch(`${baseUrl}${input.path}`, {
    method: input.method,
    headers: {
      "content-type": "application/json",
      ...input.headers,
    },
    body: input.body == null ? undefined : JSON.stringify(input.body)
  });
  const text = await response.text();
  const json = text ? (JSON.parse(text) as T) : (null as T);
  return { response, json, text };
}

async function startLlmStubServer(mode: "failure" | "success" | "tool-cycle" = "failure") {
  const requests: Array<Record<string, unknown>> = [];
  let toolCycleStreamRequestCount = 0;
  const server = createHttpServer((req, res) => {
    if (mode === "success" || mode === "tool-cycle") {
      let requestBody = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        requestBody += chunk;
      });
      req.on("end", () => {
        const request = requestBody ? JSON.parse(requestBody) as Record<string, unknown> : {};
        requests.push(request);
        if (request.stream === true) {
          const chunks = mode === "tool-cycle" && toolCycleStreamRequestCount++ === 0
            ? [
                {
                  id: "stub-tool-cycle-1",
                  created: 1,
                  model: "gpt-5.2",
                  choices: [{
                    index: 0,
                    delta: {
                      role: "assistant",
                      // OpenAI chat completion adapters ignore this vendor extension;
                      // the following request must not carry it into model history.
                      reasoning_content: "private M3 reasoning",
                      tool_calls: [{
                        index: 0,
                        id: "stub-tool-call-1",
                        type: "function",
                        function: { name: "bash", arguments: JSON.stringify({ command: "printf tool-cycle-output" }) }
                      }]
                    },
                    finish_reason: null
                  }]
                },
                { id: "stub-tool-cycle-1", created: 1, model: "gpt-5.2", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
              ]
            : [
                { id: "stub", created: 1, model: "gpt-5.2", choices: [{ index: 0, delta: { role: "assistant", content: mode === "tool-cycle" ? "tool cycle complete" : "stub response" }, finish_reason: null }] },
                { id: "stub", created: 1, model: "gpt-5.2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
              ];
          res.statusCode = 200;
          res.setHeader("content-type", "text/event-stream; charset=utf-8");
          res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({
          id: "stub",
          object: "chat.completion",
          created: 1,
          model: "gpt-5.2",
          choices: [{ index: 0, message: { role: "assistant", content: "stub summary" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }));
      });
      return;
    }
    // Return a deterministic JSON error so the legacy writeback test fails fast without external network.
    const payload = JSON.stringify({ error: { message: "llm stub", type: "stub_error" } });
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("connection", "close");
    res.end(payload);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("failed to start llm stub server");
  }
  return {
    server,
    baseURL: `http://127.0.0.1:${addr.port}/v1`,
    requests
  };
}

async function configureAgentDefaults(baseUrl: string, llmBaseURL: string) {
  const providers = await requestJson(baseUrl, {
    method: "PUT",
    path: "/api/settings/agent/providers",
    body: {
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
             baseURL: llmBaseURL,
             apiKey: "sk-test",
             apiMode: "chatCompletions"
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
  assert.equal(providers.response.status, 200, `configure providers failed: ${providers.text}`);

  const agents = await requestJson(baseUrl, {
    method: "PUT",
    path: "/api/settings/agent/agents",
    body: {
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
            pluginTools: [],
            mcpServers: [],
            defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
            scope: "both",
            order: 0
          }
       ]
     }
   });
  assert.equal(agents.response.status, 200, `configure agents failed: ${agents.text}`);

  const runtime = await requestJson(baseUrl, {
    method: "PUT",
    path: "/api/settings/agent/runtime",
    body: {
      // worker integration test should not depend on real LLM connectivity.
      modelRequestMaxRetries: 0,
      // keep a small timeout to avoid hanging on network/dns.
      modelIdleTimeoutMs: 1500,
      modelTotalTimeoutMs: 1500,
      autoCompactThresholdPct: 80
    }
  });
  assert.equal(runtime.response.status, 200, `configure agent runtime failed: ${runtime.text}`);
}

async function createFixture(params: { llmMode?: "failure" | "success" | "tool-cycle" } = {}): Promise<Fixture> {
  const repoRoot = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../..")
  ].find((candidate) => existsSync(path.join(candidate, "node_modules", ".bin", "tsx")))
    ?? path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "agent-worker-it-"));

  let llmStub: Awaited<ReturnType<typeof startLlmStubServer>> | null = null;
  let app: FastifyInstance | null = null;
  let db: Db | null = null;
  try {
    llmStub = await startLlmStubServer(params.llmMode);
    const apiPort = await getFreePort();
    const workerPort = await getFreePort();

    db = await openDb(dataDir);
    const ctx: AppContext = {
      db,
      repoRoot,
      dataDir,
      fileMaxBytes: 1024 * 1024,
      version: "test",
      logLevel: "error",
      serveWeb: false,
      webDistDir: null,
      preview: { enabled: false, runtime: null },
      credentialMasterKey: Buffer.alloc(32, 7),
      credentialMasterKeySource: "generated",
      credentialMasterKeyId: "testkey",
      credentialMasterKeyCreatedAt: Date.now(),
      authToken: null,
      authCookieSecure: false,
      agentWorkerEnabled: true,
      agentWorkerHost: "127.0.0.1",
      agentWorkerPort: workerPort,
      agentWorkerSocketPath: path.join(dataDir, "agent-worker.sock"),
      agentWorkerConcurrency: 2,
      agentInternalToken: "worker-integration-token",
      agentWorkerResponseValidation: "strict",
      agentApiOrigin: `http://127.0.0.1:${apiPort}`,
      agentPluginHostEnabled: false,
      agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock")
    };
    app = await createApp(ctx);

    const workspaceId = newSortableId("ws");
    const workspaceDirName = newSortableId("workspace");
    const workspacePath = workspaceRoot(dataDir, workspaceDirName);
    await ensureDir(workspacePath);

    const ts = Date.now();
    insertWorkspace(db, {
      id: workspaceId,
      dirName: workspaceDirName,
      title: "worker-it-workspace",
      path: workspacePath,
      terminalCredentialId: null,
      createdAt: ts,
      updatedAt: ts
    });

    // 真实 API-managed Worker 的 internal request recorder，必须在 app.listen 前安装。
    const internalRpcCalls: Fixture["internalRpcCalls"] = [];
    const callsByRequest = new WeakMap<object, InternalRpcCall>();
    app.addHook("preHandler", async (request) => {
      if (!request.url.startsWith("/api/internal/agent/")) return;
      const call: InternalRpcCall = { method: request.method, url: request.url, body: request.body };
      internalRpcCalls.push(call);
      callsByRequest.set(request, call);
    });
    app.addHook("onSend", async (request, _reply, payload) => {
      const call = callsByRequest.get(request);
      if (!call || typeof payload !== "string") return payload;
      try {
        call.responseBody = JSON.parse(payload) as unknown;
      } catch {
        // The integration assertions only inspect JSON internal RPC responses.
      }
      return payload;
    });
    app.addHook("onResponse", async (request, reply) => {
      const call = callsByRequest.get(request);
      if (call) call.statusCode = reply.statusCode;
    });
    await app.listen({ host: "127.0.0.1", port: apiPort });
    const baseUrl = `http://127.0.0.1:${apiPort}`;
    await configureAgentDefaults(baseUrl, llmStub.baseURL);

    const fixture: Fixture = {
      app,
      db,
      ctx,
      dataDir,
      workspaceId,
      workspacePath,
      baseUrl,
      workerPidFilePath: agentWorkerPidPath(dataDir),
      llmStub,
      internalRpcCalls
    };
    fixtures.add(fixture);
    return fixture;
  } catch (err) {
    // Best-effort cleanup to avoid leaving worker process / server handles behind,
    // which may cause the test runner to hang.
    const errors: unknown[] = [];
    try {
      const stubToClose = llmStub;
      if (stubToClose) await new Promise<void>((resolve) => stubToClose.server.close(() => resolve()));
    } catch (cleanupErr) {
      errors.push(cleanupErr);
    }
    try {
      if (app) await app.close();
    } catch (cleanupErr) {
      errors.push(cleanupErr);
    }
    try {
      db?.close();
    } catch (cleanupErr) {
      errors.push(cleanupErr);
    }
    try {
      await rmrf(dataDir);
    } catch (cleanupErr) {
      errors.push(cleanupErr);
    }
    if (errors.length > 0) {
      // Keep the original error as the primary failure signal.
      // Attach cleanup issues for debugging without changing the thrown type.
      (err as any).cleanupErrors = errors;
    }
    throw err;
  }
}

async function closeFixture(fixture: Fixture) {
  fixtures.delete(fixture);
  if (fixture.llmStub) {
    await new Promise<void>((resolve) => fixture.llmStub?.server.close(() => resolve()));
  }
  await fixture.app.close();
  fixture.db.close();
  await rmrf(fixture.dataDir);
}

afterEach(async () => {
  for (const fixture of Array.from(fixtures)) {
    await closeFixture(fixture);
  }
});

async function createSession(baseUrl: string, workspaceId: string) {
  const res = await requestJson<{ id: string }>(baseUrl, {
    method: "POST",
    path: "/api/agent/sessions",
    body: { workspaceId, title: "worker-it-session" }
  });
  assert.equal(res.response.status, 201, `create session failed: ${res.text}`);
  return res.json;
}

async function sendMessage(baseUrl: string, params: { sessionId: string; workspaceId: string; text: string; clientRequestId: string }) {
  const res = await requestJson<{ messageId: string; runId: string }>(baseUrl, {
    method: "POST",
    path: `/api/agent/sessions/${params.sessionId}/messages`,
    body: {
      workspaceId: params.workspaceId,
      text: params.text,
      clientRequestId: params.clientRequestId
    }
  });
  assert.equal(res.response.status, 201, `send message failed: ${res.text}`);
  return res.json;
}

async function getRunState(baseUrl: string, sessionId: string, workspaceId: string) {
  const res = await requestJson<{ status: string }>(baseUrl, {
    method: "GET",
    path: `/api/agent/sessions/${sessionId}/run-state?workspaceId=${workspaceId}`
  });
  assert.equal(res.response.status, 200, `get run-state failed: ${res.text}`);
  return res.json;
}

async function waitRunIdle(baseUrl: string, sessionId: string, workspaceId: string, timeoutMs = 20_000) {
  await waitUntil(async () => {
    const state = await getRunState(baseUrl, sessionId, workspaceId);
    return state.status === "idle";
  }, timeoutMs);
}

function createRecoveryRun(fixture: Fixture, sessionId: string, runId: string) {
  const createdAt = Date.now();
  const triggerMessageId = newSortableId("msg");
  appendMessage(fixture.db, {
    id: triggerMessageId, workspaceId: fixture.workspaceId, sessionId,
    expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "recover this run" }],
    createdAt,
  });
  createMessageRunRecord(fixture.db, {
    runId, workspaceId: fixture.workspaceId, sessionId, triggerMessageId,
    agentId: "default", providerId: "ppchat", modelId: "gpt-5.2",
    subtaskDepth: null, parentRunId: null, parentToolExecutionId: null,
    status: "running", createdAt,
  });
  startMessageRun(fixture.db, { workspaceId: fixture.workspaceId, sessionId, runId, updatedAt: createdAt });
  return createdAt;
}

async function recoverFixtureRun(fixture: Fixture) {
  const runtime = new AgentWorkerClient({
    workerOrigin: `http://${fixture.ctx.agentWorkerHost}:${fixture.ctx.agentWorkerPort}`,
    workerSocketPath: fixture.ctx.agentWorkerSocketPath,
    internalToken: fixture.ctx.agentInternalToken,
    responseValidation: "strict",
    logger: fixture.app.log,
  });
  await createAgentService(fixture.ctx, fixture.app.log).recoverRunsOnStartup({ runtime });
}

function assertRecoveryNotice(fixture: Fixture, sessionId: string) {
  const state = getMessageRunState(fixture.db, fixture.workspaceId, sessionId);
  assert.equal(state?.runNoticeText, "任务正在自动恢复");
  assert.equal(state?.retryCount, 0);
  assert.equal(state?.nextRetryAt, null);
}

function assertRecoveredRunTerminal(fixture: Fixture, params: { sessionId: string; runId: string }) {
  assert.equal(getRunRecord(fixture.db, params.runId)?.status, "completed");
  const state = getMessageRunState(fixture.db, fixture.workspaceId, params.sessionId);
  assert.equal(state?.status, "idle");
  assert.equal(state?.activeRunId, null);
  assert.equal(state?.activeAssistantMessageId, null);
  assert.deepEqual(state?.nonTerminalMessageIds, []);
  assert.deepEqual(state?.nonTerminalToolExecutionIds, []);
  assert.equal(state?.runNoticeText, "");
  assert.equal(state?.retryCount, 0);
  assert.equal(state?.nextRetryAt, null);
}

function createCompletedAssistantWithExecution(fixture: Fixture, params: {
  sessionId: string; runId: string; createdAt: number; status: "queued" | "running";
}) {
  const assistantId = newSortableId("msg");
  const head = getMessageSession(fixture.db, fixture.workspaceId, params.sessionId)!;
  appendStreamingAssistant(fixture.db, {
    id: assistantId, workspaceId: fixture.workspaceId, sessionId: params.sessionId,
    expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
    runId: params.runId, createdAt: params.createdAt + 1,
  });
  const callPartId = newSortableId("part");
  const executionId = newSortableId("exec");
  assert.equal(flushStreamingParts(fixture.db, {
    workspaceId: fixture.workspaceId, sessionId: params.sessionId, runId: params.runId, messageId: assistantId,
    parts: [{ id: callPartId, position: 0, type: "tool_call", toolName: "bash", input: { command: "printf recovered-tool" }, providerToolCallId: "recovery-tool-call" }],
    updatedAt: params.createdAt + 2,
  }), "updated");
  assert.equal(completeAssistantWithExecutions(fixture.db, {
    workspaceId: fixture.workspaceId, sessionId: params.sessionId, runId: params.runId, messageId: assistantId,
    executions: [{ id: executionId, callPartId, originSessionId: params.sessionId, originRunId: params.runId, status: "queued" }],
    updatedAt: params.createdAt + 3,
  }), "updated");
  if (params.status === "running") {
    fixture.db.prepare("update agent_tool_execution set status='running', started_at=?, updated_at=? where id=?")
      .run(params.createdAt + 4, params.createdAt + 4, executionId);
  }
  return { assistantId, executionId };
}

test("startup recovery: 空 streaming Assistant 由真实 Worker 复用并完成", async () => {
  const fixture = await createFixture({ llmMode: "success" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = createRecoveryRun(fixture, session.id, runId);
  const head = getMessageSession(fixture.db, fixture.workspaceId, session.id)!;
  const assistantId = newSortableId("msg");
  appendStreamingAssistant(fixture.db, {
    id: assistantId, workspaceId: fixture.workspaceId, sessionId: session.id,
    expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
    runId, createdAt: createdAt + 1,
  });

  await recoverFixtureRun(fixture);
  assertRecoveryNotice(fixture, session.id);
  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);

  const assistants = fixture.db.prepare("select id, status from agent_message where origin_run_id=? and type='assistant' order by created_at").all(runId) as Array<{ id: string; status: string }>;
  assert.deepEqual(assistants, [{ id: assistantId, status: "completed" }]);
  assert.equal(fixture.internalRpcCalls.filter((call) => call.url === AgentApiEndpoints.resumeStreamingAssistant.path).length, 1);
  assert.equal(fixture.internalRpcCalls.filter((call) => call.url === AgentApiEndpoints.createStreamingAssistant.path).length, 0);
  assertRecoveredRunTerminal(fixture, { sessionId: session.id, runId });
});

test("startup recovery: manual_compaction 由真实 API-managed Worker 提交唯一 Compaction", async () => {
  const fixture = await createFixture({ llmMode: "success" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();
  const userMessageId = newSortableId("msg");
  appendMessage(fixture.db, {
    id: userMessageId, workspaceId: fixture.workspaceId, sessionId: session.id,
    expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "recover compact context" }], createdAt,
  });
  createMessageRunRecord(fixture.db, {
    runId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerMessageId: userMessageId,
    agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", runKind: "manual_compaction",
    subtaskDepth: null, parentRunId: null, parentToolExecutionId: null, status: "running", createdAt,
  });
  startMessageRun(fixture.db, { workspaceId: fixture.workspaceId, sessionId: session.id, runId, updatedAt: createdAt });

  await recoverFixtureRun(fixture);
  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);

  assert.equal(getRunRecord(fixture.db, runId)?.status, "completed");
  const compactions = fixture.db.prepare(`select id, origin_run_id as originRunId, previous_message_id as previousMessageId
    from agent_message where type = 'compaction' and origin_run_id = ?`).all(runId) as Array<{ id: string; originRunId: string; previousMessageId: string }>;
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0]!.originRunId, runId);
  assert.equal(compactions[0]!.previousMessageId, userMessageId);
  assert.equal((fixture.db.prepare("select count(*) as count from agent_message where type = 'assistant' and origin_run_id = ?").get(runId) as { count: number }).count, 0);
  const recoveredSession = getMessageSession(fixture.db, fixture.workspaceId, session.id)!;
  assert.equal(recoveredSession.headMessageId, compactions[0]!.id);
  assert.equal(recoveredSession.contextRootMessageId, compactions[0]!.id);
  const compactionCall = fixture.internalRpcCalls.find((call) => call.url === "/api/internal/agent/messages/compaction");
  assert.ok(compactionCall);
  const recoveryEnqueue = fixture.internalRpcCalls.find((call) => call.url === "/api/internal/agent/run/enqueue");
  if (recoveryEnqueue) assert.equal((recoveryEnqueue.body as { runKind?: string }).runKind, "manual_compaction");
});

test("startup recovery: partial streaming Assistant 仅替代一次，Worker 复用 replacement", async () => {
  const fixture = await createFixture({ llmMode: "success" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = createRecoveryRun(fixture, session.id, runId);
  const head = getMessageSession(fixture.db, fixture.workspaceId, session.id)!;
  const oldAssistantId = newSortableId("msg");
  appendStreamingAssistant(fixture.db, {
    id: oldAssistantId, workspaceId: fixture.workspaceId, sessionId: session.id,
    expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
    runId, createdAt: createdAt + 1,
  });
  assert.equal(flushStreamingParts(fixture.db, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId, messageId: oldAssistantId,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "partial" }], updatedAt: createdAt + 2,
  }), "updated");

  await recoverFixtureRun(fixture);
  await recoverFixtureRun(fixture);
  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);

  const assistants = fixture.db.prepare("select id, status, replaces_message_id as replacesMessageId from agent_message where origin_run_id=? and type='assistant' order by created_at").all(runId) as Array<{ id: string; status: string; replacesMessageId: string | null }>;
  assert.equal(assistants.length, 2);
  assert.deepEqual(assistants[0], { id: oldAssistantId, status: "superseded", replacesMessageId: null });
  assert.equal(assistants[1]?.status, "completed");
  assert.equal(assistants[1]?.replacesMessageId, oldAssistantId);
  const resumed = fixture.internalRpcCalls.filter((call) => call.url === AgentApiEndpoints.resumeStreamingAssistant.path);
  assert.equal(resumed.length, 1);
  assert.equal((resumed[0]?.body as { messageId?: string }).messageId, assistants[1]?.id);
  assert.equal(fixture.internalRpcCalls.filter((call) => call.url === AgentApiEndpoints.createStreamingAssistant.path).length, 0);
  assertRecoveredRunTerminal(fixture, { sessionId: session.id, runId });
});

test("startup recovery: running ToolExecution 转 unknown，不调用工具且模型接收 unknown 结果", async () => {
  const fixture = await createFixture({ llmMode: "success" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = createRecoveryRun(fixture, session.id, runId);
  const { executionId } = createCompletedAssistantWithExecution(fixture, { sessionId: session.id, runId, createdAt, status: "running" });

  await recoverFixtureRun(fixture);
  assertRecoveryNotice(fixture, session.id);
  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);

  const execution = fixture.db.prepare("select status from agent_tool_execution where id=?").get(executionId) as { status: string } | undefined;
  assert.equal(execution?.status, "unknown");
  assert.equal(fixture.llmStub?.requests.length, 1);
  assert.match(JSON.stringify(fixture.llmStub?.requests[0]), /unknown/i);
  assert.equal(fixture.internalRpcCalls.filter((call) => call.url === AgentApiEndpoints.updateToolExecution.path).length, 0);
  assertRecoveredRunTerminal(fixture, { sessionId: session.id, runId });
});

test("startup recovery: queued ToolExecution 原 ID 只执行一次，重复 recovery/enqueue 不重复", async () => {
  const fixture = await createFixture({ llmMode: "success" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = createRecoveryRun(fixture, session.id, runId);
  const { executionId } = createCompletedAssistantWithExecution(fixture, { sessionId: session.id, runId, createdAt, status: "queued" });

  await recoverFixtureRun(fixture);
  await recoverFixtureRun(fixture);
  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);

  const execution = fixture.db.prepare("select id, status, result_preview as resultPreview from agent_tool_execution where id=?").get(executionId) as { id: string; status: string; resultPreview: string | null } | undefined;
  assert.deepEqual(execution && { id: execution.id, status: execution.status }, { id: executionId, status: "completed" });
  assert.match(execution?.resultPreview ?? "", /recovered-tool/);
  const toolUpdates = fixture.internalRpcCalls.filter((call) => call.url === AgentApiEndpoints.updateToolExecution.path && (call.body as { toolExecutionId?: string }).toolExecutionId === executionId);
  assert.equal(toolUpdates.filter((call) => (call.body as { status?: string }).status === "running").length, 1);
  assert.equal(toolUpdates.filter((call) => (call.body as { status?: string }).status === "completed").length, 1);
  assert.equal(fixture.llmStub?.requests.length, 1);
  assertRecoveredRunTerminal(fixture, { sessionId: session.id, runId });
});

test("worker 模式: 模型错误写入 retry notice，用户取消后通过新写回端点收敛 Run", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);

  await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hello worker",
    clientRequestId: newSortableId("req")
  });

  await waitUntil(async () => {
    const state = await getRunState(fixture.baseUrl, session.id, fixture.workspaceId) as { retryCount?: number; runNoticeText?: string };
    return (state.retryCount ?? 0) > 0 && String(state.runNoticeText ?? "").includes("Request failed, retrying");
  }, 10_000);
  const cancel = await requestJson(fixture.baseUrl, {
    method: "POST",
    path: `/api/agent/sessions/${session.id}/cancel`,
    body: { workspaceId: fixture.workspaceId }
  });
  assert.equal(cancel.response.status, 200, cancel.text);
  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);

  const messages = fixture.db.prepare(`
    select type, status
    from agent_message
    where workspace_id = ? and origin_session_id = ?
    order by depth asc
  `).all(fixture.workspaceId, session.id) as Array<{ type: string; status: string }>;
  assert.ok(messages.some((message) => message.type === "user" && message.status === "completed"));
  assert.ok(messages.some((message) => message.type === "assistant" && message.status === "cancelled"));

  const internalCalls = fixture.internalRpcCalls;
  const callIndex = (predicate: (call: Fixture["internalRpcCalls"][number]) => boolean) => {
    const index = internalCalls.findIndex(predicate);
    assert.notEqual(index, -1, "real API-managed Worker internal request was not recorded");
    return index;
  };
  const assistantCreateIndex = callIndex((call) => call.method === "POST" && call.url === "/api/internal/agent/messages/assistant");
  const retryNoticeIndex = callIndex((call) => call.method === "POST" && call.url === "/api/internal/agent/run-notice" && String((call.body as { runNoticeText?: unknown }).runNoticeText ?? "").includes("Request failed, retrying"));
  assert.ok(assistantCreateIndex < retryNoticeIndex, "assistant creation should precede retry notice");

  const assistantCreateBody = internalCalls[assistantCreateIndex]?.body as { workspaceId?: unknown; sessionId?: unknown; runId?: unknown; messageId?: unknown };
  const retryNoticeBody = internalCalls[retryNoticeIndex]?.body as { workspaceId?: unknown; sessionId?: unknown; runId?: unknown; retryCount?: unknown; nextRetryAt?: unknown };
  for (const [name, body] of [["assistant create", assistantCreateBody], ["retry notice", retryNoticeBody]] as const) {
    assert.equal(body.workspaceId, fixture.workspaceId, `${name} should carry workspaceId`);
    assert.equal(body.sessionId, session.id, `${name} should carry sessionId`);
  }
  assert.equal(typeof assistantCreateBody.messageId, "string");
  assert.equal(typeof assistantCreateBody.runId, "string");
  assert.equal(retryNoticeBody.retryCount, 1);
  assert.equal(typeof retryNoticeBody.nextRetryAt, "number");
});

test("worker 内部 replacement 端点要求令牌，并原子替代当前 streaming Assistant", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const runId = "replacement-run";
  fixture.db.prepare("insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values (?,?,?,null,'agent','provider','model','running',1,1)").run(runId, fixture.workspaceId, session.id);
  fixture.db.prepare("update session_run_state set status='running',active_run_id=? where workspace_id=? and session_id=?").run(runId, fixture.workspaceId, session.id);
  fixture.db.prepare("insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at) values ('old',?,?,null,0,'assistant','streaming',?,?,1,1,1)").run(fixture.workspaceId, null, session.id, runId);
  fixture.db.prepare("update agent_session set head_message_id='old',revision=1 where id=? and workspace_id=?").run(session.id, fixture.workspaceId);
  fixture.db.prepare("update session_run_state set active_assistant_message_id='old',non_terminal_message_ids_json='[\"old\"]' where workspace_id=? and session_id=?").run(fixture.workspaceId, session.id);
  const payload = { workspaceId: fixture.workspaceId, sessionId: session.id, runId, oldMessageId: "old", newMessageId: "new", runNoticeText: "retrying", retryCount: 1, nextRetryAt: 100, createdAt: 2 };

  const unauthorized = await fixture.app.inject({ method: AgentApiEndpoints.replaceStreamingAssistant.method, url: AgentApiEndpoints.replaceStreamingAssistant.path, payload });
  assert.equal(unauthorized.statusCode, 401);
  const authorized = await fixture.app.inject({ method: AgentApiEndpoints.replaceStreamingAssistant.method, url: AgentApiEndpoints.replaceStreamingAssistant.path, headers: { "x-awb-agent-internal-token": "worker-integration-token" }, payload });
  assert.equal(authorized.statusCode, 200);
  const body = JSON.parse(authorized.body) as { result: string; message: { id: string; replacesMessageId: string | null; previousMessageId: string | null; status: string } };
  assert.equal(body.result, "updated");
  assert.deepEqual({ id: body.message.id, previousMessageId: body.message.previousMessageId, replacesMessageId: body.message.replacesMessageId, status: body.message.status }, { id: "new", previousMessageId: null, replacesMessageId: "old", status: "streaming" });
  assert.deepEqual(fixture.db.prepare("select id,status,replaces_message_id as replacesMessageId from agent_message where id in ('old','new') order by id").all(), [{ id: "new", status: "streaming", replacesMessageId: "old" }, { id: "old", status: "superseded", replacesMessageId: null }]);
  assert.deepEqual(fixture.db.prepare("select head_message_id as headMessageId,revision from agent_session where id=?").get(session.id), { headMessageId: "new", revision: 2 });
  assert.deepEqual(fixture.db.prepare("select active_assistant_message_id as activeAssistantMessageId,non_terminal_message_ids_json as nonTerminalMessageIds,run_notice_text as runNoticeText,retry_count as retryCount,next_retry_at as nextRetryAt from session_run_state where workspace_id=? and session_id=?").get(fixture.workspaceId, session.id), { activeAssistantMessageId: "new", nonTerminalMessageIds: "[\"new\"]", runNoticeText: "retrying", retryCount: 1, nextRetryAt: 100 });
  // 第一次真实 replacement 已提交而客户端丢失响应后，第二次同 payload 仍得到同一 replacement。
  const replayed = await fixture.app.inject({ method: AgentApiEndpoints.replaceStreamingAssistant.method, url: AgentApiEndpoints.replaceStreamingAssistant.path, headers: { "x-awb-agent-internal-token": "worker-integration-token" }, payload });
  assert.deepEqual(JSON.parse(replayed.body), body);
  const changed = await fixture.app.inject({ method: AgentApiEndpoints.replaceStreamingAssistant.method, url: AgentApiEndpoints.replaceStreamingAssistant.path, headers: { "x-awb-agent-internal-token": "worker-integration-token" }, payload: { ...payload, retryCount: 2 } });
  assert.deepEqual(JSON.parse(changed.body), { result: "ignored", message: null });
});

test("Worker API 通用 ToolExecution writeback 按真实 DB 工具白名单持久化 structuredResult", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const headers = { "x-awb-agent-internal-token": "worker-integration-token" };
  const invoke = async (endpoint: { method: any; path: string }, payload: any) =>
    await fixture.app.inject({ method: endpoint.method, url: endpoint.path, headers, payload });

  for (const [index, testCase] of ([
    { toolName: "apply_patch", allowed: true },
    { toolName: "todolist", allowed: true },
    { toolName: "subtask", allowed: true },
    { toolName: "write", allowed: true },
    { toolName: "scratchpad", allowed: true },
    { toolName: "read", allowed: false },
    { toolName: "bash", allowed: false },
    { toolName: "plugin_fixture", allowed: false },
  ] as const).entries()) {
    const runId = `structured-run-${index}`;
    const messageId = `structured-assistant-${index}`;
    const callPartId = `structured-call-${index}`;
    const executionId = `structured-execution-${index}`;
    fixture.db.prepare("insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values (?,?,?,null,'agent','provider','model','running',?,?)")
      .run(runId, fixture.workspaceId, session.id, index + 1, index + 1);
    fixture.db.prepare("update session_run_state set status='running',active_run_id=? where workspace_id=? and session_id=?")
      .run(runId, fixture.workspaceId, session.id);
    assert.equal((await invoke(AgentApiEndpoints.createStreamingAssistant, {
      workspaceId: fixture.workspaceId, sessionId: session.id, runId, messageId, createdAt: index + 10,
    })).statusCode, 200);
    assert.equal((await invoke(AgentApiEndpoints.flushAssistantParts, {
      workspaceId: fixture.workspaceId, sessionId: session.id, runId, messageId, updatedAt: index + 20,
      parts: [{ id: callPartId, position: 0, type: "tool_call", toolName: testCase.toolName, input: {}, providerToolCallId: `call-${index}` }],
    })).statusCode, 200);
    assert.equal((await invoke(AgentApiEndpoints.completeAssistant, {
      workspaceId: fixture.workspaceId, sessionId: session.id, runId, messageId, updatedAt: index + 30,
      executions: [{ id: executionId, callPartId, originSessionId: session.id, originRunId: runId, status: "queued" }],
    })).statusCode, 200);
    assert.equal((await invoke(AgentApiEndpoints.updateToolExecution, {
      workspaceId: fixture.workspaceId, sessionId: session.id, runId, toolExecutionId: executionId,
      status: "running", startedAt: index + 40, updatedAt: index + 40,
    })).statusCode, 200);
    const structuredResult = { toolName: testCase.toolName, marker: true };
    assert.equal((await invoke(AgentApiEndpoints.updateToolExecution, {
      workspaceId: fixture.workspaceId, sessionId: session.id, runId, toolExecutionId: executionId,
      status: "completed", resultPreview: `preview ${testCase.toolName}`, resultTruncated: false,
      resultArtifactPath: null, structuredResult, error: null, startedAt: index + 40,
      completedAt: index + 50, updatedAt: index + 50,
    })).statusCode, 200);
    const execution = fixture.db.prepare("select result_preview as resultPreview, structured_result_json as structuredResultJson from agent_tool_execution where id=?")
      .get(executionId) as { resultPreview: string | null; structuredResultJson: string | null };
    assert.equal(execution.resultPreview, `preview ${testCase.toolName}`);
    assert.deepEqual(
      execution.structuredResultJson === null ? null : JSON.parse(execution.structuredResultJson),
      testCase.allowed ? structuredResult : null,
    );
  }
});

test("Worker 写回路由对丢失响应后的 complete 与 ToolExecution 精确重放保持幂等", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const runId = "replay-run";
  fixture.db.prepare("insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values (?,?,?,null,'agent','provider','model','running',1,1)").run(runId, fixture.workspaceId, session.id);
  fixture.db.prepare("update session_run_state set status='running',active_run_id=? where workspace_id=? and session_id=?").run(runId, fixture.workspaceId, session.id);
  const headers = { "x-awb-agent-internal-token": "worker-integration-token" };
  const invoke = async (endpoint: { method: any; path: string }, payload: any): Promise<any> =>
    await fixture.app.inject({ method: endpoint.method, url: endpoint.path, headers, payload });

  const create = { workspaceId: fixture.workspaceId, sessionId: session.id, runId, messageId: "assistant", createdAt: 2 };
  assert.equal((await invoke(AgentApiEndpoints.createStreamingAssistant, create)).statusCode, 200);
  const revisionAfterCreate = getMessageSession(fixture.db, fixture.workspaceId, session.id)?.revision;
  // 首次请求已提交但响应丢失时，composition 必须先识别 messageId
  // replay，不能基于已移动的 head 重新计算 CAS。
  const replayCreate = await invoke(AgentApiEndpoints.createStreamingAssistant, create);
  assert.equal(replayCreate.statusCode, 200);
  assert.equal(getMessageSession(fixture.db, fixture.workspaceId, session.id)?.revision, revisionAfterCreate);
  const changedCreate = await invoke(AgentApiEndpoints.createStreamingAssistant, {
    ...create,
    createdAt: 3,
  });
  assert.equal(changedCreate.statusCode, 409);
  assert.deepEqual(changedCreate.json(), {
    message: "streaming assistant replay does not match existing message",
    code: "AGENT_STREAMING_ASSISTANT_REPLAY_MISMATCH",
  });
  assert.equal(getMessageSession(fixture.db, fixture.workspaceId, session.id)?.revision, revisionAfterCreate);
  const flush = {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId, messageId: "assistant", updatedAt: 3,
    parts: [{ id: "call", position: 0, type: "tool_call", toolName: "read", input: { filePath: "README.md" }, providerToolCallId: "call-1" }]
  };
  assert.equal((await invoke(AgentApiEndpoints.flushAssistantParts, flush)).statusCode, 200);
  const complete = {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId, messageId: "assistant", updatedAt: 4,
    executions: [{ id: "execution", callPartId: "call", originSessionId: session.id, originRunId: runId, status: "queued" }]
  };
  // 第一次真实路由写入成功，但模拟客户端在读取响应前丢失该响应；随后以同一 payload 重放。
  const firstComplete = await invoke(AgentApiEndpoints.completeAssistant, complete);
  assert.equal(firstComplete.statusCode, 200);
  const replayComplete = await invoke(AgentApiEndpoints.completeAssistant, complete);
  assert.deepEqual(JSON.parse(replayComplete.body), { result: "updated" });
  const changedComplete = await invoke(AgentApiEndpoints.completeAssistant, { ...complete, updatedAt: 5 });
  assert.deepEqual(JSON.parse(changedComplete.body), { result: "ignored" });

  const running = { workspaceId: fixture.workspaceId, sessionId: session.id, runId, toolExecutionId: "execution", status: "running", startedAt: 5, updatedAt: 5 };
  assert.deepEqual(JSON.parse((await invoke(AgentApiEndpoints.updateToolExecution, running)).body), { result: "updated" });
  const terminal = {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId, toolExecutionId: "execution", status: "completed",
    resultPreview: "done", resultTruncated: false, resultArtifactPath: null, structuredResult: { ok: true }, error: null,
    startedAt: 5, completedAt: 6, updatedAt: 6
  };
  const firstTerminal = await invoke(AgentApiEndpoints.updateToolExecution, terminal);
  assert.equal(firstTerminal.statusCode, 200);
  const replayTerminal = await invoke(AgentApiEndpoints.updateToolExecution, terminal);
  assert.deepEqual(JSON.parse(replayTerminal.body), { result: "updated" });
  const changedTerminal = await invoke(AgentApiEndpoints.updateToolExecution, { ...terminal, resultPreview: "late" });
  assert.deepEqual(JSON.parse(changedTerminal.body), { result: "ignored" });
  const execution = fixture.db.prepare("select structured_result_json as structuredResultJson from agent_tool_execution where id='execution'").get() as { structuredResultJson: string | null };
  assert.equal(execution.structuredResultJson, null, "非白名单 read 工具不得持久化结构化结果");
});

test("worker 模式: ToolCall 经真实 PromptContext pending 与工具写回后进入第二轮模型", async () => {
  const fixture = await createFixture({ llmMode: "tool-cycle" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const sent = await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "run the deterministic tool cycle",
    clientRequestId: newSortableId("req")
  });

  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);

  const run = getRunRecord(fixture.db, sent.runId);
  assert.equal(run?.status, "completed");
  const assistant = fixture.db.prepare(`
    select id, status
    from agent_message
    where workspace_id = ? and origin_session_id = ? and origin_run_id = ? and type = 'assistant'
    order by depth asc
  `).all(fixture.workspaceId, session.id, sent.runId) as Array<{ id: string; status: string }>;
  assert.equal(assistant.length, 2);
  assert.deepEqual(assistant.map((message) => message.status), ["completed", "completed"]);

  const firstAssistantParts = fixture.db.prepare(`
    select id, position, type, text, tool_name as toolName, tool_input_json as toolInputJson, provider_tool_call_id as providerToolCallId
    from agent_message_part
    where message_id = ?
    order by position asc
  `).all(assistant[0]!.id) as Array<{ id: string; position: number; type: string; text: string | null; toolName: string | null; toolInputJson: string | null; providerToolCallId: string | null }>;
  const toolCall = firstAssistantParts.find((part) => part.type === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall.providerToolCallId, "stub-tool-call-1");
  assert.equal(toolCall.toolName, "bash");
  assert.deepEqual(JSON.parse(toolCall.toolInputJson ?? "null"), { command: "printf tool-cycle-output" });
  assert.equal(firstAssistantParts.some((part) => part.type === "reasoning"), false, "OpenAI stub reasoning extension must not become model-visible history");

  const execution = fixture.db.prepare(`
    select id, call_part_id as callPartId, status, result_preview as resultPreview
    from agent_tool_execution
    where call_part_id = ?
  `).get(toolCall.id) as { id: string; callPartId: string; status: string; resultPreview: string | null } | undefined;
  assert.ok(execution);
  assert.equal(execution.status, "completed");
  assert.equal(execution.callPartId, toolCall.id);
  assert.match(execution.resultPreview ?? "", /tool-cycle-output/);

  const pendingContextIndex = fixture.internalRpcCalls.findIndex((call) => {
    if (call.method !== "POST" || call.url !== "/api/internal/agent/prompt-context") return false;
    const body = call.body as { runId?: string };
    const response = call.responseBody as { pendingTools?: unknown[]; messages?: Array<{ role?: string }> } | undefined;
    return body.runId === sent.runId && call.statusCode === 200 && (response?.pendingTools?.length ?? 0) === 1;
  });
  assert.notEqual(pendingContextIndex, -1);
  const pendingContextCall = fixture.internalRpcCalls[pendingContextIndex]!;
  const pendingContextResponse = pendingContextCall.responseBody as {
    pendingTools: Array<{ toolExecutionId: string; callPartId: string; assistantMessageId: string; status: string; toolCallId: string }>;
    messages: Array<{ role: string }>;
  };
  assert.deepEqual(pendingContextResponse.pendingTools, [{
    toolExecutionId: execution.id,
    callPartId: toolCall.id,
    assistantMessageId: assistant[0]!.id,
    status: "queued",
    toolCallId: "stub-tool-call-1",
    toolName: "bash",
    args: { command: "printf tool-cycle-output" }
  }]);
  assert.equal(pendingContextResponse.messages.some((message) => message.role === "assistant" || message.role === "tool"), false);
  const pendingUpdateIndex = fixture.internalRpcCalls.findIndex((call, index) => index > pendingContextIndex && call.url === "/api/internal/agent/tool-executions/update");
  const completedContextIndex = fixture.internalRpcCalls.findIndex((call, index) => {
    if (index <= pendingUpdateIndex || call.url !== "/api/internal/agent/prompt-context") return false;
    const response = call.responseBody as { pendingTools?: unknown[]; messages?: Array<{ role?: string; content?: unknown }> } | undefined;
    return (response?.pendingTools?.length ?? -1) === 0 && response?.messages?.some((message) => message.role === "tool");
  });
  assert.ok(pendingUpdateIndex > pendingContextIndex, "pending PromptContext must precede ToolExecution writeback");
  assert.ok(completedContextIndex > pendingUpdateIndex, "terminal writeback must precede the next PromptContext");

  const pendingContext = pendingContextCall.body as { workspaceId?: string; sessionId?: string; runId?: string };
  assert.deepEqual(pendingContext, { workspaceId: fixture.workspaceId, sessionId: session.id, runId: sent.runId });
  const updateBodies = fixture.internalRpcCalls
    .slice(pendingContextIndex + 1, completedContextIndex)
    .filter((call) => call.url === "/api/internal/agent/tool-executions/update")
    .map((call) => call.body as { toolExecutionId?: string; status?: string });
  assert.deepEqual(updateBodies.map((body) => ({ toolExecutionId: body.toolExecutionId, status: body.status })), [
    { toolExecutionId: execution.id, status: "running" },
    { toolExecutionId: execution.id, status: "completed" }
  ]);

  const completedContextResponse = fixture.internalRpcCalls[completedContextIndex]!.responseBody as { messages: Array<{ role: string; content: unknown }> };
  assert.deepEqual(completedContextResponse.messages.slice(-2), [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "stub-tool-call-1", toolName: "bash", input: { command: "printf tool-cycle-output" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "stub-tool-call-1", toolName: "bash", output: { type: "text", value: execution.resultPreview } }] }
  ]);

  const modelRequests = fixture.llmStub?.requests ?? [];
  assert.equal(modelRequests.length, 2);
  const secondMessages = modelRequests[1]?.messages as Array<{ role?: string; content?: unknown }>;
  assert.ok(Array.isArray(secondMessages));
  assert.equal(JSON.stringify(secondMessages).includes("private M3 reasoning"), false);
});

test("worker 模式: 手动压缩经真实 API-managed Worker 获取三项 read-side context", async () => {
  const fixture = await createFixture({ llmMode: "success" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);

  await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "seed context for compaction",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);
  fixture.internalRpcCalls.length = 0;

  const compact = await requestJson<{ runId: string }>(fixture.baseUrl, {
    method: "POST",
    path: `/api/agent/sessions/${session.id}/compact`,
    body: {
      workspaceId: fixture.workspaceId,
      clientRequestId: newSortableId("compact")
    }
  });
  assert.equal(compact.response.status, 201, `compact session failed: ${compact.text}`);
  assert.equal(typeof compact.json.runId, "string");
  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);

  const expected = [
    { endpoint: "/api/internal/agent/execution-profile", runBound: true },
    { endpoint: "/api/internal/agent/prompt-context", runBound: true }
  ] as const;
  const indices = expected.map(({ endpoint }) => {
    const index = fixture.internalRpcCalls.findIndex((call) => call.method === "POST" && call.url === endpoint);
    assert.notEqual(index, -1, `real API-managed Worker did not request ${endpoint}`);
    return index;
  });
  assert.ok(indices[0]! < indices[1]!, "execution profile must precede prompt context");

  for (const [index, requirement] of expected.entries()) {
    const call = fixture.internalRpcCalls[indices[index]!]!;
    const body = call.body as { workspaceId?: unknown; sessionId?: unknown; runId?: unknown };
    assert.ok((call.statusCode || 0) >= 200 && (call.statusCode || 0) < 300, `${requirement.endpoint} must return 2xx`);
    assert.equal(body.workspaceId, fixture.workspaceId, `${requirement.endpoint} must carry workspaceId`);
    assert.equal(body.sessionId, session.id, `${requirement.endpoint} must carry sessionId`);
    assert.equal(body.runId, compact.json.runId, `${requirement.endpoint} must carry compact runId`);
  }

  const completedRun = getRunRecord(fixture.db, compact.json.runId);
  assert.equal(completedRun?.status, "completed", "Worker must complete the compact run after consuming read-side responses");
  const compactWrite = fixture.internalRpcCalls.find((call) =>
    call.method === "POST" && call.url === "/api/internal/agent/messages/compaction"
  );
  assert.ok(compactWrite, "Worker must submit the generated compaction summary after reading context");
  assert.ok((compactWrite?.statusCode || 0) >= 200 && (compactWrite?.statusCode || 0) < 300, "compaction write must return 2xx");

  const summary = fixture.db.prepare(`
    select message.id, message.previous_message_id as previousMessageId,
           part.text, session.head_message_id as headMessageId,
           session.context_root_message_id as contextRootMessageId
    from agent_message message
    join agent_message_part part on part.message_id = message.id and part.position = 0
    join agent_session session on session.id = ?
    where message.workspace_id = ? and message.type = 'compaction' and message.status = 'completed'
    order by message.created_at desc
    limit 1
  `).get(session.id, fixture.workspaceId) as {
    id: string; previousMessageId: string | null; text: string;
    headMessageId: string | null; contextRootMessageId: string | null;
  } | undefined;
  assert.ok(summary, "successful compaction must persist a completed compaction Message");
  assert.equal(summary?.headMessageId, summary?.id, "compaction must advance the session head");
  assert.equal(summary?.contextRootMessageId, summary?.id, "compaction must advance the context root boundary");
  assert.equal(typeof summary?.text, "string");
  assert.ok(summary!.text.length > 0);
});

test("Worker Compaction internal route 对 response-loss 重放精确请求并拒绝差异请求", async () => {
  const fixture = await createFixture({ llmMode: "success" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();
  const userMessageId = newSortableId("msg");
  appendMessage(fixture.db, {
    id: userMessageId, workspaceId: fixture.workspaceId, sessionId: session.id,
    expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "replay context" }], createdAt,
  });
  createMessageRunRecord(fixture.db, {
    runId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerMessageId: userMessageId,
    agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", runKind: "manual_compaction",
    subtaskDepth: null, parentRunId: null, parentToolExecutionId: null, status: "running", createdAt,
  });
  startMessageRun(fixture.db, { workspaceId: fixture.workspaceId, sessionId: session.id, runId, updatedAt: createdAt });
  const request = {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId,
    messageId: newSortableId("msg"), textPartId: newSortableId("part"),
    expectedHeadMessageId: userMessageId, expectedRevision: 1, summaryText: "exact summary", createdAt: createdAt + 1,
  };
  const internal = { "x-awb-agent-internal-token": fixture.ctx.agentInternalToken };
  const first = await requestJson<{ result: string; summaryMessageId: string | null }>(fixture.baseUrl, { method: "POST", path: AgentApiEndpoints.commitCompaction.path, body: request, headers: internal });
  const replay = await requestJson<{ result: string; summaryMessageId: string | null }>(fixture.baseUrl, { method: "POST", path: AgentApiEndpoints.commitCompaction.path, body: request, headers: internal });
  const different = await requestJson<{ result: string; summaryMessageId: string | null }>(fixture.baseUrl, { method: "POST", path: AgentApiEndpoints.commitCompaction.path, body: { ...request, summaryText: "different" }, headers: internal });
  assert.equal(first.response.status, 200);
  assert.deepEqual(replay.json, first.json);
  assert.deepEqual(different.json, { result: "ignored", summaryMessageId: null });
  assert.equal((fixture.db.prepare("select count(*) as count from agent_message where type = 'compaction'").get() as { count: number }).count, 1);
});

test("worker 模式: worker pid 文件会被写入", async () => {
  const fixture = await createFixture();
  await waitUntil(async () => {
    return fs
      .stat(fixture.workerPidFilePath)
      .then(() => true)
      .catch(() => false);
  }, 6_000);
});
