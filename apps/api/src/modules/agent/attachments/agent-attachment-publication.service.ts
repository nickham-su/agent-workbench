import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { HttpError } from "../../../app/errors.js";
import type { Db } from "../../../infra/db/db.js";
import { workspaceRoot } from "../../../infra/fs/paths.js";
import { workspaceLifecycleCoordinator } from "../../../infra/locks/workspace-lifecycle-coordinator.js";
import { workspaceDeletingFence } from "../lifecycle/workspace-deleting-fence.js";
import { assertAgentAttachmentTempId } from "./agent-attachment-paths.js";
import {
  prepareAgentWorkspaceAttachmentPublication, resolveSafeWorkspaceAgentAttachment, removeAgentAttachmentTempFile,
} from "./agent-attachment-storage.js";
import {
  AgentAttachmentPublicationStore, attachmentPublicationUncertain,
  type AttachmentPublicationIntent, type PublicationImage, type PublicationRequestScope,
} from "./agent-attachment-publication.store.js";

export type StagedQueuePublicationImage = PublicationImage & { tempId: string; filename: string };
export type PublishedQueueImage = PublicationImage & { intentId: string; filename: string };
export type PublishQueueRequest = PublicationRequestScope & { payloadHash: string; images: readonly StagedQueuePublicationImage[] };
type PublicationHooks = {
  /** Fault injection only: production does not provide hooks. */
  afterReservation?: () => void | Promise<void>;
  afterPublishingBoundary?: (imagePosition: number) => void;
  afterPublishBeforeRecord?: (imagePosition: number) => void;
  afterBusinessCommit?: () => void;
};

/**
 * Narrow attachment transaction boundary for the future receipt application.
 * It deliberately exposes neither Workspace unlink nor online maintenance release.
 * The caller owns request fingerprinting and must reuse its stable clientRequestId.
 */
export class AgentAttachmentPublicationService {
  readonly store: AgentAttachmentPublicationStore;
  private readonly publisherGeneration: string;

  constructor(private readonly dependencies: {
    db: Db; dataDir: string; publisherGeneration?: string; nowMs?: () => number; forTest?: PublicationHooks;
  }) {
    this.store = new AgentAttachmentPublicationStore(dependencies.db, dependencies.nowMs);
    this.publisherGeneration = dependencies.publisherGeneration ?? randomUUID();
  }

  getRetention() { return this.store.getRetention(); }

  /** Run before new admissions after API startup. Unknown publications remain charged. */
  recoverPreviousPublishers() { this.store.recoverPreviousPublishers(this.publisherGeneration); }

  getRequestStatus(scope: PublicationRequestScope) {
    this.assertScope(scope);
    return this.store.getRequest(scope).map(intent => ({
      id: intent.id, attachmentId: intent.attachmentId, state: intent.state, byteSize: intent.byteSize,
      mediaType: intent.mediaType, retentionCode: intent.retentionCode, receiptId: intent.receiptId,
      maintenanceId: intent.maintenanceId, releasedAt: intent.releasedAt,
    }));
  }

  /**
   * commit is synchronous and runs in the real receipt transaction. It must
   * create receipt + attachment references, or return the existing receipt.
   * Publication reservations have already committed independently at this point.
   * Do not call this method from an enclosing SQLite transaction.
   */
  async publishAndCommit<T>(input: PublishQueueRequest, commit: (input: {
    images: readonly PublishedQueueImage[]; existingReceiptId: string | null;
  }) => { receiptId: string; value: T }): Promise<T> {
    if (this.dependencies.db.inTransaction) throw new Error("Attachment publication requires an independent transaction");
    const request = { ...input, images: input.images.map(image => Object.freeze({ ...image })) };
    for (const image of request.images) {
      try { assertAgentAttachmentTempId(image.tempId); }
      catch { throw new HttpError(400, "Invalid attachment upload identifier."); }
    }
    return workspaceLifecycleCoordinator.withMutation(request.workspaceId, async () => {
      const workspaceDirName = this.assertScope(request);
      let reserved = false;
      let businessCommitted = false;
      const prepared: Array<{ intent: AttachmentPublicationIntent; publisher: Awaited<ReturnType<typeof prepareAgentWorkspaceAttachmentPublication>> }> = [];
      try {
        let intents = this.store.reserveRequest({ ...request, workspaceDirName, publisherGeneration: this.publisherGeneration });
        reserved = true;
        await this.dependencies.forTest?.afterReservation?.();
        this.assertScope(request);
        const existingReceiptId = this.store.getCommittedReceiptId(request, request.payloadHash);
        if (existingReceiptId !== null) {
          // A committed acknowledgement remains retrievable even if an image
          // was later retained/cancelled or its Workspace file is unavailable.
          if (intents.some(intent => intent.receiptId !== existingReceiptId)) throw attachmentPublicationUncertain();
          businessCommitted = true;
          const value = this.commitReceipt(request, intents, existingReceiptId, commit);
          businessCommitted = true;
          return value;
        }
        for (const intent of intents) {
          if (intent.state === "published" || (intent.state === "retained" && intent.ownedDev !== null && intent.ownedIno !== null)) {
            if (intent.receiptId !== null) throw attachmentPublicationUncertain();
            await this.verifyPublished(intent);
          } else if (intent.state === "reserved" && intent.publisherGeneration === this.publisherGeneration) {
            const publisher = await prepareAgentWorkspaceAttachmentPublication({
              dataDir: this.dependencies.dataDir, workspaceDirName,
              attachmentId: intent.attachmentId, storageKey: intent.storageKey, mediaType: intent.mediaType,
              tempId: request.images[intent.imagePosition]!.tempId,
              expectedContent: { byteSize: intent.byteSize, byteSha256: intent.byteSha256 },
            });
            prepared.push({ intent, publisher });
            publisher.checkAvailable();
          } else {
            throw attachmentPublicationUncertain();
          }
        }
        // All sources are prepared before the first irreversible link. No await
        // separates the durable publishing boundary from its synchronous link.
        for (const { intent, publisher } of prepared) {
          this.assertScope(request);
          publisher.checkAvailable();
          this.store.beginPublishing(intent.id, this.publisherGeneration);
          this.dependencies.forTest?.afterPublishingBoundary?.(intent.imagePosition);
          const owned = publisher.publish();
          this.dependencies.forTest?.afterPublishBeforeRecord?.(intent.imagePosition);
          this.store.recordPublished(intent.id, this.publisherGeneration, owned);
        }
        intents = this.store.getRequest(request);
        const value = this.commitReceipt(request, intents, null, commit);
        businessCommitted = true;
        this.dependencies.forTest?.afterBusinessCommit?.();
        return value;
      } catch (error) {
        if (reserved && !businessCommitted) {
          // Only a reserved row is proof of no publication. A publishing row is
          // never retried, released, or cleaned by pathname, even after failure.
          try {
            this.store.releaseReservedUnpublished(request, this.publisherGeneration);
            this.store.retainRequest(request, "business_rollback");
          } catch {
            throw new HttpError(503, "Attachment publication recovery is pending; retry using the same request ID.");
          }
        }
        if (error instanceof HttpError) throw error;
        // Filesystem/SQLite exceptions can contain private paths or payloads.
        throw new HttpError(503, "Attachment request could not be confirmed; query or retry using the same request ID.");
      } finally {
        await Promise.allSettled(prepared.map(({ publisher }) => publisher.close()));
        // Cleanup is restricted to the original private upload temp names.
        // Published Workspace names are never removed, including on rollback.
        await Promise.allSettled(request.images.map(image => removeAgentAttachmentTempFile({
          dataDir: this.dependencies.dataDir, tempId: image.tempId,
        })));
      }
    });
  }

  private commitReceipt<T>(request: PublishQueueRequest, intents: readonly AttachmentPublicationIntent[],
    existingReceiptId: string | null, commit: (input: { images: readonly PublishedQueueImage[]; existingReceiptId: string | null }) => { receiptId: string; value: T }): T {
    return this.dependencies.db.transaction(() => {
      this.assertScope(request);
      const images = Object.freeze(intents.map(intent => Object.freeze({
        intentId: intent.id, attachmentId: intent.attachmentId, storageKey: intent.storageKey,
        byteSize: intent.byteSize, byteSha256: intent.byteSha256, mediaType: intent.mediaType,
        filename: request.images[intent.imagePosition]!.filename,
      })));
      const result = commit({ images, existingReceiptId });
      if (result && typeof (result as unknown as { then?: unknown }).then === "function") {
        throw new Error("Attachment receipt commit must be synchronous");
      }
      if (!result || typeof result.receiptId !== "string" || result.receiptId.length === 0) throw attachmentPublicationUncertain();
      if (existingReceiptId !== null) {
        if (result.receiptId !== existingReceiptId || this.store.getCommittedReceiptId(request, request.payloadHash) !== existingReceiptId) {
          throw attachmentPublicationUncertain();
        }
      } else {
        this.store.associateReceipt(request, request.payloadHash, result.receiptId);
      }
      return result.value;
    }).immediate();
  }

  private assertScope(scope: PublicationRequestScope): string {
    workspaceDeletingFence.assertWritable(scope.workspaceId);
    const workspace = this.dependencies.db.prepare("select dir_name,path from workspaces where id=?").get(scope.workspaceId) as { dir_name: string; path: string } | undefined;
    if (!workspace) throw new HttpError(404, "workspace not found");
    if (path.resolve(workspace.path) !== path.resolve(workspaceRoot(this.dependencies.dataDir, workspace.dir_name))) {
      throw new HttpError(409, "Workspace attachment storage is unavailable.", "AGENT_ATTACHMENT_PUBLICATION_UNCERTAIN");
    }
    const session = this.dependencies.db.prepare("select workspace_id,kind from agent_session where id=?").get(scope.sessionId) as { workspace_id: string; kind: string } | undefined;
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspace_id !== scope.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    if (session.kind !== "primary") throw new HttpError(400, "subtask session is read-only", "AGENT_SUBTASK_READONLY");
    return workspace.dir_name;
  }

  private async verifyPublished(intent: AttachmentPublicationIntent) {
    const content = await resolveSafeWorkspaceAgentAttachment({
      dataDir: this.dependencies.dataDir, workspaceDirName: intent.workspaceDirName,
      attachmentId: intent.attachmentId, storageKey: intent.storageKey,
      mediaType: intent.mediaType, expectedByteSize: intent.byteSize,
    });
    if (!content) {
      this.store.retainRequest(intent, "attachment_integrity_failed");
      throw attachmentPublicationUncertain();
    }
    try {
      const stat = await content.handle.stat({ bigint: true });
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(Math.min(64 * 1024, intent.byteSize));
      let position = 0;
      while (position < intent.byteSize) {
        const { bytesRead } = await content.handle.read(buffer, 0, Math.min(buffer.length, intent.byteSize - position), position);
        if (bytesRead === 0) throw attachmentPublicationUncertain();
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const { bytesRead: extra } = await content.handle.read(Buffer.alloc(1), 0, 1, intent.byteSize);
      const after = await content.handle.stat({ bigint: true });
      if (String(stat.dev) !== intent.ownedDev || String(stat.ino) !== intent.ownedIno
        || after.size !== BigInt(intent.byteSize) || extra !== 0 || hash.digest("hex") !== intent.byteSha256) {
        throw attachmentPublicationUncertain();
      }
    } catch {
      this.store.retainRequest(intent, "attachment_integrity_failed");
      throw attachmentPublicationUncertain();
    } finally { await content.handle.close(); }
  }
}
