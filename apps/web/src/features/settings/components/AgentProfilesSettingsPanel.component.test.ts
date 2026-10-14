import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSettings, AgentToolName, UpdateAgentSettingsRequest } from "@agent-workbench/shared";
import { apiClient } from "@/shared/api";
import zhCN from "@/shared/i18n/locales/zh-CN";
import enUS from "@/shared/i18n/locales/en-US";

const [{ shallowMount, flushPromises }, { createI18n }, { defineComponent, h, nextTick }, component] = await Promise.all([
  import("@vue/test-utils"), import("vue-i18n"), import("vue"), import("./AgentProfilesSettingsPanel.vue"),
]);
const SlotStub = defineComponent({ setup(_props, { slots }) { return () => h("div", slots.default?.()); } });

for (const [locale, messages] of [["zh-CN", zhCN], ["en-US", enUS]] as const) {
  test(`AC-ENABLEMENT-LOCALE/EXPLICIT: actual ${locale} settings form keeps Git opt-in and round-trips`, async () => {
    let settings: AgentSettings = { agents: [{
      id: "existing-agent", name: "Existing", summary: "", prompt: "", globalPromptIds: [],
      tools: ["bash"], mcpServers: [], pluginTools: [], scope: "both", order: 0,
      defaultModel: { providerId: "fixture-provider", modelId: "fixture-model" },
    }], updatedAt: 1 };
    const saved: UpdateAgentSettingsRequest[] = [];
    const originalAdapter = apiClient.defaults.adapter;
    apiClient.defaults.adapter = async (config) => {
      let data: unknown;
      if (config.method === "put" && config.url === "/settings/agent/agents") {
        const body = JSON.parse(String(config.data)) as UpdateAgentSettingsRequest;
        saved.push(body); settings = { ...body, updatedAt: settings.updatedAt + 1 }; data = settings;
      } else if (config.method === "get") {
        switch (config.url) {
          case "/settings/agent/agents": data = settings; break;
          case "/settings/agent/providers": data = { default: null, updatedAt: 1, providers: [{ id: "fixture-provider", name: "Fixture", npm: "@ai-sdk/openai", options: { baseURL: null, hasApiKey: false, apiKeyMasked: null }, models: [{ id: "fixture-model", providerModelId: "fixture-model", name: "Fixture", contextWindowTokens: 1000, options: {} }] }] }; break;
          case "/settings/agent/mcp": data = { servers: [], updatedAt: 1 }; break;
          case "/settings/agent/global-prompts": data = { prompts: [], updatedAt: 1 }; break;
          case "/settings/agent/plugins": data = { plugins: [], updatedAt: 1 }; break;
          case "/settings/agent/plugins/runtime-snapshots": data = { plugins: [] }; break;
          default: throw new Error(`Unexpected fixture request: ${config.method} ${config.url}`);
        }
      } else throw new Error(`Unexpected fixture request: ${config.method} ${config.url}`);
      return { config, data, status: 200, statusText: "OK", headers: {} };
    };
    const wrapper = shallowMount(component.default, { global: {
      plugins: [createI18n({ legacy: false, locale, messages: { [locale]: messages } })],
      stubs: { "a-button": true, "a-tag": true, "a-modal": SlotStub, "a-form": SlotStub, "a-form-item": SlotStub,
        "a-select": true, "a-input": true, "a-textarea": true, "a-cascader": true, "a-radio-group": true, "a-radio-button": true },
    } });
    try {
      await flushPromises();
      assert.equal(saved.length, 0, "loading an old profile must not silently migrate settings");
      assert.deepEqual(settings.agents[0]!.tools, ["bash"]);
      const form = wrapper.vm as unknown as {
        openCreateAgent: () => void; openEditAgent: (id: string) => void; submitAgent: () => void;
        agentFormTools: AgentToolName[]; agentFormName: string; agentFormDefaultModelPath: string[];
        toolOptions: Array<{ value: string; label: string }>;
      };
      assert.deepEqual(form.toolOptions.find((option) => option.value === "git"), { label: "Git", value: "git" });
      form.openCreateAgent(); await nextTick();
      assert.deepEqual(form.agentFormTools, ["bash", "write", "apply_patch", "subtask"]);
      assert(wrapper.text().includes(messages.settings.agentProfiles.gitToolHelp));
      form.openEditAgent("existing-agent"); await nextTick();
      assert.deepEqual(form.agentFormTools, ["bash"]);
      form.agentFormTools = ["bash", "git"]; form.submitAgent(); await flushPromises();
      assert.deepEqual(saved.at(-1)?.agents[0]?.tools, ["bash", "git"]);
      assert.deepEqual(settings.agents[0]?.tools, ["bash", "git"]);
      form.openEditAgent("existing-agent"); await nextTick();
      assert.deepEqual(form.agentFormTools, ["bash", "git"]);
      form.agentFormTools = ["bash"]; form.submitAgent(); await flushPromises();
      assert.deepEqual(saved.at(-1)?.agents[0]?.tools, ["bash"]);
      form.openCreateAgent(); await nextTick();
      assert.equal(form.agentFormTools.includes("git"), false, "subsequent new agents remain opt-in");
    } finally { wrapper.unmount(); apiClient.defaults.adapter = originalAdapter; }
  });
}
