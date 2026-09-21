import type { AgentItemView } from "@agent-workbench/shared";

export type AgentSelectionOption = {
  value: string;
  label: string;
  resolvedModel: AgentItemView["resolvedModel"];
};

export type AgentPresentation = {
  agentOptions: AgentSelectionOption[];
  subtaskAgentLabels: Record<string, string>;
};

export function splitAvailableAgents(agents: AgentItemView[]): AgentPresentation {
  return {
    agentOptions: agents
      .filter((agent) => agent.scope === "user" || agent.scope === "both")
      .map((agent) => ({
        value: agent.id,
        label: agent.name,
        resolvedModel: agent.resolvedModel
      })),
    subtaskAgentLabels: Object.fromEntries(
      agents.map((agent) => [agent.id, agent.name])
    )
  };
}

export function createEmptyAgentPresentation(): AgentPresentation {
  return { agentOptions: [], subtaskAgentLabels: {} };
}
