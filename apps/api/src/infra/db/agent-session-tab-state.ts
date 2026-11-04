import type { AgentSessionKind, AgentSessionVisibility } from "@agent-workbench/shared";
import type { Db } from "./db.js";

/** Creation and the one-time v23 migration are the only callers of this default. */
export function initialAgentSessionTabVisible(kind: AgentSessionKind, visibility: AgentSessionVisibility): boolean {
  return kind === "primary" && visibility === "listed";
}

/** The caller must be inside the Session + RunState creation transaction. */
export function insertInitialAgentSessionTabState(db: Db, input: {
  workspaceId: string; id: string; kind: AgentSessionKind; visibility: AgentSessionVisibility; createdAt: number;
}) {
  db.prepare(`insert into workspace_session_tab_state (workspace_id, session_id, visible, updated_at)
    values (@workspaceId, @id, @visible, @createdAt)`)
    .run({ ...input, visible: initialAgentSessionTabVisible(input.kind, input.visibility) ? 1 : 0 });
}
