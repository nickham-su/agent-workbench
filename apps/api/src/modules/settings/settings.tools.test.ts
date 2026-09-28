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
  getAgentProviderModels,
  getAgentProvidersSettingsInternal,
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
      preview: { enabled: false, runtime: null },
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
      options: { baseURL: "https://api.example.test", apiKey: null },
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

function configureModelListProvider(ctx: AppContext, npm: "@ai-sdk/moonshotai" | "@ai-sdk/deepseek" | "@ai-sdk/anthropic" | "@ai-sdk/openai", baseURL: string) {
  updateAgentProvidersSettings(ctx, createLogger(), { default: null, providers: [{
    id: "provider_1", name: "Provider", npm,
    options: { baseURL, apiKey: "fixture-key" },
    models: [
      { id: "local-id", providerModelId: "remote-id", name: "Model", contextWindowTokens: 128000, options: {} },
      { id: "custom-local", providerModelId: "custom-provider-id", name: "Custom", contextWindowTokens: 128000, options: {} },
    ]
  }] });
}

test("Moonshot and DeepSeek discover remote models with Bearer, preserving configured actual IDs", async () => {
  const { ctx, db } = await createFixture();
  const oldFetch = globalThis.fetch;
  try {
    for (const [npm, baseURL, expectedUrl] of [
      ["@ai-sdk/moonshotai", "https://api.moonshot.cn/v1", "https://api.moonshot.cn/v1/models"],
      ["@ai-sdk/moonshotai", "https://api.moonshot.ai", "https://api.moonshot.ai/v1/models"],
      ["@ai-sdk/deepseek", "https://api.deepseek.com", "https://api.deepseek.com/models"],
      ["@ai-sdk/deepseek", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/models"],
      ["@ai-sdk/deepseek", "https://gateway.example.test/deepseek/v1", "https://gateway.example.test/deepseek/v1/models"],
    ] as const) {
      configureModelListProvider(ctx, npm, baseURL);
      let fetches = 0;
      globalThis.fetch = async (input, init) => {
        fetches++;
        assert.equal(String(input), expectedUrl);
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
        assert.equal(new Headers(init?.headers).get("x-api-key"), null);
        return new Response(JSON.stringify({ object: "list", data: [
          { id: "remote-id" }, { id: "new-model" }, { id: "new-model" },
        ] }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      const first = await getAgentProviderModels(ctx, createLogger(), { providerId: "provider_1" }, { refresh: true });
      assert.equal(first.source, "remote");
      assert.equal(first.warning, null);
      assert.deepEqual(first.items.map((item) => item.id), ["remote-id", "new-model", "custom-provider-id"]);
      const cached = await getAgentProviderModels(ctx, createLogger(), { providerId: "provider_1" });
      assert.equal(cached.source, "cache");
      assert.equal(fetches, 1);
      await getAgentProviderModels(ctx, createLogger(), { providerId: "provider_1" }, { refresh: true });
      assert.equal(fetches, 2);
    }
  } finally {
    globalThis.fetch = oldFetch;
    db.close();
  }
});

test("remote discovery retains Anthropic authentication and falls back on unsafe or invalid responses", async () => {
  const { ctx, db } = await createFixture();
  const oldFetch = globalThis.fetch;
  const logged: unknown[] = [];
  const logger = { warn: (...args: unknown[]) => { logged.push(args); } } as unknown as FastifyBaseLogger;
  try {
    configureModelListProvider(ctx, "@ai-sdk/anthropic", "https://api.anthropic.com/v1");
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://api.anthropic.com/v1/models");
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      assert.equal(new Headers(init?.headers).get("x-api-key"), "fixture-key");
      assert.ok(new Headers(init?.headers).get("anthropic-version"));
      return new Response(JSON.stringify({ data: [{ id: "anthropic-remote" }] }), { status: 200 });
    };
    const anthropic = await getAgentProviderModels(ctx, logger, { providerId: "provider_1" }, { refresh: true });
    assert.equal(anthropic.source, "remote");

    configureModelListProvider(ctx, "@ai-sdk/openai", "https://api.openai.com/v1");
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://api.openai.com/v1/models");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
      assert.equal(new Headers(init?.headers).get("x-api-key"), null);
      return new Response(JSON.stringify({ data: [{ id: "openai-model" }] }), { status: 200 });
    };
    const openai = await getAgentProviderModels(ctx, logger, { providerId: "provider_1" }, { refresh: true });
    assert.equal(openai.source, "remote");

    for (const npm of ["@ai-sdk/moonshotai", "@ai-sdk/deepseek"] as const) {
      configureModelListProvider(ctx, npm, "https://custom.example.test/gateway");
      for (const response of [
        new Response(JSON.stringify({ error: { message: "private-response" } }), { status: 401 }),
        new Response(JSON.stringify({ error: { message: "private-response" } }), { status: 200 }),
        new Response(JSON.stringify({ data: [{ notAnId: "private-response" }] }), { status: 200 }),
      ]) {
        globalThis.fetch = async (_input, init) => {
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
          return response;
        };
        const fallback = await getAgentProviderModels(ctx, logger, { providerId: "provider_1" }, { refresh: true });
        assert.equal(fallback.source, "fallback");
        assert.ok(fallback.warning);
        assert.deepEqual(fallback.items.map((item) => item.id), ["remote-id", "custom-provider-id"]);
      }
      globalThis.fetch = async (_input, init) => {
        assert.ok(init?.signal);
        throw new DOMException("discovery timed out", "TimeoutError");
      };
      const timedOut = await getAgentProviderModels(ctx, logger, { providerId: "provider_1" }, { refresh: true });
      assert.equal(timedOut.source, "fallback");
      assert.deepEqual(timedOut.items.map((item) => item.id), ["remote-id", "custom-provider-id"]);
      globalThis.fetch = async () => { throw new Error("private-response fixture-key"); };
      const unavailable = await getAgentProviderModels(ctx, logger, { providerId: "provider_1" }, { refresh: true });
      assert.equal(unavailable.source, "fallback");
      assert.deepEqual(unavailable.items.map((item) => item.id), ["remote-id", "custom-provider-id"]);
    }
    const diagnostic = JSON.stringify(logged);
    for (const secret of ["fixture-key", "custom.example.test", "private-response", "discovery timed out"]) {
      assert.equal(diagnostic.includes(secret), false);
    }
  } finally {
    globalThis.fetch = oldFetch;
    db.close();
  }
});

test("model discovery refuses endpoint credentials and redirects without forwarding Bearer", async () => {
  const { ctx, db } = await createFixture();
  const oldFetch = globalThis.fetch;
  try {
    configureModelListProvider(ctx, "@ai-sdk/moonshotai", "https://private-user:private-pass@custom.example.test/v1");
    globalThis.fetch = async () => { throw new Error("unexpected discovery request"); };
    const unsafe = await getAgentProviderModels(ctx, createLogger(), { providerId: "provider_1" }, { refresh: true });
    assert.equal(unsafe.source, "fallback");
    assert.deepEqual(unsafe.items.map((item) => item.id), ["remote-id", "custom-provider-id"]);

    configureModelListProvider(ctx, "@ai-sdk/deepseek", "https://custom.example.test/gateway");
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } });
    };
    const redirected = await getAgentProviderModels(ctx, createLogger(), { providerId: "provider_1" }, { refresh: true });
    assert.equal(redirected.source, "fallback");

    configureModelListProvider(ctx, "@ai-sdk/deepseek", "https://custom.example.test/v1?token=private");
    globalThis.fetch = async () => { throw new Error("query string must not be sent"); };
    const query = await getAgentProviderModels(ctx, createLogger(), { providerId: "provider_1" }, { refresh: true });
    assert.equal(query.source, "fallback");

    configureModelListProvider(ctx, "@ai-sdk/moonshotai", "https://api.moonshot.ai/v1");
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const empty = await getAgentProviderModels(ctx, createLogger(), { providerId: "provider_1" }, { refresh: true });
    assert.equal(empty.source, "remote");
    assert.deepEqual(empty.items.map((item) => item.id), ["remote-id", "custom-provider-id"]);
  } finally {
    globalThis.fetch = oldFetch;
    db.close();
  }
});

test("model refresh fallback never logs configured URL or an untrusted fetch error", async () => {
  const { ctx, db } = await createFixture();
  const sensitiveURL = "https://private-user:private-pass@invalid.example/v1?private-query=hidden#private-fragment";
  updateAgentProvidersSettings(ctx, createLogger(), { default: null, providers: [{
    id: "provider_1", name: "Provider", npm: "@ai-sdk/openai",
    options: { baseURL: sensitiveURL, apiKey: "fixture-key" },
    models: [{ id: "model_1", providerModelId: "model-1", name: "Model", contextWindowTokens: 128000, options: {} }]
  }] });
  const logged: unknown[] = [];
  const logger = { warn: (...args: unknown[]) => { logged.push(args); } } as unknown as FastifyBaseLogger;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error(`fetch failed at ${sensitiveURL}`); };
  try {
    const result = await getAgentProviderModels(ctx, logger, { providerId: "provider_1" }, { refresh: true });
    assert.equal(result.source, "fallback");
    assert.equal(logged.length, 1);
    const diagnostic = JSON.stringify(logged);
    for (const secret of ["private-user", "private-pass", "private-query", "private-fragment", sensitiveURL]) {
      assert.equal(diagnostic.includes(secret), false, "fallback log must not expose endpoint credentials");
    }
  } finally {
    globalThis.fetch = oldFetch;
    db.close();
  }
});

test("agent settings persist archive tools while filtering hidden baseline tools", async () => {
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
        "archive_read",
        "archive_search",
        "read",
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

  assert.deepEqual(updated.agents[0]?.tools, ["bash", "todolist", "visual_analyze", "archive_read", "archive_search"]);
  assert.deepEqual(getAgentSettings(ctx).agents[0]?.tools, ["bash", "todolist", "visual_analyze", "archive_read", "archive_search"]);
  assert.deepEqual(
    (getSettingJson(db, AGENT_SETTINGS_KEY)?.value as { agents: Array<{ tools: string[] }> }).agents[0]?.tools,
    ["bash", "todolist", "visual_analyze", "archive_read", "archive_search"]
  );
});
test("saving new Provider models strips reserved options without dropping legal settings", async () => {
  const { ctx } = await createFixture();
  updateAgentProvidersSettings(ctx, createLogger(), { default: null, providers: [{
    id: "kimi", name: "Kimi", npm: "@ai-sdk/moonshotai",
    options: { baseURL: "https://api.moonshot.ai/v1", apiKey: null },
    models: [{ id: "local", providerModelId: "kimi-k2.6", name: "Kimi 2.6", contextWindowTokens: 1024,
      options: { providerOptionsByKey: { moonshotai: {
        thinking: { type: "disabled" }, "reasoning-history": "ignored", reasoningEffort: "high",
        parallelToolCalls: true, custom: { thinking: "ordinary", constructor: "bad" },
      } } } }],
  }] });
  const options = getAgentProvidersSettingsInternal(ctx).providers.find((provider) => provider.id === "kimi")
    ?.models[0]?.options?.providerOptionsByKey?.moonshotai;
  assert.deepEqual(options, { parallelToolCalls: true, custom: { thinking: "ordinary" } });
});
