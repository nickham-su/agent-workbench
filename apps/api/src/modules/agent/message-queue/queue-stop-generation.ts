import { createHash } from "node:crypto";
import { AGENT_QUEUE_INITIAL_STOP_GENERATION } from "@agent-workbench/shared";
import type { Db } from "../../../infra/db/db.js";

/** Immutable Stop identities, not timestamps or mutable exit proofs, fence in-flight sends. */
export function sessionStopGeneration(db: Db, scope: { workspaceId: string; sessionId: string }): string {
  const stops = db.prepare(`select b.root_session_id as rootSessionId,b.operation_id as operationId
    from agent_session_stop_barrier b where b.workspace_id=? and (b.root_session_id=? or exists(
      select 1 from agent_session_stop_target t where t.workspace_id=b.workspace_id and t.root_session_id=b.root_session_id
        and t.operation_id=b.operation_id and t.target_session_id=?)) order by b.root_session_id,b.operation_id`)
    .all(scope.workspaceId, scope.sessionId, scope.sessionId);
  if (stops.length === 0) return AGENT_QUEUE_INITIAL_STOP_GENERATION;
  return createHash("sha256").update(JSON.stringify(stops)).digest("hex");
}
