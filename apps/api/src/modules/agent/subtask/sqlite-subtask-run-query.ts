import type { Db } from "../../../infra/db/db.js";
import {
  getAgentSession,
  getRunRecord,
  getSessionVisibleItems,
} from "../agent.store.js";
import type { SubtaskRunQuery } from "./subtask-ports.js";

/** SQLite query adapter for ownership-fenced Subtask result/status reads. */
export class SqliteSubtaskRunQuery implements SubtaskRunQuery {
  constructor(private readonly db: Db) {}

  findSession(sessionId: string) {
    return getAgentSession(this.db, sessionId);
  }

  findRunInSession(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }) {
    const run = getRunRecord(this.db, input.runId);
    if (!run || run.workspaceId !== input.workspaceId || run.sessionId !== input.sessionId) {
      return null;
    }
    return run;
  }

  listVisibleItemsByRun(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }) {
    return getSessionVisibleItems(this.db, input.workspaceId, input.sessionId)
      .filter((item) => item.runId === input.runId)
      .sort((a, b) => a.id - b.id);
  }
}
