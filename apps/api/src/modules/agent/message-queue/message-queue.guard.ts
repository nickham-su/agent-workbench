import type { AgentQueuePauseCode } from "@agent-workbench/shared";
import type { Db } from "../../../infra/db/db.js";
import { HttpError } from "../../../app/errors.js";

/** Legacy force-start/history paths must never silently overtake accepted inputs. */
export function assertSessionQueueUnoccupied(db: Db, workspaceId: string, sessionId: string, options: { allowPaused?: boolean } = {}) {
  const control = db.prepare("select mode from agent_session_queue_control where workspace_id=? and session_id=?").get(workspaceId, sessionId) as { mode: string } | undefined;
  if (!options.allowPaused && control?.mode === "paused") throw new HttpError(409, "Session message queue is paused", "AGENT_QUEUE_PAUSED");
  const pending = db.prepare(`with recursive visible(id,previous_id) as (
    select m.id,m.previous_message_id from agent_session s join agent_message m on m.id=s.head_message_id
      where s.workspace_id=? and s.id=? and m.workspace_id=s.workspace_id
    union all
    select m.id,m.previous_message_id from visible v join agent_message m on m.id=v.previous_id
      where m.workspace_id=? and v.id is not (select context_root_message_id from agent_session where id=?)
    ) select 1 from agent_user_message_receipt r where r.workspace_id=? and
      ((r.session_id=? and r.status='queued') or
       (r.status='injected' and r.confirmation_state='unconfirmed' and r.message_id in (select id from visible))) limit 1`)
    .get(workspaceId, sessionId, workspaceId, sessionId, workspaceId, sessionId);
  if (pending) throw new HttpError(409, "Session has pending inputs", "SESSION_HAS_PENDING_INPUT");
}

/** Must be called inside the mutation's transaction. Already-paused reasons are preserved. */
export function pauseMessageQueue(db: Db, workspaceId: string, sessionId: string, code: AgentQueuePauseCode, updatedAt: number) {
  db.prepare(`update agent_session_queue_control set mode='paused',pause_code=?,queue_version=queue_version+1,updated_at=?
    where workspace_id=? and session_id=? and mode='active'`).run(code, updatedAt, workspaceId, sessionId);
}
