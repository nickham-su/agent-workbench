import type { Db } from "../../../infra/db/db.js";
import {
  findSubtaskRunByParentTool,
  listSubtaskChildSessionIdsByRunId,
} from "../agent.store.js";
import type {
  ActiveSubtaskChildQuery,
  SubtaskLineagePersistence,
} from "./subtask-ports.js";

export function isSubtaskParentToolUniqueConstraintError(
  error: unknown,
): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  // SQLite reports indexed columns rather than the partial-index name.
  return (
    candidate.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    typeof candidate.message === "string" &&
    candidate.message.includes("agent_run.parent_run_id") &&
    candidate.message.includes("agent_run.parent_tool_item_id")
  );
}

/**
 * Named SQLite authority for durable lineage reads and the target unique
 * classifier used by P3 conflict arbitration.
 */
export class SqliteSubtaskLineagePersistence
  implements SubtaskLineagePersistence, ActiveSubtaskChildQuery
{
  constructor(private readonly db: Db) {}

  findChildByParentTool(input: {
    workspaceId: string;
    parentRunId: string;
    parentToolItemId: number;
  }) {
    return findSubtaskRunByParentTool(this.db, input);
  }

  isParentToolUniqueConflict(error: unknown) {
    return isSubtaskParentToolUniqueConstraintError(error);
  }

  listByParentRun(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }) {
    return listSubtaskChildSessionIdsByRunId(this.db, input);
  }
}
