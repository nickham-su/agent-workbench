import { randomUUID } from "node:crypto";
import { AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES, type AgentAttachmentRetentionResponse } from "@agent-workbench/shared";
import type { AgentImageMediaType } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import { HttpError } from "../../../app/errors.js";
import type { Db } from "../../../infra/db/db.js";
import { AGENT_IMAGE_MAX_BYTES, AGENT_IMAGE_MAX_COUNT, AGENT_IMAGE_MAX_TOTAL_BYTES, AGENT_IMAGE_MEDIA_TYPES } from "./agent-attachment-limits.js";
import { assertAgentAttachmentId, assertAgentAttachmentStorageKey, assertAgentAttachmentWorkspaceDirectory } from "./agent-attachment-paths.js";

export type PublicationRequestScope = { workspaceId: string; sessionId: string; clientRequestId: string };
export type PublicationImage = {
  attachmentId: string; storageKey: string; mediaType: AgentImageMediaType; byteSize: number; byteSha256: string;
};
export type PublicationState = "reserved" | "publishing" | "published" | "retained" | "released_unpublished" | "released_offline_maintenance";
export type PublicationRetentionCode = "outcome_unknown" | "business_rollback" | "cancelled" | "abandoned"
  | "workspace_logically_deleted" | "attachment_integrity_failed" | "recovered_unpublished";
export type AttachmentPublicationIntent = PublicationRequestScope & PublicationImage & {
  id: string; imagePosition: number; payloadHash: string; workspaceDirName: string; state: PublicationState;
  publisherGeneration: string; ownedDev: string | null; ownedIno: string | null; receiptId: string | null;
  retentionCode: string | null; maintenanceId: string | null; releasedAt: number | null; createdAt: number; updatedAt: number;
};
type IntentRow = {
  id: string; workspace_id: string; session_id: string; client_request_id: string; image_position: number;
  payload_hash: string; byte_sha256: string; attachment_id: string; storage_key: string; workspace_dir_name: string;
  byte_size: number; media_type: AgentImageMediaType; state: PublicationState; retention_code: string | null;
  publisher_generation: string; owned_dev: string | null; owned_ino: string | null; receipt_id: string | null;
  maintenance_id: string | null; released_at: number | null; created_at: number; updated_at: number;
};
const CHARGED = "state not in ('released_unpublished','released_offline_maintenance')";
const SHA256 = /^[0-9a-f]{64}$/;
const SELECT_REQUEST = "select * from agent_attachment_publication_intent where workspace_id=? and session_id=? and client_request_id=? order by image_position";
function fromRow(row: IntentRow): AttachmentPublicationIntent {
  return {
    id: row.id, workspaceId: row.workspace_id, sessionId: row.session_id, clientRequestId: row.client_request_id,
    imagePosition: row.image_position, payloadHash: row.payload_hash, byteSha256: row.byte_sha256,
    attachmentId: row.attachment_id, storageKey: row.storage_key, workspaceDirName: row.workspace_dir_name,
    byteSize: row.byte_size, mediaType: row.media_type, state: row.state, retentionCode: row.retention_code,
    publisherGeneration: row.publisher_generation, ownedDev: row.owned_dev, ownedIno: row.owned_ino,
    receiptId: row.receipt_id, maintenanceId: row.maintenance_id, releasedAt: row.released_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
export function attachmentPublicationUncertain() {
  return new HttpError(409, "Attachment publication cannot be safely repeated; retained storage remains charged.", "AGENT_ATTACHMENT_PUBLICATION_UNCERTAIN");
}
function payloadConflict() {
  return new HttpError(409, "The request ID has already been used with different content.", "AGENT_REQUEST_PAYLOAD_CONFLICT");
}
function scopeArgs(scope: PublicationRequestScope) { return [scope.workspaceId, scope.sessionId, scope.clientRequestId]; }

/** Pure DB authority. Reservations/state-before-publication MUST commit outside the receipt transaction. */
export class AgentAttachmentPublicationStore {
  constructor(private readonly db: Db, private readonly nowMs: () => number = Date.now) {}

  private independent<T>(operation: () => T): T {
    if (this.db.inTransaction) throw new Error("Attachment publication requires an independent transaction");
    return this.db.transaction(operation).immediate();
  }

  getRetention(): AgentAttachmentRetentionResponse {
    const row = this.db.prepare(`select coalesce(sum(byte_size),0) as charged,
      coalesce(sum(case when state in ('reserved','publishing') then byte_size else 0 end),0) as reserved
      from agent_attachment_publication_intent where ${CHARGED}`).get() as { charged: number; reserved: number };
    return { scope: "agent_web_queue_v1", limitBytes: AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES,
      chargedBytes: row.charged, reservedBytes: row.reserved, retainedBytes: row.charged - row.reserved };
  }

  getRequest(scope: PublicationRequestScope): AttachmentPublicationIntent[] {
    return (this.db.prepare(SELECT_REQUEST).all(...scopeArgs(scope)) as IntentRow[]).map(fromRow);
  }

  reserveRequest(input: PublicationRequestScope & {
    payloadHash: string; workspaceDirName: string; publisherGeneration: string; images: readonly PublicationImage[];
  }): AttachmentPublicationIntent[] {
    this.validateReservation(input);
    return this.independent(() => {
      const existing = this.getRequest(input);
      if (existing.length > 0 && (existing.length !== input.images.length || existing.some((intent, index) => {
        const image = input.images[index]!;
        return intent.imagePosition !== index || intent.payloadHash !== input.payloadHash
          || intent.workspaceDirName !== input.workspaceDirName || intent.byteSha256 !== image.byteSha256
          || intent.byteSize !== image.byteSize || intent.mediaType !== image.mediaType;
      }))) throw payloadConflict();
      if (existing.length > 0 && this.getCommittedReceiptId(input, input.payloadHash) !== null) return existing;
      if (existing.some(intent => intent.state === "released_offline_maintenance" || intent.state === "publishing"
        || (intent.state === "retained" && (intent.ownedDev === null || intent.ownedIno === null)))) {
        throw attachmentPublicationUncertain();
      }
      const additionalBytes = existing.length === 0
        ? input.images.reduce((sum, image) => sum + image.byteSize, 0)
        : existing.filter(intent => intent.state === "released_unpublished").reduce((sum, intent) => sum + intent.byteSize, 0);
      // Existing tombstones are resolved before capacity: a replay is not a new allocation.
      if (additionalBytes > 0 && this.getRetention().chargedBytes + additionalBytes > AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES) {
        throw new HttpError(507, "Attachment retained-storage limit reached; offline maintenance is required.", "AGENT_ATTACHMENT_RETENTION_CAPACITY_EXCEEDED");
      }
      const now = this.nowMs();
      if (existing.length > 0) {
        const adopt = this.db.prepare(`update agent_attachment_publication_intent set state='reserved', publisher_generation=?,
          retention_code=null, updated_at=? where id=? and state in ('reserved','released_unpublished')`);
        for (const intent of existing) adopt.run(input.publisherGeneration, now, intent.id);
      } else {
        const insert = this.db.prepare(`insert into agent_attachment_publication_intent
          (id,workspace_id,session_id,client_request_id,image_position,payload_hash,byte_sha256,
           attachment_id,storage_key,workspace_dir_name,byte_size,media_type,state,publisher_generation,created_at,updated_at)
          values (?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?)`);
        input.images.forEach((image, position) => insert.run(`pub_${randomUUID()}`, input.workspaceId,
          input.sessionId, input.clientRequestId, position, input.payloadHash, image.byteSha256,
          image.attachmentId, image.storageKey, input.workspaceDirName, image.byteSize, image.mediaType,
          input.publisherGeneration, now, now));
      }
      return this.getRequest(input);
    });
  }

  beginPublishing(id: string, publisherGeneration: string): void {
    this.independent(() => {
      const changed = this.db.prepare(`update agent_attachment_publication_intent set state='publishing',updated_at=?
        where id=? and state='reserved' and publisher_generation=?`).run(this.nowMs(), id, publisherGeneration).changes;
      if (changed !== 1) throw attachmentPublicationUncertain();
    });
  }

  recordPublished(id: string, publisherGeneration: string, owned: { dev: number; ino: number }): void {
    if (!Number.isSafeInteger(owned.dev) || owned.dev < 0 || !Number.isSafeInteger(owned.ino) || owned.ino < 0) {
      throw attachmentPublicationUncertain();
    }
    this.independent(() => {
      const changed = this.db.prepare(`update agent_attachment_publication_intent
        set state='published',owned_dev=?,owned_ino=?,retention_code=null,updated_at=?
        where id=? and state='publishing' and publisher_generation=?`).run(String(owned.dev), String(owned.ino),
          this.nowMs(), id, publisherGeneration).changes;
      if (changed !== 1) throw attachmentPublicationUncertain();
    });
  }

  /** A reserved CAS proves no publisher could have crossed the durable publishing boundary. */
  releaseReservedUnpublished(scope: PublicationRequestScope, publisherGeneration: string): void {
    this.independent(() => this.db.prepare(`update agent_attachment_publication_intent
      set state='released_unpublished',retention_code='recovered_unpublished',updated_at=?
      where workspace_id=? and session_id=? and client_request_id=? and state='reserved' and publisher_generation=?`)
      .run(this.nowMs(), ...scopeArgs(scope), publisherGeneration));
  }

  /** Called before admitting requests for a new API generation; never retries filesystem publication. */
  recoverPreviousPublishers(publisherGeneration: string): void {
    this.independent(() => {
      const now = this.nowMs();
      this.db.prepare(`update agent_attachment_publication_intent set state='retained',retention_code='outcome_unknown',updated_at=?
        where state='publishing' and publisher_generation<>?`).run(now, publisherGeneration);
      this.db.prepare(`update agent_attachment_publication_intent set state='released_unpublished',
        retention_code='recovered_unpublished',updated_at=? where state='reserved' and publisher_generation<>?`).run(now, publisherGeneration);
    });
  }

  retainRequest(scope: PublicationRequestScope, code: PublicationRetentionCode): void {
    this.independent(() => this.db.prepare(`update agent_attachment_publication_intent
      set state='retained',retention_code=case when state='publishing' then 'outcome_unknown'
        when retention_code in ('outcome_unknown','attachment_integrity_failed') then retention_code
        else ? end,updated_at=? where workspace_id=? and session_id=? and client_request_id=?
      and state in ('publishing','published','retained')`).run(code, this.nowMs(), ...scopeArgs(scope)));
  }

  /** Intended for the receipt cancellation/abandon transaction; never releases charged storage. */
  retainReceipt(scope: { workspaceId: string; sessionId: string; receiptId: string }, code: "cancelled" | "abandoned"): void {
    this.db.prepare(`update agent_attachment_publication_intent set state='retained',retention_code=?,updated_at=?
      where workspace_id=? and session_id=? and receipt_id=? and state in ('published','retained')`)
      .run(code, this.nowMs(), scope.workspaceId, scope.sessionId, scope.receiptId);
  }

  getCommittedReceiptId(scope: PublicationRequestScope, payloadHash: string): string | null {
    const receipt = this.db.prepare(`select id,payload_hash from agent_user_message_receipt
      where workspace_id=? and session_id=? and client_request_id=?`).get(...scopeArgs(scope)) as { id: string; payload_hash: string } | undefined;
    if (!receipt) return null;
    if (receipt.payload_hash !== payloadHash) throw payloadConflict();
    return receipt.id;
  }

  /** Called INSIDE the receipt transaction, after its real attachment references exist. */
  associateReceipt(scope: PublicationRequestScope, payloadHash: string, receiptId: string): void {
    if (!this.db.inTransaction) throw new Error("Receipt publication association requires its business transaction");
    if (this.getCommittedReceiptId(scope, payloadHash) !== receiptId) throw attachmentPublicationUncertain();
    const intents = this.getRequest(scope);
    const receipt = this.db.prepare("select attachment_count from agent_user_message_receipt where id=?").get(receiptId) as { attachment_count: number };
    const referenceCount = this.db.prepare("select count(*) as count from agent_user_message_receipt_attachment where receipt_id=?")
      .get(receiptId) as { count: number };
    if (receipt.attachment_count !== intents.length || referenceCount.count !== intents.length) throw attachmentPublicationUncertain();
    for (const intent of intents) {
      if ((intent.state !== "published" && intent.state !== "retained") || !intent.ownedDev || !intent.ownedIno
        || (intent.receiptId !== null && intent.receiptId !== receiptId)) throw attachmentPublicationUncertain();
      const reference = this.db.prepare(`select 1 from agent_user_message_receipt_attachment ref
        join agent_attachment attachment on attachment.id=ref.attachment_id and attachment.workspace_id=ref.workspace_id
        where ref.workspace_id=? and ref.session_id=? and ref.receipt_id=? and ref.position=?
          and ref.attachment_id=? and ref.byte_sha256=? and attachment.storage_key=?
          and attachment.media_type=? and attachment.byte_size=?`)
        .get(scope.workspaceId, scope.sessionId, receiptId, intent.imagePosition, intent.attachmentId, intent.byteSha256,
          intent.storageKey, intent.mediaType, intent.byteSize);
      if (!reference) throw attachmentPublicationUncertain();
      this.db.prepare(`update agent_attachment_publication_intent set receipt_id=?,
        state=case when receipt_id is null then 'published' else state end,updated_at=? where id=?`)
        .run(receiptId, this.nowMs(), intent.id);
    }
  }

  private validateReservation(input: PublicationRequestScope & {
    payloadHash: string; workspaceDirName: string; publisherGeneration: string; images: readonly PublicationImage[];
  }) {
    if (![input.workspaceId, input.sessionId, input.clientRequestId, input.publisherGeneration].every(value => typeof value === "string" && value.length > 0)
      || !SHA256.test(input.payloadHash) || input.images.length > AGENT_IMAGE_MAX_COUNT
      || new Set(input.images.map(image => image.attachmentId)).size !== input.images.length) {
      throw new HttpError(400, "Invalid attachment publication request.");
    }
    try {
      assertAgentAttachmentWorkspaceDirectory(input.workspaceDirName);
      for (const image of input.images) {
        assertAgentAttachmentId(image.attachmentId);
        assertAgentAttachmentStorageKey(image.attachmentId, image.storageKey, image.mediaType);
        if (!SHA256.test(image.byteSha256) || !AGENT_IMAGE_MEDIA_TYPES.includes(image.mediaType)
          || !Number.isSafeInteger(image.byteSize) || image.byteSize < 1 || image.byteSize > AGENT_IMAGE_MAX_BYTES) throw new Error("Invalid image");
      }
    } catch { throw new HttpError(400, "Invalid attachment publication request."); }
    if (input.images.reduce((sum, image) => sum + image.byteSize, 0) > AGENT_IMAGE_MAX_TOTAL_BYTES) {
      throw new HttpError(413, "Attachment request exceeds the image byte limit.");
    }
  }
}
