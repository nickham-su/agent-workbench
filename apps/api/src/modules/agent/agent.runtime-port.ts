import type { AgentQueuedRun } from "./agent.service.js";

export type AgentRuntimePort = {
  enqueueRun(run: AgentQueuedRun & { inputText?: string; workspacePath: string }): void | Promise<void>;
  cancelSession(sessionId: string): void | Promise<void>;
};
