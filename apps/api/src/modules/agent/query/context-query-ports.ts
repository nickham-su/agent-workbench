import type {
  AgentContextItemRecord,
  AgentContextItemsResponse,
  AgentSessionRecord,
  AgentSessionRunState,
  AgentSessionStatusSummaryResponse
} from "@agent-workbench/shared";
import type { UiArtifactCapabilityPort } from "../artifact/ui-artifact-capability.js";
import type { AgentRunRecord, AgentRunStateRow } from "../agent.store.js";
import type { SubtaskParentKey, SubtaskRunProjectionRecord } from "./context-query-read-model.js";

export type ContextItemsQuery = {
  afterId?: number;
  tailLimit?: number;
  beforeId?: number;
  limit?: number;
  expectedHeadItemId?: number;
};

export type ContextQueryStore = {
  getSession(sessionId: string): AgentSessionRecord | null;
  getWorkspace(workspaceId: string): { title: string; dirName: string } | null;
  listTranscript(workspaceId: string, sessionId: string): AgentContextItemRecord[];
  listAfterWindow(input: { workspaceId: string; sessionId: string; afterId: number }): AgentContextItemRecord[];
  getTailWindow(workspaceId: string, sessionId: string, tailLimit: number): { items: AgentContextItemRecord[]; hasMoreBefore: boolean };
  getBeforeWindow(input: { workspaceId: string; sessionId: string; beforeId: number; limit: number }): { items: AgentContextItemRecord[]; hasMoreBefore: boolean };
  getTranscriptItem(workspaceId: string, sessionId: string, itemId: number): AgentContextItemRecord | null;
  getRunState(workspaceId: string, sessionId: string): AgentRunStateRow;
  getRun(runId: string): AgentRunRecord | null;
  getLatestTerminalRun(input: { workspaceId: string; sessionId: string }): (AgentRunRecord & { status: "completed" | "failed" | "cancelled" }) | null;
  listSubtaskRunProjectionsByParentTools(input: {
    workspaceId: string;
    parents: SubtaskParentKey[];
  }): SubtaskRunProjectionRecord[];
  listNonTerminalVisibleItemIds(workspaceId: string, sessionId: string): number[];
};

export type AvailableAgentQuery = {
  findUserDisplayAgent(input: { workspaceId: string; agentId: string }): { id: string; name: string } | null;
};

export type ContextQueryApplicationDependencies = {
  store: ContextQueryStore;
  uiArtifacts: UiArtifactCapabilityPort;
  availableAgentQuery: AvailableAgentQuery;
  resolveContextWindowTokens(input: {
    workspaceId: string;
    sessionKind: AgentSessionRecord["kind"];
    run: AgentRunRecord;
  }): number | null;
  clock: { nowMs(): number };
  logger: { warn(bindings: Record<string, unknown>, message: string): void;
    error(bindings: Record<string, unknown>, message: string): void };
};

export type ContextQueryApplicationPort = {
  getContextItems(sessionId: string, query?: ContextItemsQuery): AgentContextItemsResponse;
  getContextItem(sessionId: string, itemId: number): AgentContextItemRecord;
  getApplyPatchUiArtifact(params: { sessionId: string; itemId: number }): Promise<unknown>;
  getWriteUiArtifact(params: { sessionId: string; itemId: number }): Promise<unknown>;
  getRunState(sessionId: string): AgentSessionRunState;
  getSessionStatusSummary(params: { sessionId: string; agentId?: string | null; selectedAgentId?: string | null }): AgentSessionStatusSummaryResponse;
};
