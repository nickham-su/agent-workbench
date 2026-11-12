import type { Db } from "../../../infra/db/db.js";
import { HttpError } from "../../../app/errors.js";
import { AgentAttachmentPublicationStore } from "../attachments/agent-attachment-publication.store.js";

/** Fixed targets only: a retry must never discover and cancel later messages. */
export function cancelQueuedReceipts(db: Db, scope: { workspaceId: string; sessionId: string }, receiptIds: readonly string[], at: number): number {
  return db.transaction(() => {
    const rows = [...new Set(receiptIds)].map(id => {
      const row = db.prepare("select id,status from agent_user_message_receipt where workspace_id=? and session_id=? and id=?")
        .get(scope.workspaceId, scope.sessionId, id) as { id: string; status: string } | undefined;
      if (!row) throw new HttpError(404, "Receipt not found");
      return row;
    });
    const queued = rows.filter(row => row.status === "queued");
    const publications = new AgentAttachmentPublicationStore(db, () => at);
    for (const row of queued) {
      publications.retainReceipt({ ...scope, receiptId: row.id }, "cancelled");
      db.prepare("delete from agent_user_message_receipt_attachment where receipt_id=?").run(row.id);
      db.prepare("update agent_user_message_receipt set status='cancelled',input_text=null,text=null,updated_at=? where id=?").run(at, row.id);
    }
    if (queued.length) db.prepare("update agent_session_queue_control set queue_version=queue_version+1,updated_at=? where workspace_id=? and session_id=?")
      .run(at, scope.workspaceId, scope.sessionId);
    return queued.length;
  }).immediate();
}

/** Run-scoped cleanup: delayed failure/terminal replays cannot touch a later Run's buffer. */
export function discardRunQueuedReceipts(db: Db, scope: { workspaceId: string; sessionId: string; runId: string }, at: number) {
  const rows = db.prepare("select id from agent_user_message_receipt where workspace_id=? and session_id=? and target_run_id=? and status='queued'")
    .all(scope.workspaceId, scope.sessionId, scope.runId) as Array<{ id: string }>;
  return cancelQueuedReceipts(db, scope, rows.map(row => row.id), at);
}
