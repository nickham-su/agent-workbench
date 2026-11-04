import type { AgentSessionKind, AgentSessionVisibility, WorkspaceAgentTabState } from "@agent-workbench/shared";
import { WorkspaceAgentTabStateErrorCode } from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import type { Db } from "../../infra/db/db.js";

export type AgentSessionKindForTabState = AgentSessionKind;
type WorkspaceSessionTabStateRow = {
  sessionId: string; visible: number; kind: AgentSessionKind; visibility: AgentSessionVisibility;
};

export function workspaceExistsForAgentTabState(db: Db, workspaceId: string): boolean {
  return Boolean(db.prepare("select 1 from workspaces where id = ?").get(workspaceId));
}

/** Returns only a Session currently owned by the supplied Workspace. */
export function findAgentSessionKindInWorkspace(db: Db, workspaceId: string, sessionId: string): AgentSessionKind | null {
  const row = db.prepare("select kind from agent_session where id = ? and workspace_id = ?")
    .get(sessionId, workspaceId) as { kind: AgentSessionKind } | undefined;
  return row?.kind ?? null;
}

function invalidTabState(): never {
  throw new HttpError(500, "Agent Tab state is invalid", WorkspaceAgentTabStateErrorCode.Invalid);
}

/** Do not let an inner join silently turn corrupt actual state into a closed Tab. */
export function assertWorkspaceSessionTabStateValid(db: Db, workspaceId: string) {
  const missing = db.prepare(`select 1 from agent_session s left join workspace_session_tab_state t
    on t.workspace_id = s.workspace_id and t.session_id = s.id
    where s.workspace_id = @workspaceId and (t.session_id is null or t.visible not in (0,1)) limit 1`).get({ workspaceId });
  const orphan = db.prepare(`select 1 from workspace_session_tab_state t
    where (t.workspace_id = @workspaceId or t.session_id in (select id from agent_session where workspace_id = @workspaceId))
      and not exists (select 1 from agent_session s where s.id = t.session_id and s.workspace_id = t.workspace_id) limit 1`).get({ workspaceId });
  if (missing || orphan) invalidTabState();
}

/** Caller owns the consistent read transaction (also used by the tabs list). */
export function readWorkspaceAgentTabState(db: Db, workspaceId: string): WorkspaceAgentTabState {
  assertWorkspaceSessionTabStateValid(db, workspaceId);
  const rows = db.prepare(`select t.session_id as sessionId, t.visible, s.kind, s.visibility
    from workspace_session_tab_state t join agent_session s
      on s.id = t.session_id and s.workspace_id = t.workspace_id
    where t.workspace_id = ? order by t.session_id collate binary asc`).all(workspaceId) as WorkspaceSessionTabStateRow[];
  return {
    workspaceId,
    openedSessionIds: rows.filter((row) => row.visible === 1).map((row) => row.sessionId),
    closedSessionIds: rows.filter((row) => row.kind === "primary" && row.visibility === "listed" && row.visible === 0).map((row) => row.sessionId),
    openedSubtaskSessionIds: rows.filter((row) => row.kind === "subtask" && row.visible === 1).map((row) => row.sessionId)
  };
}

/** Actual state is created with the Session. Mutations never upsert or delete. */
export function updateWorkspaceSessionTabState(db: Db, input: {
  workspaceId: string; sessionId: string; visible: boolean; updatedAt: number;
}) {
  const foreign = db.prepare("select 1 from workspace_session_tab_state where session_id = ? and workspace_id <> ? limit 1")
    .get(input.sessionId, input.workspaceId);
  if (foreign) invalidTabState();
  const result = db.prepare(`update workspace_session_tab_state set visible = @visible, updated_at = @updatedAt
    where workspace_id = @workspaceId and session_id = @sessionId`).run({ ...input, visible: Number(input.visible) });
  if (result.changes !== 1) invalidTabState();
}
