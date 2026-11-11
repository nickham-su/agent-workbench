import { Readable } from "node:stream";
import { createAgentComposition } from "./agent.composition.js";
import { stageAgentImageUpload } from "./attachments/agent-attachment-storage.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty } from "node-pty";
import { createServer } from "node:net";
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { afterEach, test, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../app/createApp.js";
import type { AppContext } from "../../app/context.js";
import { openDb } from "../../infra/db/db.js";
import type { Db } from "../../infra/db/db.js";
import { AUTH_COOKIE_NAME, AUTH_REMEMBER_TTL_MS, createSessionCookieValue } from "../../infra/auth/sessionCookie.js";
import { ensureDir, rmrf } from "../../infra/fs/fs.js";
import { agentWorkerPidPath, workspaceRoot } from "../../infra/fs/paths.js";
import { newSortableId } from "../../utils/ids.js";
import { insertWorkspace } from "../workspaces/workspace.store.js";
import { AgentInteractiveInputService } from "./message-queue/interactive-input.service.js";
import { createMessageRunRecord, getRunRecord } from "./agent-message.store.js";
import { createAgentService } from "./agent.composition.js";
import { AgentWorkerClient } from "./agent.worker-client.js";
import { AgentRuntimeControlService } from "./runtime-control/runtime-control.service.js";
import { AgentRuntimeControlStore } from "./runtime-control/runtime-control.store.js";
import { RunLifecycleApplication } from "./lifecycle/run-lifecycle-application.js";
import { RunPromptStaticCacheInvalidator } from "./prompt/run-prompt-static-cache.js";
import { AgentRunCompletedEventHub, type AgentRunCompletedEvent } from "./run-completed-events.js";
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
import { readScheduledExecution } from "../scheduled-tasks/scheduled-task.store.js";

type InternalRpcCall = { method: string; url: string; body: unknown; responseBody?: unknown; statusCode?: number };
type LlmStub = {
  server: HttpServer;
  baseURL: string;
  requests: Array<Record<string, unknown>>;
  requestHeaders: Array<Record<string, string | string[] | undefined>>;
  requestPaths: string[];
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
  internalRpcGate: { before?: (call: InternalRpcCall) => Promise<void | "drop">; after?: (call: InternalRpcCall, payload: string) => Promise<string | undefined> };
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

type StubToolCall = { name: "bash" | "read"; args: Record<string, string> };

async function startLlmStubServer(mode: "failure" | "success" | "tool-cycle" = "failure", toolCommand = "printf tool-cycle-output", toolCount = 1, toolCalls?: StubToolCall[]) {
  const requests: Array<Record<string, unknown>> = [];
  const requestHeaders: Array<Record<string, string | string[] | undefined>> = [];
  const requestPaths: string[] = [];
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
        requestHeaders.push({ ...req.headers });
        requestPaths.push(req.url || "");
        const isChatCompletions = req.url === "/v1/chat/completions";
        if (request.stream === true) {
          if (isChatCompletions) {
            const chunks = [
              { id: "stub", created: 1, model: "gpt-5.2", choices: [{ index: 0, delta: { role: "assistant", content: "stub response" }, finish_reason: null }] },
              { id: "stub", created: 1, model: "gpt-5.2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
            ];
            res.statusCode = 200;
            res.setHeader("content-type", "text/event-stream; charset=utf-8");
            res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
            return;
          }
          const chunks: Array<{ type: string; item?: { type: string; [key: string]: unknown }; [key: string]: unknown }> = mode === "tool-cycle" && toolCycleStreamRequestCount++ === 0
            ? [
                {
                  type: "response.created",
                  response: { id: "stub-tool-cycle-1", created_at: 1, model: "gpt-5.2" }
                },
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: {
                    type: "reasoning",
                    id: "stub-reasoning-item-1",
                    encrypted_content: null
                  }
                },
                {
                  type: "response.reasoning_summary_text.delta",
                  item_id: "stub-reasoning-item-1",
                  summary_index: 0,
                  delta: "inspect with bash"
                },
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: {
                    type: "reasoning",
                    id: "stub-reasoning-item-1",
                    encrypted_content: null
                  }
                },
                {
                  type: "response.output_item.added",
                  output_index: 1,
                  item: {
                    type: "function_call",
                    id: "stub-function-item-1",
                    call_id: "stub-tool-call-1",
                    name: "bash",
                    arguments: ""
                  }
                },
                {
                  type: "response.function_call_arguments.delta",
                  item_id: "stub-function-item-1",
                  output_index: 1,
                  delta: JSON.stringify({ command: toolCommand })
                },
                {
                  type: "response.output_item.done",
                  output_index: 1,
                  item: {
                    type: "function_call",
                    id: "stub-function-item-1",
                    call_id: "stub-tool-call-1",
                    name: "bash",
                    arguments: JSON.stringify({ command: toolCommand }),
                    status: "completed"
                  }
                },
                {
                  type: "response.completed",
                  response: {
                    output: [{
                      type: "reasoning",
                      id: "stub-reasoning-item-1",
                      encrypted_content: "stub-encrypted-reasoning"
                    }],
                    usage: { input_tokens: 1, output_tokens: 1 },
                    service_tier: null
                  }
                }
              ]
            : [
                { type: "response.created", response: { id: "stub", created_at: 1, model: "gpt-5.2" } },
                { type: "response.output_item.added", output_index: 0, item: { type: "message", id: `stub-message-${requests.length}`, phase: "final_answer" } },
                { type: "response.output_text.delta", item_id: `stub-message-${requests.length}`, delta: mode === "tool-cycle" ? "tool cycle complete" : "stub response" },
                { type: "response.output_item.done", output_index: 0, item: { type: "message", id: `stub-message-${requests.length}`, phase: "final_answer" } },
                { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 }, service_tier: null } }
              ];
          res.statusCode = 200;
          res.setHeader("content-type", "text/event-stream; charset=utf-8");
          if (toolCount > 1 && chunks.some(chunk => "item" in chunk && chunk.item?.type === "function_call")) {
            const callChunks = chunks.filter(chunk => ("item" in chunk && chunk.item?.type === "function_call") || chunk.type === "response.function_call_arguments.delta");
            const terminal = chunks.pop()!;
            for (let index = 2; index <= toolCount; index++) for (const chunk of callChunks) chunks.push(JSON.parse(JSON.stringify(chunk)
              .replaceAll("stub-function-item-1", `stub-function-item-${index}`).replaceAll("stub-tool-call-1", `stub-tool-call-${index}`)
              .replaceAll('"output_index":1', `"output_index":${index}`)));
            chunks.push(terminal);
          }
          for (const [index, tool] of (toolCalls ?? []).entries()) {
            const itemId = `stub-function-item-${index + 1}`;
            for (const chunk of chunks) {
              if (chunk.item?.type === "function_call" && chunk.item.id === itemId) {
                chunk.item.name = tool.name;
                if (chunk.type === "response.output_item.done") chunk.item.arguments = JSON.stringify(tool.args);
              }
              if (chunk.type === "response.function_call_arguments.delta" && chunk.item_id === itemId) {
                chunk.delta = JSON.stringify(tool.args);
              }
            }
          }
          res.end(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""));
          return;
        }
        res.statusCode = 200;
        if (isChatCompletions) {
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({
            id: "stub",
            object: "chat.completion",
            created: 1,
            model: "gpt-5.2",
            choices: [{ index: 0, message: { role: "assistant", content: "stub summary" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }));
          return;
        }
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({
          id: "stub",
          created_at: 1,
          model: "gpt-5.2",
          output: [{
            type: "message",
            role: "assistant",
            id: "stub-summary-message",
            phase: "final_answer",
            content: [{ type: "output_text", text: "stub summary", annotations: [] }]
          }],
          usage: { input_tokens: 1, output_tokens: 1 }
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
    requests,
    requestHeaders,
    requestPaths
  };
}

async function configureAgentDefaults(
  baseUrl: string,
  llmBaseURL: string,
  providerNpm = "@ai-sdk/openai",
  modelOptions?: Record<string, unknown>,
  modelRequestMaxRetries = 0,
  headers?: Record<string, string>,
) {
  const providers = await requestJson(baseUrl, {
    method: "PUT",
    path: "/api/settings/agent/providers",
    headers,
    body: {
      default: {
        providerId: "ppchat",
        modelId: "gpt-5.2"
      },
      providers: [
         {
            id: "ppchat",
            name: "ppchat",
            npm: providerNpm,
           options: {
             baseURL: llmBaseURL,
             apiKey: "sk-test"
           },
           models: [
            {
              id: "gpt-5.2",
              name: "gpt-5.2",
              contextWindowTokens: 128000,
              ...(modelOptions ? { options: modelOptions } : {}),
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
    headers,
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
    headers,
    body: {
      // worker integration test should not depend on real LLM connectivity.
      modelRequestMaxRetries,
      // keep a small timeout to avoid hanging on network/dns.
      modelIdleTimeoutMs: 1500,
      modelTotalTimeoutMs: 1500,
      autoCompactThresholdPct: 80
    }
  });
  assert.equal(runtime.response.status, 200, `configure agent runtime failed: ${runtime.text}`);
}

async function createFixture(params: {
  llmMode?: "failure" | "success" | "tool-cycle";
  providerNpm?: "@ai-sdk/openai" | "@ai-sdk/openai-compatible";
  modelOptions?: Record<string, unknown>;
  modelRequestMaxRetries?: number;
  toolCommand?: string;
  toolCount?: number;
  toolCalls?: StubToolCall[];
  workspaceId?: string;
  authToken?: string | null;
} = {}): Promise<Fixture> {
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
    llmStub = await startLlmStubServer(params.llmMode, params.toolCommand, params.toolCalls?.length ?? params.toolCount, params.toolCalls);
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
      authToken: params.authToken ?? null,
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

    const workspaceId = params.workspaceId ?? newSortableId("ws");
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
    const internalRpcGate: Fixture["internalRpcGate"] = {};
    const callsByRequest = new WeakMap<object, InternalRpcCall>();
    app.addHook("preHandler", async (request, reply) => {
      if (!request.url.startsWith("/api/internal/agent/")) return;
      const call: InternalRpcCall = { method: request.method, url: request.url, body: request.body };
      internalRpcCalls.push(call);
      callsByRequest.set(request, call);
      if (await internalRpcGate.before?.(call) === "drop") {
        reply.hijack();
        reply.raw.destroy();
        return reply;
      }
    });
    app.addHook("onSend", async (request, _reply, payload) => {
      const call = callsByRequest.get(request);
      if (!call || typeof payload !== "string") return payload;
      try {
        call.responseBody = JSON.parse(payload) as unknown;
      } catch {
        // The integration assertions only inspect JSON internal RPC responses.
      }
      return await internalRpcGate.after?.(call, payload) ?? payload;
    });
    app.addHook("onResponse", async (request, reply) => {
      const call = callsByRequest.get(request);
      if (call) call.statusCode = reply.statusCode;
    });
    await app.listen({ host: "127.0.0.1", port: apiPort });
    const baseUrl = `http://127.0.0.1:${apiPort}`;
    // Public authentication is selected before createApp registers its hooks.
    // Bootstrap with an independent controller Cookie, never the CLI cache or
    // the Worker's internal token; unauthenticated fixtures keep their defaults.
    const headers = ctx.authToken ? {
      cookie: `${AUTH_COOKIE_NAME}=${createSessionCookieValue({
        authToken: ctx.authToken, nowMs: Date.now(), ttlMs: AUTH_REMEMBER_TTL_MS
      })}`
    } : undefined;
    await configureAgentDefaults(baseUrl, llmStub.baseURL, params.providerNpm, params.modelOptions, params.modelRequestMaxRetries, headers);

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
      internalRpcCalls,
      internalRpcGate
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

async function createSession(baseUrl: string, workspaceId: string, headers?: Record<string, string>) {
  const res = await requestJson<{ id: string }>(baseUrl, {
    method: "POST",
    path: "/api/agent/sessions",
    headers,
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

function assertStartupRecoveryFailed(fixture: Fixture, params: { sessionId: string; runId: string; assistantId?: string; executionId?: string; executionStatus?: "cancelled" | "unknown" }) {
  const run = getRunRecord(fixture.db, params.runId);
  assert.equal(run?.status, "failed");
  assert.equal(run?.terminalResultCode, "run_startup_recovery_failed");
  const state = getMessageRunState(fixture.db, fixture.workspaceId, params.sessionId);
  assert.equal(state?.status, "idle");
  assert.equal(state?.activeRunId, null);
  assert.equal(state?.runNoticeText, "");
  if (params.assistantId) assert.equal(fixture.db.prepare("select status from agent_message where id=?").get(params.assistantId) && (fixture.db.prepare("select status from agent_message where id=?").get(params.assistantId) as { status: string }).status, "failed");
  if (params.executionId) assert.equal((fixture.db.prepare("select status from agent_tool_execution where id=?").get(params.executionId) as { status: string } | undefined)?.status, params.executionStatus);
}

function assertNoStartupBusinessExecution(fixture: Fixture) {
  assert.equal(fixture.internalRpcCalls.some((call) => call.url === "/api/internal/agent/run/enqueue"), false);
  assert.equal(fixture.internalRpcCalls.some((call) => call.url === AgentApiEndpoints.resumeStreamingAssistant.path), false);
  assert.equal(fixture.internalRpcCalls.some((call) => call.url === AgentApiEndpoints.createStreamingAssistant.path), false);
  assert.equal(fixture.internalRpcCalls.some((call) => call.url === AgentApiEndpoints.updateToolExecution.path), false);
  assert.deepEqual(fixture.llmStub?.requestPaths, []);
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

test("same live API recovers a restarted managed Worker through committed lifecycle publication exactly once", async (t) => {
  const runId = newSortableId("run");
  const stoppedRunId = newSortableId("run");
  const events: AgentRunCompletedEvent[] = [];
  let cacheClears = 0;
  let stoppedCacheClears = 0;
  let startupRecoveries = 0;
  let fixture: Fixture;
  const captured: { service?: AgentRuntimeControlService } = {};
  const originalRecover = AgentRuntimeControlService.prototype.recover;
  const originalStartup = RunLifecycleApplication.prototype.recoverRunsOnStartup;
  const originalPublish = AgentRunCompletedEventHub.prototype.publish;
  const originalClear = RunPromptStaticCacheInvalidator.prototype.clear;
  t.mock.method(AgentRuntimeControlService.prototype, "recover", function (this: AgentRuntimeControlService) {
    originalRecover.call(this);
    captured.service = this;
  });
  t.mock.method(RunLifecycleApplication.prototype, "recoverRunsOnStartup", async function (
    this: RunLifecycleApplication,
    command: Parameters<typeof originalStartup>[0],
  ) {
    const result = await originalStartup.call(this, command);
    startupRecoveries++;
    return result;
  });
  t.mock.method(AgentRunCompletedEventHub.prototype, "publish", function (this: AgentRunCompletedEventHub, event: AgentRunCompletedEvent) {
    if (event.runId === runId || event.runId === stoppedRunId) {
      assert.equal(fixture.db.inTransaction, false);
      assert.equal(getRunRecord(fixture.db, event.runId)?.executionPhase, "terminal");
      events.push(event);
    }
    originalPublish.call(this, event);
  });
  t.mock.method(RunPromptStaticCacheInvalidator.prototype, "clear", function (this: RunPromptStaticCacheInvalidator, target: string) {
    if (target === runId || target === stoppedRunId) {
      assert.equal(fixture.db.inTransaction, false);
      assert.equal(getRunRecord(fixture.db, target)?.executionPhase, "terminal");
      if (target === runId) cacheClears++;
      else stoppedCacheClears++;
    }
    originalClear.call(this, target);
  });

  fixture = await createFixture();
  await waitUntil(async () => startupRecoveries === 1 && !!captured.service, 10_000);
  const service = captured.service!;
  const firstInstanceId = service.currentRuntimeInstanceId!;
  const firstInstance = fixture.db.prepare("select state, process_identity_json as identity from agent_runtime_instance where runtime_instance_id=?")
    .get(firstInstanceId) as { state: string; identity: string };
  assert.equal(firstInstance.state, "ready");
  const childPid = (JSON.parse(firstInstance.identity) as { pid: number }).pid;
  assert.ok(Number.isInteger(childPid) && childPid > 1 && childPid !== process.pid);
  // Source-mode tsx has a launcher parent. Crash the actual Worker, allowing
  // its original ChildProcess launcher to exit naturally; killing only the
  // launcher would leave a live Worker rather than simulate a Worker crash.
  const workerPid = Number(await fs.readFile(fixture.workerPidFilePath, "utf8"));
  assert.ok(Number.isInteger(workerPid) && workerPid > 1 && workerPid !== process.pid);
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  createRecoveryRun(fixture, session.id, runId);
  new AgentRuntimeControlStore(fixture.db).bindAdmission({ workspaceId: fixture.workspaceId, sessionId: session.id, runId }, firstInstanceId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const stream = await fetch(`${fixture.baseUrl}/api/internal/agent/events/sse`, {
      headers: { "x-awb-agent-internal-token": fixture.ctx.agentInternalToken! },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    // Real child exit, spawn, identity handshake and onReady recovery, with
    // the original API, DB, lifecycle cache and SSE connection still alive.
    process.kill(workerPid, "SIGKILL");
    await waitUntil(async () => startupRecoveries === 2 && service.currentRuntimeInstanceId !== firstInstanceId, 20_000);
    assert.equal(captured.service, service, "recovery must use the same production runtime-control instance");
    const exited = fixture.db.prepare("select state from agent_runtime_instance where runtime_instance_id=?").get(firstInstanceId) as { state: string };
    assert.equal(exited.state, "exited");
    assertStartupRecoveryFailed(fixture, { sessionId: session.id, runId });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.finalStatus, "failed");
    assert.equal(cacheClears, 1);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let chunks = "";
    while (!chunks.includes(`"eventId":"${events[0]!.eventId}"`)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "completion SSE must reach the existing live connection");
      chunks += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(chunks, /event: agent\.run\.completed\.v1/);
    assert.ok(chunks.includes(`"runId":"${runId}"`));

    // Call the captured production capability, not a copy of recovery logic.
    service.recover();
    service.recover();
    await recoverFixtureRun(fixture);
    assert.equal(events.length, 1);
    assert.equal(cacheClears, 1);
    assertStartupRecoveryFailed(fixture, { sessionId: session.id, runId });

    // Normal service Stop uses the very same bound lifecycle capability.
    // A subsequent public cancel must not publish the already-terminal Run
    // again through the older cancellation persistence/application path.
    const stoppedSession = await createSession(fixture.baseUrl, fixture.workspaceId);
    createRecoveryRun(fixture, stoppedSession.id, stoppedRunId);
    const stopInput = { workspaceId: fixture.workspaceId, rootSessionId: stoppedSession.id, operationId: randomUUID() };
    service.stopSession(stopInput);
    service.stopSession(stopInput);
    const cancelled = await requestJson(fixture.baseUrl, {
      method: "POST", path: `/api/agent/sessions/${stoppedSession.id}/cancel`, body: { workspaceId: fixture.workspaceId },
    });
    assert.equal(cancelled.response.status, 200, cancelled.text);
    service.recover();
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => [event.runId, event.finalStatus]), [[runId, "failed"], [stoppedRunId, "cancelled"]]);
    assert.equal(stoppedCacheClears, 1);
    assert.equal(cacheClears, 1);
    const beforeExit = events.length;
    await service.reconcileStops();
    assert.equal(events.length, beforeExit, "exit/proof reconciliation must not invent another terminal publication");
    assert.equal(stoppedCacheClears, 1);
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
});

test("startup recovery: streaming Assistant 收敛为失败且不重启 Worker 业务", async () => {
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

  assertStartupRecoveryFailed(fixture, { sessionId: session.id, runId, assistantId });
  assertNoStartupBusinessExecution(fixture);
});

test("worker 模式: openai-compatible 保持使用 Chat Completions", async () => {
  const fixture = await createFixture({ llmMode: "success", providerNpm: "@ai-sdk/openai-compatible" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const sent = await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "use the compatible provider",
    clientRequestId: newSortableId("req")
  });

  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);

  assert.equal(getRunRecord(fixture.db, sent.runId)?.status, "completed");
  assert.deepEqual(fixture.llmStub?.requestPaths, ["/v1/chat/completions"]);
});

test("Agent 主请求将模型 aiSdk headers 传入真实 mock fetch", async () => {
  const fixture = await createFixture({
    llmMode: "success",
    modelOptions: {
      aiSdk: {
        headers: { "x-model-config": "agent-main" },
        allowSystemInMessages: true,
      },
    },
  });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "verify configured header",
    clientRequestId: "req_ai_sdk_headers",
  });
  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);

  assert.equal(fixture.llmStub?.requestHeaders[0]?.["x-model-config"], "agent-main");
  assert.deepEqual(fixture.llmStub?.requestPaths, ["/v1/responses"]);
});

test("startup recovery: manual_compaction 收敛为失败且不提交 Compaction", async () => {
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

  assertStartupRecoveryFailed(fixture, { sessionId: session.id, runId });
  assert.equal((fixture.db.prepare("select count(*) as count from agent_message where type = 'compaction' and origin_run_id = ?").get(runId) as { count: number }).count, 0);
  assertNoStartupBusinessExecution(fixture);
});

test("startup recovery: partial streaming Assistant 收敛失败，不创建 replacement", async () => {
  const fixture = await createFixture({ llmMode: "success" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = createRecoveryRun(fixture, session.id, runId);
  const head = getMessageSession(fixture.db, fixture.workspaceId, session.id)!;
  const assistantId = newSortableId("msg");
  appendStreamingAssistant(fixture.db, { id: assistantId, workspaceId: fixture.workspaceId, sessionId: session.id, expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision, runId, createdAt: createdAt + 1 });
  assert.equal(flushStreamingParts(fixture.db, { workspaceId: fixture.workspaceId, sessionId: session.id, runId, messageId: assistantId, parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "partial" }], updatedAt: createdAt + 2 }), "updated");

  await recoverFixtureRun(fixture);
  await recoverFixtureRun(fixture);

  assertStartupRecoveryFailed(fixture, { sessionId: session.id, runId, assistantId });
  assert.equal((fixture.db.prepare("select count(*) as count from agent_message where origin_run_id=? and type='assistant'").get(runId) as { count: number }).count, 1);
  assertNoStartupBusinessExecution(fixture);
});

test("startup recovery: running ToolExecution 转 unknown，不调用工具或模型", async () => {
  const fixture = await createFixture({ llmMode: "success" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = createRecoveryRun(fixture, session.id, runId);
  const { executionId } = createCompletedAssistantWithExecution(fixture, { sessionId: session.id, runId, createdAt, status: "running" });

  await recoverFixtureRun(fixture);

  assertStartupRecoveryFailed(fixture, { sessionId: session.id, runId, executionId, executionStatus: "unknown" });
  assertNoStartupBusinessExecution(fixture);
});

test("startup recovery: queued ToolExecution 转 cancelled，不调用工具或模型", async () => {
  const fixture = await createFixture({ llmMode: "success" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = createRecoveryRun(fixture, session.id, runId);
  const { executionId } = createCompletedAssistantWithExecution(fixture, { sessionId: session.id, runId, createdAt, status: "queued" });

  await recoverFixtureRun(fixture);
  await recoverFixtureRun(fixture);

  assertStartupRecoveryFailed(fixture, { sessionId: session.id, runId, executionId, executionStatus: "cancelled" });
  assertNoStartupBusinessExecution(fixture);
});

test("worker 模式: 模型错误写入 retry notice，用户取消后通过新写回端点收敛 Run", async () => {
  const fixture = await createFixture({ modelRequestMaxRetries: 1 });
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

test("worker 内部 discard 端点要求令牌，作废 replay-only Assistant 且响应不泄漏密文", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const runId = "discard-run";
  const assistantId = "discard-assistant";
  const sentinel = "opaque-encrypted-replay-SENTINEL-discard-route-718b";
  fixture.db.prepare("insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values (?,?,?,null,'agent','provider','model','running',1,1)")
    .run(runId, fixture.workspaceId, session.id);
  fixture.db.prepare("update session_run_state set status='running',active_run_id=? where workspace_id=? and session_id=?")
    .run(runId, fixture.workspaceId, session.id);
  const headers = { "x-awb-agent-internal-token": "worker-integration-token" };
  assert.equal((await fixture.app.inject({
    method: AgentApiEndpoints.createStreamingAssistant.method,
    url: AgentApiEndpoints.createStreamingAssistant.path,
    headers,
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId, messageId: assistantId, createdAt: 2 },
  })).statusCode, 200);
  assert.equal((await fixture.app.inject({
    method: AgentApiEndpoints.flushAssistantParts.method,
    url: AgentApiEndpoints.flushAssistantParts.path,
    headers,
    payload: {
      workspaceId: fixture.workspaceId, sessionId: session.id, runId, messageId: assistantId, updatedAt: 3,
      parts: [{
        id: "discard-reasoning", position: 0, type: "reasoning", text: "",
        providerReplay: {
          version: 1,
          provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "provider", model: "gpt-5" },
          item: { type: "reasoning", itemId: "discard-item", encryptedContent: sentinel },
        },
      }],
    },
  })).statusCode, 200);
  const payload = { workspaceId: fixture.workspaceId, sessionId: session.id, runId, messageId: assistantId, updatedAt: 4 };
  const unauthorized = await fixture.app.inject({ method: AgentApiEndpoints.discardStreamingAssistant.method, url: AgentApiEndpoints.discardStreamingAssistant.path, payload });
  assert.equal(unauthorized.statusCode, 401);
  const discarded = await fixture.app.inject({ method: AgentApiEndpoints.discardStreamingAssistant.method, url: AgentApiEndpoints.discardStreamingAssistant.path, headers, payload });
  assert.equal(discarded.statusCode, 200);
  assert.deepEqual(JSON.parse(discarded.body), { result: "updated" });
  assert.doesNotMatch(discarded.body, new RegExp(sentinel));
  assert.deepEqual(fixture.db.prepare("select status from agent_message where id=?").get(assistantId), { status: "superseded" });
  const sessionAfterDiscard = fixture.db.prepare("select head_message_id as headMessageId,revision from agent_session where id=?").get(session.id) as { headMessageId: string | null; revision: number };
  assert.equal(sessionAfterDiscard.headMessageId, null);
  const replayed = await fixture.app.inject({ method: AgentApiEndpoints.discardStreamingAssistant.method, url: AgentApiEndpoints.discardStreamingAssistant.path, headers, payload });
  assert.deepEqual(JSON.parse(replayed.body), { result: "updated" });
  assert.deepEqual(fixture.db.prepare("select head_message_id as headMessageId,revision from agent_session where id=?").get(session.id), sessionAfterDiscard);
  const changed = await fixture.app.inject({ method: AgentApiEndpoints.discardStreamingAssistant.method, url: AgentApiEndpoints.discardStreamingAssistant.path, headers, payload: { ...payload, updatedAt: 5 } });
  assert.deepEqual(JSON.parse(changed.body), { result: "ignored" });
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

test("Worker 首次处理新 Run 时从 replay-only completed DB 历史重建 OpenAI replay", async () => {
  const fixture = await createFixture({ llmMode: "success" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const initial = getMessageSession(fixture.db, fixture.workspaceId, session.id)!;
  const createdAt = Date.now();
  appendMessage(fixture.db, {
    id: "restart-history-user", workspaceId: fixture.workspaceId, sessionId: session.id,
    expectedHeadMessageId: initial.headMessageId, expectedRevision: initial.revision,
    type: "user", status: "completed",
    parts: [{ id: "restart-history-user-text", position: 0, type: "text", text: "persisted question" }],
    createdAt,
  });
  const afterUser = getMessageSession(fixture.db, fixture.workspaceId, session.id)!;
  appendMessage(fixture.db, {
    id: "restart-history-assistant", workspaceId: fixture.workspaceId, sessionId: session.id,
    expectedHeadMessageId: afterUser.headMessageId, expectedRevision: afterUser.revision,
    type: "assistant", status: "completed",
    parts: [{
      id: "restart-history-reasoning", position: 0, type: "reasoning", text: "",
      providerReplay: {
        version: 1,
        provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "ppchat", model: "gpt-5.2" },
        item: { type: "reasoning", itemId: "restart-reasoning-item", encryptedContent: "restart-encrypted-reasoning" },
      },
    }],
    createdAt: createdAt + 1,
  });

  await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "continue after restart",
    clientRequestId: "restart-replay-request",
  });
  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);
  assert.equal(fixture.llmStub?.requests.length, 1);
  const input = fixture.llmStub?.requests[0]?.input as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(input));
  assert.ok(input.some((item) => item.type === "reasoning"
    && item.id === "restart-reasoning-item"
    && item.encrypted_content === "restart-encrypted-reasoning"));
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
    select id, position, type, text, tool_name as toolName, tool_input_json as toolInputJson,
      provider_tool_call_id as providerToolCallId, provider_replay_json as providerReplayJson
    from agent_message_part
    where message_id = ?
    order by position asc
  `).all(assistant[0]!.id) as Array<{ id: string; position: number; type: string; text: string | null; toolName: string | null; toolInputJson: string | null; providerToolCallId: string | null; providerReplayJson: string | null }>;
  const reasoning = firstAssistantParts.find((part) => part.type === "reasoning");
  assert.ok(reasoning);
  assert.equal(reasoning.text, "inspect with bash");
  assert.match(reasoning.providerReplayJson ?? "", /stub-reasoning-item-1/);
  assert.match(reasoning.providerReplayJson ?? "", /stub-encrypted-reasoning/);
  const toolCall = firstAssistantParts.find((part) => part.type === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall.providerToolCallId, "stub-tool-call-1");
  assert.equal(toolCall.toolName, "bash");
  assert.deepEqual(JSON.parse(toolCall.toolInputJson ?? "null"), { command: "printf tool-cycle-output" });
  assert.match(toolCall.providerReplayJson ?? "", /stub-function-item-1/);
  assert.doesNotMatch(toolCall.providerReplayJson ?? "", /stub-tool-call-1/);

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
  const secondRequest = modelRequests[1] ?? {};
  const secondInput = secondRequest.input as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(secondInput));
  const replayedReasoningIndex = secondInput.findIndex((item) => item.type === "reasoning" && item.id === "stub-reasoning-item-1");
  const replayedFunctionIndex = secondInput.findIndex((item) => item.type === "function_call" && item.id === "stub-function-item-1");
  const functionOutputIndex = secondInput.findIndex((item) => item.type === "function_call_output" && item.call_id === "stub-tool-call-1");
  assert.ok(replayedReasoningIndex >= 0);
  assert.deepEqual(secondInput[replayedReasoningIndex], {
    type: "reasoning",
    id: "stub-reasoning-item-1",
    encrypted_content: "stub-encrypted-reasoning",
    summary: [{ type: "summary_text", text: "inspect with bash" }]
  });
  assert.ok(replayedFunctionIndex > replayedReasoningIndex);
  assert.deepEqual(secondInput[replayedFunctionIndex], {
    type: "function_call",
    call_id: "stub-tool-call-1",
    name: "bash",
    arguments: JSON.stringify({ command: "printf tool-cycle-output" }),
    id: "stub-function-item-1"
  });
  assert.ok(functionOutputIndex > replayedFunctionIndex);
  assert.ok(secondInput.some((item) => item.type === "function_call_output" && item.call_id === "stub-tool-call-1"));
  assert.equal(secondRequest.store, false);
  assert.deepEqual(secondRequest.include, ["reasoning.encrypted_content"]);
  const serializedSecondRequest = JSON.stringify(secondRequest);
  assert.doesNotMatch(serializedSecondRequest, /previous_response_id|previousResponseId|conversation|reasoningContext|reasoning_context/);
  assert.deepEqual(fixture.llmStub?.requestPaths, ["/v1/responses", "/v1/responses"]);
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
  await waitUntil(async () => fixture.internalRpcCalls.some((call) =>
    call.method === "POST" && call.url === "/api/internal/agent/compaction-source" && (call.statusCode || 0) >= 200 && (call.statusCode || 0) < 300
  ), 10_000);

  const expected = [
    { endpoint: "/api/internal/agent/execution-profile", runBound: true },
    { endpoint: "/api/internal/agent/compaction-source", runBound: true }
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

  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);
  const compactRun = getRunRecord(fixture.db, compact.json.runId);
  assert.equal(compactRun?.status, "completed");
  assert.equal(compactRun?.executionPhase, "terminal");
  assert.equal(compactRun?.terminalResultCode, "compaction_not_needed");
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
  assert.equal(summary, undefined, "no-effect source must not persist a compaction Message");
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
    expectedHeadMessageId: userMessageId, expectedRevision: 1, retainedFromMessageId: null,
    summaryText: "exact summary", intent: { status: "completed" as const, code: "compaction_completed" as const, detail: null }, createdAt: createdAt + 1,
  };
  const internal = { "x-awb-agent-internal-token": fixture.ctx.agentInternalToken };
  const path = AgentApiEndpoints.commitCompactionWithTerminalIntent.path;
  const first = await requestJson<{ result: string; summaryMessageId: string | null }>(fixture.baseUrl, { method: "POST", path, body: request, headers: internal });
  const replay = await requestJson<{ result: string; summaryMessageId: string | null }>(fixture.baseUrl, { method: "POST", path, body: request, headers: internal });
  const different = await requestJson<{ result: string; summaryMessageId: string | null }>(fixture.baseUrl, { method: "POST", path, body: { ...request, summaryText: "different" }, headers: internal });
  assert.equal(first.response.status, 200);
  assert.deepEqual(replay.json, first.json);
  assert.equal(different.response.status, 409);
  assert.equal((fixture.db.prepare("select count(*) as count from agent_message where type = 'compaction'").get() as { count: number }).count, 1);
});

test("Worker Compaction internal route enforces persistent Run kind intent semantics without partial writes", async () => {
  const fixture = await createFixture({ llmMode: "success" });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const userSession = await createSession(fixture.baseUrl, fixture.workspaceId);
  const subtaskSession = await createSession(fixture.baseUrl, fixture.workspaceId);
  const internal = { "x-awb-agent-internal-token": fixture.ctx.agentInternalToken };
  const path = AgentApiEndpoints.commitCompactionWithTerminalIntent.path;
  const createRun = (sessionId: string, runId: string, runKind: "manual_compaction" | "user" | "subtask", createdAt: number) => {
    const userMessageId = newSortableId("msg");
    appendMessage(fixture.db, {
      id: userMessageId, workspaceId: fixture.workspaceId, sessionId,
      expectedHeadMessageId: getMessageSession(fixture.db, fixture.workspaceId, sessionId)!.headMessageId,
      expectedRevision: getMessageSession(fixture.db, fixture.workspaceId, sessionId)!.revision,
      type: "user", status: "completed", originRunId: null,
      parts: [{ id: newSortableId("part"), position: 0, type: "text", text: `${runKind} context` }], createdAt,
    });
    createMessageRunRecord(fixture.db, {
      runId, workspaceId: fixture.workspaceId, sessionId, triggerMessageId: userMessageId,
      agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", runKind,
      subtaskDepth: null, parentRunId: null, parentToolExecutionId: null, status: "running", createdAt,
    });
    startMessageRun(fixture.db, { workspaceId: fixture.workspaceId, sessionId, runId, updatedAt: createdAt });
    const state = getMessageSession(fixture.db, fixture.workspaceId, sessionId)!;
    return { userMessageId, expectedRevision: state.revision };
  };
  const requestFor = (sessionId: string, runId: string, head: string, expectedRevision: number, createdAt: number) => ({
    workspaceId: fixture.workspaceId, sessionId, runId,
    messageId: newSortableId("msg"), textPartId: newSortableId("part"),
    expectedHeadMessageId: head, expectedRevision, retainedFromMessageId: null,
    summaryText: "summary", createdAt,
  });

  const manualRunId = newSortableId("run");
  const manual = createRun(session.id, manualRunId, "manual_compaction", 100);
  const beforeManual = getMessageSession(fixture.db, fixture.workspaceId, session.id)!;
  const missingIntent = await requestJson<{ message: string }>(fixture.baseUrl, {
    method: "POST", path, headers: internal,
    body: requestFor(session.id, manualRunId, manual.userMessageId, manual.expectedRevision, 101),
  });
  assert.equal(missingIntent.response.status, 400);
  assert.equal(getMessageSession(fixture.db, fixture.workspaceId, session.id)?.headMessageId, beforeManual.headMessageId);
  assert.equal(getMessageSession(fixture.db, fixture.workspaceId, session.id)?.contextRootMessageId, beforeManual.contextRootMessageId);
  assert.equal(getMessageSession(fixture.db, fixture.workspaceId, session.id)?.revision, beforeManual.revision);
  assert.equal(getRunRecord(fixture.db, manualRunId)?.executionPhase, "work_pending");
  assert.equal(getRunRecord(fixture.db, manualRunId)?.intendedTerminalCode, null);
  assert.equal((fixture.db.prepare("select count(*) as count from agent_message where origin_run_id = ? and type = 'compaction'").get(manualRunId) as { count: number }).count, 0);

  const userRunId = newSortableId("run");
  const user = createRun(userSession.id, userRunId, "user", 200);
  const userIntent = await requestJson<{ message: string }>(fixture.baseUrl, {
    method: "POST", path, headers: internal,
    body: { ...requestFor(userSession.id, userRunId, user.userMessageId, user.expectedRevision, 201), intent: { status: "completed", code: "compaction_completed", detail: null } },
  });
  assert.equal(userIntent.response.status, 400);
  assert.equal(getRunRecord(fixture.db, userRunId)?.executionPhase, "work_pending");
  assert.equal((fixture.db.prepare("select count(*) as count from agent_message where origin_run_id = ? and type = 'compaction'").get(userRunId) as { count: number }).count, 0);
  const userArtifact = await requestJson<{ result: string }>(fixture.baseUrl, {
    method: "POST", path, headers: internal,
    body: requestFor(userSession.id, userRunId, user.userMessageId, user.expectedRevision, 202),
  });
  assert.equal(userArtifact.response.status, 200, userArtifact.text);
  assert.equal(userArtifact.json.result, "updated");
  assert.equal(getRunRecord(fixture.db, userRunId)?.executionPhase, "work_pending");
  assert.equal(getRunRecord(fixture.db, userRunId)?.intendedTerminalCode, null);

  const subtaskRunId = newSortableId("run");
  const subtask = createRun(subtaskSession.id, subtaskRunId, "subtask", 300);
  const subtaskIntent = await requestJson<{ message: string }>(fixture.baseUrl, {
    method: "POST", path, headers: internal,
    body: { ...requestFor(subtaskSession.id, subtaskRunId, subtask.userMessageId, subtask.expectedRevision, 301), intent: { status: "completed", code: "compaction_completed", detail: null } },
  });
  assert.equal(subtaskIntent.response.status, 400);
  assert.equal(getRunRecord(fixture.db, subtaskRunId)?.executionPhase, "work_pending");
  assert.equal((fixture.db.prepare("select count(*) as count from agent_message where origin_run_id = ? and type = 'compaction'").get(subtaskRunId) as { count: number }).count, 0);
  const subtaskArtifact = await requestJson<{ result: string }>(fixture.baseUrl, {
    method: "POST", path, headers: internal,
    body: requestFor(subtaskSession.id, subtaskRunId, subtask.userMessageId, subtask.expectedRevision, 302),
  });
  assert.equal(subtaskArtifact.response.status, 200, subtaskArtifact.text);
  assert.equal(subtaskArtifact.json.result, "updated");
  assert.equal(getRunRecord(fixture.db, subtaskRunId)?.executionPhase, "work_pending");
  assert.equal(getRunRecord(fixture.db, subtaskRunId)?.intendedTerminalCode, null);
});

test("scheduled slot starts a real Agent Worker and history converges after its Run completes", async () => {
  const fixture = await createFixture({ llmMode: "success", providerNpm: "@ai-sdk/openai-compatible" });
  // Worker readiness starts the scheduler; only then make a slot due, so this
  // tests the running phase rather than startup's intentional silent catch-up.
  await waitUntil(async () => fs.stat(fixture.workerPidFilePath).then(() => true, () => false), 6_000);
  const base = `/api/workspaces/${fixture.workspaceId}/scheduled-tasks`;
  const created = await requestJson<{ task: { id: string } }>(fixture.baseUrl, {
    method: "POST", path: base,
    body: { name: "Worker end-to-end", prompt: "Answer briefly", agentId: "default", enabled: true,
      triggerMode: "new_session", sourceSessionId: null, sourceMessageId: null,
      schedule: { kind: "hourly", minutesUtc: [0] } }
  });
  assert.equal(created.response.status, 201, `create task failed: ${created.text}`);
  const taskId = created.json.task.id;
  const dueSlot = Date.now() - 1000;
  fixture.db.prepare("update scheduled_agent_task set next_run_at=? where id=?").run(dueSlot, taskId);
  let executionId: string | undefined;
  await waitUntil(async () => {
    const row = fixture.db.prepare(`select id from scheduled_agent_execution
      where task_id=? and trigger_type='scheduled' and scheduled_for=?`).get(taskId, dueSlot) as {id: string} | undefined;
    executionId = row?.id;
    return !!row;
  }, 8_000);
  const claimed = readScheduledExecution(fixture.db, fixture.workspaceId, executionId!)!;
  assert.ok(claimed.sessionId);
  await waitUntil(async () => getRunRecord(fixture.db, readScheduledExecution(fixture.db,
    fixture.workspaceId, executionId!)?.runId ?? "")?.status === "completed", 25_000);
  let completed: {id: string; status: string; runId: string} | undefined;
  await waitUntil(async () => {
    const history = await requestJson<{items: Array<{id: string; status: string; runId: string}>}>(fixture.baseUrl, {
      method: "GET", path: `${base}/${taskId}/executions?triggerType=scheduled`
    });
    assert.equal(history.response.status, 200, history.text);
    completed = history.json.items[0];
    return completed?.status === "completed";
  }, 6_000);
  assert.equal(completed?.id, executionId);
  assert.equal(completed?.runId, readScheduledExecution(fixture.db, fixture.workspaceId, executionId!)?.runId);
  assert.equal(getRunRecord(fixture.db, readScheduledExecution(fixture.db, fixture.workspaceId, executionId!)!.runId!)?.status, "completed");
  assert.equal(fixture.llmStub?.requestPaths.includes("/v1/chat/completions"), true);
  const runCount = fixture.db.prepare("select count(*) as n from agent_run where session_id=?")
    .get(claimed.sessionId) as {n: number};
  assert.equal(runCount.n, 1);
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

test("worker 模式: PTY登录缓存由真实Worker builtin bash中的独立awb共享", async (t) => {
  const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await fs.mkdir(testsRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testsRoot, "cli-worker-it-"));
  const home = path.join(root, "home");
  const prefix = path.join(root, "npm-prefix");
  const temporary = path.join(root, "tmp");
  const npmCache = path.join(root, "npm-cache");
  await Promise.all([home, prefix, temporary, npmCache].map((directory) => fs.mkdir(directory)));
  const priorHome = process.env.HOME;
  const priorPath = process.env.PATH;
  const isolatedPath = `${path.join(prefix, "bin")}${path.delimiter}${priorPath ?? path.dirname(process.execPath)}`;
  let fixture: Fixture | undefined;
  t.after(async () => {
    try {
      // Stop the API-managed Worker before deleting its HOME or installation.
      if (fixture) await closeFixture(fixture);
      await fs.rm(root, { recursive: true, force: true });
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: isolatedPath,
    TMPDIR: temporary, NODE_PATH: "", NODE_OPTIONS: "",
    npm_config_cache: npmCache, npm_config_prefix: prefix,
    NPM_CONFIG_CACHE: npmCache, NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_USERCONFIG: path.join(home, ".npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(home, "global.npmrc")
  };
  assert.ok(existsSync(path.join(repoRoot, "packages/cli/dist/cli.cjs")), "build packages/cli before the Worker gate");
  // npm link only touches this fixture's prefix/cache; never the user's prefix.
  execFileSync("npm", ["--cache", npmCache, "--userconfig", env.NPM_CONFIG_USERCONFIG!, "--globalconfig", env.NPM_CONFIG_GLOBALCONFIG!,
    "link", "-w", "packages/cli", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--package-lock=false"], {
    cwd: repoRoot, env, stdio: "pipe", timeout: 30_000
  });
  assert.equal(await fs.realpath(path.join(prefix, "bin/awb")), await fs.realpath(path.join(repoRoot, "packages/cli/dist/cli.cjs")));
  process.env.HOME = home;
  process.env.PATH = isolatedPath;
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const workspaceId = newSortableId("ws");
  // Host login profiles may reset PATH/HOME. Restore only this test's isolated
  // process environment inside the real bash -lc, never inject authentication.
  const toolCommand = `export HOME=${quote(home)} PATH=${quote(isolatedPath)}; command -v awb && awb --help && awb session list --workspace ${quote(workspaceId)} --updated-within 1h`;
  const authToken = randomUUID();
  const controllerCookie = createSessionCookieValue({ authToken, nowMs: Date.now(), ttlMs: AUTH_REMEMBER_TTL_MS });
  fixture = await createFixture({ llmMode: "tool-cycle", workspaceId, toolCommand, authToken });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId, { cookie: `${AUTH_COOKIE_NAME}=${controllerCookie}` });
  const queryPath = `/api/agent/sessions/query?${new URLSearchParams({
    workspaceId, updatedWithinSeconds: "3600", kind: "all", status: "all"
  })}`;
  const unauthenticated = await requestJson(fixture.baseUrl, { method: "GET", path: queryPath });
  assert.equal(unauthenticated.response.status, 401, "the same public query must reject a request without a Cookie");
  const internalOnly = await requestJson(fixture.baseUrl, {
    method: "GET", path: queryPath,
    headers: { "x-awb-agent-internal-token": fixture.ctx.agentInternalToken }
  });
  assert.equal(internalOnly.response.status, 401, "an internal credential must not authorize the public query");

  const terminal = spawnPty("bash", ["--noprofile", "--norc", "-c", `awb --help && awb login --url ${quote(fixture.baseUrl)}`], {
    cwd: fixture.workspacePath,
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    name: "xterm-256color", cols: 100, rows: 30
  });
  let terminalOutput = "";
  let tokenSent = false;
  const terminalCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { terminal.kill(); reject(new Error("isolated PTY login timed out")); }, 10_000);
    terminal.onData((chunk) => {
      terminalOutput += chunk;
      if (!tokenSent && terminalOutput.includes("输入隐藏")) {
        tokenSent = true;
        terminal.write(`${authToken}\r`);
      }
    });
    terminal.onExit(({ exitCode }) => { clearTimeout(timer); resolve(exitCode); });
  });
  assert.equal(terminalCode, 0);
  assert.ok(tokenSent);
  assert.match(terminalOutput, /Usage: awb/);
  assert.match(terminalOutput, /登录成功/);
  assert.ok(!terminalOutput.includes(authToken), "PTY must not echo the generated credential");
  const cachePath = path.join(home, ".config/awb/config.json");
  const before = await fs.stat(cachePath);
  // A separate controller Cookie avoids reading or printing the CLI's cache.
  const sent = await requestJson<{ runId: string }>(fixture.baseUrl, {
    method: "POST", path: `/api/agent/sessions/${session.id}/messages`,
    headers: { cookie: `${AUTH_COOKIE_NAME}=${controllerCookie}` },
    body: { workspaceId, text: "query sessions with the independent CLI", clientRequestId: newSortableId("req") }
  });
  assert.equal(sent.response.status, 201);
  const activeFixture = fixture;
  await waitUntil(async () => getMessageRunState(activeFixture.db, workspaceId, session.id)?.status === "idle", 20_000);
  assert.equal(getRunRecord(fixture.db, sent.json.runId)?.status, "completed");
  assert.ok(fixture.llmStub && fixture.llmStub.requests.length >= 2, "real Worker must complete the tool/model cycle");
  const completed = fixture.internalRpcCalls.find((call) => {
    const update = call.body as { runId?: string; status?: string };
    return call.url === "/api/internal/agent/tool-executions/update" && update.runId === sent.json.runId && update.status === "completed";
  });
  assert.ok(completed, "real builtin execution must write its result through internal RPC");
  const update = completed.body as { resultPreview: string };
  assert.match(update.resultPreview, /Usage: awb/);
  assert.match(update.resultPreview, new RegExp(`Workspace：${workspaceId}`));
  const metadata = fixture.db.prepare("select created_at as createdAt from agent_session where workspace_id = ? and id = ?")
    .get(workspaceId, session.id) as { createdAt: number };
  assert.ok(update.resultPreview.includes(`创建时间：${new Date(metadata.createdAt).toISOString()}\n最近更新时间：`));
  assert.match(update.resultPreview, /查询结束：已输出 1 个 Session。/);
  assert.ok(!update.resultPreview.includes(authToken));
  assert.ok(!update.resultPreview.includes(controllerCookie));
  assert.equal((await fs.stat(cachePath)).mtimeMs, before.mtimeMs, "fresh Cookie needs no renewal cache rewrite");
  const afterWorker = await requestJson(fixture.baseUrl, { method: "GET", path: queryPath });
  assert.equal(afterWorker.response.status, 401, "public authentication must still be active after the successful Worker query");
  t.diagnostic(`公开查询负对照：无Cookie=${unauthenticated.response.status}，仅内部凭证=${internalOnly.response.status}，Worker查询后无Cookie=${afterWorker.response.status}；PTY登录与真实Worker共享缓存链路成功。`);
});


const queueToolRounds: Array<{ name: string; tools: StubToolCall[]; failedResults: number }> = [
  { name: "串行双 read", tools: Array.from({ length: 2 }, () => ({ name: "read", args: { filePath: "queue.txt" } })), failedResults: 0 },
  { name: "并行双 bash", tools: Array.from({ length: 2 }, () => ({ name: "bash", args: { command: "printf tool-cycle-output" } })), failedResults: 0 },
  { name: "并行 bash／串行 read／并行 bash 混合批次", tools: [
    { name: "bash", args: { command: "printf tool-cycle-output" } }, { name: "bash", args: { command: "printf tool-cycle-output" } },
    { name: "read", args: { filePath: "queue.txt" } },
    { name: "bash", args: { command: "printf tool-cycle-output" } }, { name: "bash", args: { command: "printf tool-cycle-output" } },
  ], failedResults: 0 },
  { name: "并行 bash 后 read 合法失败结果", tools: [
    { name: "bash", args: { command: "printf tool-cycle-output" } }, { name: "bash", args: { command: "printf tool-cycle-output" } },
    { name: "read", args: { filePath: "missing-queue.txt" } },
  ], failedResults: 1 },
];
for (const round of queueToolRounds) test(`worker 队列: ${round.name}整轮闭合后同 Run 注入文本和真实图片，实际下一请求在全部结果之后包含输入`, { timeout: 30_000 }, async t => {
  const fixture = await createFixture({ llmMode: "tool-cycle", toolCalls: round.tools });
  await fs.writeFile(path.join(fixture.workspacePath, "queue.txt"), "queue fixture\n");
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const worker = new AgentWorkerClient({ workerOrigin: `http://${fixture.ctx.agentWorkerHost}:${fixture.ctx.agentWorkerPort}`,
    workerSocketPath: fixture.ctx.agentWorkerSocketPath, internalToken: fixture.ctx.agentInternalToken, responseValidation: "strict", logger: fixture.app.log });
  const identity = await worker.getRuntimeIdentity();
  const runtime = new AgentRuntimeControlService(new AgentRuntimeControlStore(fixture.db), worker);
  runtime.ready(identity.runtimeInstanceId);
  const composition = createAgentComposition(fixture.ctx, fixture.app.log);
  const queue = composition.createMessageQueue(runtime);
  t.after(async () => { await queue.close(); await runtime.close(); composition.dispose(); });
  queue.service.recoverPublications(); queue.service.openAdmission();
  // This independent assembly uses the real fixture Worker, already identity-ready above.
  // Open dispatch explicitly without starting a second background scanner.
  queue.dispatcher.resumeRuntimeDispatch();
  const scope = { workspaceId: fixture.workspaceId, sessionId: session.id };
  const first = await queue.service.accept(session.id, { workspaceId: fixture.workspaceId, clientRequestId: "queue-first", text: "queue initial" });
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(next => { resolve = next; }); return { promise, resolve }; };
  const entered = round.tools.map(() => deferred()), release = round.tools.map(() => deferred());
  const terminalIndexes = new Map<string, number>();
  fixture.internalRpcGate.before = async call => {
    const body = call.body as { status?: string; toolExecutionId: string };
    if (call.url !== "/api/internal/agent/tool-executions/update" || !["completed", "failed"].includes(body.status ?? "")) return;
    // A retried write for one execution must not masquerade as another tool's result.
    const index = terminalIndexes.get(body.toolExecutionId) ?? terminalIndexes.size;
    terminalIndexes.set(body.toolExecutionId, index);
    assert.ok(index < round.tools.length);
    entered[index]?.resolve(); await release[index]?.promise;
  };
  t.after(() => release.forEach(gate => gate.resolve()));
  const activated = await queue.dispatcher.dispatchSession(scope); assert.ok(activated);
  await entered[0]!.promise;
  assert.equal(fixture.llmStub!.requests.length, 1);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const image = await stageAgentImageUpload({ dataDir: fixture.ctx.dataDir, attachmentId: `att_${randomUUID()}`, tempId: `tmp_${randomUUID()}`,
    filename: "queue.png", stream: Readable.from([png]), onBytes: () => undefined });
  const accepted = await queue.service.accept(session.id, { workspaceId: fixture.workspaceId, clientRequestId: "queue-second", text: "queued second exact text", images: [image] });
  assert.equal(accepted.receipt.status, "queued"); assert.equal(accepted.queue.pendingCount, 1);
  for (let index = 1; index < round.tools.length; index++) {
    // Each bash/bash pair is one real parallel batch: both terminal writes must
    // enter before either is released, rather than accidentally testing serial reads.
    if (round.tools[index - 1]!.name === "bash" && round.tools[index]!.name === "bash") {
      await entered[index]!.promise;
    }
    release[index - 1]!.resolve(); await entered[index]!.promise;
    assert.equal(queue.service.snapshot(scope).pendingCount, 1); assert.equal(fixture.llmStub!.requests.length, 1);
  }
  release.at(-1)!.resolve();
  await waitRunIdle(fixture.baseUrl, session.id, fixture.workspaceId);
  const receipt = queue.service.detail(scope, accepted.receipt.id).receipt;
  assert.equal(receipt.status, "injected"); assert.equal(receipt.runId, activated.runId); assert.equal(receipt.confirmationState, "confirmed");
  assert.equal(receipt.confirmationSource, "worker_model"); assert.equal(queue.service.detail(scope, first.receipt.id).receipt.confirmationState, "confirmed");
  assert.equal(getRunRecord(fixture.db, activated.runId)!.status, "completed");
  assert.equal((fixture.db.prepare("select count(*) as n from agent_run where session_id=?").get(session.id) as { n: number }).n, 1);
  assert.equal(fixture.llmStub!.requests.length, 2);
  assert.equal(terminalIndexes.size, round.tools.length);
  const request = fixture.llmStub!.requests[1]!;
  assert.equal(request.max_output_tokens, 4096);
  const input = request.input as Array<Record<string, unknown>>;
  const outputs = input.map((item, index) => item.type === "function_call_output" ? index : -1).filter(index => index >= 0);
  assert.equal(outputs.length, round.tools.length);
  const calls = input.filter(item => item.type === "function_call");
  assert.deepEqual(calls.map(item => item.name), round.tools.map(tool => tool.name));
  assert.deepEqual(new Set(input.filter(item => item.type === "function_call_output").map(item => item.call_id)), new Set(calls.map(item => item.call_id)));
  assert.equal((fixture.db.prepare("select count(*) as n from agent_tool_execution where origin_run_id=? and status='failed'").get(activated.runId) as { n: number }).n, round.failedResults);
  const userIndex = input.findIndex(item => item.role === "user" && JSON.stringify(item.content).includes("queued second exact text"));
  assert.ok(userIndex > Math.max(...outputs));
  assert.ok(JSON.stringify(input[userIndex]).includes(`data:image/png;base64,${png.toString("base64")}`));
  const injectCalls = fixture.internalRpcCalls.filter(call => call.url === "/api/internal/agent/interactive-input/inject");
  assert.equal(injectCalls.length, 1); assert.equal((injectCalls[0]!.body as { runId: string }).runId, activated.runId);
});


function controlGate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function interactiveWorkerFixture(t: TestContext) {
  const fixture = await createFixture({ llmMode: "success", modelRequestMaxRetries: 0 });
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);
  const worker = new AgentWorkerClient({ workerOrigin: `http://${fixture.ctx.agentWorkerHost}:${fixture.ctx.agentWorkerPort}`,
    workerSocketPath: fixture.ctx.agentWorkerSocketPath, internalToken: fixture.ctx.agentInternalToken, responseValidation: "strict", logger: fixture.app.log });
  const identity = await worker.getRuntimeIdentity();
  const runtime = new AgentRuntimeControlService(new AgentRuntimeControlStore(fixture.db), worker); runtime.ready(identity.runtimeInstanceId);
  const composition = createAgentComposition(fixture.ctx, fixture.app.log), queue = composition.createMessageQueue(runtime);
  t.after(async () => { await queue.close(); await runtime.close(); composition.dispose(); });
  queue.service.recoverPublications(); queue.service.openAdmission();
  // This independent assembly uses the real fixture Worker, already identity-ready above.
  // Open dispatch explicitly without starting a second background scanner.
  queue.dispatcher.resumeRuntimeDispatch();
  const scope = { workspaceId: fixture.workspaceId, sessionId: session.id };
  const accept = (id: string) => queue.service.accept(session.id, { workspaceId: fixture.workspaceId, clientRequestId: id, text: id });
  const snapshot = () => new Promise<{ activeCount: number }>((resolve, reject) => {
    const request = httpRequest({ ...(fixture.ctx.agentWorkerSocketPath ? { socketPath: fixture.ctx.agentWorkerSocketPath }
      : { hostname: fixture.ctx.agentWorkerHost, port: fixture.ctx.agentWorkerPort }), path: "/_internal/analytics-snapshot",
      headers: { "x-awb-agent-internal-token": fixture.ctx.agentInternalToken } }, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
      response.on("end", () => { try { assert.equal(response.statusCode, 200); const value = JSON.parse(body) as { activeCount: number };
        assert.equal(typeof value.activeCount, "number"); resolve(value); } catch (error) { reject(error); } });
    });
    request.setTimeout(2000, () => request.destroy(new Error("Worker snapshot timed out"))); request.on("error", reject); request.end();
  });
  return { fixture, session, worker, runtime, queue, scope, accept, snapshot, runtimeInstanceId: identity.runtimeInstanceId };
}

for (const mode of ["prepare", "continue", "finish", "persistent_continue"] as const) test(`worker 队列H1: 已提交${mode}无效回包后同operation重放，无孤儿Run`, { timeout: 45_000 }, async t => {
  const f = await interactiveWorkerFixture(t), first = await f.accept("h1-trigger");
  let queued: Awaited<ReturnType<typeof f.accept>> | undefined;
  if (mode === "prepare") queued = await f.accept("h1-before-prepare");
  const retired = controlGate(), target = mode === "prepare" ? AgentApiEndpoints.prepareInteractiveInput.path : AgentApiEndpoints.completeInteractiveAssistant.path;
  let failures = mode === "persistent_continue" ? 8 : 1, damaged = 0, operationId: string | undefined;
  f.fixture.internalRpcGate.before = async call => {
    if (mode !== "prepare" && mode !== "finish" && !queued && call.url === target) queued = await f.accept("h1-during-model");
  };
  f.fixture.internalRpcGate.after = async call => {
    if (call.url === AgentApiEndpoints.retireRuntimeAdmission.path && (call.responseBody as { retired?: boolean }).retired) retired.resolve();
    if (call.url !== target || failures === 0) return;
    const body = call.body as { operationId: string; runId: string }, response = call.responseBody as { decision: string };
    assert.equal(response.decision, mode === "prepare" ? "prepare" : mode === "finish" ? "finish" : "continue");
    operationId ??= body.operationId; assert.equal(body.operationId, operationId);
    if (mode === "finish" && !queued) queued = await f.accept("h1-after-committed-finish");
    if (mode === "persistent_continue" && failures === 1) {
      // Beyond the ordinary terminal retry window, remain tracked rather than retire.
      assert.equal(getRunRecord(f.fixture.db, body.runId)!.status, "running");
      assert.equal(getMessageRunState(f.fixture.db, f.scope.workspaceId, f.scope.sessionId)!.activeAssistantMessageId, null);
      assert.equal(f.queue.service.snapshot(f.scope).pendingCount, 1); assert.equal((await f.snapshot()).activeCount, 1);
      assert.equal(f.fixture.internalRpcCalls.filter(item => item.url === AgentApiEndpoints.retireRuntimeAdmission.path).length, 0);
      await f.worker.enqueueRun({ ...f.scope, runtimeInstanceId: f.runtimeInstanceId, runId: body.runId, workspacePath: f.fixture.workspacePath, workspaceRepoDirNames: [], inputText: "h1-trigger" });
    }
    damaged++; failures--; return damaged % 2 ? "{}" : "{invalid-json";
  };
  const activated = await f.queue.dispatcher.dispatchSession(f.scope); assert.ok(activated);
  await retired.promise; await waitRunIdle(f.fixture.baseUrl, f.scope.sessionId, f.scope.workspaceId);
  assert.equal(getRunRecord(f.fixture.db, activated.runId)!.status, "completed"); assert.equal((await f.snapshot()).activeCount, 0);
  assert.equal(damaged, mode === "persistent_continue" ? 8 : 1);
  const repeated = f.fixture.internalRpcCalls.filter(call => call.url === target && (call.body as { operationId: string }).operationId === operationId);
  assert.equal(repeated.length, damaged + 1); assert.ok(repeated.every(call => JSON.stringify(call.body) === JSON.stringify(repeated[0]!.body)));
  assert.equal(f.fixture.llmStub!.requests.length, mode === "continue" || mode === "persistent_continue" ? 2 : 1);
  assert.equal((f.fixture.db.prepare("select count(*) as n from agent_run where session_id=?").get(f.scope.sessionId) as { n: number }).n, 1);
  assert.equal(f.queue.service.detail(f.scope, first.receipt.id).receipt.confirmationState, "confirmed"); assert.ok(queued);
  const input = f.queue.service.detail(f.scope, queued.receipt.id).receipt;
  if (mode === "finish") { assert.equal(input.status, "queued"); assert.equal(f.queue.service.snapshot(f.scope).pendingCount, 1); }
  else { assert.equal(input.status, "injected"); assert.equal(input.runId, activated.runId); assert.equal(input.confirmationState, "confirmed"); }
  assert.equal(f.fixture.internalRpcCalls.filter(call => call.url === AgentApiEndpoints.retireRuntimeAdmission.path && !(call.responseBody as { retired?: boolean }).retired).length, 0);
});

for (const decision of ["continue", "finish"] as const) test(`worker 队列H1: Stop中断未知${decision}回包等待，迟到回包不复活同Run`, { timeout: 30_000 }, async t => {
  const f = await interactiveWorkerFixture(t); await f.accept("h1-stop-trigger");
  let queued: Awaited<ReturnType<typeof f.accept>> | undefined, calls = 0;
  const waiting = controlGate(), release = controlGate(); t.after(() => release.resolve());
  f.fixture.internalRpcGate.before = async call => {
    if (decision === "continue" && !queued && call.url === AgentApiEndpoints.completeInteractiveAssistant.path) queued = await f.accept("h1-stop-queued");
  };
  f.fixture.internalRpcGate.after = async call => {
    if (call.url !== AgentApiEndpoints.completeInteractiveAssistant.path) return;
    assert.equal((call.responseBody as { decision: string }).decision, decision);
    if (decision === "finish" && !queued) queued = await f.accept("h1-stop-after-committed-finish");
    if (++calls === 1) return "{}";
    waiting.resolve(); await release.promise;
  };
  const activated = await f.queue.dispatcher.dispatchSession(f.scope); assert.ok(activated); await waiting.promise;
  assert.equal((await f.snapshot()).activeCount, 1); assert.ok(queued);
  f.queue.service.stop(f.scope, "h1-stop-during-control");
  await f.runtime.reconcileStops();
  await waitUntil(async () => f.queue.service.snapshot(f.scope).stop?.state === "quiescent", 10_000);
  assert.equal((await f.snapshot()).activeCount, 0); assert.equal(getRunRecord(f.fixture.db, activated.runId)!.status, decision === "finish" ? "completed" : "cancelled");
  const before = f.queue.service.snapshot(f.scope); release.resolve();
  await waitUntil(async () => f.fixture.internalRpcCalls.filter(call => call.url === AgentApiEndpoints.completeInteractiveAssistant.path).every(call => call.statusCode === 200), 10_000);
  assert.deepEqual(f.queue.service.snapshot(f.scope), before); assert.equal(f.fixture.llmStub!.requests.length, 1);
  assert.equal(f.queue.service.detail(f.scope, queued.receipt.id).receipt.status, "cancelled");
  assert.equal(getMessageRunState(f.fixture.db, f.scope.workspaceId, f.scope.sessionId)!.status, "idle");
  await assert.rejects(f.worker.enqueueRun({ ...f.scope, runtimeInstanceId: f.runtimeInstanceId, runId: activated.runId, workspacePath: f.fixture.workspacePath, workspaceRepoDirNames: [] }));
  assert.equal((await f.snapshot()).activeCount, 0);
});

for(const fault of ["request_lost","continuous_failure","committed_reply_lost"] as const) test(`worker S8 retirement ${fault}: undrained sends reject and the next input executes once after retirement`,{timeout:45_000},async t=>{
  const f=await interactiveWorkerFixture(t); const first=await f.accept(`retire-${fault}`);
  let originalRunId:string|undefined, attempts=0, queued:Awaited<ReturnType<typeof f.accept>>|undefined;
  const failures=fault==="continuous_failure"?3:1;
  f.fixture.internalRpcGate.before=async call=>{
    if(call.url!==AgentApiEndpoints.retireRuntimeAdmission.path) return;
    const body=call.body as {runId:string;runtimeInstanceId:string}; originalRunId??=body.runId;
    if(body.runId!==originalRunId) return;
    assert.equal(body.runtimeInstanceId,f.runtimeInstanceId); attempts++;
    if(attempts===1) {
      assert.equal((await f.snapshot()).activeCount,0,"the notifier must not retain the execution controller");
      await assert.rejects(f.accept(`before-retirement-proof-${fault}`), { statusCode: 409, code: "AGENT_QUEUE_EXECUTION_NOT_DRAINED" });
      assert.equal(f.queue.service.snapshot(f.scope).pendingCount,0);
    }
    if(fault!=="committed_reply_lost"&&attempts<=failures) throw Object.assign(new Error("isolated retirement transport unavailable"),{statusCode:503});
  };
  f.fixture.internalRpcGate.after=async call=>{
    if(call.url!==AgentApiEndpoints.retireRuntimeAdmission.path||(call.body as {runId:string}).runId!==originalRunId) return;
    if(!queued) {
      // Transport-fault error responses also pass through this onSend hook.
      if (!(call.responseBody as {retired?:boolean}).retired) return;
      assert.equal((call.responseBody as {retired:boolean}).retired,true);
      queued=await f.accept(`arrived-after-retirement-proof-${fault}`);
      assert.equal(f.queue.service.snapshot(f.scope).pendingCount,1);
    }
    if(fault==="committed_reply_lost"&&attempts===1) return "{}";
  };
  const activated=await f.queue.dispatcher.dispatchSession(f.scope);assert.ok(activated);
  f.queue.dispatcher.start();
  await waitUntil(async()=>{
    const receipt=queued&&f.queue.service.detail(f.scope,queued.receipt.id).receipt;
    return !!receipt&&receipt.status==="injected"&&receipt.confirmationState==="confirmed"&&attempts===failures+1;
  },25_000);
  await waitRunIdle(f.fixture.baseUrl,f.scope.sessionId,f.scope.workspaceId);
  assert.ok(queued);const receipt=f.queue.service.detail(f.scope,queued.receipt.id).receipt;
  assert.notEqual(receipt.runId,activated.runId);assert.equal(first.receipt.id,f.queue.service.detail(f.scope,first.receipt.id).receipt.id);
  assert.equal(f.fixture.llmStub!.requests.length,2,"a retirement retry must never execute a model again");
  assert.equal((f.fixture.db.prepare("select count(*) as n from agent_run where session_id=?").get(f.scope.sessionId) as {n:number}).n,2);
  assert.equal(f.queue.service.snapshot(f.scope).pendingCount,0);
  // Every no-candidate prepare was released by its real Assistant binding, not a TTL.
  const prepare=f.fixture.internalRpcCalls.find(call=>call.url===AgentApiEndpoints.prepareInteractiveInput.path)!;
  const replay=await f.fixture.app.inject({method:"POST",url:prepare.url,headers:{"x-awb-agent-internal-token":f.fixture.ctx.agentInternalToken,"content-type":"application/json"},payload:JSON.stringify(prepare.body)});
  assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().decision,"expired");
});

for (const networkUnknown of [false, true]) test(`worker 队列H2: 真实容量拒绝 unknown=${networkUnknown} 收敛failed/paused并发布SSE，无孤儿或误确认`, { timeout: 45_000 }, async t => {
  const f = await interactiveWorkerFixture(t);
  const originalPrepare = AgentInteractiveInputService.prototype.prepare;
  const configured = new WeakSet<AgentInteractiveInputService>();
  let contextReads = 0, oversized = true, inputService: AgentInteractiveInputService | undefined;
  t.mock.method(AgentInteractiveInputService.prototype, "prepare", function(this: AgentInteractiveInputService, input: Parameters<typeof originalPrepare>[0]) {
    if (input.sessionId === f.scope.sessionId && !configured.has(this)) {
      configured.add(this); inputService = this;
      // Test-only context assembly seam: the real service still measures/stages and commits the decision.
      const getContext = (this as any).getContext.bind(this);
      (this as any).getContext = async (scope: typeof input) => {
        contextReads++; const context = await getContext(scope);
        return oversized ? { ...context, system: "x".repeat(16 * 1024 * 1024) } : context;
      };
    }
    return originalPrepare.call(this, input);
  });
  const first = await f.accept("h2-trigger"), queued = await f.accept("h2-queued");
  let attempts = 0;
  f.fixture.internalRpcGate.before = async call => {
    if (call.url === AgentApiEndpoints.prepareInteractiveInput.path && ++attempts === 1 && networkUnknown) return "drop" as const;
  };
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 35_000);
  t.after(() => { clearTimeout(timeout); controller.abort(); });
  const stream = await fetch(`${f.fixture.baseUrl}/api/internal/agent/events/sse`, {
    headers: { "x-awb-agent-internal-token": f.fixture.ctx.agentInternalToken! }, signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  assert.equal(f.fixture.app.server.listening, true, "fixture server is still listening after opening SSE");
  const activated = await f.queue.dispatcher.dispatchSession(f.scope);
  assert.ok(activated);
  const reader = stream.body!.getReader(), decoder = new TextDecoder(); let chunks = "";
  while (!chunks.includes(`"runId":"${activated.runId}"`)) {
    const chunk = await reader.read(); assert.equal(chunk.done, false); chunks += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(chunks, /event: agent\.run\.completed\.v1/); assert.match(chunks, /"finalStatus":"failed"/); await reader.cancel();
  await waitRunIdle(f.fixture.baseUrl, f.scope.sessionId, f.scope.workspaceId);
  await waitUntil(async () => (await f.snapshot()).activeCount === 0 && f.fixture.internalRpcCalls.some(call =>
    call.url === AgentApiEndpoints.retireRuntimeAdmission.path && (call.responseBody as { retired?: boolean })?.retired === true), 10_000);
  const run = getRunRecord(f.fixture.db, activated.runId)!; assert.equal(run.status, "failed"); assert.equal(run.executionPhase, "terminal");
  const snapshot = f.queue.service.snapshot(f.scope); assert.equal(snapshot.mode, "paused"); assert.equal(snapshot.pauseCode, "prepare_snapshot_too_large");
  assert.equal(snapshot.pendingCount, 1); assert.equal(snapshot.unconfirmedInputCount, 1);
  assert.equal(f.queue.service.detail(f.scope, first.receipt.id).receipt.confirmationState, "unconfirmed");
  assert.equal(f.queue.service.detail(f.scope, queued.receipt.id).receipt.status, "queued");
  const calls = f.fixture.internalRpcCalls.filter(call => call.url === AgentApiEndpoints.prepareInteractiveInput.path);
  assert.equal(calls.length, networkUnknown ? 2 : 1); assert.equal(attempts, calls.length);
  assert.ok(calls.every(call => JSON.stringify(call.body) === JSON.stringify(calls[0]!.body)));
  const response = calls.at(-1)!.responseBody as { decision: string; reason: string };
  assert.equal(calls.at(-1)!.statusCode, 200); assert.equal(response.decision, "rejected"); assert.equal(response.reason, "snapshot_too_large");
  const rows = f.fixture.db.prepare("select result_json as json from agent_queue_operation where kind='prepare' and session_id=?").all(f.scope.sessionId) as Array<{ json: string }>;
  assert.equal(rows.length, 1); assert.deepEqual(JSON.parse(rows[0]!.json), { runId: activated.runId,
    response: { operationId: (calls[0]!.body as { operationId: string }).operationId, decision: "rejected", reason: "snapshot_too_large" } });
  assert.equal(f.fixture.llmStub!.requests.length, 0);
  assert.equal(f.fixture.internalRpcCalls.filter(call => (call.url === AgentApiEndpoints.createStreamingAssistant.path || call.url === AgentApiEndpoints.injectInteractiveInput.path)).length, 0);
  assert.equal(await f.queue.dispatcher.dispatchSession(f.scope), null);
  assert.equal((f.fixture.db.prepare("select count(*) as n from agent_run where session_id=?").get(f.scope.sessionId) as { n: number }).n, 1);
  assert.equal(contextReads, 1); assert.equal((inputService as any).frozen.bytes, 0);
  const replay = await f.fixture.app.inject({ method: "POST", url: calls[0]!.url,
    headers: { "x-awb-agent-internal-token": f.fixture.ctx.agentInternalToken!, "content-type": "application/json" }, payload: JSON.stringify(calls[0]!.body) });
  assert.equal(replay.statusCode, 200); assert.equal(replay.json().decision, "rejected"); assert.equal(contextReads, 1);
  if (!networkUnknown) {
    // After correcting the context, only an explicit user resume starts another Run.
    oversized = false;
    const resumed = await f.queue.service.resume(f.scope.sessionId, { workspaceId: f.scope.workspaceId,
      operationId: "h2-explicit-resume", expectedQueueVersion: snapshot.queueVersion });
    assert.equal(resumed.action, "continued_unconfirmed"); assert.ok(resumed.runId); assert.notEqual(resumed.runId, activated.runId);
    await waitRunIdle(f.fixture.baseUrl, f.scope.sessionId, f.scope.workspaceId);
    assert.equal(getRunRecord(f.fixture.db, resumed.runId)!.status, "completed");
    assert.equal(f.queue.service.snapshot(f.scope).unconfirmedInputCount, 0);
    assert.equal(f.fixture.llmStub!.requests.length, 1);
    return;
  }
  // Existing explicit recovery remains usable; abandoning does not delete or confirm User input.
  const abandoned = f.queue.service.abandon(f.scope.sessionId, { workspaceId: f.scope.workspaceId, operationId: "h2-explicit-abandon",
    expectedQueueVersion: snapshot.queueVersion, expectedUnconfirmedInputSetHash: snapshot.unconfirmedInputSetHash!, confirmIrreversible: true });
  assert.equal(abandoned.queue.unconfirmedInputCount, 0); assert.equal(abandoned.queue.pendingCount, 1);
  assert.equal(f.queue.service.detail(f.scope, first.receipt.id).receipt.confirmationState, "abandoned");
});
