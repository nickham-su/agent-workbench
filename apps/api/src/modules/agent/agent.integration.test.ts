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
  await configureAgentDefaults(app);
  const fixture: Fixture = { app, db, dataDir, workspaceId, workspacePath };
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

  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: {
      "x-awb-agent-internal-token": "test-internal-token"
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: message.runId
    }
  });
  assert.equal(profileRes.statusCode, 200, `get execution profile failed: ${profileRes.body}`);
  const profileBody = profileRes.json() as {
    resolved: { runId: string; agentId: string; providerId: string; modelId: string };
  };
  assert.equal(profileBody.resolved.runId, message.runId);
  assert.equal(profileBody.resolved.agentId, "default");
  assert.equal(profileBody.resolved.providerId, "ppchat");
  assert.equal(profileBody.resolved.modelId, "gpt-5.2");

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
  assert.ok(forkConversation.events.length >= 2);
  assert.equal(forkConversation.events[0]?.type, "session.fork_base");
  assert.equal(forkConversation.events[0]?.payload.fromSessionId, session.id);
  assert.equal(forkConversation.events[0]?.payload.fromEventId, first.messageEventId);

  const firstUser = forkConversation.events.find((event) => event.type === "user.message.created");
  assert.ok(firstUser, "missing cloned user.message.created");
  assert.ok(String(firstUser?.payload?.text?.preview || "").includes("seed"));
});

test("agent provider 设置 GET 脱敏且 PUT 省略 apiKey 时保留旧值", async () => {
  const fixture = await createFixture();

  const secretKey = "sk-live-123456";
  const updateWithKey = await fixture.app.inject({
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
            apiKey: secretKey
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
  assert.equal(updateWithKey.statusCode, 200, `update providers with key failed: ${updateWithKey.body}`);

  const firstGet = await fixture.app.inject({
    method: "GET",
    url: "/api/settings/agent/providers"
  });
  assert.equal(firstGet.statusCode, 200, `get providers failed: ${firstGet.body}`);
  const firstBody = firstGet.json() as {
    providers: Array<{
      id: string;
      options: { hasApiKey: boolean; apiKeyMasked: string | null; baseURL: string };
    }>;
  };
  const firstProvider = firstBody.providers.find((item) => item.id === "ppchat");
  assert.ok(firstProvider, "missing provider 'ppchat'");
  assert.equal(firstProvider?.options.hasApiKey, true);
  assert.ok(firstProvider?.options.apiKeyMasked?.endsWith("3456"));
  assert.notEqual(firstProvider?.options.apiKeyMasked, secretKey);

  const updateWithoutKey = await fixture.app.inject({
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
            baseURL: "https://code.ppchat.vip/v1"
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
  assert.equal(updateWithoutKey.statusCode, 200, `update providers without key failed: ${updateWithoutKey.body}`);

  const secondGet = await fixture.app.inject({
    method: "GET",
    url: "/api/settings/agent/providers"
  });
  assert.equal(secondGet.statusCode, 200, `get providers failed: ${secondGet.body}`);
  const secondBody = secondGet.json() as {
    providers: Array<{
      id: string;
      options: { hasApiKey: boolean; apiKeyMasked: string | null };
    }>;
  };
  const secondProvider = secondBody.providers.find((item) => item.id === "ppchat");
  assert.ok(secondProvider, "missing provider 'ppchat' after update");
  assert.equal(secondProvider?.options.hasApiKey, true);
  assert.ok(secondProvider?.options.apiKeyMasked?.endsWith("3456"));

  const session = await createSession(fixture.app, fixture.workspaceId);
  const message = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hello settings",
    clientRequestId: newSortableId("req")
  });

  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: {
      "x-awb-agent-internal-token": "test-internal-token"
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: message.runId
    }
  });
  assert.equal(profileRes.statusCode, 200, `get execution profile failed: ${profileRes.body}`);
  const profileBody = profileRes.json() as {
    provider: {
      options: {
        apiKey: string;
      };
    };
  };
  assert.equal(profileBody.provider.options.apiKey, secretKey);
});

test("agent provider 支持 anthropic 并可解析 execution profile", async () => {
  const fixture = await createFixture();

  const setRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: {
        providerId: "anthropic-main",
        modelId: "claude-3-7-sonnet-20250219"
      },
      providers: [
        {
          id: "anthropic-main",
          name: "Anthropic",
          npm: "@ai-sdk/anthropic",
          options: {
            baseURL: "https://api.anthropic.com/v1",
            apiKey: "sk-ant-test"
          },
          models: [
            {
              id: "claude-3-7-sonnet-20250219",
              name: "Claude 3.7 Sonnet",
              options: {
                aiSdk: {
                  maxOutputTokens: 1024
                },
                providerOptionsByKey: {
                  anthropic: {
                    thinking: {
                      type: "enabled",
                      budgetTokens: 256
                    }
                  }
                }
              }
            }
          ]
        }
      ]
    }
  });
  assert.equal(setRes.statusCode, 200, `set anthropic provider failed: ${setRes.body}`);

  const session = await createSession(fixture.app, fixture.workspaceId);
  const sent = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "/bash echo provider profile",
    clientRequestId: newSortableId("req")
  });

  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: {
      "x-awb-agent-internal-token": "test-internal-token"
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: sent.runId
    }
  });
  assert.equal(profileRes.statusCode, 200, `get anthropic profile failed: ${profileRes.body}`);
  const profile = profileRes.json() as {
    provider: {
      id: string;
      npm: string;
      options: { baseURL: string; apiKey: string };
    };
    model: {
      options?: Record<string, unknown>;
    };
  };

  assert.equal(profile.provider.id, "anthropic-main");
  assert.equal(profile.provider.npm, "@ai-sdk/anthropic");
  assert.equal(profile.provider.options.baseURL, "https://api.anthropic.com/v1");
  assert.equal(profile.provider.options.apiKey, "sk-ant-test");
  assert.equal((profile.model.options?.aiSdk as Record<string, unknown>)?.maxOutputTokens, 1024);
});
