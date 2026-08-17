import type { AgentQueuedRun } from "./agent.service.js";

export type AgentRuntimeRun = AgentQueuedRun & {
  inputText?: string;
  workspacePath: string;
  workspaceRepoDirNames: string[];
};

export type AgentRuntimePort = {
  enqueueRun(run: AgentRuntimeRun): void | Promise<void>;
  cancelSession(sessionId: string): void | Promise<void>;
};
