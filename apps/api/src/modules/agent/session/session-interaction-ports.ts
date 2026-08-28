import type {
  AgentImageMediaType,
  AgentContextItemRecord,
  AgentControlResult,
  AgentForkSessionRequest,
  AgentRevertSessionRequest,
  AgentSendMessageRequest,
  AgentSendMessageResponse,
  AgentSessionRecord,
  AgentSessionRunState,
  AgentUiLocale
} from "@agent-workbench/shared";
import type { AgentApiSubtaskStartRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { AgentRuntimePort } from "../agent.runtime-port.js";

export type SessionCreateInput = {
  id: string;
  workspaceId: string;
  title: string;
  kind: "primary" | "subtask";
  createdAt: number;
  forkedFromSessionId?: string | null;
  forkedFromItemId?: number | null;
};

export type SessionCloneInput = {
  id: string;
  createdAt: number;
  archiveAt: number;
  fromSession: AgentSessionRecord;
  fromItemId: number;
  mode: "with_archive" | "visible_only";
  title?: string;
  targetKind: "primary" | "subtask";
  boundaryPolicy: "public-user-assistant" | "internal-resolved";
};

export type SessionInteractionStore = {
  workspaceExists(workspaceId: string): boolean;
  getSession(sessionId: string): AgentSessionRecord | null;
  listSessions(workspaceId: string): AgentSessionRecord[];
  createSession(input: SessionCreateInput): void;
  cloneSession(input: SessionCloneInput): Promise<AgentSessionRecord>;
  findClientRequestDedup(input: { workspaceId: string; sessionId: string; clientRequestId: string }): { messageItemId: number; runId: string } | null;
  getRunState(workspaceId: string, sessionId: string): Pick<AgentSessionRunState, "status">;
  getControlRunState(sessionId: string): AgentSessionRunState;
  getTranscriptItem(sessionId: string, workspaceId: string, itemId: number): AgentContextItemRecord | null;
  hasNonTerminalItems(workspaceId: string, sessionId: string): boolean;
  moveHead(input: { workspaceId: string; sessionId: string; expectedHeadItemId: number | null; nextHeadItemId: number; updatedAt: number }): void;
};

export type SessionProfileReader = {
  resolveUser(input: { workspaceId: string; sessionId: string; requestedAgentId?: string | null }): { agentId: string; providerId: string; modelId: string };
};

export type SessionLifecycleStarter = {
  startUserRun(input: {
    workspaceId: string;
    sessionId: string;
    clientRequestId: string;
    text: string;
    inputText: string;
    images: NormalizedAgentUserImageInput[];
    agentId: string;
    providerId: string;
    modelId: string;
    uiLocale: AgentUiLocale | null;
    runtime: AgentRuntimePort;
  }): Promise<AgentSendMessageResponse>;
};

export type SessionInteractionClock = { nowMs(): number };
export type SessionInteractionIds = { newSessionId(): string };
export type SessionInteractionLogger = { warn(bindings: Record<string, unknown>, message: string): void };

export type SessionInteractionApplicationDependencies = {
  store: SessionInteractionStore;
  profileReader: SessionProfileReader;
  lifecycleStarter: SessionLifecycleStarter;
  clock: SessionInteractionClock;
  ids: SessionInteractionIds;
  logger: SessionInteractionLogger;
  normalizeUiLocale(value: unknown): AgentUiLocale | null;
  isConflict(error: unknown): boolean;
  toConflictHttpError(error: unknown): Error;
};

export type RevertSessionCommand = {
  sessionId: string;
  body: AgentRevertSessionRequest;
  runtime: Pick<AgentRuntimePort, "cancelSession">;
};

export type SubtaskSessionMaterializationCommand = {
  workspaceId: string;
  parentSessionId: string;
  parentToolItemId: number;
  session: AgentApiSubtaskStartRequest["session"];
  subtaskTitleBase: string;
  forkBoundaryItemId: number | null;
  shouldUsePreforkSummary: boolean;
};

export type SessionInteractionApplication = {
  listSessions(workspaceId: string): AgentSessionRecord[];
  createPrimarySession(params: { workspaceId: string; title?: string }): AgentSessionRecord;
  forkPrimarySession(params: AgentForkSessionRequest): Promise<AgentSessionRecord>;
  sendMessage(params: { sessionId: string; body: NormalizedAgentUserMessageInput; runtime: AgentRuntimePort }): Promise<AgentSendMessageResponse>;
  revertSession(command: RevertSessionCommand): Promise<AgentControlResult>;
  resolveSubtaskSessionForStart(command: SubtaskSessionMaterializationCommand): Promise<{ session: AgentSessionRecord; createdSessionId: string | null }>;
};

export type NormalizedAgentUserImageInput = {
  attachmentId: string;
  storageKey: string;
  tempId: string;
  filename: string;
  mediaType: AgentImageMediaType;
  byteSize: number;
  position: number;
};

export type NormalizedAgentUserMessageInput = {
  workspaceId: string;
  clientRequestId: string;
  text: string;
  agentId?: string;
  uiLocale?: AgentUiLocale;
  images?: NormalizedAgentUserImageInput[];
};
