import type { AgentResumeMessageQueueRequest, AgentResumeMessageQueueResponse, AgentAbandonUnconfirmedInputRequest, AgentAbandonUnconfirmedInputResponse, AgentQueueErrorCode } from "@agent-workbench/shared";
import type { Db } from "../../../infra/db/db.js";
import { HttpError } from "../../../app/errors.js";
import { createMessageRunRecord, startMessageRun, getMessageRunState, getVisibleMessageChain, hasNonTerminalVisibleMessageWork } from "../agent-message.store.js";
import { AgentAttachmentPublicationStore } from "../attachments/agent-attachment-publication.store.js";
import { assertSessionRuntimeUnblocked } from "../runtime-control/runtime-control.store.js";
import { AgentMessageQueueStore, queueIdentity, queuePayloadHash, type QueueScope } from "./message-queue.store.js";

type ResumeRequest = AgentResumeMessageQueueRequest & { sessionId: string };
type AbandonRequest = AgentAbandonUnconfirmedInputRequest & { sessionId: string };
export type QueueResumeActivation = { response: AgentResumeMessageQueueResponse; activated: boolean; inputText: string };

/** Recovery never treats a terminal DB row as physical runtime exit, and never changes existing User origin. */
export class AgentQueueRecoveryStore {
  private readonly queue: AgentMessageQueueStore;
  constructor(private readonly db: Db, private readonly now = Date.now) { this.queue = new AgentMessageQueueStore(db, now); }
  replay<T extends AgentResumeMessageQueueResponse | AgentAbandonUnconfirmedInputResponse>(input: ResumeRequest | AbandonRequest, kind: "resume" | "abandon"): T | null {
    return this.db.transaction(() => {
      this.queue.assertScope(input);
      const operation = this.db.prepare("select kind,request_hash,result_json from agent_queue_operation where workspace_id=? and session_id=? and operation_id=?")
        .get(input.workspaceId, input.sessionId, input.operationId) as { kind: string; request_hash: string; result_json: string } | undefined;
      if (!operation) return null;
      if (operation.kind !== kind || operation.request_hash !== queuePayloadHash(input)) throw new HttpError(409, "Operation payload differs", "AGENT_QUEUE_OPERATION_CONFLICT");
      // The action is immutable; the displayed queue must describe this read,
      // not the historical state before a later Stop/enqueue/cancel/confirmation.
      const original = JSON.parse(operation.result_json) as T;
      const { queue: _queue, ...metadata } = original;
      this.db.prepare("update agent_queue_operation set result_json=? where workspace_id=? and session_id=? and operation_id=?").run(JSON.stringify(metadata), input.workspaceId, input.sessionId, input.operationId);
      return { ...original, queue: this.queue.snapshot(input) };
    }).immediate();
  }
  private assertRecoverable(scope: QueueScope, expectedVersion: number) {
    this.queue.assertScope(scope);
    this.queue.ensureControl(scope);
    const snapshot = this.queue.snapshot(scope);
    if (snapshot.queueVersion !== expectedVersion) throw new HttpError(409, "Queue version changed", "AGENT_QUEUE_VERSION_CONFLICT");
    assertSessionRuntimeUnblocked(this.db, scope.workspaceId, scope.sessionId);
    if (this.queue.hasUndrainedExecution(scope) || getMessageRunState(this.db, scope.workspaceId, scope.sessionId)?.status !== "idle")
      throw new HttpError(409, "Previous execution is not drained", "AGENT_QUEUE_EXECUTION_NOT_DRAINED");
    const ids = getVisibleMessageChain(this.db, scope).map(message => message.id);
    if (hasNonTerminalVisibleMessageWork(this.db, scope) || this.db.prepare(`select 1 from agent_tool_execution e join agent_message_part p on p.id=e.call_part_id
      where p.message_id in (select value from json_each(?)) and e.status='unknown' limit 1`).get(JSON.stringify(ids)))
      throw new HttpError(409, "Historical tools are not safe to continue", "AGENT_QUEUE_TOOL_STATE_UNSAFE");
    return snapshot;
  }
  /** First authoritative CAS precedes profile resolution; activation repeats CAS after async handoff. */
  validateResume(input: ResumeRequest, validateProfile: () => void) {
    this.db.transaction(() => {
      if (this.replay(input, "resume")) return;
      this.assertRecoverable(input, input.expectedQueueVersion);
      validateProfile();
    }).immediate();
  }
  private record<T>(input: ResumeRequest | AbandonRequest, kind: "resume" | "abandon", response: T, at: number): T {
    this.db.prepare("insert into agent_queue_operation(workspace_id,session_id,operation_id,kind,request_hash,result_json,created_at) values (?,?,?,?,?,?,?)")
      .run(input.workspaceId, input.sessionId, input.operationId, kind, queuePayloadHash(input), JSON.stringify(Object.fromEntries(Object.entries(response as object).filter(([key]) => key !== "queue"))), at);
    return response;
  }
  /** Send does not require idle recovery while an active Run is accepting inputs. */
  validateSend(scope: QueueScope): boolean {
    const snapshot = this.queue.snapshot(scope);
    assertSessionRuntimeUnblocked(this.db, scope.workspaceId, scope.sessionId);
    if (snapshot.mode === "active" && getMessageRunState(this.db, scope.workspaceId, scope.sessionId)?.status === "running") return false;
    this.assertRecoverable(scope, snapshot.queueVersion);
    return snapshot.mode === "paused" || snapshot.unconfirmedInputCount > 0;
  }

  /** Called inside the final receipt transaction; physical handoff is strictly post-commit. */
  activateForSend(scope: QueueScope, runId: string, at: number): { runId: string; inputText: string } | null {
    this.assertRecoverable(scope, this.queue.snapshot(scope).queueVersion);
    return this.activateRecoveredInputs(scope, runId, at);
  }

  private activateRecoveredInputs(scope: QueueScope, runId: string, at: number): { runId: string; inputText: string } | null {
      const identity = this.queue.fixedIdentity(scope);
      const positions = new Map(getVisibleMessageChain(this.db, scope).map((message, index) => [message.id, index]));
      const unconfirmed = this.queue.listUnconfirmed(scope).sort((a, b) => positions.get(a.message_id!)! - positions.get(b.message_id!)!);
      const trigger = unconfirmed[0];
      if (trigger && unconfirmed.some(row => row.session_id !== scope.sessionId)) throw new HttpError(409, "A fork cannot claim another Session's inputs", "AGENT_QUEUE_INPUT_SCOPE_CONFLICT");
      this.db.prepare("update agent_session_queue_control set mode='active',pause_code=null,queue_version=queue_version+1,updated_at=? where workspace_id=? and session_id=?")
        .run(at, scope.workspaceId, scope.sessionId);
      if (trigger) {
        if (!identity) throw new Error("Recovery input identity is missing");
        createMessageRunRecord(this.db, { ...scope, ...identity, runId, triggerMessageId: trigger.message_id!, runKind: "user", interactiveQueue: true,
          uiLocale: trigger.ui_locale, subtaskDepth: 0, parentRunId: null, parentToolExecutionId: null, status: "running", createdAt: at });
        for (const receipt of unconfirmed) this.db.prepare("insert into agent_interactive_run_input(workspace_id,session_id,run_id,receipt_id) values (?,?,?,?)")
          .run(scope.workspaceId, scope.sessionId, runId, receipt.id);
        startMessageRun(this.db, { ...scope, runId, updatedAt: at });
      }
    return trigger ? { runId, inputText: trigger.input_text ?? "" } : null;
  }

  resume(input: ResumeRequest, runId: string, at: number): QueueResumeActivation {
    return this.db.transaction(() => {
      const replay = this.replay<AgentResumeMessageQueueResponse>(input, "resume");
      if (replay) return { response: replay, activated: false, inputText: "" };
      this.assertRecoverable(input, input.expectedQueueVersion);
      const activation = this.activateRecoveredInputs(input, runId, at);
      const response: AgentResumeMessageQueueResponse = activation
        ? { action: "continued_unconfirmed", runId: activation.runId, queue: this.queue.snapshot(input) }
        : { action: this.queue.listQueued(input).length ? "dispatch_queued" : "unpaused_only", runId: null, queue: this.queue.snapshot(input) };
      this.record(input, "resume", response, at);
      return { response, activated: activation !== null, inputText: activation?.inputText ?? "" };
    }).immediate();
  }
  abandon(input: AbandonRequest): AgentAbandonUnconfirmedInputResponse {
    return this.db.transaction(() => {
      const replay = this.replay<AgentAbandonUnconfirmedInputResponse>(input, "abandon");
      if (replay) return replay;
      const snapshot = this.assertRecoverable(input, input.expectedQueueVersion);
      if (!snapshot.unconfirmedInputCount)
        throw new HttpError(409, "No unconfirmed input to abandon", "AGENT_NO_UNCONFIRMED_INPUT" satisfies AgentQueueErrorCode);
      if (input.confirmIrreversible !== true || snapshot.unconfirmedInputSetHash !== input.expectedUnconfirmedInputSetHash)
        throw new HttpError(409, "Unconfirmed input set changed", "AGENT_UNCONFIRMED_SET_CONFLICT" satisfies AgentQueueErrorCode);
      const receipts = this.queue.listUnconfirmed(input);
      const at = this.now();
      for (const receipt of receipts) {
        if (receipt.session_id !== input.sessionId) throw new HttpError(409, "A fork cannot abandon another Session's inputs", "AGENT_QUEUE_INPUT_SCOPE_CONFLICT");
        this.db.prepare("update agent_user_message_receipt set confirmation_state='abandoned',abandoned_at=?,updated_at=? where id=? and confirmation_state='unconfirmed'").run(at, at, receipt.id);
        new AgentAttachmentPublicationStore(this.db, this.now).retainReceipt({ ...input, receiptId: receipt.id }, "abandoned");
      }
      this.db.prepare("update agent_session_queue_control set mode='paused',pause_code='inputs_abandoned',queue_version=queue_version+1,updated_at=? where workspace_id=? and session_id=?")
        .run(at, input.workspaceId, input.sessionId);
      return this.record(input, "abandon", { abandonedReceiptIds: receipts.map(row => row.id), queue: this.queue.snapshot(input) }, at);
    }).immediate();
  }
}
