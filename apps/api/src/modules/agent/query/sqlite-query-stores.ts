import type { Db } from "../../../infra/db/db.js";
import { getWorkspace, listRecentWorkspaces } from "../../workspaces/workspace.store.js";
import {
  getAgentSession,
  getLatestTerminalAssistantTextByRunId,
  getLatestTerminalRunRecord,
  getRunRecord,
  getRunState,
  getSessionTranscriptBeforeWindow,
  listSubtaskRunProjectionsByParentTools,
  getSessionTranscriptItems,
  getSessionTranscriptItemsAfterIdWindow,
  getSessionTranscriptTailWindow,
  getTranscriptItemById,
  listNonTerminalVisibleItemIds,
  listRecentSessionsAcrossWorkspaces
} from "../agent.store.js";
import type { ContextQueryStore } from "./context-query-ports.js";
import type { PeripheralAgentQueryStore } from "./peripheral-agent-query-ports.js";

export class SqliteContextQueryStore implements ContextQueryStore {
  constructor(private readonly db: Db) {}

  getSession(sessionId: string) { return getAgentSession(this.db, sessionId); }
  getWorkspace(workspaceId: string) {
    const workspace = getWorkspace(this.db, workspaceId);
    return workspace ? { title: workspace.title, dirName: workspace.dirName } : null;
  }
  listTranscript(workspaceId: string, sessionId: string) { return getSessionTranscriptItems(this.db, workspaceId, sessionId); }
  listAfterWindow(input: { workspaceId: string; sessionId: string; afterId: number }) { return getSessionTranscriptItemsAfterIdWindow(this.db, input); }
  getTailWindow(workspaceId: string, sessionId: string, tailLimit: number) { return getSessionTranscriptTailWindow(this.db, workspaceId, sessionId, tailLimit); }
  getBeforeWindow(input: { workspaceId: string; sessionId: string; beforeId: number; limit: number }) { return getSessionTranscriptBeforeWindow(this.db, input); }
  getTranscriptItem(workspaceId: string, sessionId: string, itemId: number) { return getTranscriptItemById(this.db, workspaceId, sessionId, itemId); }
  getRunState(workspaceId: string, sessionId: string) { return getRunState(this.db, workspaceId, sessionId); }
  getRun(runId: string) { return getRunRecord(this.db, runId); }
  getLatestTerminalRun(input: { workspaceId: string; sessionId: string }) { return getLatestTerminalRunRecord(this.db, input); }
  listSubtaskRunProjectionsByParentTools(input: { workspaceId: string; parents: Array<{ parentRunId: string; parentToolItemId: number }> }) { return listSubtaskRunProjectionsByParentTools(this.db, input); }
  listNonTerminalVisibleItemIds(workspaceId: string, sessionId: string) { return listNonTerminalVisibleItemIds(this.db, workspaceId, sessionId); }
}

export class SqlitePeripheralAgentQueryStore implements PeripheralAgentQueryStore {
  constructor(private readonly db: Db) {}

  workspaceExists(workspaceId: string) { return Boolean(getWorkspace(this.db, workspaceId)); }
  listRecentSessions(limit: number, kind: "primary" | "subtask" | "all") { return listRecentSessionsAcrossWorkspaces(this.db, limit, kind); }
  listRecentWorkspaces(limit: number) { return listRecentWorkspaces(this.db, limit); }
  getRun(runId: string) { return getRunRecord(this.db, runId); }
  getLatestTerminalAssistantText(runId: string) { return getLatestTerminalAssistantTextByRunId(this.db, { runId }); }
}
