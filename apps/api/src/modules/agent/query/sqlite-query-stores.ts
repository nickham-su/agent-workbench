import type { Db } from "../../../infra/db/db.js";
import { getWorkspace, listRecentWorkspaces } from "../../workspaces/workspace.store.js";
import {
  getLatestTerminalAssistantTextForMessageRun,
  getRunRecord,
  listRecentMessageSessionsAcrossWorkspaces
} from "../agent-message.store.js";
import type { PeripheralAgentQueryStore } from "./peripheral-agent-query-ports.js";

export class SqlitePeripheralAgentQueryStore implements PeripheralAgentQueryStore {
  constructor(private readonly db: Db) {}

  workspaceExists(workspaceId: string) { return Boolean(getWorkspace(this.db, workspaceId)); }
  listRecentSessions(limit: number, kind: "primary" | "subtask" | "all") { return listRecentMessageSessionsAcrossWorkspaces(this.db, limit, kind); }
  listRecentWorkspaces(limit: number) { return listRecentWorkspaces(this.db, limit); }
  getRun(runId: string) { return getRunRecord(this.db, runId); }
  getLatestTerminalAssistantText(runId: string) { return getLatestTerminalAssistantTextForMessageRun(this.db, { runId }); }
}
