import type {
  AgentListAvailableAgentsResponse,
  AgentRecentSessionsResponse,
  AgentRecentWorkspacesResponse
} from "@agent-workbench/shared";

export type PeripheralAgentQueryStore = {
  workspaceExists(workspaceId: string): boolean;
  listRecentSessions(limit: number, kind: "primary" | "subtask" | "all"): AgentRecentSessionsResponse["items"];
  listRecentWorkspaces(limit: number): AgentRecentWorkspacesResponse["items"];
  getRun(runId: string): { runId: string } | null;
  getLatestTerminalAssistantText(runId: string): { itemId: number | null; text: string };
};

/** Narrow capability shared with Context status projection; neither application references the other. */
export type AvailableAgentsQuery = {
  listUserAgents(workspaceId: string): AgentListAvailableAgentsResponse["agents"];
};

export type PeripheralAgentQueryApplicationDependencies = {
  store: PeripheralAgentQueryStore;
  availableAgentsQuery: AvailableAgentsQuery;
};

export type PeripheralAgentQueryApplicationPort = {
  listRecentSessions(params: { limit?: number; kind?: "primary" | "subtask" | "all" }): AgentRecentSessionsResponse;
  listRecentWorkspaces(params: { limit?: number }): AgentRecentWorkspacesResponse;
  getRunFinalText(params: { runId: string }): { found: boolean; text: string };
  listAvailableAgents(params: { workspaceId: string; surface?: string }): AgentListAvailableAgentsResponse;
};
