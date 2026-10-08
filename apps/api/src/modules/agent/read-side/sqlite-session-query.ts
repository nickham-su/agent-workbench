import type { AgentSessionListResponse, AgentSessionRecord } from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import type { Db } from "../../../infra/db/db.js";
import { listEffectiveWorkspaceSessionTabStateOverrides } from "../../workspaces/workspace-session-tab-state.store.js";
import { getMessageSession } from "../agent-message.store.js";
import { decodeSessionCursor, encodeSessionCursor, type SessionListQuery } from "./session-list-query.js";

export const SESSION_METADATA_COLUMNS = `s.id,s.workspace_id as workspaceId,s.title,s.kind,
  s.head_message_id as headMessageId,s.context_root_message_id as contextRootMessageId,s.revision,
  s.forked_from_session_id as forkedFromSessionId,s.forked_from_message_id as forkedFromMessageId,
  s.created_at as createdAt,s.updated_at as updatedAt`;
export const CONTINUABLE_CONDITION = `s.kind = 'primary' and s.head_message_id is not null
  and agent_trim_title(s.title) <> '' and agent_trim_title(s.title) <> '新会话'`;
export const TABS_CONDITION = `(
  (s.kind = 'primary' and not exists (select 1 from workspace_session_tab_state t
    where t.workspace_id = s.workspace_id and t.session_id = s.id and t.visible = 0))
  or (s.kind = 'subtask' and exists (select 1 from workspace_session_tab_state t
    where t.workspace_id = s.workspace_id and t.session_id = s.id and t.visible = 1)))`;

/** Public metadata reads deliberately do not load messages or run state. */
export class SqliteSessionQuery {
  constructor(private readonly db: Db) {}

  private assertWorkspace(workspaceId: string) {
    if (!this.db.prepare("select 1 from workspaces where id = ?").get(workspaceId)) {
      throw new HttpError(404, "workspace not found", "WORKSPACE_NOT_FOUND");
    }
  }

  getSession(input: { workspaceId: string; sessionId: string }): AgentSessionRecord {
    return this.db.transaction(() => {
      this.assertWorkspace(input.workspaceId);
      const session = getMessageSession(this.db, input.workspaceId, input.sessionId);
      if (!session) throw new HttpError(404, "session not found", "SESSION_NOT_FOUND");
      return session;
    }).deferred();
  }

  listSessions(input: SessionListQuery): AgentSessionListResponse {
    // Cursor validation precedes SQL and does not grant access to another Workspace.
    const cursor = input.scope === "continuable" && input.cursor ? decodeSessionCursor(input.cursor, input) : null;
    return this.db.transaction((): AgentSessionListResponse => {
      this.assertWorkspace(input.workspaceId);
      if (input.scope === "tabs") {
        const overrides = listEffectiveWorkspaceSessionTabStateOverrides(this.db, input.workspaceId);
        const items = this.db.prepare(`select ${SESSION_METADATA_COLUMNS} from agent_session s
          where s.workspace_id = ? and ${TABS_CONDITION}
          order by s.updated_at desc, s.id collate binary desc`).all(input.workspaceId) as AgentSessionRecord[];
        return { scope: "tabs", items, tabState: {
          workspaceId: input.workspaceId,
          closedSessionIds: overrides.filter((item) => item.kind === "primary").map((item) => item.sessionId),
          openedSubtaskSessionIds: overrides.filter((item) => item.kind === "subtask").map((item) => item.sessionId)
        } };
      }
      const cursorCondition = cursor ? "and (s.updated_at < @updatedAt or (s.updated_at = @updatedAt and s.id collate binary < @id))" : "";
      const rows = this.db.prepare(`select ${SESSION_METADATA_COLUMNS} from agent_session s
        where s.workspace_id = @workspaceId and ${CONTINUABLE_CONDITION} ${cursorCondition}
        order by s.updated_at desc, s.id collate binary desc limit @limitPlusOne`).all({
          workspaceId: input.workspaceId, limitPlusOne: input.limit + 1,
          ...(cursor ? { updatedAt: cursor.updatedAt, id: cursor.id } : {})
        }) as AgentSessionRecord[];
      const items = rows.slice(0, input.limit);
      const last = items.at(-1);
      const nextCursor = rows.length > input.limit && last ? encodeSessionCursor({
        v: 1, scope: "continuable", workspaceId: input.workspaceId, limit: input.limit,
        updatedAt: last.updatedAt, id: last.id
      }) : null;
      return { scope: "continuable", items, nextCursor };
    }).deferred();
  }
}
