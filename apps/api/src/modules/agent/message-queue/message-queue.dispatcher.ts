import { HttpError } from "../../../app/errors.js";
import type { RunLifecycleApplication } from "../lifecycle/run-lifecycle-application.js";
import type { RuntimeControlPort } from "../lifecycle/run-lifecycle-ports.js";
import { workspaceDeletingFence } from "../lifecycle/workspace-deleting-fence.js";
import { assertSessionRuntimeUnblocked } from "../runtime-control/runtime-control.store.js";
import { AgentMessageQueueStore, queueIdentity, sameQueueIdentity, type QueueScope } from "./message-queue.store.js";
import type { QueueProfileResolver } from "./message-queue.service.js";

/** Single-process, bounded FIFO dispatcher. Production start is deliberately deferred until S6. */
export class AgentMessageQueueDispatcher {
  private closed = false;
  private acceptingScans: boolean;
  private admissionEpoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private started = false;
  private cursor = "";
  private scanFailed = false;
  constructor(readonly store: AgentMessageQueueStore, private readonly dependencies: {
    lifecycle: Pick<RunLifecycleApplication, "startQueuedUserRun">; runtime: RuntimeControlPort;
    resolveProfile: QueueProfileResolver; onScanError?: () => void; intervalMs?: number; batchSize?: number; admissionInitiallyClosed?: boolean;
  }) { this.acceptingScans = !dependencies.admissionInitiallyClosed; }

  /** Temporary runtime window: receipts remain durable and active, no trigger is published. */
  suspendRuntimeDispatch() {
    this.acceptingScans = false;
    this.admissionEpoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  resumeRuntimeDispatch() {
    if (this.closed) return;
    this.acceptingScans = true;
    this.wake();
  }
  private assertDispatchAdmission(epoch: number) {
    if (this.closed || !this.acceptingScans || epoch !== this.admissionEpoch)
      throw new HttpError(503, "Queue dispatch is temporarily suspended", "AGENT_QUEUE_DISPATCH_SUSPENDED");
  }

  /** Called only after the shared Worker-ready / fallback-onListen recovery barrier. */
  start() { if (this.closed || this.started) return; this.started = true; this.wake(); }
  wake() {
    if (!this.started || this.closed || !this.acceptingScans || this.timer || this.inFlight) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.scanOnce().then(() => { this.scanFailed = false; }, () => {
        if (!this.scanFailed) this.dependencies.onScanError?.();
        this.scanFailed = true;
      }).finally(() => { if (!this.closed && this.started) this.schedule(); });
    }, 0);
    this.timer.unref();
  }
  private schedule() {
    if (this.timer || this.closed || !this.acceptingScans) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.wake(); }, this.dependencies.intervalMs ?? 500);
    this.timer.unref();
  }

  scanOnce(): Promise<void> {
    if (this.closed || !this.acceptingScans) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.scan().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async scan() {
    const sessions = this.store.db.prepare(`select c.workspace_id as workspaceId,c.session_id as sessionId from agent_session_queue_control c
      where c.mode='active' and c.session_id>? and exists(select 1 from agent_user_message_receipt r where r.session_id=c.session_id and r.status='queued')
      order by c.session_id limit ?`).all(this.cursor, Math.max(1, Math.min(this.dependencies.batchSize ?? 32, 100))) as QueueScope[];
    this.cursor = sessions.at(-1)?.sessionId ?? "";
    for (const scope of sessions) {
      if (this.closed || !this.acceptingScans) break;
      await this.dispatchSession(scope);
    }
  }

  async dispatchSession(scope: QueueScope) {
    if (this.closed || !this.acceptingScans || workspaceDeletingFence.isDeleting(scope.workspaceId)) return null;
    const epoch = this.admissionEpoch;
    const assertDispatchAdmission = () => this.assertDispatchAdmission(epoch);
    let validatingProfile = false;
    try {
      this.store.assertScope(scope);
      assertSessionRuntimeUnblocked(this.store.db, scope.workspaceId, scope.sessionId);
      const snapshot = this.store.snapshot(scope);
      if (snapshot.mode !== "active" || !snapshot.pendingCount || snapshot.unconfirmedInputCount) return null;
      if (this.store.hasUndrainedExecution(scope)) return null;
      const receipt = this.store.get(scope, snapshot.items[0]!.id);
      this.store.fixedIdentity(scope);
      validatingProfile = true;
      const identity = queueIdentity(receipt);
      const resolved = this.dependencies.resolveProfile({ ...scope, requestedAgentId: identity.agentId, fixedIdentity: identity, hasImages: receipt.attachment_count > 0 });
      if (!sameQueueIdentity(identity, resolved)) throw new HttpError(409, "Accepted input profile changed", "AGENT_QUEUE_AGENT_CONFLICT");
      validatingProfile = false;
      assertDispatchAdmission();
      return await this.dependencies.lifecycle.startQueuedUserRun({ ...scope, receiptId: receipt.id, inputText: receipt.input_text!, runtime: this.dependencies.runtime, assertDispatchAdmission });
    } catch (error) {
      if (error instanceof HttpError && ["AGENT_QUEUE_DISPATCH_SUSPENDED", "WORKSPACE_DELETING", "AGENT_SESSION_STOP_PENDING", "AGENT_SESSION_STOP_UNKNOWN", "AGENT_QUEUE_NOT_DISPATCHABLE", "RUN_NOT_ACTIVE"].includes(error.code ?? "")) return null;
      // A public enqueue timeout is unknown, not proof to create a second Run. The lifecycle owns same-Run reconciliation.
      if (this.store.db.prepare("select 1 from agent_session where workspace_id=? and id=?").get(scope.workspaceId, scope.sessionId))
        this.store.pause(scope, error instanceof HttpError && error.code === "AGENT_QUEUE_IDENTITY_INVARIANT" ? "invariant_violation" : validatingProfile ? "profile_unavailable" : "recovery_required");
      return null;
    }
  }

  /** Block before runtime shutdown; a timeout is diagnostic, never permission to replay the active receipt. */
  async close(timeoutMs = 1000) {
    this.closed = true; this.suspendRuntimeDispatch(); this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.inFlight) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.inFlight.then(() => true, () => false), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
