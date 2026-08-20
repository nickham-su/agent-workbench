import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../app/createApp.js";
import { openDb } from "../../infra/db/db.js";
import type { Db } from "../../infra/db/db.js";
import { ensureDir, rmrf } from "../../infra/fs/fs.js";
import { agentWorkerPidPath, workspaceRoot } from "../../infra/fs/paths.js";
import { newSortableId } from "../../utils/ids.js";
import { insertWorkspace } from "../workspaces/workspace.store.js";
import { getRunRecord } from "./agent.store.js";

type InternalRpcCall = { method: string; url: string; body: unknown; statusCode?: number };

type Fixture = {
  app: FastifyInstance;
  db: Db;
  dataDir: string;
  workspaceId: string;
  workspacePath: string;
  baseUrl: string;
  workerPidFilePath: string;
  llmStub?: HttpServer;
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

async function requestJson<T>(baseUrl: string, input: { method: string; path: string; body?: unknown }) {
  const response = await fetch(`${baseUrl}${input.path}`, {
    method: input.method,
    headers: {
      "content-type": "application/json"
    },
    body: input.body == null ? undefined : JSON.stringify(input.body)
  });
  const text = await response.text();
  const json = text ? (JSON.parse(text) as T) : (null as T);
  return { response, json, text };
}

async function startLlmStubServer(mode: "failure" | "success" = "failure") {
  const server = createHttpServer((req, res) => {
    if (mode === "success") {
      let requestBody = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        requestBody += chunk;
      });
      req.on("end", () => {
        const request = requestBody ? JSON.parse(requestBody) as { stream?: unknown } : {};
        if (request.stream === true) {
          const chunks = [
            { id: "stub", created: 1, model: "gpt-5.2", choices: [{ index: 0, delta: { role: "assistant", content: "stub response" }, finish_reason: null }] },
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
    baseURL: `http://127.0.0.1:${addr.port}/v1`
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

async function createFixture(params: { llmMode?: "failure" | "success" } = {}): Promise<Fixture> {
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
      agentWorkerEnabled: true,
      agentWorkerHost: "127.0.0.1",
      agentWorkerPort: workerPort,
      agentWorkerSocketPath: path.join(dataDir, "agent-worker.sock"),
      agentWorkerConcurrency: 2,
      agentInternalToken: "worker-integration-token",
      agentWorkerResponseValidation: "strict",
      agentApiOrigin: `http://127.0.0.1:${apiPort}`,
      agentStartupRecoveryMode: "recover",
      agentPluginHostEnabled: false,
      agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock")
    });

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
      dataDir,
      workspaceId,
      workspacePath,
      baseUrl,
      workerPidFilePath: agentWorkerPidPath(dataDir),
      llmStub: llmStub.server,
      internalRpcCalls
    };
    fixtures.add(fixture);
    return fixture;
  } catch (err) {
    // Best-effort cleanup to avoid leaving worker process / server handles behind,
    // which may cause the test runner to hang.
    const errors: unknown[] = [];
    try {
      if (llmStub) await new Promise<void>((resolve) => llmStub?.server.close(() => resolve()));
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
    await new Promise<void>((resolve) => fixture.llmStub?.close(() => resolve()));
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
  const res = await requestJson<{ messageItemId: number; runId: string }>(baseUrl, {
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

async function getRunState(baseUrl: string, sessionId: string) {
  const res = await requestJson<{ status: string }>(baseUrl, {
    method: "GET",
    path: `/api/agent/sessions/${sessionId}/run-state`
  });
  assert.equal(res.response.status, 200, `get run-state failed: ${res.text}`);
  return res.json;
}

async function waitRunIdle(baseUrl: string, sessionId: string, timeoutMs = 20_000) {
  await waitUntil(async () => {
    const state = await getRunState(baseUrl, sessionId);
    return state.status === "idle";
  }, timeoutMs);
}

test("worker 模式: 发送消息后会落地 context items", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);

  await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hello worker",
    clientRequestId: newSortableId("req")
  });

  await waitRunIdle(fixture.baseUrl, session.id);

  const context = await requestJson<{
    items: Array<{ kind: string; output: Record<string, any> }>;
  }>(fixture.baseUrl, {
    method: "GET",
    path: `/api/agent/sessions/${session.id}/context-items`
  });
  assert.equal(context.response.status, 200, `get context-items failed: ${context.text}`);
  assert.ok(context.json.items.some((item) => item.kind === "user"));
  assert.ok(context.json.items.some((item) => item.kind === "assistant"));
  const failedAssistant = context.json.items.find((item) => item.kind === "assistant" && item.output?.type === "assistant_text");
  assert.ok(failedAssistant, "assistant item should exist");
  assert.equal(typeof failedAssistant?.output?.text, "string");
  assert.equal(
    typeof failedAssistant?.output?.error,
    "string",
    "worker failure should be persisted as assistant output.error"
  );

  const internalCalls = fixture.internalRpcCalls;
  const callIndex = (predicate: (call: Fixture["internalRpcCalls"][number]) => boolean) => {
    const index = internalCalls.findIndex(predicate);
    assert.notEqual(index, -1, "real API-managed Worker internal request was not recorded");
    return index;
  };
  const contextCreateIndex = callIndex((call) => call.method === "POST" && call.url === "/api/internal/agent/context-items");
  const runStateIndex = callIndex((call) => call.method === "POST" && call.url === "/api/internal/agent/run-state");
  const contextUpdateIndex = callIndex((call) => call.method === "PATCH" && call.url.startsWith("/api/internal/agent/context-items/"));
  const runCompleteIndex = callIndex((call) => call.method === "POST" && call.url === "/api/internal/agent/run-complete");
  assert.notEqual(contextCreateIndex, runStateIndex, "context create and run-state should be distinct requests");
  assert.notEqual(runStateIndex, contextUpdateIndex, "run-state and context update should be distinct requests");
  assert.ok(runStateIndex < contextUpdateIndex, "run-state should precede context update writeback");
  assert.ok(contextUpdateIndex < runCompleteIndex, "context update should precede run completion");

  const contextCreateBody = internalCalls[contextCreateIndex]?.body as { workspaceId?: unknown; sessionId?: unknown; runId?: unknown };
  const runStateBody = internalCalls[runStateIndex]?.body as { workspaceId?: unknown; sessionId?: unknown; activeRunId?: unknown };
  const runCompleteBody = internalCalls[runCompleteIndex]?.body as { workspaceId?: unknown; sessionId?: unknown; runId?: unknown };
  for (const [name, body] of [["context create", contextCreateBody], ["run-state", runStateBody], ["run-complete", runCompleteBody]] as const) {
    assert.equal(body.workspaceId, fixture.workspaceId, `${name} should carry workspaceId`);
    assert.equal(body.sessionId, session.id, `${name} should carry sessionId`);
  }
  assert.equal(typeof contextCreateBody.runId, "string");
  assert.equal(typeof runStateBody.activeRunId, "string");
  assert.equal(typeof runCompleteBody.runId, "string");
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
  await waitRunIdle(fixture.baseUrl, session.id);
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
  await waitRunIdle(fixture.baseUrl, session.id);

  const expected = [
    { endpoint: "/api/internal/agent/execution-profile", runBound: true },
    { endpoint: "/api/internal/agent/prompt-context", runBound: true },
    { endpoint: "/api/internal/agent/messages-context", runBound: false }
  ] as const;
  const indices = expected.map(({ endpoint }) => {
    const index = fixture.internalRpcCalls.findIndex((call) => call.method === "POST" && call.url === endpoint);
    assert.notEqual(index, -1, `real API-managed Worker did not request ${endpoint}`);
    return index;
  });
  assert.ok(indices[0]! < indices[1]!, "execution profile must precede prompt context");
  assert.ok(indices[1]! < indices[2]!, "prompt context must precede messages context");

  for (const [index, requirement] of expected.entries()) {
    const call = fixture.internalRpcCalls[indices[index]!]!;
    const body = call.body as { workspaceId?: unknown; sessionId?: unknown; runId?: unknown };
    assert.ok((call.statusCode || 0) >= 200 && (call.statusCode || 0) < 300, `${requirement.endpoint} must return 2xx`);
    assert.equal(body.workspaceId, fixture.workspaceId, `${requirement.endpoint} must carry workspaceId`);
    assert.equal(body.sessionId, session.id, `${requirement.endpoint} must carry sessionId`);
    if (requirement.runBound) {
      assert.equal(body.runId, compact.json.runId, `${requirement.endpoint} must carry compact runId`);
    } else {
      assert.equal(Object.hasOwn(body, "runId"), false, "messages-context must remain session-bound");
    }
  }

  const completedRun = getRunRecord(fixture.db, compact.json.runId);
  assert.equal(completedRun?.status, "completed", "Worker must complete the compact run after consuming read-side responses");
  const compactWrite = fixture.internalRpcCalls.find((call) =>
    call.method === "POST" && call.url === "/api/internal/agent/context/compact"
  );
  assert.ok(compactWrite, "Worker must submit the generated compaction summary after reading context");
  assert.ok((compactWrite?.statusCode || 0) >= 200 && (compactWrite?.statusCode || 0) < 300, "compaction write must return 2xx");

  const context = await requestJson<{
    items: Array<{ kind: string; runId: string | null; boundaryReason: string | null; output: { type?: string; text?: string } }>;
  }>(fixture.baseUrl, {
    method: "GET",
    path: `/api/agent/sessions/${session.id}/context-items`
  });
  assert.equal(context.response.status, 200, `get compacted context failed: ${context.text}`);
  const summary = context.json.items.find((item) => item.runId === compact.json.runId && item.boundaryReason === "compaction");
  assert.ok(summary, "successful compaction must persist a compaction boundary item");
  assert.equal(summary?.kind, "system");
  assert.equal(summary?.output?.type, "system_text");
  assert.equal(typeof summary?.output?.text, "string");
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
