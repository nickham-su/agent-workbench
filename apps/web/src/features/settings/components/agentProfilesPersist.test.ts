import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSettings, UpdateAgentSettingsRequest } from "@agent-workbench/shared";
import { persistAgentProfilesDraft } from "./agentProfilesPersist";

function makeAgent(updatedAt: number): UpdateAgentSettingsRequest["agents"][number] {
  return {
    id: `agent-${updatedAt}`,
    name: `Agent ${updatedAt}`,
    summary: "",
    prompt: "",
    globalPromptIds: [],
    tools: ["bash"],
    pluginTools: [],
    mcpServers: [],
    defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
    scope: "both",
    order: 0
  };
}

function makeRequestBody(updatedAt: number): UpdateAgentSettingsRequest {
  return {
    agents: [makeAgent(updatedAt)]
  };
}

function makeSettings(updatedAt: number): AgentSettings {
  return {
    agents: [makeAgent(updatedAt)],
    updatedAt
  };
}

test("persistAgentProfilesDraft 仅在 revision 仍匹配时应用返回结果", async () => {
  let revision = 1;
  let appliedUpdatedAt = 0;
  let resolveFirst: (value: AgentSettings) => void = () => undefined;

  const first = persistAgentProfilesDraft({
    getRevision: () => revision,
    body: makeRequestBody(1),
    update: async () => await new Promise<AgentSettings>((resolve) => {
      resolveFirst = resolve;
    }),
    applyIfLatest: (res, responseRevision) => {
      if (responseRevision !== revision) return;
      appliedUpdatedAt = res.updatedAt;
    }
  });

  revision = 2;

  const second = persistAgentProfilesDraft({
    getRevision: () => revision,
    body: makeRequestBody(2),
    update: async () => makeSettings(2),
    applyIfLatest: (res, responseRevision) => {
      if (responseRevision !== revision) return;
      appliedUpdatedAt = res.updatedAt;
    }
  });

  await second;
  resolveFirst(makeSettings(1));

  await first;

  assert.equal(appliedUpdatedAt, 2);
});


test("agent profiles draft preserves existing pluginTools when editing unrelated fields", async () => {
  const settings = makeSettings(3);
  const current = settings.agents[0];
  if (!current) throw new Error("expected existing agent");
  current.pluginTools = ["plugin_debug-tools_echo_inspect"];
  if (!current.defaultModel) throw new Error("expected defaultModel");

  const body: UpdateAgentSettingsRequest = {
    agents: [
      {
        id: current.id,
        name: "Updated Agent",
        summary: current.summary,
        prompt: current.prompt,
        globalPromptIds: current.globalPromptIds,
        tools: current.tools,
        mcpServers: current.mcpServers,
        pluginTools: current.pluginTools,
        defaultModel: current.defaultModel,
        scope: current.scope,
        order: current.order
      }
    ]
  };

  const response: AgentSettings = {
    agents: body.agents,
    updatedAt: settings.updatedAt
  };

  let applied: AgentSettings | null = null;
  await persistAgentProfilesDraft({
    getRevision: () => 1,
    body,
    update: async () => response,
    applyIfLatest: (res) => {
      applied = res;
    }
  });

  if (applied === null) throw new Error("expected applied settings");
  const appliedSettings: AgentSettings = applied;
  assert.deepEqual(appliedSettings.agents[0]?.pluginTools, ["plugin_debug-tools_echo_inspect"]);
});
