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
import { newSortableId } from "../../utils/ids.js";

type Fixture = {
  app: FastifyInstance;
  db: Db;
  dataDir: string;
  workspaceId: string;
  workspacePath: string;
};

const fixtures = new Set<Fixture>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createFixture(): Promise<Fixture> {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "agent-it-"));

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
    agentWorkerConcurrency: 2,
    agentInternalToken: "test-internal-token",
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
  const fixture: Fixture = { app, db, dataDir, workspaceId, workspacePath };
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
  return res.json() as { messageEventId: string; runId: string; deduplicated: boolean; triggerMessageId?: string };
}

async function getRunState(app: FastifyInstance, sessionId: string) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/run-state` });
  assert.equal(res.statusCode, 200, `get run-state failed: ${res.body}`);
  return res.json() as { status: "idle" | "running" | "waiting_approval"; activeRunId: string | null };
}

async function waitRunIdle(app: FastifyInstance, sessionId: string, timeoutMs = 12_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runState = await getRunState(app, sessionId);
    if (runState.status === "idle") return;
    await sleep(60);
  }
  throw new Error(`wait run idle timeout, sessionId=${sessionId}`);
}

async function getConversation(app: FastifyInstance, sessionId: string) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/conversation` });
  assert.equal(res.statusCode, 200, `get conversation failed: ${res.body}`);
  return res.json() as {
    headEventId: string | null;
    events: Array<{ id: string; type: string; payload: Record<string, any> }>;
  };
}

test("agent 消息去重与单次落账", async () => {
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
  assert.equal(second.messageEventId, first.messageEventId);
  assert.equal(second.runId, first.runId);

  await waitRunIdle(fixture.app, session.id);
  const conversation = await getConversation(fixture.app, session.id);
  const userEvents = conversation.events.filter((event) => event.type === "user.message.created");
  assert.equal(userEvents.length, 1);
  assert.equal(userEvents[0]?.payload.clientRequestId, clientRequestId);
});

test("agent bash 输出超长时写入 artifact 并截断预览", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const message = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: `/bash node -e "process.stdout.write('x'.repeat(70000))"`,
    clientRequestId: newSortableId("req")
  });

  await waitRunIdle(fixture.app, session.id);
  const conversation = await getConversation(fixture.app, session.id);
  const toolCompleted = conversation.events.find(
    (event) => event.type === "tool.completed" && event.payload.runId === message.runId
  );
  assert.ok(toolCompleted, "missing tool.completed event");

  const output = toolCompleted?.payload.output as { truncated: boolean; artifactPath: string | null };
  assert.equal(output.truncated, true);
  assert.ok(typeof output.artifactPath === "string" && output.artifactPath.length > 0);

  const artifactFullPath = path.join(fixture.workspacePath, output.artifactPath!);
  const artifactStat = await fs.stat(artifactFullPath);
  assert.ok(artifactStat.isFile());
});

test("agent cancel 会回退 head 并阻止 bash 副作用", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const message = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: `/bash sleep 2 && touch cancel-marker.txt`,
    clientRequestId: newSortableId("req")
  });

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: {
      workspaceId: fixture.workspaceId,
      anchorEventId: message.messageEventId
    }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel failed: ${cancelRes.body}`);
  const cancelBody = cancelRes.json() as { headEventId: string | null };
  assert.equal(cancelBody.headEventId, message.messageEventId);

  await sleep(2600);
  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "idle");

  const markerPath = path.join(fixture.workspacePath, "cancel-marker.txt");
  const markerExists = await fs
    .stat(markerPath)
    .then(() => true)
    .catch(() => false);
  assert.equal(markerExists, false);

  const conversation = await getConversation(fixture.app, session.id);
  assert.equal(conversation.headEventId, message.messageEventId);
  assert.equal(conversation.events.at(-1)?.id, message.messageEventId);
});

test("agent revert 后不可见分支不再出现在会话视图", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const first = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "first line",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.app, session.id);

  await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "second line",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.app, session.id);

  const revertRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/revert`,
    payload: {
      workspaceId: fixture.workspaceId,
      toEventId: first.messageEventId,
      reason: "integration-test"
    }
  });
  assert.equal(revertRes.statusCode, 200, `revert failed: ${revertRes.body}`);

  const conversation = await getConversation(fixture.app, session.id);
  assert.equal(conversation.headEventId, first.messageEventId);

  const userMessages = conversation.events
    .filter((event) => event.type === "user.message.created")
    .map((event) => String(event.payload?.text?.preview || ""));
  assert.ok(userMessages.some((text) => text.includes("first line")));
  assert.equal(userMessages.some((text) => text.includes("second line")), false);
});

test("agent fork 会创建新 session 并包含 fork_base 事件", async () => {
  const fixture = await createFixture();
  const session = await createSession(fixture.app, fixture.workspaceId);

  const first = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "seed",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.app, session.id);

  const forkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: session.id,
      fromEventId: first.messageEventId,
      title: "forked"
    }
  });
  assert.equal(forkRes.statusCode, 201, `fork failed: ${forkRes.body}`);
  const forkSession = forkRes.json() as { id: string };

  const forkConversation = await getConversation(fixture.app, forkSession.id);
  assert.equal(forkConversation.events.length, 1);
  assert.equal(forkConversation.events[0]?.type, "session.fork_base");
  assert.equal(forkConversation.events[0]?.payload.fromSessionId, session.id);
  assert.equal(forkConversation.events[0]?.payload.fromEventId, first.messageEventId);
});
