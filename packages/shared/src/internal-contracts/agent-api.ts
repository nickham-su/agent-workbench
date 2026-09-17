export const AgentApiEndpoints = {
  createStreamingAssistant: {
    method: "POST",
    path: "/api/internal/agent/messages/assistant",
  },
  flushAssistantParts: {
    method: "POST",
    path: "/api/internal/agent/messages/assistant/parts",
  },
  resumeStreamingAssistant: {
    method: "POST",
    path: "/api/internal/agent/messages/assistant/resume",
  },
  replaceStreamingAssistant: {
    method: "POST",
    path: "/api/internal/agent/messages/assistant/replace",
  },
  completeAssistant: {
    method: "POST",
    path: "/api/internal/agent/messages/assistant/complete",
  },
  updateToolExecution: {
    method: "POST",
    path: "/api/internal/agent/tool-executions/update",
  },
  updateRunNotice: {
    method: "POST",
    path: "/api/internal/agent/run-notice",
  },
  commitCompaction: {
    method: "POST",
    path: "/api/internal/agent/messages/compaction",
  },
  completeRun: {
    method: "POST",
    path: "/api/internal/agent/run-complete",
  },
  getSubtaskPreforkPlan: {
    method: "POST",
    path: "/api/internal/agent/subtask/prefork-plan",
  },
  startSubtask: {
    method: "POST",
    path: "/api/internal/agent/subtask/start",
  },
  getSubtaskResult: {
    method: "POST",
    path: "/api/internal/agent/subtask/result",
  },
  getSubtaskStatus: {
    method: "POST",
    path: "/api/internal/agent/subtask/status",
  },
  getExecutionProfile: {
    method: "POST",
    path: "/api/internal/agent/execution-profile",
  },
  getPromptContext: {
    method: "POST",
    path: "/api/internal/agent/prompt-context",
  },
  getMessagesContext: {
    method: "POST",
    path: "/api/internal/agent/messages-context",
  },
  archiveRead: {
    method: "POST",
    path: "/api/internal/agent/archive/read",
  },
  archiveSearch: {
    method: "POST",
    path: "/api/internal/agent/archive/search",
  },
} as const;

export * from "./agent-api-run.js";
export * from "./agent-api-message.js";
export * from "./agent-api-subtask.js";
export * from "./agent-api-read.js";
