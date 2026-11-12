import type { Db } from "../../../infra/db/db.js";
import { HttpError } from "../../../app/errors.js";

/** Legacy force-start/history paths must never silently overtake accepted inputs. */
export function assertSessionQueueUnoccupied(db: Db, workspaceId: string, sessionId: string) {
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
