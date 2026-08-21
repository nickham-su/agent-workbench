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

  deleteNewSessionIfStillEmpty(input: {
    workspaceId: string;
    sessionId: string;
  }) {
    return this.deleteEmptySubtaskSessionIfStillEligible({ ...input, olderThan: null, requireForkLineage: false });
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
            s.forked_from_item_id as forkedFromItemId
          from agent_session s
          left join agent_session_head h
            on h.workspace_id = s.workspace_id and h.session_id = s.id
          where s.kind = 'subtask'
            and s.created_at < @olderThan
            and h.head_item_id is null
            and not exists (
              select 1 from agent_run r
              where r.workspace_id = s.workspace_id and r.session_id = s.id
            )
            and not exists (
              select 1 from agent_context_item i
              where i.workspace_id = s.workspace_id and i.session_id = s.id
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
              and (@requireForkLineage = 0 or (forked_from_session_id is not null and forked_from_item_id is not null))
              and not exists (
                select 1 from agent_session_head h
                where h.workspace_id = @workspaceId and h.session_id = @sessionId and h.head_item_id is not null
              )
              and not exists (
                select 1 from agent_run r
                where r.workspace_id = @workspaceId and r.session_id = @sessionId
              )
              and not exists (
                select 1 from agent_context_item i
                where i.workspace_id = @workspaceId and i.session_id = @sessionId
              )
          `,
        )
        .run({ ...input, requireForkLineage: input.requireForkLineage ? 1 : 0 }).changes,
    );
    return transaction() > 0;
  }
}
