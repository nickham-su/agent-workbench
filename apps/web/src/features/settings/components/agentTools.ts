import type { AgentToolName } from "@agent-workbench/shared";

export const DEFAULT_AGENT_TOOLS: AgentToolName[] = [
  "bash",
  "write",
  "apply_patch",
  "subtask"
];

const CONFIGURABLE_AGENT_TOOLS: AgentToolName[] = [
  ...DEFAULT_AGENT_TOOLS,
  "scratchpad"
];

export function normalizeAgentTools(raw: readonly AgentToolName[]) {
  const out: AgentToolName[] = [];
  const seen = new Set<AgentToolName>();
  for (const item of raw) {
    if (!CONFIGURABLE_AGENT_TOOLS.includes(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function toAgentToolOptions(translate: (key: string) => string) {
  return CONFIGURABLE_AGENT_TOOLS.map((tool) => ({
    label: translate(agentToolLabelKey(tool)),
    value: tool
  }));
}

export function agentToolLabelKey(tool: AgentToolName) {
  if (tool === "bash") return "settings.agentProfiles.tools.bash";
  if (tool === "write") return "settings.agentProfiles.tools.write";
  if (tool === "apply_patch") return "settings.agentProfiles.tools.applyPatch";
  if (tool === "scratchpad") return "settings.agentProfiles.tools.scratchpad";
  return "settings.agentProfiles.tools.subtask";
}
