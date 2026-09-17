import type { AgentSessionRecord } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import type {
  AgentApiCompleteAssistantRequest,
  AgentApiCreateStreamingAssistantRequest,
  AgentApiCreateStreamingAssistantResponse,
  AgentApiFlushAssistantPartsRequest,
  AgentApiReplaceStreamingAssistantRequest,
  AgentApiReplaceStreamingAssistantResponse,
  AgentApiPromptContextRequest,
  AgentApiResumeStreamingAssistantRequest,
  AgentApiPromptContextResponse,
  AgentApiArchiveReadRequest,
  AgentApiArchiveSearchRequest,
  AgentApiArchivePageResponse,
  AgentApiRunCompleteRequest,
  AgentApiUpdateRunNoticeRequest,
  AgentApiUpdateToolExecutionRequest,
  AgentApiFencedWriteResponse
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
  archiveReadFromWorker(params: AgentApiArchiveReadRequest): AgentApiArchivePageResponse;
  archiveSearchFromWorker(params: AgentApiArchiveSearchRequest): AgentApiArchivePageResponse;
  createStreamingAssistantFromWorker(params: AgentApiCreateStreamingAssistantRequest): AgentApiCreateStreamingAssistantResponse;
  flushAssistantPartsFromWorker(params: AgentApiFlushAssistantPartsRequest): AgentApiFencedWriteResponse;
  resumeStreamingAssistantFromWorker(params: AgentApiResumeStreamingAssistantRequest): AgentApiFencedWriteResponse;
  replaceStreamingAssistantFromWorker(params: AgentApiReplaceStreamingAssistantRequest): AgentApiReplaceStreamingAssistantResponse;
  completeAssistantFromWorker(params: AgentApiCompleteAssistantRequest): AgentApiFencedWriteResponse;
  updateToolExecutionFromWorker(params: AgentApiUpdateToolExecutionRequest): AgentApiFencedWriteResponse;
  updateRunNoticeFromWorker(params: AgentApiUpdateRunNoticeRequest): AgentApiFencedWriteResponse;
  completeRunFromWorker(params: AgentApiRunCompleteRequest): void;
  getSession(sessionId: string): Pick<AgentSessionRecord, "headMessageId"> | null;
};
