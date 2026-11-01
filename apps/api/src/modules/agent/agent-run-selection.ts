/** Shared ordering for latest-created Run queries; terminal outcome/update time is irrelevant. */
export const LATEST_CREATED_RUN_ORDER_SQL = "created_at desc, run_id desc";

/**
 * Narrow SQL projection shared by single-Session recovery and batched activity reads.
 * Arguments must be trusted SQL expressions/parameter names, never request values.
 */
export function sessionSelectionAgentIdSql(workspaceId: string, sessionId: string, activeRunId: string): string {
  return `coalesce(
    (select run.agent_id from agent_run run
      where run.run_id = ${activeRunId}
        and run.workspace_id = ${workspaceId} and run.session_id = ${sessionId}),
    (select run.agent_id from agent_run run
      where run.workspace_id = ${workspaceId} and run.session_id = ${sessionId}
      order by ${LATEST_CREATED_RUN_ORDER_SQL} limit 1)
  )`;
}
