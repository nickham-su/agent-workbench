import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentPluginSettings, PluginRuntimeSnapshot } from "@agent-workbench/shared";
import { toPluginRows, toPluginToolOptions } from "./agentPluginViewModel";

function makeSnapshot(overrides?: Partial<PluginRuntimeSnapshot>): PluginRuntimeSnapshot {
  return {
    id: "debug-tools",
    path: "/tmp/plugins/debug-tools",
    manifest: {
      schemaVersion: 1,
      id: "debug-tools",
      name: "Debug Tools",
      version: "0.1.0",
      entry: "dist/index.js",
      capabilities: ["tools"],
      tools: [{ name: "echo_inspect", description: "Echo and inspect input" }]
    },
    entryPath: "/tmp/plugins/debug-tools/dist/index.js",
    enabled: true,
    state: "ready",
    diagnostics: [],
    capabilities: {
      tools: [
        {
          canonicalName: "plugin_debug-tools_echo_inspect",
          shortName: "echo_inspect",
          description: "Echo and inspect input"
        }
      ]
    },
    ...overrides
  };
}

test("agent plugins rows reflect global enable state and discovered tools", () => {
  const settings: AgentPluginSettings = {
    plugins: [{ id: "debug-tools", enabled: true }],
    updatedAt: 1
  };

  const rows = toPluginRows({ settings, snapshots: [makeSnapshot()] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.enabled, true);
  assert.deepEqual(rows[0]?.capabilities.tools?.map((tool) => tool.canonicalName), ["plugin_debug-tools_echo_inspect"]);
});

test("plugin tool options keep unavailable tools visible but disabled", () => {
  const settings: AgentPluginSettings = {
    plugins: [{ id: "debug-tools", enabled: false }],
    updatedAt: 1
  };

  const disabledBySetting = toPluginToolOptions({ settings, snapshots: [makeSnapshot()] });
  assert.deepEqual(disabledBySetting, [
    {
      label: "echo_inspect · debug-tools",
      value: "plugin_debug-tools_echo_inspect",
      disabled: true
    }
  ]);

  const disabledByState = toPluginToolOptions({
    settings: { plugins: [{ id: "debug-tools", enabled: true }], updatedAt: 1 },
    snapshots: [makeSnapshot({ state: "invalid_manifest" })]
  });
  assert.equal(disabledByState[0]?.disabled, true);
});

test("plugin tool options enable ready tools from enabled plugins", () => {
  const settings: AgentPluginSettings = {
    plugins: [{ id: "debug-tools", enabled: true }],
    updatedAt: 1
  };

  const options = toPluginToolOptions({ settings, snapshots: [makeSnapshot()] });
  assert.deepEqual(options, [
    {
      label: "echo_inspect · debug-tools",
      value: "plugin_debug-tools_echo_inspect",
      disabled: false
    }
  ]);
});
