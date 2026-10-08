import type { Db } from "../../infra/db/db.js";

export type AgentSessionKindForTabState = "primary" | "subtask";

export type WorkspaceSessionTabStateOverride = {
  sessionId: string;
  visible: boolean;
  kind: AgentSessionKindForTabState;
};

type WorkspaceSessionTabStateOverrideRow = {
  sessionId: string;
  visible: number;
  kind: AgentSessionKindForTabState;
};

/** Narrow existence lookup for the tab-state API's stable Workspace error. */
export function workspaceExistsForAgentTabState(db: Db, workspaceId: string): boolean {
  return Boolean(db.prepare("select 1 from workspaces where id = ?").get(workspaceId));
}

/** Returns only a Session currently owned by the supplied Workspace. */
export function findAgentSessionKindInWorkspace(
  db: Db,
  workspaceId: string,
  sessionId: string
): AgentSessionKindForTabState | null {
  const row = db
    .prepare("select kind from agent_session where id = ? and workspace_id = ?")
    .get(sessionId, workspaceId) as { kind: AgentSessionKindForTabState } | undefined;
  return row?.kind ?? null;
}

/**
 * Reads only visibility overrides that still have the semantics required by the UI.
 * The double join condition deliberately ignores orphaned and cross-Workspace rows.
 */
export function listEffectiveWorkspaceSessionTabStateOverrides(
  db: Db,
  workspaceId: string
): WorkspaceSessionTabStateOverride[] {
  const rows = db
    .prepare(`
      select state.session_id as sessionId, state.visible as visible, session.kind as kind
      from workspace_session_tab_state as state
      join agent_session as session
        on session.id = state.session_id
       and session.workspace_id = state.workspace_id
      where state.workspace_id = @workspaceId
        and (
          (session.kind = 'primary' and state.visible = 0)
          or (session.kind = 'subtask' and state.visible = 1)
        )
      order by state.session_id asc
    `)
    .all({ workspaceId }) as WorkspaceSessionTabStateOverrideRow[];

  return rows.map((row) => ({ ...row, visible: row.visible === 1 }));
}

export function upsertWorkspaceSessionTabStateOverride(
  db: Db,
  input: { workspaceId: string; sessionId: string; visible: boolean; updatedAt: number }
) {
  db.prepare(`
    insert into workspace_session_tab_state (workspace_id, session_id, visible, updated_at)
    values (@workspaceId, @sessionId, @visible, @updatedAt)
    on conflict(workspace_id, session_id) do update set
      visible = excluded.visible,
      updated_at = excluded.updated_at
  `).run({ ...input, visible: input.visible ? 1 : 0 });
}

export function deleteWorkspaceSessionTabStateOverride(db: Db, workspaceId: string, sessionId: string) {
  db.prepare("delete from workspace_session_tab_state where workspace_id = ? and session_id = ?").run(workspaceId, sessionId);
}
