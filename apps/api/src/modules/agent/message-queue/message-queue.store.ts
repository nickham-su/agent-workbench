import { createHash } from "node:crypto";
import { canonicalRuntimeStopJson } from "@agent-workbench/shared/node/agent-run-stop";
import {
  AGENT_QUEUE_MAX_PENDING_BYTES, AGENT_QUEUE_MAX_PENDING_COUNT,
  type AgentMessageQueueSnapshot, type AgentQueueIdentity, type AgentQueuePauseCode,
  type AgentReceiptDetailResponse, type AgentUserMessageReceipt,
} from "@agent-workbench/shared";
import type { Db } from "../../../infra/db/db.js";
import { HttpError } from "../../../app/errors.js";
import { newSortableId } from "../../../utils/ids.js";
import { getMessageSession, getVisibleMessageChain } from "../agent-message.store.js";
import type { PublishedQueueImage } from "../attachments/agent-attachment-publication.service.js";
import { AgentAttachmentPublicationStore } from "../attachments/agent-attachment-publication.store.js";
import { workspaceDeletingFence } from "../lifecycle/workspace-deleting-fence.js";
import { pauseMessageQueue } from "./message-queue.guard.js";

export type QueueScope = { workspaceId: string; sessionId: string };
export type QueueReceiptRow = {
  id: string; workspace_id: string; session_id: string; client_request_id: string; sequence: number;
  payload_hash: string; status: "queued" | "injected" | "cancelled"; text: string | null; input_text: string | null;
  payload_bytes: number; attachment_count: number; agent_id: string; provider_id: string; model_id: string;
  ui_locale: "zh-CN" | "en-US" | null; message_id: string | null; injected_run_id: string | null;
  confirmation_state: "unconfirmed" | "confirmed" | "abandoned" | null;
  confirmation_source: "worker_model" | "local_fallback" | null; created_at: number; updated_at: number;
};
export const queueIdentity = (row: Pick<QueueReceiptRow, "agent_id" | "provider_id" | "model_id">): AgentQueueIdentity => ({ agentId: row.agent_id, providerId: row.provider_id, modelId: row.model_id });
export const sameQueueIdentity = (a: AgentQueueIdentity, b: AgentQueueIdentity) => a.agentId === b.agentId && a.providerId === b.providerId && a.modelId === b.modelId;
export const queuePayloadHash = (value: unknown) => createHash("sha256").update(canonicalRuntimeStopJson(value)).digest("hex");
export function toQueueReceipt(row: QueueReceiptRow): AgentUserMessageReceipt {
  const common = { id: row.id, clientRequestId: row.client_request_id, sequence: row.sequence, createdAt: row.created_at, updatedAt: row.updated_at };
  if (row.status !== "injected") return { ...common, status: row.status, messageId: null, runId: null, confirmationState: null, confirmationSource: null };
  const injected = { ...common, status: "injected" as const, messageId: row.message_id!, runId: row.injected_run_id! };
  return row.confirmation_state === "confirmed" ? { ...injected, confirmationState: "confirmed", confirmationSource: row.confirmation_source! }
    : { ...injected, confirmationState: row.confirmation_state as "unconfirmed" | "abandoned", confirmationSource: null };
}

/** One SQLite authority for accepted receipts, independent queue versions and snapshots. */
export class AgentMessageQueueStore {
  constructor(readonly db: Db, private readonly now = Date.now, private readonly newId = () => newSortableId("receipt")) {}

  assertScope(scope: QueueScope) {
    workspaceDeletingFence.assertWritable(scope.workspaceId);
    const session = getMessageSession(this.db, scope.workspaceId, scope.sessionId);
    if (!session) throw new HttpError(404, "Session not found");
    if (session.kind !== "primary") throw new HttpError(400, "Subtask session is read-only", "AGENT_SUBTASK_READONLY");
    if (!this.db.prepare("select 1 from workspaces where id=?").get(scope.workspaceId)) throw new HttpError(404, "Workspace not found");
    return session;
  }

  ensureControl(scope: QueueScope) {
    this.db.prepare(`insert into agent_session_queue_control(workspace_id,session_id,mode,queue_version,next_sequence,updated_at)
      values (?,?,'active',0,1,?) on conflict(session_id) do nothing`).run(scope.workspaceId, scope.sessionId, this.now());
  }

  getByRequest(scope: QueueScope & { clientRequestId: string }): QueueReceiptRow | null {
    return this.db.prepare("select * from agent_user_message_receipt where workspace_id=? and session_id=? and client_request_id=?")
      .get(scope.workspaceId, scope.sessionId, scope.clientRequestId) as QueueReceiptRow | undefined ?? null;
  }

  get(scope: QueueScope, receiptId: string): QueueReceiptRow {
    const row = this.db.prepare("select * from agent_user_message_receipt where workspace_id=? and session_id=? and id=?")
      .get(scope.workspaceId, scope.sessionId, receiptId) as QueueReceiptRow | undefined;
    if (!row) throw new HttpError(404, "Receipt not found");
    return row;
  }

  listQueued(scope: QueueScope) {
    return this.db.prepare("select * from agent_user_message_receipt where workspace_id=? and session_id=? and status='queued' order by sequence")
      .all(scope.workspaceId, scope.sessionId) as QueueReceiptRow[];
  }

  /** Only the authoritative visible ancestry can contribute recovery inputs. */
  listUnconfirmed(scope: QueueScope) {
    const ids = getVisibleMessageChain(this.db, scope).map(message => message.id);
    if (ids.length === 0) return [];
    return this.db.prepare(`select * from agent_user_message_receipt where workspace_id=? and status='injected'
      and confirmation_state='unconfirmed' and message_id in (select value from json_each(?))`).all(scope.workspaceId, JSON.stringify(ids)) as QueueReceiptRow[];
  }

  /** DB terminal alone is not a runtime-exit proof. Retirement is owned by S3. */
  hasUndrainedExecution(scope: QueueScope) {
    return !!this.db.prepare(`select 1 from agent_run where workspace_id=? and session_id=? and execution_phase<>'terminal'
      union all select 1 from agent_run_runtime_admission where workspace_id=? and session_id=?
        and runtime_instance_id is not null and state<>'retired' limit 1`)
      .get(scope.workspaceId, scope.sessionId, scope.workspaceId, scope.sessionId);
  }

  fixedIdentity(scope: QueueScope): AgentQueueIdentity | null {
    const current = this.db.prepare(`select r.agent_id,r.provider_id,r.model_id from agent_run r join session_run_state s on s.active_run_id=r.run_id
      where s.workspace_id=? and s.session_id=? and s.status='running' and r.run_kind='user' and r.interactive_queue_enabled=1
      and r.execution_phase in ('work_pending','work_in_progress')`).get(scope.workspaceId, scope.sessionId) as Parameters<typeof queueIdentity>[0] | undefined;
    const unconfirmed = this.listUnconfirmed(scope);
    const queued = this.listQueued(scope);
    const identity = current ? queueIdentity(current) : unconfirmed[0] ? queueIdentity(unconfirmed[0]) : queued[0] ? queueIdentity(queued[0]) : null;
    if (identity && [...unconfirmed, ...queued].some(row => !sameQueueIdentity(identity, queueIdentity(row)))) {
      throw new HttpError(409, "Session input identities are inconsistent", "AGENT_QUEUE_IDENTITY_INVARIANT");
    }
    return identity;
  }

  assertNamespaceAvailable(scope: QueueScope & { clientRequestId: string }) {
    if (this.db.prepare("select 1 from agent_client_request where workspace_id=? and session_id=? and client_request_id=?")
      .get(scope.workspaceId, scope.sessionId, scope.clientRequestId)) {
      throw new HttpError(409, "Request identity is owned by the legacy send API", "AGENT_REQUEST_ID_NAMESPACE_CONFLICT");
    }
  }

  assertCapacity(scope: QueueScope, bytes: number) {
    const pending = this.db.prepare(`select count(*) as count,coalesce(sum(payload_bytes),0) as bytes from agent_user_message_receipt
      where workspace_id=? and session_id=? and status='queued'`).get(scope.workspaceId, scope.sessionId) as { count: number; bytes: number };
    if (pending.count >= AGENT_QUEUE_MAX_PENDING_COUNT || pending.bytes + bytes > AGENT_QUEUE_MAX_PENDING_BYTES)
      throw new HttpError(429, "Session message queue capacity exceeded", "AGENT_QUEUE_CAPACITY_EXCEEDED");
  }

  /** Called by publication service inside its real, top-level receipt transaction. */
  insert(input: QueueScope & { clientRequestId: string; payloadHash: string; inputText: string; text: string; payloadBytes: number;
    identity: AgentQueueIdentity; uiLocale: "zh-CN" | "en-US" | null; images: readonly PublishedQueueImage[] }) {
    this.ensureControl(input);
    this.assertNamespaceAvailable(input);
    this.assertCapacity(input, input.payloadBytes);
    const control = this.db.prepare("select next_sequence as sequence from agent_session_queue_control where session_id=?").get(input.sessionId) as { sequence: number };
    const id = this.newId(); const at = this.now();
    this.db.prepare(`insert into agent_user_message_receipt(id,workspace_id,session_id,client_request_id,sequence,payload_hash,status,input_text,text,
      payload_bytes,attachment_count,agent_id,provider_id,model_id,ui_locale,created_at,updated_at)
      values (@id,@workspaceId,@sessionId,@clientRequestId,@sequence,@payloadHash,'queued',@inputText,@text,@payloadBytes,@attachmentCount,
        @agentId,@providerId,@modelId,@uiLocale,@at,@at)`).run({ ...input, ...input.identity, id, sequence: control.sequence, attachmentCount: input.images.length, at });
    for (let position = 0; position < input.images.length; position++) {
      const image = input.images[position]!;
      this.db.prepare(`insert into agent_attachment(id,workspace_id,storage_key,filename,media_type,byte_size,created_at) values (?,?,?,?,?,?,?)`)
        .run(image.attachmentId, input.workspaceId, image.storageKey, image.filename, image.mediaType, image.byteSize, at);
      this.db.prepare(`insert into agent_user_message_receipt_attachment(workspace_id,session_id,receipt_id,position,attachment_id,byte_sha256) values (?,?,?,?,?,?)`)
        .run(input.workspaceId, input.sessionId, id, position, image.attachmentId, image.byteSha256);
    }
    this.db.prepare("update agent_session_queue_control set next_sequence=next_sequence+1,queue_version=queue_version+1,updated_at=? where session_id=?")
      .run(at, input.sessionId);
    return this.get(input, id);
  }

  detail(scope: QueueScope, receiptId: string): AgentReceiptDetailResponse {
    const row = this.get(scope, receiptId);
    return { receipt: toQueueReceipt(row), text: row.text, inputText: row.input_text, attachments: this.attachments(scope, receiptId).map(({ id, position, filename, mediaType, byteSize }) => ({ id, position, filename, mediaType, byteSize })) };
  }

  attachments(scope: QueueScope, receiptId: string) {
    return this.db.prepare(`select a.id,a.storage_key as storageKey,a.filename,a.media_type as mediaType,a.byte_size as byteSize,
      ra.position,ra.byte_sha256 as byteSha256 from agent_user_message_receipt_attachment ra join agent_attachment a on a.id=ra.attachment_id
      where ra.workspace_id=? and ra.session_id=? and ra.receipt_id=? order by ra.position`).all(scope.workspaceId, scope.sessionId, receiptId) as Array<{
        id: string; storageKey: string; filename: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; byteSize: number; position: number; byteSha256: string;
      }>;
  }

  cancel(scope: QueueScope, receiptId: string) {
    return this.db.transaction(() => {
      this.assertScope(scope);
      const row = this.get(scope, receiptId);
      if (row.status === "injected") throw new HttpError(409, "Receipt has already entered the conversation", "AGENT_RECEIPT_ALREADY_INJECTED");
      if (row.status === "cancelled") return toQueueReceipt(row);
      const at = this.now();
      new AgentAttachmentPublicationStore(this.db, this.now).retainReceipt({ ...scope, receiptId }, "cancelled");
      this.db.prepare("delete from agent_user_message_receipt_attachment where receipt_id=?").run(receiptId);
      this.db.prepare("update agent_user_message_receipt set status='cancelled',input_text=null,text=null,updated_at=? where id=?").run(at, receiptId);
      this.db.prepare("update agent_session_queue_control set queue_version=queue_version+1,updated_at=? where session_id=?").run(at, scope.sessionId);
      return toQueueReceipt(this.get(scope, receiptId));
    }).immediate();
  }

  pause(scope: QueueScope, code: AgentQueuePauseCode) {
    this.db.transaction(() => { this.ensureControl(scope); pauseMessageQueue(this.db, scope.workspaceId, scope.sessionId, code, this.now()); }).immediate();
  }

  snapshot(scope: QueueScope): AgentMessageQueueSnapshot {
    return this.db.transaction(() => {
      this.assertScope(scope);
      const control = this.db.prepare("select mode,pause_code as pauseCode,queue_version as queueVersion from agent_session_queue_control where session_id=?")
        .get(scope.sessionId) as { mode: "active" | "paused"; pauseCode: AgentQueuePauseCode | null; queueVersion: number } | undefined;
      const rows = this.listQueued(scope); const unconfirmed = this.listUnconfirmed(scope);
      // Chain order, not receipt sequence across different source Sessions, is authoritative.
      const positions = new Map(getVisibleMessageChain(this.db, scope).map((message, index) => [message.id, index]));
      unconfirmed.sort((a, b) => positions.get(a.message_id!)! - positions.get(b.message_id!)!);
      const barriers = this.db.prepare(`select b.operation_id as operationId,b.state,b.last_error_code as code,b.created_at as createdAt,
          (select count(*) from agent_session_stop_target t where t.workspace_id=b.workspace_id and t.root_session_id=b.root_session_id
            and t.operation_id=b.operation_id and t.state<>'quiescent') as unresolvedTargets
        from agent_session_stop_barrier b where b.workspace_id=? and (b.root_session_id=? or exists(select 1 from agent_session_stop_target t
          where t.workspace_id=b.workspace_id and t.root_session_id=b.root_session_id and t.operation_id=b.operation_id and t.target_session_id=?))
        order by b.created_at,b.operation_id`).all(scope.workspaceId, scope.sessionId, scope.sessionId) as Array<{ operationId: string; state: string; code: AgentMessageQueueSnapshot["stop"]["code"]; createdAt: number; unresolvedTargets: number }>;
      const unresolved = barriers.filter(row => row.state !== "quiescent");
      const state: AgentMessageQueueSnapshot["stop"]["state"] = unresolved.some(row => row.state === "unknown") ? "unknown" : unresolved.length ? "pending" : barriers.length ? "quiescent" : "none";
      const selected = unresolved.find(row => row.state === state);
      return { workspaceId: scope.workspaceId, sessionId: scope.sessionId, queueVersion: control?.queueVersion ?? 0, mode: control?.mode ?? "active", pauseCode: control?.pauseCode ?? null,
        inputIdentity: this.fixedIdentity(scope),
        pendingCount: rows.length, pendingBytes: rows.reduce((sum, row) => sum + row.payload_bytes, 0), pendingIdentity: rows[0] ? queueIdentity(rows[0]) : null,
        unconfirmedInputCount: unconfirmed.length, recoveryIdentity: unconfirmed[0] ? queueIdentity(unconfirmed[0]) : null,
        unconfirmedInputSetHash: unconfirmed.length ? queuePayloadHash({ version: "agent-unconfirmed-input-set-v1", workspaceId: scope.workspaceId, sessionId: scope.sessionId,
          inputs: unconfirmed.map(row => ({ receiptId: row.id, messageId: row.message_id!, ...queueIdentity(row) })) }) : null,
        stop: { state, unresolvedOperationCount: unresolved.length, unresolvedTargetCount: unresolved.reduce((sum, row) => sum + row.unresolvedTargets, 0), code: selected?.code ?? (state === "pending" ? "stop_requested" : null) },
        items: rows.map(row => ({ ...toQueueReceipt(row), status: "queued" as const, messageId: null, runId: null, confirmationState: null, confirmationSource: null,
          textPreview: [...(row.text ?? "")].slice(0, 256).join(""), attachmentCount: row.attachment_count })) };
    })();
  }
}
