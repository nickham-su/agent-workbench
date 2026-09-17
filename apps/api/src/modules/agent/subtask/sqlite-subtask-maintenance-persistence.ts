import type { Db } from "../../../infra/db/db.js";
import type {
  SubtaskLocalCompensationPersistence,
  SubtaskOrphanCandidate,
  SubtaskOrphanPersistence,
} from "./subtask-ports.js";

/**
 * SQLite-only maintenance adapter. Its two public capabilities intentionally
 * expose separate policies: callers cannot disable orphan age/fork safeguards.
 */
export class SqliteSubtaskMaintenancePersistence
  implements SubtaskLocalCompensationPersistence, SubtaskOrphanPersistence
{
  constructor(private readonly db: Db) {}

  /**
   * Removes only the Session created by the failing materialization request.
   * A fork may point its head at shared parent Messages, which are intentionally
   * not a deletion precondition and are never removed here.
   */
  deleteCreatedSessionIfStillSafe(input: {
    workspaceId: string;
    createdSessionId: string;
    expectedParentSessionId: string;
    expectedForkedFromSessionId: string | null;
    expectedForkedFromMessageId: string | null;
  }) {
    const transaction = this.db.transaction(() =>
      this.db.prepare(`
        delete from agent_session
        where id = @createdSessionId
          and workspace_id = @workspaceId
          and kind = 'subtask'
          and forked_from_session_id is @expectedForkedFromSessionId
          and forked_from_message_id is @expectedForkedFromMessageId
          and (
            @expectedForkedFromSessionId is null
            or forked_from_session_id = @expectedParentSessionId
          )
          and exists (
            select 1 from session_run_state state
            where state.workspace_id = @workspaceId
              and state.session_id = @createdSessionId
              and state.status = 'idle'
              and state.active_run_id is null
          )
          and not exists (
            select 1 from agent_run run
            where run.workspace_id = @workspaceId
              and run.session_id = @createdSessionId
          )
          and not exists (
            select 1 from agent_message message
            where message.workspace_id = @workspaceId
              and message.origin_session_id = @createdSessionId
          )
          and not exists (
            select 1 from agent_tool_execution execution
            where execution.origin_session_id = @createdSessionId
          )
          and not exists (
            select 1 from agent_client_request request
            where request.workspace_id = @workspaceId
              and request.session_id = @createdSessionId
          )
          and not exists (
            select 1 from agent_session_agent_model_override override
            where override.session_id = @createdSessionId
          )
          and not exists (
            select 1 from agent_session descendant
            where descendant.workspace_id = @workspaceId
              and descendant.forked_from_session_id = @createdSessionId
          )
      `).run(input).changes,
    );
    return transaction() > 0;
  }

  listSuspects(input: { olderThan: number }): SubtaskOrphanCandidate[] {
    return this.db
      .prepare(
        `
          select
            s.workspace_id as workspaceId,
            s.id as sessionId,
            s.created_at as createdAt,
            s.forked_from_session_id as forkedFromSessionId,
            s.forked_from_message_id as forkedFromMessageId
          from agent_session s
          where s.kind = 'subtask'
            and s.created_at < @olderThan
            and s.head_message_id is null
            and not exists (
              select 1 from agent_run r
              where r.workspace_id = s.workspace_id and r.session_id = s.id
            )
          order by s.created_at asc, s.id asc
        `,
      )
      .all(input) as SubtaskOrphanCandidate[];
  }

  deleteSuspectIfStillEligible(input: {
    workspaceId: string;
    sessionId: string;
    olderThan: number;
  }) {
    return this.deleteEmptySubtaskSessionIfStillEligible({ ...input, requireForkLineage: true });
  }

  /** Shared final-fence primitive; private so policy switches never cross domains. */
  private deleteEmptySubtaskSessionIfStillEligible(input: {
    workspaceId: string;
    sessionId: string;
    olderThan: number | null;
    requireForkLineage: boolean;
  }) {
    const transaction = this.db.transaction(() =>
      this.db
        .prepare(
          `
            delete from agent_session
            where id = @sessionId
              and workspace_id = @workspaceId
              and kind = 'subtask'
              and (@olderThan is null or created_at < @olderThan)
              and (@requireForkLineage = 0 or (forked_from_session_id is not null and forked_from_message_id is not null))
              and head_message_id is null
              and not exists (
                select 1 from agent_run r
                where r.workspace_id = @workspaceId and r.session_id = @sessionId
              )
          `,
        )
        .run({ ...input, requireForkLineage: input.requireForkLineage ? 1 : 0 }).changes,
    );
    return transaction() > 0;
  }
}
