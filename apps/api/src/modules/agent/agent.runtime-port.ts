import type { AgentContextItemRecord, AgentSessionRecord } from "@agent-workbench/shared";
import type {
  AgentApiCreateContextItemRequest,
  AgentApiCreateContextItemResponse,
  AgentApiPromptContextRequest,
  AgentApiPromptContextResponse,
  AgentApiRunCompleteRequest,
  AgentApiRunStateRequest,
  AgentApiUpdateContextItemRequest
} from "@agent-workbench/shared/internal-contracts/agent-api";
import type { AgentRuntimeRun, RuntimeControlPort } from "./lifecycle/run-lifecycle-ports.js";

export type { AgentRuntimeRun };
export type AgentRuntimePort = RuntimeControlPort;

/**
 * Local fallback execution needs only these read/writeback/lifecycle operations.
 * Keep this port independent from AgentService so the runtime cannot acquire the
 * service's unrelated route, startup, or configuration responsibilities.
 */
export type LocalAgentRuntimeExecutionPort = {
  getPromptContextForRun(params: AgentApiPromptContextRequest): Promise<AgentApiPromptContextResponse>;
  appendContextItemFromWorker(params: AgentApiCreateContextItemRequest): AgentApiCreateContextItemResponse;
  updateContextItemFromWorker(params: AgentApiUpdateContextItemRequest & { itemId: number }): Promise<AgentContextItemRecord>;
  updateRunStateFromWorker(params: AgentApiRunStateRequest): void;
  completeRunFromWorker(params: AgentApiRunCompleteRequest): void;
  getSession(sessionId: string): Pick<AgentSessionRecord, "headItemId"> | null;
};
