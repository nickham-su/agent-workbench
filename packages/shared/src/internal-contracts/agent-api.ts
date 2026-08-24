import { AgentApiContextItemPathTemplate, buildAgentApiContextItemPath } from "./agent-api-context.js";

export const AgentApiEndpoints = {
  updateRunState: {
    method: "POST",
    path: "/api/internal/agent/run-state"
  },
  completeRun: {
    method: "POST",
    path: "/api/internal/agent/run-complete"
  },
  createContextItem: {
    method: "POST",
    path: "/api/internal/agent/context-items"
  },
  updateContextItem: {
    method: "PATCH",
    path: buildAgentApiContextItemPath,
    routeTemplate: AgentApiContextItemPathTemplate
  },
  compactContext: {
    method: "POST",
    path: "/api/internal/agent/context/compact"
  },
  getSubtaskPreforkPlan: {
    method: "POST",
    path: "/api/internal/agent/subtask/prefork-plan"
  },
  startSubtask: {
    method: "POST",
    path: "/api/internal/agent/subtask/start"
  },
  getSubtaskResult: {
    method: "POST",
    path: "/api/internal/agent/subtask/result"
  },
  getSubtaskStatus: {
    method: "POST",
    path: "/api/internal/agent/subtask/status"
  },
  getExecutionProfile: {
    method: "POST",
    path: "/api/internal/agent/execution-profile"
  },
  getPromptContext: {
    method: "POST",
    path: "/api/internal/agent/prompt-context"
  },
  getMessagesContext: {
    method: "POST",
    path: "/api/internal/agent/messages-context"
  }
} as const;

export * from "./agent-api-run.js";
export * from "./agent-api-context.js";
export * from "./agent-api-subtask.js";
export * from "./agent-api-read.js";
