import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import type { AppContext } from "../../app/context.js";
import { openDb } from "../../infra/db/db.js";
import { getSettingJson } from "./settings.store.js";
import {
  getAgentSettings,
  registerGlobalSystemPromptTextProvider,
  updateAgentProvidersSettings,
  updateAgentSettings
} from "./settings.service.js";

const AGENT_SETTINGS_KEY = "agent_agents_v1";
const tempDirs: string[] = [];

function createLogger() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => createLogger()
  } as unknown as FastifyBaseLogger;
}

async function createFixture() {
  registerGlobalSystemPromptTextProvider(() => "test global system prompt");

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-agent-settings-tools-test-"));
  tempDirs.push(dataDir);
  const db = await openDb(dataDir);
  const ctx = {
    db,
    repoRoot: process.cwd(),
    dataDir,
    fileMaxBytes: 1024 * 1024,
    version: "test",
    serveWeb: false,
    webDistDir: null,
    credentialMasterKey: Buffer.alloc(32, 7),
    credentialMasterKeySource: "generated",
    credentialMasterKeyId: "testkey",
    credentialMasterKeyCreatedAt: 1,
    authToken: null,
    authCookieSecure: false,
    agentWorkerEnabled: false,
    agentWorkerHost: "127.0.0.1",
    agentWorkerPort: 0,
    agentWorkerSocketPath: path.join(dataDir, "agent-worker.sock"),
    agentWorkerConcurrency: 1,
    agentInternalToken: "token",
    agentWorkerResponseValidation: "strict",
    agentApiOrigin: "http://127.0.0.1:0",
    agentStartupRecoveryMode: "recover",
    agentPluginHostEnabled: false,
    agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock"),
    agentPluginServicesEnabled: false
  } satisfies AppContext;

  updateAgentProvidersSettings(ctx, createLogger(), {
    default: null,
    providers: [{
      id: "provider_1",
      name: "Provider",
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://api.example.test", apiKey: null, apiMode: "responses" },
      models: [{
        id: "model_1",
        providerModelId: "model-1",
        name: "Model",
        contextWindowTokens: 128000,
        options: {}
      }]
    }]
  });

  return { ctx, db };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("agent settings persist todolist and visual_analyze while filtering hidden default tools", async () => {
  const { ctx, db } = await createFixture();

  const updated = updateAgentSettings(ctx, createLogger(), {
    agents: [{
      id: "agent_1",
      name: "Agent",
      summary: "",
      prompt: "",
      globalPromptIds: [],
      tools: [
        "bash",
        "todolist",
        "visual_analyze",
        "read",
        "archive_search",
        "archive_read",
        "skill",
        "todolist"
      ],
      mcpServers: [],
      pluginTools: [],
      defaultModel: { providerId: "provider_1", modelId: "model_1" },
      scope: "both",
      order: 0
    }]
  });

  assert.deepEqual(updated.agents[0]?.tools, ["bash", "todolist", "visual_analyze"]);
  assert.deepEqual(getAgentSettings(ctx).agents[0]?.tools, ["bash", "todolist", "visual_analyze"]);
  assert.deepEqual(
    (getSettingJson(db, AGENT_SETTINGS_KEY)?.value as { agents: Array<{ tools: string[] }> }).agents[0]?.tools,
    ["bash", "todolist", "visual_analyze"]
  );
});
