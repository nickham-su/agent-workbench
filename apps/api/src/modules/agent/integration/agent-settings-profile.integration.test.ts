import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setSettingJson } from "../../settings/settings.store.js";
import { normalizeMaxSubtaskDepthForUpdate } from "../../settings/settings.service.js";
import { createAgentSession, createRunRecord, getRunRecord } from "../agent.store.js";
import { newSortableId } from "../../../utils/ids.js";
import {
  createAgentIntegrationFixture,
  createPrimarySession,
  sendAgentMessage,
  type AgentIntegrationFixture
} from "../testkit/agent-integration-testkit.js";

test("GET /api/settings/agent/agents 返回每个 agent 的 resolvedModel", async (t) => {
  const fixture = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(async () => {
    await fixture.dispose();
  });

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
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          pluginTools: [],
          mcpServers: [],
          defaultModel: { providerId: "global_provider", modelId: "global_model" },
          scope: "both",
          order: 0
        },
        {
          id: "custom",
          name: "custom",
          summary: "",
          prompt: "Use a custom model.",
          tools: ["bash", "read"],
          pluginTools: [],
          mcpServers: [],
          defaultModel: { providerId: "agent_provider", modelId: "agent_model" },
          scope: "both",
          order: 1
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
    source: "agent_default"
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

async function createIntegrationFixtureForTest(
  t: TestContext,
  options?: Parameters<typeof createAgentIntegrationFixture>[0]
) {
  const value = await createAgentIntegrationFixture(options);
  t.after(async () => {
    await value.dispose();
  });
  return value;
}

function createSubtaskSessionForSettingsTest(fixture: AgentIntegrationFixture, params?: {
  title?: string;
  forkedFromSessionId?: string | null;
  forkedFromItemId?: number | null;
}) {
  const createdAt = Date.now();
  const id = newSortableId("sess");
  createAgentSession(fixture.db, {
    id,
    workspaceId: fixture.workspaceId,
    title: params?.title || "it-subtask-session",
    kind: "subtask",
    createdAt,
    forkedFromSessionId: params?.forkedFromSessionId ?? null,
    forkedFromItemId: params?.forkedFromItemId ?? null
  });
  return { id };
}

test("maxSubtaskDepth 更新规范化只接受有限整数范围", async (t: TestContext) => {
  assert.equal(normalizeMaxSubtaskDepthForUpdate(1), 1);
  assert.equal(normalizeMaxSubtaskDepthForUpdate(5), 5);
  for (const invalid of ["1", "5", 1.5, 0, 6, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => normalizeMaxSubtaskDepthForUpdate(invalid),
      (err: unknown) => (err as { statusCode?: unknown; code?: unknown }).statusCode === 400
        && (err as { code?: unknown }).code === "AGENT_MAX_SUBTASK_DEPTH_INVALID"
    );
  }
});

test("agent settings 兼容缺省 scope/order 并按原顺序归一化", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);
  const res = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "b",
          name: "B",
           summary: "",
           prompt: "b",
           tools: ["bash", "read"],
           pluginTools: [],
           mcpServers: [],
           defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
           scope: "both",
           order: 9
        },
        {
          id: "a",
          name: "A",
           summary: "",
           prompt: "a",
           tools: ["bash", "read"],
           pluginTools: [],
           mcpServers: [],
           defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
           scope: "user",
           order: 3
        }
      ]
    }
  });
  assert.equal(res.statusCode, 200, `update agent settings failed: ${res.body}`);

  setSettingJson(fixture.db, "agent_agents_v1", {
    agents: [
      { id: "legacy-1", name: "Legacy 1", summary: "", prompt: "", tools: ["bash"], pluginTools: [], mcpServers: [], defaultModel: null },
      { id: "legacy-2", name: "Legacy 2", summary: "", prompt: "", tools: ["read"], pluginTools: [], mcpServers: [], defaultModel: null }
    ]
  }, Date.now());

  const getRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/agents" });
  assert.equal(getRes.statusCode, 200, `get agent settings failed: ${getRes.body}`);
  const body = getRes.json() as { agents: Array<{ id: string; scope: string; order: number }> };
  assert.deepEqual(body.agents.map((item) => ({ id: item.id, scope: item.scope, order: item.order })), [
    { id: "legacy-1", scope: "both", order: 0 },
    { id: "legacy-2", scope: "both", order: 1 }
  ]);
});

test("agent settings 保存并回读 scratchpad，默认工具列表仍不包含它", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);
  const res = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "",
          tools: ["bash", "scratchpad", "read", "scratchpad", "subtask"],
          pluginTools: [],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(res.statusCode, 200, `update agent settings failed: ${res.body}`);

  const body = res.json() as { agents: Array<{ tools: string[] }> };
  assert.deepEqual(body.agents[0]?.tools, ["bash", "scratchpad", "subtask"]);

  const getRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/agents" });
  assert.equal(getRes.statusCode, 200, `get agent settings failed: ${getRes.body}`);
  const getBody = getRes.json() as { agents: Array<{ tools: string[] }> };
  assert.deepEqual(getBody.agents[0]?.tools, ["bash", "scratchpad", "subtask"]);

  setSettingJson(fixture.db, "agent_agents_v1", {
    agents: [
      { id: "legacy", name: "Legacy", summary: "", prompt: "", tools: undefined, pluginTools: [], mcpServers: [], defaultModel: null }
    ]
  }, Date.now());
  const fallbackRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/agents" });
  const fallbackBody = fallbackRes.json() as { agents: Array<{ tools: string[] }> };
  assert.deepEqual(fallbackBody.agents[0]?.tools, ["bash", "write", "apply_patch", "subtask"]);
});

test("agent scope 校验会拒绝错误场景的 agent 并在无可用 agent 时返回明确错误", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);
  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        { id: "subtask-only", name: "Subtask Only", summary: "", prompt: "", tools: ["bash", "read"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "subtask", order: 0 }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);

  const session = await createPrimarySession(fixture);
  const wrongRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    payload: { workspaceId: fixture.workspaceId, text: "hi", clientRequestId: "req_scope_wrong", agentId: "subtask-only" }
  });
  assert.equal(wrongRes.statusCode, 400, `wrong scope should fail: ${wrongRes.body}`);
  assert.equal(wrongRes.json().code, "AGENT_SCOPE_NOT_ALLOWED");

  const fallbackRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    payload: { workspaceId: fixture.workspaceId, text: "hi", clientRequestId: "req_scope_none" }
  });
  assert.equal(fallbackRes.statusCode, 400, `no available user agent should fail: ${fallbackRes.body}`);
  assert.equal(fallbackRes.json().code, "AGENT_NO_AVAILABLE_FOR_SURFACE");
});

test("agent runtime settings maxSubtaskDepth 默认值、边界和非法更新", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);

  const defaultRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/runtime" });
  assert.equal(defaultRes.statusCode, 200);
  assert.equal(defaultRes.json().maxSubtaskDepth, 1);

  const minRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { maxSubtaskDepth: 1 }
  });
  assert.equal(minRes.statusCode, 200, minRes.body);
  assert.equal(minRes.json().maxSubtaskDepth, 1);

  const maxRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { maxSubtaskDepth: 5 }
  });
  assert.equal(maxRes.statusCode, 200, maxRes.body);
  assert.equal(maxRes.json().maxSubtaskDepth, 5);

  for (const invalid of [0, 6, -1, 1.5, "1", "5"]) {
    const invalidRes = await fixture.app.inject({
      method: "PUT",
      url: "/api/settings/agent/runtime",
      payload: { maxSubtaskDepth: invalid }
    });
    assert.equal(invalidRes.statusCode, 400, invalidRes.body);
    assert.equal(invalidRes.json().code, "AGENT_MAX_SUBTASK_DEPTH_INVALID");
  }

  const unchangedRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/runtime" });
  assert.equal(unchangedRes.statusCode, 200);
  assert.equal(unchangedRes.json().maxSubtaskDepth, 5);

  for (const corrupt of [0, 6, 1.5, "1", null]) {
    setSettingJson(fixture.db, "agent_runtime_v1", { maxSubtaskDepth: corrupt }, Date.now());
    const corruptRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/runtime" });
    assert.equal(corruptRes.statusCode, 200);
    assert.equal(corruptRes.json().maxSubtaskDepth, 1, `stored ${String(corrupt)} should fall back to default`);
  }
});

test("agent runtime settings modelRequestRetryBackoffMaxMs 默认值、边界和旧数据兼容", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);

  const defaultRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/runtime" });
  assert.equal(defaultRes.statusCode, 200);
  assert.equal(defaultRes.json().modelRequestRetryBackoffMaxMs, 60_000);

  for (const value of [2_000, 3_600_000]) {
    const res = await fixture.app.inject({
      method: "PUT",
      url: "/api/settings/agent/runtime",
      payload: { modelRequestRetryBackoffMaxMs: value }
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().modelRequestRetryBackoffMaxMs, value);
  }

  for (const invalid of [1_999, 3_600_001, 2_000.5, "not-a-number", null]) {
    const res = await fixture.app.inject({
      method: "PUT",
      url: "/api/settings/agent/runtime",
      payload: { modelRequestRetryBackoffMaxMs: invalid }
    });
    assert.equal(res.statusCode, 400, res.body);
  }

  setSettingJson(fixture.db, "agent_runtime_v1", { modelRequestMaxRetries: 5 }, Date.now());
  const legacyRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/runtime" });
  assert.equal(legacyRes.statusCode, 200);
  assert.equal(legacyRes.json().modelRequestRetryBackoffMaxMs, 60_000);

  for (const corrupt of [1_999, 3_600_001, 2_000.5, "not-a-number", null]) {
    setSettingJson(fixture.db, "agent_runtime_v1", { modelRequestRetryBackoffMaxMs: corrupt }, Date.now());
    const res = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/runtime" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().modelRequestRetryBackoffMaxMs, 60_000, `stored ${String(corrupt)} should fall back to default`);
  }
});

test("agent runtime settings 可通过 execution-profile 下发", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);

  const runtimeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: {
      modelIdleTimeoutMs: 1234,
      modelTotalTimeoutMs: 5678,
      modelRequestMaxRetries: 4,
      modelRequestRetryBackoffMaxMs: 120_000
    }
  });
  assert.equal(runtimeRes.statusCode, 200, `update agent runtime settings failed: ${runtimeRes.body}`);

  const session = await createPrimarySession(fixture);
  const msg = await sendAgentMessage(fixture, {
    sessionId: session.id,
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
  assert.equal(profile.runtime?.modelRequestRetryBackoffMaxMs, 120_000);
  assert.equal(typeof profile.runtime?.autoCompactThresholdPct, "number");
  assert.equal(typeof profile.model?.contextWindowTokens, "number");
  assert.equal(profile.provider?.options?.apiMode, "responses");
  assert.equal(profile.compaction, null);
});

test("agent runtime settings 部分更新时保留 modelRequestRetryBackoffMaxMs", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);

  const initialRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { modelRequestRetryBackoffMaxMs: 120_000 }
  });
  assert.equal(initialRes.statusCode, 200, initialRes.body);

  const partialRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { modelRequestMaxRetries: 7 }
  });
  assert.equal(partialRes.statusCode, 200, partialRes.body);
  assert.equal(partialRes.json().modelRequestMaxRetries, 7);
  assert.equal(partialRes.json().modelRequestRetryBackoffMaxMs, 120_000);

  const getRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/runtime" });
  assert.equal(getRes.statusCode, 200, getRes.body);
  assert.equal(getRes.json().modelRequestRetryBackoffMaxMs, 120_000);
});

test("agent runtime compactionModel 支持保存、下发、清空和引用保护", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);

  const providers = [
    {
      id: "ppchat",
      name: "ppchat",
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://code.ppchat.vip/v1", apiKey: "sk-test" },
      models: [{ id: "gpt-5.2", name: "gpt-5.2", contextWindowTokens: 128000 }]
    },
    {
      id: "compaction-provider",
      name: "Compaction Provider",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://example.invalid/v1", apiKey: "sk-compaction" },
      models: [{ id: "compact-model", name: "Compact Model", contextWindowTokens: 32000 }]
    }
  ];

  const providersRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: { default: null, providers }
  });
  assert.equal(providersRes.statusCode, 200, `configure providers failed: ${providersRes.body}`);

  const emptyRuntimeRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/runtime" });
  assert.equal(emptyRuntimeRes.statusCode, 200);
  assert.equal(emptyRuntimeRes.json().compactionModel, null);

  const invalidRuntimeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { compactionModel: { providerId: "compaction-provider", modelId: "missing-model" } }
  });
  assert.equal(invalidRuntimeRes.statusCode, 400);
  assert.equal(invalidRuntimeRes.json().code, "AGENT_MODEL_NOT_FOUND");

  const runtimeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { compactionModel: { providerId: "compaction-provider", modelId: "compact-model" } }
  });
  assert.equal(runtimeRes.statusCode, 200, `update runtime settings failed: ${runtimeRes.body}`);
  assert.deepEqual(runtimeRes.json().compactionModel, {
    providerId: "compaction-provider",
    modelId: "compact-model"
  });

  const session = await createPrimarySession(fixture);
  const msg = await sendAgentMessage(fixture, {
    sessionId: session.id,
        text: "hi",
    clientRequestId: "req_runtime_compaction_model"
  });
  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: msg.runId }
  });
  assert.equal(profileRes.statusCode, 200, `get execution profile failed: ${profileRes.body}`);
  const profile = profileRes.json() as any;
  assert.equal(profile.model?.id, "gpt-5.2");
  assert.equal(profile.compaction?.source, "runtime_compaction");
  assert.equal(profile.compaction?.provider?.id, "compaction-provider");
  assert.equal(profile.compaction?.model?.id, "compact-model");

  const clearRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { compactionModel: null }
  });
  assert.equal(clearRes.statusCode, 200);
  assert.equal(clearRes.json().compactionModel, null);

  const profileAfterClearRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: msg.runId }
  });
  assert.equal(profileAfterClearRes.statusCode, 200);
  assert.equal(profileAfterClearRes.json().compaction, null);

  const setAgainRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { compactionModel: { providerId: "compaction-provider", modelId: "compact-model" } }
  });
  assert.equal(setAgainRes.statusCode, 200);

  const clearCompactionApiKeyRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: null,
      providers: providers.map((provider) => provider.id === "compaction-provider"
        ? { ...provider, options: { ...provider.options, apiKey: null } }
        : provider)
    }
  });
  assert.equal(clearCompactionApiKeyRes.statusCode, 200, `clear compaction apiKey failed: ${clearCompactionApiKeyRes.body}`);

  const profileWithoutCompactionKeyRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: msg.runId }
  });
  assert.equal(profileWithoutCompactionKeyRes.statusCode, 200, `get execution profile without compaction key failed: ${profileWithoutCompactionKeyRes.body}`);
  assert.equal(profileWithoutCompactionKeyRes.json().model?.id, "gpt-5.2");
  assert.equal(profileWithoutCompactionKeyRes.json().compaction, null);

  const removeReferencedProviderRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: { default: null, providers: [providers[0]] }
  });
  assert.equal(removeReferencedProviderRes.statusCode, 409);
  assert.equal(removeReferencedProviderRes.json().code, "AGENT_PROVIDER_MODEL_RENAME_REFERENCED");

  const renameReferencedModelRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: null,
      providers: providers.map((provider) => provider.id === "compaction-provider"
        ? { ...provider, models: [{ id: "compact-model-v2", name: "Compact Model v2", contextWindowTokens: 32000 }] }
        : provider)
    }
  });
  assert.equal(renameReferencedModelRes.statusCode, 409);
  assert.equal(renameReferencedModelRes.json().code, "AGENT_PROVIDER_MODEL_RENAME_REFERENCED");
});

test("openai provider apiMode 会在 settings 与 execution-profile/single-call profile 中透传", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);

  const providersRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "compat_openai", modelId: "deepseek-v3" },
      providers: [
        {
          id: "compat_openai",
          name: "compat_openai",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://example.openai-compatible.invalid/v1",
            apiKey: "sk-compat",
            apiMode: "chatCompletions"
          },
          models: [
            {
              id: "deepseek-v3",
              name: "deepseek-v3",
              contextWindowTokens: 128000
            }
          ]
        },
        {
          id: "anthropic_provider",
          name: "anthropic_provider",
          npm: "@ai-sdk/anthropic",
          options: {
            baseURL: "https://api.anthropic.com/v1",
            apiKey: "sk-anthropic",
            // 非 openai provider 上送该字段也应被忽略。
            apiMode: "chatCompletions"
          },
          models: [
            {
              id: "claude-sonnet",
              name: "claude-sonnet",
              contextWindowTokens: 200000
            }
          ]
        }
      ]
    }
  });
  assert.equal(providersRes.statusCode, 200, `update providers failed: ${providersRes.body}`);

  const getProvidersRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/providers" });
  assert.equal(getProvidersRes.statusCode, 200, `get providers failed: ${getProvidersRes.body}`);
  const providersBody = getProvidersRes.json() as any;
  const openaiProvider = providersBody.providers.find((item: any) => item.id === "compat_openai");
  const anthropicProvider = providersBody.providers.find((item: any) => item.id === "anthropic_provider");
  assert.equal(openaiProvider?.options?.apiMode, "chatCompletions");
  assert.equal(anthropicProvider?.options?.apiMode, undefined);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
          defaultModel: { providerId: "compat_openai", modelId: "deepseek-v3" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `update agents failed: ${agentsRes.body}`);

  const session = await createPrimarySession(fixture);
  const msg = await sendAgentMessage(fixture, {
    sessionId: session.id,
        text: "hi",
    clientRequestId: "req_provider_api_mode"
  });

  const executionProfileRes = await fixture.app.inject({
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
  assert.equal(executionProfileRes.statusCode, 200, `get execution profile failed: ${executionProfileRes.body}`);
  const executionProfile = executionProfileRes.json() as any;
  assert.equal(executionProfile.provider?.id, "compat_openai");
  assert.equal(executionProfile.provider?.options?.apiMode, "chatCompletions");

  const singleCallProfileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/single-call-model-profile",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: msg.runId
    }
  });
  assert.equal(singleCallProfileRes.statusCode, 200, `get single-call model profile failed: ${singleCallProfileRes.body}`);
  const singleCallProfile = singleCallProfileRes.json() as any;
  assert.equal(singleCallProfile.provider?.id, "compat_openai");
  assert.equal(singleCallProfile.provider?.options?.apiMode, "chatCompletions");

  const invalidModeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "compat_openai", modelId: "deepseek-v3" },
      providers: [
        {
          id: "compat_openai",
          name: "compat_openai",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://example.openai-compatible.invalid/v1",
            apiKey: "sk-compat",
            apiMode: "invalid-mode"
          },
          models: [
            {
              id: "deepseek-v3",
              name: "deepseek-v3",
              contextWindowTokens: 128000
            }
          ]
        }
      ]
    }
  });

  assert.equal(invalidModeRes.statusCode, 400, `update provider with invalid apiMode should fail: ${invalidModeRes.body}`);
  const invalidModeBody = invalidModeRes.json() as any;
  assert.equal(typeof invalidModeBody?.message, "string");

  const keepModeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "compat_openai", modelId: "deepseek-v3" },
      providers: [
        {
          id: "compat_openai",
          name: "compat_openai",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://example.openai-compatible.invalid/v1",
            apiKey: "sk-compat"
          },
          models: [
            {
              id: "deepseek-v3",
              name: "deepseek-v3",
              contextWindowTokens: 128000
            }
          ]
        }
      ]
    }
  });
  assert.equal(keepModeRes.statusCode, 200, `update provider without apiMode failed: ${keepModeRes.body}`);
  const keepModeBody = keepModeRes.json() as any;
  const keepModeProvider = keepModeBody.providers.find((item: any) => item.id === "compat_openai");
  assert.equal(keepModeProvider?.options?.apiMode, "chatCompletions");
});

test("subtask session 的 execution-profile 按 subtask surface 校验", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);

  const settingsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "subtask-agent",
          name: "subtask-agent",
          summary: "",
          prompt: "You are a subtask specialist.",
          tools: ["bash", "read"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "subtask",
          order: 0
        }
      ]
    }
  });
  assert.equal(settingsRes.statusCode, 200, `update agent settings failed: ${settingsRes.body}`);

  const session = createSubtaskSessionForSettingsTest(fixture, { title: "subtask-profile" });

  const createdAt = Date.now();
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "subtask-agent",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "running",
    createdAt
  });

  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId }
  });
  assert.equal(profileRes.statusCode, 200, `get subtask execution profile failed: ${profileRes.body}`);
  const profile = profileRes.json() as any;
  assert.equal(profile.agent?.id, "subtask-agent");
});

test("run 创建后若 agent scope 改为不允许, execution-profile 会返回明确错误", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);
  const session = await createPrimarySession(fixture);
  const sent = await sendAgentMessage(fixture, {
    sessionId: session.id,
    text: "hi",
    clientRequestId: "req_scope_changed_after_run"
  });

  const updateRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "subtask",
          order: 0
        }
      ]
    }
  });
  assert.equal(updateRes.statusCode, 200, `update agent settings failed: ${updateRes.body}`);

  const profileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: sent.runId }
  });
  assert.equal(profileRes.statusCode, 400, `execution profile should reject changed scope: ${profileRes.body}`);
  assert.equal(profileRes.json().code, "AGENT_SCOPE_NOT_ALLOWED");
});

test("agent providers settings 要求 contextWindowTokens 必填且合法", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);

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

test("single-call model profile 使用 agent 显式默认模型", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);

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
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
          defaultModel: {
            providerId: "agent_provider",
            modelId: "agent_model"
          },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);

  const session = await createPrimarySession(fixture);
  const sent = await sendAgentMessage(fixture, {
    sessionId: session.id,
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
  assert.equal(profile.resolved?.source, "agent_default");
  assert.equal(profile.provider?.id, "agent_provider");
  assert.equal(profile.model?.id, "agent_model");
});

test("openai-compatible provider 可在 settings 与 profile 中保存透传", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);

  const providersRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "compat_openai", modelId: "deepseek-v3" },
      providers: [
        {
          id: "compat_openai",
          name: "compat_openai",
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "https://example.openai-compatible.invalid/v1",
            apiKey: "sk-compat"
          },
          models: [
            {
              id: "deepseek-v3",
              name: "deepseek-v3",
              contextWindowTokens: 128000
            }
          ]
        }
      ]
    }
  });
  assert.equal(providersRes.statusCode, 200, `update providers failed: ${providersRes.body}`);

  const getProvidersRes = await fixture.app.inject({ method: "GET", url: "/api/settings/agent/providers" });
  assert.equal(getProvidersRes.statusCode, 200, `get providers failed: ${getProvidersRes.body}`);
  const providersBody = getProvidersRes.json() as any;
  const provider = providersBody.providers.find((item: any) => item.id === "compat_openai");
  assert.equal(provider?.npm, "@ai-sdk/openai-compatible");
  assert.equal(provider?.options?.apiMode, undefined);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          mcpServers: [],
          defaultModel: { providerId: "compat_openai", modelId: "deepseek-v3" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `update agents failed: ${agentsRes.body}`);

  const session = await createPrimarySession(fixture);
  const msg = await sendAgentMessage(fixture, {
    sessionId: session.id,
        text: "hi",
    clientRequestId: "req_provider_openai_compatible"
  });

  const singleCallProfileRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/single-call-model-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: msg.runId }
  });
  assert.equal(singleCallProfileRes.statusCode, 200, `get single-call model profile failed: ${singleCallProfileRes.body}`);
  const singleCallProfile = singleCallProfileRes.json() as any;
  assert.equal(singleCallProfile.provider?.id, "compat_openai");
  assert.equal(singleCallProfile.provider?.npm, "@ai-sdk/openai-compatible");
  assert.equal(singleCallProfile.provider?.options?.apiMode, undefined);
});

test("openai-compatible provider 支持按 OpenAI 风格拉取远程模型列表", async (t: TestContext) => {
  const fixture = await createIntegrationFixtureForTest(t);
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let authHeader = "";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    authHeader = headers.get("authorization") ?? "";
    return new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "qwen-max" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const providersRes = await fixture.app.inject({
      method: "PUT",
      url: "/api/settings/agent/providers",
      payload: {
        default: { providerId: "compat_openai", modelId: "deepseek-chat" },
        providers: [
          {
            id: "compat_openai",
            name: "compat_openai",
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: "https://example.openai-compatible.invalid/v1",
              apiKey: "sk-compat"
            },
            models: []
          }
        ]
      }
    });
    assert.equal(providersRes.statusCode, 200, `update providers failed: ${providersRes.body}`);

    const modelsRes = await fixture.app.inject({
      method: "GET",
      url: "/api/settings/agent/providers/compat_openai/models"
    });
    assert.equal(modelsRes.statusCode, 200, `get provider models failed: ${modelsRes.body}`);
    const body = modelsRes.json() as any;
    assert.equal(body.providerId, "compat_openai");
    assert.equal(body.source, "remote");
    assert.deepEqual(body.items.map((item: any) => item.id), ["deepseek-chat", "qwen-max"]);
    assert.equal(requestUrl, "https://example.openai-compatible.invalid/v1/models");
    assert.equal(authHeader, "Bearer sk-compat");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
