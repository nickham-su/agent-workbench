import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../app/createApp.js";
import { openDb } from "../../infra/db/db.js";
import type { Db } from "../../infra/db/db.js";
import { ensureDir, rmrf } from "../../infra/fs/fs.js";
import { agentWorkerPidPath, workspaceRoot } from "../../infra/fs/paths.js";
import { newSortableId } from "../../utils/ids.js";
import { insertWorkspace } from "../workspaces/workspace.store.js";

type Fixture = {
  app: FastifyInstance;
  db: Db;
  dataDir: string;
  workspaceId: string;
  workspacePath: string;
  baseUrl: string;
  workerPidFilePath: string;
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

async function createFixture(): Promise<Fixture> {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "agent-worker-it-"));

  const apiPort = await getFreePort();
  const workerPort = await getFreePort();

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
    agentWorkerEnabled: true,
    agentWorkerHost: "127.0.0.1",
    agentWorkerPort: workerPort,
    agentWorkerSocketPath: path.join(dataDir, "agent-worker.sock"),
    agentWorkerConcurrency: 2,
    agentInternalToken: "worker-integration-token",
    agentApiOrigin: `http://127.0.0.1:${apiPort}`
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

  await app.listen({ host: "127.0.0.1", port: apiPort });

  const baseUrl = `http://127.0.0.1:${apiPort}`;
  await configureAgentDefaults(baseUrl);

  const fixture: Fixture = {
    app,
    db,
    dataDir,
    workspaceId,
    workspacePath,
    baseUrl,
    workerPidFilePath: agentWorkerPidPath(dataDir)
  };
  fixtures.add(fixture);
  return fixture;
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

async function configureAgentDefaults(baseUrl: string) {
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
  assert.equal(agents.response.status, 200, `configure agents failed: ${agents.text}`);
}

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
  const res = await requestJson<{ messageEventId: string; runId: string }>(baseUrl, {
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
  const res = await requestJson<{ status: string; activeRunId: string | null }>(baseUrl, {
    method: "GET",
    path: `/api/agent/sessions/${sessionId}/run-state`
  });
  assert.equal(res.response.status, 200, `get run-state failed: ${res.text}`);
  return res.json;
}

async function waitRunIdle(baseUrl: string, sessionId: string, timeoutMs = 15_000) {
  await waitUntil(async () => {
    const state = await getRunState(baseUrl, sessionId);
    return state.status === "idle";
  }, timeoutMs);
}

async function getConversation(baseUrl: string, sessionId: string) {
  const res = await requestJson<{
    headEventId: string | null;
    events: Array<{ id: string; type: string; payload: Record<string, any> }>;
  }>(baseUrl, {
    method: "GET",
    path: `/api/agent/sessions/${sessionId}/conversation`
  });
  assert.equal(res.response.status, 200, `get conversation failed: ${res.text}`);
  return res.json;
}

test("worker 模式: 消息由独立 worker 执行并回写事件", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);

  await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "/bash echo hello worker",
    clientRequestId: newSortableId("req")
  });

  await waitRunIdle(fixture.baseUrl, session.id);
  const conversation = await getConversation(fixture.baseUrl, session.id);
  const workerTurn = conversation.events.find((event) => event.type === "model.turn.started");
  assert.ok(workerTurn, "missing model.turn.started");
  assert.equal(workerTurn?.payload.model, "gpt-5.2");
});

test("worker 模式: /write 与 /read 工具可读写工作区文件", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);

  const writeRun = await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "/write notes/tool.txt hello-from-worker",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.baseUrl, session.id);

  const written = await fs.readFile(path.join(fixture.workspacePath, "notes/tool.txt"), "utf8");
  assert.equal(written, "hello-from-worker");

  const readRun = await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "/read notes/tool.txt",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.baseUrl, session.id);

  const conversation = await getConversation(fixture.baseUrl, session.id);
  const writeCompleted = conversation.events.find(
    (event) => event.type === "tool.completed" && event.payload.runId === writeRun.runId
  );
  assert.ok(writeCompleted, "missing tool.completed for write run");

  const readCompleted = conversation.events.find(
    (event) => event.type === "tool.completed" && event.payload.runId === readRun.runId
  );
  assert.ok(readCompleted, "missing tool.completed for read run");
  assert.ok(String(readCompleted?.payload.output?.preview || "").includes("1: hello-from-worker"));
});

test("worker 模式: /read 越界路径会被拒绝", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);

  const run = await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "/read ../outside.txt",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.baseUrl, session.id);

  const conversation = await getConversation(fixture.baseUrl, session.id);
  const toolFailed = conversation.events.find(
    (event) => event.type === "tool.failed" && event.payload.runId === run.runId
  );
  assert.ok(toolFailed, "missing tool.failed event");
  assert.ok(String(toolFailed?.payload.error || "").includes("outside workspace"));
});

test("worker 模式: /read 通过软链接逃逸会被拒绝", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);

  const externalFile = path.join(fixture.dataDir, "outside-secret.txt");
  await fs.writeFile(externalFile, "top-secret", "utf8");
  await fs.symlink(externalFile, path.join(fixture.workspacePath, "outside-link.txt"));

  const run = await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "/read outside-link.txt",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.baseUrl, session.id);

  const conversation = await getConversation(fixture.baseUrl, session.id);
  const toolFailed = conversation.events.find(
    (event) => event.type === "tool.failed" && event.payload.runId === run.runId
  );
  assert.ok(toolFailed, "missing tool.failed event");
  assert.ok(String(toolFailed?.payload.error || "").includes("symlink"));
});

test("worker 模式: cancel 可阻止 bash 副作用", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);

  const sent = await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: `/bash sleep 2 && touch worker-cancel-marker.txt`,
    clientRequestId: newSortableId("req")
  });

  const cancel = await requestJson<{ headEventId: string | null }>(fixture.baseUrl, {
    method: "POST",
    path: `/api/agent/sessions/${session.id}/cancel`,
    body: {
      workspaceId: fixture.workspaceId,
      anchorEventId: sent.messageEventId
    }
  });
  assert.equal(cancel.response.status, 200, `cancel failed: ${cancel.text}`);
  assert.equal(cancel.json.headEventId, sent.messageEventId);

  await sleep(2600);
  const markerPath = path.join(fixture.workspacePath, "worker-cancel-marker.txt");
  const markerExists = await fs
    .stat(markerPath)
    .then(() => true)
    .catch(() => false);
  assert.equal(markerExists, false);
});

test("worker 异常退出后可自动重启并继续处理请求", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.baseUrl, fixture.workspaceId);

  await waitUntil(async () => {
    const raw = await fs.readFile(fixture.workerPidFilePath, "utf8").catch(() => "");
    return raw.trim().length > 0;
  }, 12_000);

  const firstPidRaw = await fs.readFile(fixture.workerPidFilePath, "utf8");
  const firstPid = Number.parseInt(firstPidRaw.trim(), 10);
  assert.ok(Number.isFinite(firstPid) && firstPid > 0, `invalid worker pid: ${firstPidRaw}`);

  process.kill(firstPid, "SIGKILL");

  await waitUntil(async () => {
    const raw = await fs.readFile(fixture.workerPidFilePath, "utf8").catch(() => "");
    const nextPid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(nextPid) && nextPid > 0 && nextPid !== firstPid;
  }, 25_000, 180);

  await sendMessage(fixture.baseUrl, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "/bash echo after restart",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.baseUrl, session.id, 20_000);

  const conversation = await getConversation(fixture.baseUrl, session.id);
  const userMessages = conversation.events.filter((event) => event.type === "user.message.created");
  assert.ok(userMessages.length >= 1);
});
