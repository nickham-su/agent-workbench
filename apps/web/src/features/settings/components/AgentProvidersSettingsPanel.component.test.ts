import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderNpm, AgentProvidersSettingsView } from "@agent-workbench/shared";
import { apiClient } from "@/shared/api";
import zhCN from "@/shared/i18n/locales/zh-CN";

const [{ shallowMount, flushPromises }, { createI18n }, component] = await Promise.all([
  import("@vue/test-utils"),
  import("vue-i18n"),
  import("./AgentProvidersSettingsPanel.vue"),
]);

test("新建 Moonshot 默认使用国内端点，编辑已保存配置不覆盖地址", async () => {
  const existingMoonshotURL = "https://api.moonshot.ai/v1";
  const settings: AgentProvidersSettingsView = {
    default: null,
    updatedAt: 1,
    providers: [{
      id: "existing-moonshot",
      name: "Existing Moonshot",
      npm: "@ai-sdk/moonshotai",
      options: { baseURL: existingMoonshotURL, hasApiKey: false, apiKeyMasked: null },
      models: [],
    }],
  };
  const originalAdapter = apiClient.defaults.adapter;
  apiClient.defaults.adapter = async (config) => {
    assert.equal(config.method, "get");
    assert.equal(config.url, "/settings/agent/providers");
    return { config, data: settings, status: 200, statusText: "OK", headers: {} };
  };

  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  const wrapper = shallowMount(component.default, {
    global: {
      plugins: [i18n],
      stubs: {
        "a-alert": true,
        "a-button": true,
        "a-checkbox": true,
        "a-form": true,
        "a-form-item": true,
        "a-input": true,
        "a-input-number": true,
        "a-input-password": true,
        "a-modal": true,
        "a-select": true,
        "a-tag": true,
        "a-textarea": true,
      },
    },
  });
  try {
    await flushPromises();
    assert.match(wrapper.text(), /查询不到时可直接输入完整的 Provider 模型ID/);
    const form = wrapper.vm as unknown as {
      providerFormBaseURL: string;
      providerFormNpm: AgentProviderNpm;
      openCreateProvider: () => void;
      onProviderNpmChange: (npm: AgentProviderNpm) => void;
      openEditProvider: (id: string) => void;
    };

    form.openCreateProvider();
    form.providerFormNpm = "@ai-sdk/moonshotai";
    form.onProviderNpmChange(form.providerFormNpm);
    assert.equal(form.providerFormBaseURL, "https://api.moonshot.cn/v1");

    form.openEditProvider("existing-moonshot");
    assert.equal(form.providerFormBaseURL, existingMoonshotURL);
    form.onProviderNpmChange("@ai-sdk/moonshotai");
    assert.equal(form.providerFormBaseURL, existingMoonshotURL);

    for (const [npm, expectedURL] of [
      ["@ai-sdk/deepseek", "https://api.deepseek.com"],
      ["@ai-sdk/anthropic", "https://api.anthropic.com/v1"],
      ["@ai-sdk/openai", "https://api.openai.com/v1"],
      ["@ai-sdk/openai-compatible", "https://your-openai-compatible-host/v1"],
    ] as const) {
      form.openCreateProvider();
      form.providerFormNpm = npm;
      form.onProviderNpmChange(npm);
      assert.equal(form.providerFormBaseURL, expectedURL);
    }
  } finally {
    wrapper.unmount();
    apiClient.defaults.adapter = originalAdapter;
  }
});

test("Moonshot/DeepSeek 列表失败静默清空候选，保留手动输入与其他 Provider 行为", async () => {
  const settings: AgentProvidersSettingsView = {
    default: null,
    updatedAt: 1,
    providers: ([
      ["moonshot", "@ai-sdk/moonshotai"],
      ["deepseek", "@ai-sdk/deepseek"],
      ["anthropic", "@ai-sdk/anthropic"],
    ] as const).map(([id, npm]) => ({
      id, name: id, npm,
      options: { baseURL: "https://example.test", hasApiKey: true, apiKeyMasked: "***" },
      models: [{ id: `local-${id}`, providerModelId: `configured-${id}`, name: "Configured", contextWindowTokens: 128000, options: {} }],
    })),
  };
  const originalAdapter = apiClient.defaults.adapter;
  let responseMode = "success";
  let savedModelId = "";
  apiClient.defaults.adapter = async (config) => {
    let data: unknown;
    if (config.method === "get" && config.url === "/settings/agent/providers") {
      data = settings;
    } else if (config.method === "get" && config.url === "/settings/agent/agents") {
      data = { agents: [] };
    } else if (config.method === "get" && config.url?.endsWith("/models")) {
      if (responseMode === "throw") throw new Error("untrusted-upstream-error");
      const id = config.url.split("/").at(-2);
      data = {
        providerId: id,
        items: [{ id: "official-model", label: "official-model" }, { id: `configured-${id}`, label: `configured-${id}` }],
        source: responseMode === "cachedFallback" ? "cache" : ["success", "unknown"].includes(responseMode) ? "remote" : "fallback",
        cached: responseMode === "cachedFallback",
        fetchedAt: 1, expiresAt: 2,
        warning: ["success", "fallbackNoWarning"].includes(responseMode) ? null : responseMode === "unknown" ? "untrusted-upstream-error" : "AGENT_PROVIDER_MODELS_REMOTE_UNAVAILABLE",
      };
    } else if (config.method === "put" && config.url === "/settings/agent/providers") {
      const draft = JSON.parse(String(config.data)) as { providers: Array<{ id: string; models: Array<{ providerModelId: string }> }> };
      savedModelId = draft.providers.find((provider) => provider.id === "deepseek")?.models.at(-1)?.providerModelId ?? "";
      data = settings;
    } else {
      throw new Error(`Unexpected test request: ${config.method} ${config.url}`);
    }
    return { config, data, status: 200, statusText: "OK", headers: {} };
  };

  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  const wrapper = shallowMount(component.default, {
    global: {
      plugins: [i18n],
      stubs: {
        "a-alert": true, "a-button": true, "a-checkbox": true, "a-form": true,
        "a-form-item": true, "a-input": true, "a-input-number": true,
        "a-input-password": true, "a-modal": true, "a-select": true,
        "a-tag": true, "a-textarea": true,
      },
    },
  });
  try {
    await flushPromises();
    const form = wrapper.vm as unknown as {
      openAddModel: (id: string) => void;
      openEditModel: (id: string, modelId: string) => Promise<void>;
      closeModelModal: () => void;
      onProviderModelIdSearch: (value: string) => void;
      onProviderModelIdChange: (value: string) => void;
      submitModel: () => void;
      providerModelIdOptions: Array<{ value: string }>;
      providerModelIdOptionsWarning: string;
      providerModelIdOptionsLoading: boolean;
      modelFormProviderModelId: string;
      modelFormName: string;
      modelModalOpen: boolean;
    };
    for (const id of ["moonshot", "deepseek"] as const) {
      responseMode = "success";
      form.openAddModel(id);
      await flushPromises();
      assert.deepEqual(form.providerModelIdOptions.map(({ value }) => value), ["official-model", `configured-${id}`]);
      assert.equal(form.providerModelIdOptionsWarning, "");
      form.closeModelModal();

      for (const mode of ["fallback", "fallbackNoWarning", "cachedFallback", "unknown", "throw"]) {
        responseMode = mode;
        form.openAddModel(id);
        await flushPromises();
        assert.equal(form.providerModelIdOptionsLoading, false);
        assert.deepEqual(form.providerModelIdOptions, [], `${id}: ${mode}`);
        assert.equal(form.providerModelIdOptionsWarning, "", `${id}: ${mode}`);
        assert.doesNotMatch(wrapper.text(), /AGENT_PROVIDER_MODELS_REMOTE_UNAVAILABLE|untrusted-upstream-error/);
        form.onProviderModelIdSearch("typed-full-model-id");
        form.onProviderModelIdChange("typed-full-model-id");
        assert.equal(form.modelFormProviderModelId, "typed-full-model-id");
        assert.deepEqual(form.providerModelIdOptions, [], "search must not restore suggestions");
        form.closeModelModal();
      }
    }

    responseMode = "fallback";
    await form.openEditModel("moonshot", "local-moonshot");
    await flushPromises();
    assert.equal(form.modelFormProviderModelId, "configured-moonshot");
    assert.deepEqual(form.providerModelIdOptions, [], "edit value remains but is not a suggestion");
    form.closeModelModal();

    responseMode = "throw";
    form.openAddModel("deepseek");
    await flushPromises();
    form.onProviderModelIdSearch("typed-full-model-id");
    form.onProviderModelIdChange("typed-full-model-id");
    form.submitModel();
    await flushPromises();
    assert.equal(savedModelId, "typed-full-model-id");
    assert.equal(form.modelModalOpen, false);

    responseMode = "fallback";
    form.openAddModel("anthropic");
    await flushPromises();
    assert.deepEqual(form.providerModelIdOptions.map(({ value }) => value), ["official-model", "configured-anthropic"]);
    assert.equal(form.providerModelIdOptionsWarning, "AGENT_PROVIDER_MODELS_REMOTE_UNAVAILABLE");
  } finally {
    wrapper.unmount();
    apiClient.defaults.adapter = originalAdapter;
  }
});
