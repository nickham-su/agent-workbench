import type { Db } from "../../../infra/db/db.js";
import { HttpError } from "../../../app/errors.js";

/** A structural operation must not silently overtake still-buffered inputs. */
export function assertSessionQueueUnoccupied(db: Db, workspaceId: string, sessionId: string) {
  const pending = db.prepare("select 1 from agent_user_message_receipt where workspace_id=? and session_id=? and status='queued' limit 1")
    .get(workspaceId, sessionId);
  if (pending) throw new HttpError(409, "Session has pending inputs", "SESSION_HAS_PENDING_INPUT");
}
