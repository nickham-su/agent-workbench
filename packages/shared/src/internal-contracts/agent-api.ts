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
  discardStreamingAssistant: {
    method: "POST",
    path: "/api/internal/agent/messages/assistant/discard",
  },
  completeAssistant: {
    method: "POST",
    path: "/api/internal/agent/messages/assistant/complete",
  },
  completeTerminalAssistant: {
    method: "POST",
    path: "/api/internal/agent/messages/assistant/complete-terminal",
  },
  updateToolExecution: {
    method: "POST",
    path: "/api/internal/agent/tool-executions/update",
  },
  updateRunNotice: {
    method: "POST",
    path: "/api/internal/agent/run-notice",
  },
  commitCompactionWithTerminalIntent: {
    method: "POST",
    path: "/api/internal/agent/messages/compaction/complete",
  },
  confirmCompactionCommit: {
    method: "POST",
    path: "/api/internal/agent/messages/compaction/confirm",
  },
  markRunWorkInProgress: {
    method: "POST",
    path: "/api/internal/agent/runs/work-in-progress",
  },
  persistRunTerminalIntent: {
    method: "POST",
    path: "/api/internal/agent/runs/terminal-intent",
  },
  convergeRunTerminal: {
    method: "POST",
    path: "/api/internal/agent/runs/converge-terminal",
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
  getCompactionSource: {
    method: "POST",
    path: "/api/internal/agent/compaction-source",
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
export * from "./agent-provider-replay.js";
