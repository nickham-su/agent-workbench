import type { AgentListAvailableAgentsResponse, AgentRecentSessionsResponse, AgentRecentWorkspacesResponse } from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import type { PeripheralAgentQueryApplicationDependencies } from "./peripheral-agent-query-ports.js";

export class PeripheralAgentQueryApplication {
  constructor(private readonly dependencies: PeripheralAgentQueryApplicationDependencies) {}

  listRecentSessions(params: { limit?: number; kind?: "primary" | "subtask" | "all" }): AgentRecentSessionsResponse {
    const kind = params.kind === "primary" || params.kind === "subtask" ? params.kind : "all";
    return { items: this.dependencies.store.listRecentSessions(Math.max(1, Math.min(50, params.limit || 10)), kind) };
  }

  listRecentWorkspaces(params: { limit?: number }): AgentRecentWorkspacesResponse {
    return { items: this.dependencies.store.listRecentWorkspaces(Math.max(1, Math.min(50, params.limit || 10))) };
  }

  getRunFinalText(params: { runId: string }) {
    const runId = String(params.runId || "").trim();
    if (!runId || !this.dependencies.store.getRun(runId)) return { found: false, text: "" };
    const latest = this.dependencies.store.getLatestTerminalAssistantText(runId);
    return { found: latest.itemId != null, text: latest.text };
  }

  listAvailableAgents(params: { workspaceId: string; surface?: string }): AgentListAvailableAgentsResponse {
    const workspaceId = String(params.workspaceId || "").trim();
    if (!workspaceId) throw new HttpError(400, "workspaceId is required", "WORKSPACE_ID_REQUIRED");
    if (!this.dependencies.store.workspaceExists(workspaceId)) throw new HttpError(404, "workspace not found", "WORKSPACE_NOT_FOUND");
    const surface = params.surface ?? "user";
    if (surface !== "user") throw new HttpError(400, "surface must be user", "AGENT_SURFACE_INVALID");
    const agents = this.dependencies.availableAgentsQuery.listUserAgents(workspaceId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
    return { agents };
  }
}
