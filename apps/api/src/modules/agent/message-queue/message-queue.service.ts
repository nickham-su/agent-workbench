import type { AgentResumeMessageQueueRequest, AgentResumeMessageQueueResponse, AgentAbandonUnconfirmedInputRequest } from "@agent-workbench/shared";
import { AgentQueueRecoveryStore } from "./queue-recovery.store.js";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  AGENT_QUEUE_MAX_TEXT_BYTES, type AgentAcceptUserMessageMultipartPayload, type AgentAcceptUserMessageResponse,
  type AgentQueueIdentity, type AgentReceiptResponse, type AgentStopMessageQueueResponse,
} from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import { workspaceRoot } from "../../../infra/fs/paths.js";
import { AGENT_IMAGE_MAX_COUNT, AGENT_IMAGE_MAX_TOTAL_BYTES } from "../attachments/agent-attachment-limits.js";
import { AgentAttachmentPublicationService, type StagedQueuePublicationImage } from "../attachments/agent-attachment-publication.service.js";
import { resolveSafeWorkspaceAgentAttachment, removeAgentAttachmentTempFile } from "../attachments/agent-attachment-storage.js";
import type { AgentRuntimeControlService } from "../runtime-control/runtime-control.service.js";
import { AgentMessageQueueStore, queuePayloadHash, sameQueueIdentity, toQueueReceipt, type QueueScope } from "./message-queue.store.js";

export type AcceptQueueMessage = AgentAcceptUserMessageMultipartPayload & { images?: readonly StagedQueuePublicationImage[] };
export type QueueProfileResolver = (input: QueueScope & { requestedAgentId?: string; fixedIdentity: AgentQueueIdentity | null; hasImages: boolean }) => AgentQueueIdentity;

/** User-facing receipt authority; accepting durable inputs does not require an available Worker. */
export class AgentMessageQueueService {
  private closed = false;
  private accepting: boolean;
  private readonly activeAccepts = new Set<Promise<void>>();
  private wakeDispatcher: (() => void) | null = null;
  constructor(readonly store: AgentMessageQueueStore, private readonly dependencies: {
    admissionInitiallyClosed?: boolean; dataDir: string; publications: AgentAttachmentPublicationService;
    runtimeControl: Pick<AgentRuntimeControlService, "stopSession" | "reconcileStops">;
    resolveProfile: QueueProfileResolver;
    resumeSession?: (request: AgentResumeMessageQueueRequest & { sessionId: string }) => Promise<AgentResumeMessageQueueResponse>;
  }) { this.accepting = !dependencies.admissionInitiallyClosed; }

  setDispatcherWake(wake: () => void) { this.wakeDispatcher = wake; }
  openAdmission() { if (!this.closed) this.accepting = true; }
  closeAdmission() { this.closed = true; this.accepting = false; }
  /** False means the caller must keep DB/publication resources alive until requests settle. */
  async close(timeoutMs = 1000) {
    this.closeAdmission();
    if (!this.activeAccepts.size) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all([...this.activeAccepts]).then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  /** Call once behind the API startup barrier, before any new receipt admission. */
  recoverPublications() { this.dependencies.publications.recoverPreviousPublishers(); }
  private assertAccepting() { if (!this.accepting || this.closed) throw new HttpError(503, "Message queue is stopping", "AGENT_QUEUE_STOPPING"); }

  private fingerprint(input: AcceptQueueMessage) {
    return queuePayloadHash({ version: "agent-user-receipt-v1", inputText: input.text ?? "", agentId: input.agentId?.trim() || null,
      uiLocale: input.uiLocale ?? null, images: (input.images ?? []).map((image, position) => ({ position, filename: image.filename,
        mediaType: image.mediaType, byteSize: image.byteSize, byteSha256: image.byteSha256 })) });
  }

  private resolveProfile(scope: QueueScope, input: AcceptQueueMessage): AgentQueueIdentity {
    const fixed = this.store.fixedIdentity(scope);
    if (fixed && input.agentId?.trim() && input.agentId.trim() !== fixed.agentId)
      throw new HttpError(409, "Agent differs from the Session input identity", "AGENT_QUEUE_AGENT_CONFLICT");
    const resolved = this.dependencies.resolveProfile({ ...scope, requestedAgentId: input.agentId?.trim() || undefined,
      fixedIdentity: fixed, hasImages: !!input.images?.length });
    if (fixed && !sameQueueIdentity(fixed, resolved)) throw new HttpError(409, "Session input profile is unavailable", "AGENT_QUEUE_AGENT_CONFLICT");
    return resolved;
  }

  async accept(sessionId: string, input: AcceptQueueMessage): Promise<AgentAcceptUserMessageResponse> {
    const scope = { workspaceId: input.workspaceId, sessionId };
    const images = [...(input.images ?? [])];
    let settled!: () => void;
    const pending = new Promise<void>(resolve => { settled = resolve; });
    this.activeAccepts.add(pending);
    try {
      this.assertAccepting(); this.store.assertScope(scope);
      const payloadHash = this.fingerprint(input);
      const inputText = input.text ?? "";
      if (Buffer.byteLength(inputText, "utf8") > AGENT_QUEUE_MAX_TEXT_BYTES)
        throw new HttpError(413, "Message text exceeds the UTF-8 byte limit", "AGENT_QUEUE_TEXT_TOO_LARGE");
      if (!inputText.trim() && !images.length) throw new HttpError(400, "Text or image is required");
      if (images.length > AGENT_IMAGE_MAX_COUNT || images.reduce((sum, image) => sum + image.byteSize, 0) > AGENT_IMAGE_MAX_TOTAL_BYTES)
        throw new HttpError(400, "Message image limits exceeded", "AGENT_IMAGE_TOTAL_BYTES_EXCEEDED");
      const checkExisting = () => {
        const existing = this.store.getByRequest({ ...scope, clientRequestId: input.clientRequestId });
        if (existing && existing.payload_hash !== payloadHash) throw new HttpError(409, "Request payload differs from its accepted receipt", "AGENT_REQUEST_PAYLOAD_CONFLICT");
        return existing;
      };
      const existing = checkExisting();
      if (existing) return { receipt: toQueueReceipt(existing), deduplicated: true, queue: this.store.snapshot(scope) };
      this.store.assertNamespaceAvailable({ ...scope, clientRequestId: input.clientRequestId });
      const payloadBytes = Buffer.byteLength(inputText, "utf8") + images.reduce((sum, image) => sum + image.byteSize, 0);
      // Predictable validation before publication; repeat it after await inside the actual receipt transaction.
      this.store.assertCapacity(scope, payloadBytes);
      this.resolveProfile(scope, input);
      const accepted = await this.dependencies.publications.publishAndCommit({ ...scope, clientRequestId: input.clientRequestId, payloadHash, images }, ({ images: published }) => {
        this.assertAccepting(); this.store.assertScope(scope);
        const duplicate = checkExisting();
        if (duplicate) return { receiptId: duplicate.id, value: { receipt: toQueueReceipt(duplicate), deduplicated: true } };
        const identity = this.resolveProfile(scope, input);
        const row = this.store.insert({ ...scope, clientRequestId: input.clientRequestId, payloadHash, inputText, text: inputText.trim(),
          payloadBytes, identity, uiLocale: input.uiLocale ?? null, images: published });
        return { receiptId: row.id, value: { receipt: toQueueReceipt(row), deduplicated: false } };
      });
      this.wakeDispatcher?.();
      return { ...accepted, queue: this.store.snapshot(scope) };
    } catch (error) {
      if (error instanceof HttpError && error.code === "AGENT_QUEUE_IDENTITY_INVARIANT") this.store.pause(scope, "invariant_violation");
      throw error;
    } finally {
      try {
        await Promise.all(images.map(image => removeAgentAttachmentTempFile({ dataDir: this.dependencies.dataDir, tempId: image.tempId }).catch(() => undefined)));
      } finally { this.activeAccepts.delete(pending); settled(); }
    }
  }

  snapshot(scope: QueueScope) { return this.store.snapshot(scope); }
  byRequest(scope: QueueScope & { clientRequestId: string }): AgentReceiptResponse {
    return this.store.db.transaction(() => {
      this.store.assertScope(scope);
      const row = this.store.getByRequest(scope);
      if (!row) throw new HttpError(404, "Receipt not found");
      return { receipt: toQueueReceipt(row), queue: this.store.snapshot(scope) };
    })();
  }
  detail(scope: QueueScope, receiptId: string) {
    return this.store.db.transaction(() => { this.store.assertScope(scope); return this.store.detail(scope, receiptId); })();
  }
  cancel(scope: QueueScope, receiptId: string): AgentReceiptResponse {
    return this.store.db.transaction(() => ({ receipt: this.store.cancel(scope, receiptId), queue: this.store.snapshot(scope) })).immediate();
  }
  stop(scope: QueueScope, operationId: string): AgentStopMessageQueueResponse {
    this.assertAccepting(); this.store.assertScope(scope);
    const stopped = this.dependencies.runtimeControl.stopSession({ workspaceId: scope.workspaceId, rootSessionId: scope.sessionId, operationId });
    if (!stopped.replayed) void this.dependencies.runtimeControl.reconcileStops().catch(() => undefined);
    return { stopOperation: { operationId: stopped.record.operationId, acceptedQueueVersion: stopped.record.acceptedQueueVersion, targetCount: stopped.record.targetCount }, queue: this.store.snapshot(scope) };
  }
  async resume(sessionId: string, input: AgentResumeMessageQueueRequest): Promise<AgentResumeMessageQueueResponse> {
    this.assertAccepting();
    const scope = { ...input, sessionId };
    const replay = new AgentQueueRecoveryStore(this.store.db).replay<AgentResumeMessageQueueResponse>(scope, "resume");
    if (replay) return replay;
    new AgentQueueRecoveryStore(this.store.db).validateResume(scope, () => {
      const fixedIdentity = this.store.fixedIdentity(scope);
      if (fixedIdentity) {
        const receipts = [...this.store.listUnconfirmed(scope), ...this.store.listQueued(scope)];
        const resolved = this.dependencies.resolveProfile({ ...scope, fixedIdentity, hasImages: receipts.some(row => row.attachment_count > 0) });
        if (!sameQueueIdentity(fixedIdentity, resolved)) throw new HttpError(409, "Recovery profile is unavailable", "AGENT_QUEUE_PROFILE_UNAVAILABLE");
      }
    });
    if (!this.dependencies.resumeSession) throw new HttpError(503, "Queue recovery is not assembled", "AGENT_QUEUE_RECOVERY_UNAVAILABLE");
    let settled!: () => void;
    const pending = new Promise<void>(resolve => { settled = resolve; });
    this.activeAccepts.add(pending);
    try { const result = await this.dependencies.resumeSession(scope); this.wakeDispatcher?.(); return result; }
    finally { this.activeAccepts.delete(pending); settled(); }
  }
  abandon(sessionId: string, input: AgentAbandonUnconfirmedInputRequest) {
    this.assertAccepting();
    return new AgentQueueRecoveryStore(this.store.db).abandon({ ...input, sessionId });
  }
  retention() { return this.dependencies.publications.getRetention(); }

  /** A pinned, fully verified image buffer: never hand an unchecked Workspace pathname to HTTP. */
  async attachment(scope: QueueScope, receiptId: string, attachmentId: string) {
    this.store.assertScope(scope);
    this.store.get(scope, receiptId);
    const image = this.store.attachments(scope, receiptId).find(image => image.id === attachmentId);
    if (!image) throw new HttpError(404, "Receipt attachment not found");
    const workspace = this.store.db.prepare("select dir_name as dirName,path from workspaces where id=?").get(scope.workspaceId) as { dirName: string; path: string };
    if (path.resolve(workspace.path) !== path.resolve(workspaceRoot(this.dependencies.dataDir, workspace.dirName))) throw new HttpError(404, "Receipt attachment not found");
    const resolved = await resolveSafeWorkspaceAgentAttachment({ dataDir: this.dependencies.dataDir, workspaceDirName: workspace.dirName,
      attachmentId, storageKey: image.storageKey, mediaType: image.mediaType, expectedByteSize: image.byteSize }).catch(() => null);
    if (!resolved) throw new HttpError(404, "Receipt attachment not found");
    try {
      const content = await resolved.handle.readFile();
      if (content.length !== image.byteSize || createHash("sha256").update(content).digest("hex") !== image.byteSha256) throw new HttpError(404, "Receipt attachment not found");
      // Authorization may have changed while reading; do not expose cancelled/deleted receipt images.
      this.store.assertScope(scope);
      if (!this.store.attachments(scope, receiptId).some(attachment => attachment.id === attachmentId)) throw new HttpError(404, "Receipt attachment not found");
      return { content, mediaType: image.mediaType };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(404, "Receipt attachment not found");
    } finally { await resolved.handle.close().catch(() => undefined); }
  }
}
