import type { AgentPluginSettings, PluginRuntimeSnapshot } from "@agent-workbench/shared";

export type PluginRow = PluginRuntimeSnapshot & {
  enabled: boolean;
  config?: unknown;
};

export function toPluginRows(params: {
  settings: AgentPluginSettings | null;
  snapshots: PluginRuntimeSnapshot[];
}): PluginRow[] {
  const configured = new Map((params.settings?.plugins ?? []).map((item) => [item.id, item]));
  return params.snapshots.map((snapshot) => {
    const setting = configured.get(snapshot.id);
    return {
      ...snapshot,
      enabled: setting?.enabled === true,
      config: setting?.config
    };
  });
}

export function toPluginToolOptions(params: {
  settings: AgentPluginSettings | null;
  snapshots: PluginRuntimeSnapshot[];
}): Array<{ label: string; value: string; disabled?: boolean }> {
  const enabledPlugins = new Set(
    (params.settings?.plugins ?? []).filter((item) => item.enabled).map((item) => item.id)
  );
  const options: Array<{ label: string; value: string; disabled?: boolean }> = [];

  for (const snapshot of params.snapshots) {
    const pluginReady = snapshot.state === "ready";
    const pluginEnabled = enabledPlugins.has(snapshot.id);
    for (const tool of snapshot.capabilities.tools ?? []) {
      options.push({
        label: `${tool.shortName} · ${snapshot.id}`,
        value: tool.canonicalName,
        disabled: !(pluginEnabled && pluginReady)
      });
    }
  }

  return options.sort((a, b) => a.label.localeCompare(b.label));
}
