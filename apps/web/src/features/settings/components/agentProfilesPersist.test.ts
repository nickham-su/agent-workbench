import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSettings } from "@agent-workbench/shared";
import { persistAgentProfilesDraft } from "./agentProfilesPersist";

function makeSettings(updatedAt: number): AgentSettings {
  return {
    agents: [
      {
        id: `agent-${updatedAt}`,
        name: `Agent ${updatedAt}`,
        summary: "",
        prompt: "",
        globalPromptIds: [],
        tools: ["bash"],
        pluginTools: [],
        mcpServers: [],
        defaultModel: null,
        scope: "both",
        order: 0
      }
    ],
    updatedAt
  };
}

test("persistAgentProfilesDraft 仅在 revision 仍匹配时应用返回结果", async () => {
  let revision = 1;
  let appliedUpdatedAt = 0;
  let resolveFirst: (value: AgentSettings) => void = () => undefined;

  const first = persistAgentProfilesDraft({
    getRevision: () => revision,
    body: makeSettings(1),
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
    body: makeSettings(2),
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
  settings.agents[0].pluginTools = ["plugin_debug-tools_echo_inspect"];

  const body = {
    agents: [
      {
        ...settings.agents[0],
        name: "Updated Agent"
      }
    ],
    updatedAt: settings.updatedAt
  };

  let applied: AgentSettings | null = null;
  await persistAgentProfilesDraft({
    getRevision: () => 1,
    body,
    update: async () => body,
    applyIfLatest: (res) => {
      applied = res;
    }
  });

  if (applied === null) throw new Error("expected applied settings");
  const appliedSettings: AgentSettings = applied;
  assert.deepEqual(appliedSettings.agents[0]?.pluginTools, ["plugin_debug-tools_echo_inspect"]);
});
