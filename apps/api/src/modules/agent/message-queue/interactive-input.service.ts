import { FrozenPrepareCache, PrepareCapacityError } from "./frozen-prepare-cache.js";
import { agentAttachmentRelativePath } from "../attachments/agent-attachment-paths.js";
import { AGENT_QUEUE_INPUT_ESTIMATOR_VERSION, AGENT_QUEUE_INPUT_POLICY_VERSION, AGENT_QUEUE_MAX_INJECT_BATCH } from "@agent-workbench/shared";
import type {
  AgentApiPrepareInteractiveInputRequest, AgentApiPrepareInteractiveInputResponse,
  AgentApiInjectInteractiveInputRequest, AgentApiInjectInteractiveInputResponse,
  AgentApiCompleteInteractiveAssistantRequest, AgentApiCompleteInteractiveAssistantResponse,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import type { AgentApiPromptContextResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { Db } from "../../../infra/db/db.js";
import { HttpError } from "../../../app/errors.js";
import { appendMessage, completeAssistantWithExecutions, getMessageRunState, getMessageSessionHead, getRunRecord, insertMessageClientRequestDedup, persistRunTerminalIntent } from "../agent-message.store.js";
import { assertSessionRuntimeUnblocked } from "../runtime-control/runtime-control.store.js";
import { AgentMessageQueueStore, queueIdentity, queuePayloadHash, sameQueueIdentity, toQueueReceipt, type QueueScope } from "./message-queue.store.js";
import { interactiveRunEnabled, type InputBindingSource, type InteractiveScope } from "./interactive-input-binding.store.js";

type OperationKind = "prepare" | "inject" | "complete_or_continue";
type Operation = QueueScope & { operationId: string };
type FrozenPrepare = Extract<AgentApiPrepareInteractiveInputResponse, { decision: "prepare" }>;
type PrepareMetadata = { operationId: string; decision: "prepare" | "finish"; preparationSnapshotHash?: string; headMessageId?: string | null; sessionRevision?: number; candidateReceiptIds?: string[] };
type PreparationFlight = { operationId: string; invalid: boolean; promise: Promise<AgentApiPrepareInteractiveInputResponse> };
type StoredOperation<T> = { response: T; runId: string; continuationHeadMessageId?: string };
const stale = (message: string) => new HttpError(409, message, "AGENT_INTERACTIVE_INPUT_STALE");

/** Queue operations are write-reserved transactions. Context assembly is outside the lock and CASed on entry. */
export class AgentInteractiveInputService {
  private readonly queue: AgentMessageQueueStore;
  private accepting = true;
  private readonly frozen = new FrozenPrepareCache();
  private readonly flights = new Map<string, PreparationFlight>();
  private readonly cleanup: ReturnType<typeof setInterval>;
  constructor(private readonly db: Db, private readonly getContext: (scope: InteractiveScope) => Promise<AgentApiPromptContextResponse>, private readonly now = Date.now) {
    this.queue = new AgentMessageQueueStore(db, now);
    this.cleanup = setInterval(() => this.releaseEndedRuns(), 1000);
    this.cleanup.unref();
  }
  /** Stop new preparation/injection; completion remains available for terminal writeback drain. */
  closeAdmission() {
    this.accepting = false; clearInterval(this.cleanup); this.frozen.clear();
    for (const flight of this.flights.values()) flight.invalid = true;
  }
  private runKey(scope: InteractiveScope) { return JSON.stringify([scope.workspaceId, scope.sessionId, scope.runId]); }
  private releaseEndedRuns() {
    if (!this.db.open) { clearInterval(this.cleanup); this.frozen.clear(); return; }
    for (const key of new Set([...this.frozen.keys, ...this.flights.keys()])) {
      const [workspaceId, sessionId, runId] = JSON.parse(key) as string[];
      const run = getRunRecord(this.db, runId);
      if (!run || run.status !== "running" || !this.db.prepare("select 1 from workspaces where id=?").get(workspaceId)) this.releaseRun({workspaceId,sessionId,runId});
    }
  }
  releaseRun(scope: InteractiveScope) {
    const key = this.runKey(scope); this.frozen.release(key);
    const flight = this.flights.get(key); if (flight) flight.invalid = true;
  }
  /** Only a successful binding at this revision releases this Run's old frozen request. */
  releaseBound(scope: InteractiveScope, inputRevision: number) {
    const key = this.runKey(scope), slot = this.currentFrozen(scope);
    if (slot && slot.context.sessionRevision <= inputRevision) this.frozen.release(key);
    const flight = this.flights.get(key); if (flight) flight.invalid = true;
  }
  private currentFrozen(scope: InteractiveScope): FrozenPrepare | null {
    const row = this.db.prepare("select operation_id as operationId from agent_queue_operation where workspace_id=? and session_id=? and kind='prepare' and json_extract(result_json,'$.runId')=? order by rowid desc limit 1").get(scope.workspaceId, scope.sessionId, scope.runId) as {operationId: string} | undefined;
    return row ? this.frozen.get<FrozenPrepare>(this.runKey(scope),row.operationId) : null;
  }
  private minimal(kind: OperationKind, response: unknown) {
    const { queue: _queue, ...stable } = response as Record<string, unknown>;
    if (kind !== "prepare") return stable;
    const prepared = response as AgentApiPrepareInteractiveInputResponse;
    if (prepared.decision === "rejected") return {operationId: prepared.operationId, decision: prepared.decision, reason: prepared.reason};
    if (prepared.decision !== "prepare") return {operationId: prepared.operationId, decision: prepared.decision};
    return {operationId: prepared.operationId, decision: "prepare", preparationSnapshotHash: prepared.preparationSnapshotHash,
      headMessageId: prepared.context?.headMessageId ?? stable.headMessageId, sessionRevision: prepared.context?.sessionRevision ?? stable.sessionRevision,
      candidateReceiptIds: prepared.candidates?.map(item => item.receipt.id) ?? stable.candidateReceiptIds,
      inputReceiptIds: prepared.inputReceiptIds, effectiveInputPolicyVersion: prepared.effectiveInputPolicyVersion, estimatorVersion: prepared.estimatorVersion};
  }

  private assertAccepting() {
    if (!this.accepting) throw new HttpError(503, "Interactive input is stopping", "AGENT_QUEUE_STOPPING");
  }

  private replay<T>(input: Operation, kind: OperationKind, request: unknown): T | null {
    return this.db.transaction(() => {
      this.queue.assertScope(input);
      const row = this.db.prepare("select kind,request_hash,result_json from agent_queue_operation where workspace_id=? and session_id=? and operation_id=?")
        .get(input.workspaceId, input.sessionId, input.operationId) as { kind: string; request_hash: string; result_json: string } | undefined;
      if (!row) return null;
      if (row.kind !== kind || row.request_hash !== queuePayloadHash(request)) throw new HttpError(409, "Operation identity has a different payload", "AGENT_QUEUE_OPERATION_CONFLICT");
      const stored = JSON.parse(row.result_json) as StoredOperation<Record<string, unknown>>;
      // Compatibility with pre-release schema-26 rows: retain the tombstone, not duplicated prompt/body/path data.
      const minimal = {...stored, response: this.minimal(kind, stored.response)};
      const json = JSON.stringify(minimal);
      if (json !== row.result_json) this.db.prepare("update agent_queue_operation set result_json=? where workspace_id=? and session_id=? and operation_id=?").run(json,input.workspaceId,input.sessionId,input.operationId);
      const queue = this.queue.snapshot(input);
      if (kind === "prepare") {
        if (stored.response.decision === "rejected") return {operationId:input.operationId, decision:"rejected", reason:stored.response.reason, queue} as T;
        if (stored.response.decision === "finish") return {operationId:input.operationId, decision:"finish", queue} as T;
        const cached = this.frozen.get<FrozenPrepare>(this.runKey({...input,runId:stored.runId}), input.operationId);
        return (cached ? {...cached,queue} : {operationId:input.operationId,decision:"expired",queue}) as T;
      }
      return {...minimal.response, queue} as T;
    }).immediate();
  }
  private record<T>(input: Operation & { runId: string }, kind: OperationKind, request: unknown, response: T, continuationHeadMessageId?: string): T {
    this.db.prepare(`insert into agent_queue_operation(workspace_id,session_id,operation_id,kind,request_hash,result_json,created_at) values (?,?,?,?,?,?,?)`)
      .run(input.workspaceId, input.sessionId, input.operationId, kind, queuePayloadHash(request), JSON.stringify({ response: this.minimal(kind, response), runId: input.runId, ...(continuationHeadMessageId ? { continuationHeadMessageId } : {}) }), this.now());
    return response;
  }
  private assertActive(scope: InteractiveScope, allowAssistant = false) {
    this.queue.assertScope(scope);
    assertSessionRuntimeUnblocked(this.db, scope.workspaceId, scope.sessionId);
    const run = getRunRecord(this.db, scope.runId);
    const state = getMessageRunState(this.db, scope.workspaceId, scope.sessionId);
    if (!interactiveRunEnabled(this.db, scope) || !run || run.status !== "running" || !["work_pending", "work_in_progress"].includes(run.executionPhase)
      || state?.status !== "running" || state.activeRunId !== scope.runId || (!allowAssistant && state.activeAssistantMessageId)) throw stale("Run is not at an interactive input boundary");
    if (this.db.prepare("select 1 from agent_tool_execution where origin_run_id=? and status in ('queued','running','unknown') limit 1").get(scope.runId)) throw stale("Tool round is not safely closed");
    return run;
  }
  async prepare(input: AgentApiPrepareInteractiveInputRequest): Promise<AgentApiPrepareInteractiveInputResponse> {
    this.assertAccepting();
    const replay = this.replay<AgentApiPrepareInteractiveInputResponse>(input, "prepare", input);
    if (replay) return Promise.resolve(replay);
    this.releaseEndedRuns();
    const key = this.runKey(input), existing = this.flights.get(key);
    if (existing) {
      if (existing.operationId !== input.operationId) return Promise.reject(stale("Another preparation is in flight"));
      return existing.promise.then(() => this.replay<AgentApiPrepareInteractiveInputResponse>(input,"prepare",input)!);
    }
    // Even pending-preparation backpressure is an authoritative, replayable decision.
    if (this.flights.size >= 1024) return this.prepareOnce(input, {operationId:input.operationId,invalid:false,promise:undefined!}, true);
    const flight: PreparationFlight = {operationId:input.operationId,invalid:false,promise:undefined!};
    this.flights.set(key,flight);
    flight.promise = this.prepareOnce(input, flight).finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
    return flight.promise;
  }
  private async prepareOnce(input: AgentApiPrepareInteractiveInputRequest, flight: PreparationFlight, capacityReached = false): Promise<AgentApiPrepareInteractiveInputResponse> {
    this.assertAccepting();
    const replay = this.replay<AgentApiPrepareInteractiveInputResponse>(input, "prepare", input);
    if (replay) return replay;
    // Reject a new operation at a stopped/closed boundary before assembling model context.
    this.db.transaction(() => this.assertActive(input)).immediate();
    const context = capacityReached ? null : await this.getContext(input);
    this.assertAccepting();
    if (flight.invalid) throw stale("Preparation boundary was released");
    let publish: (() => void) | undefined;
    const response = this.db.transaction(() => {
      const replay = this.replay<AgentApiPrepareInteractiveInputResponse>(input, "prepare", input);
      if (replay) return replay;
      const run = this.assertActive(input);
      const head = getMessageSessionHead(this.db, input)!;
      if (context && (head.headMessageId !== context.headMessageId || head.revision !== context.sessionRevision || context.pendingTools.length)) throw stale("Prompt context changed while preparing");
      const snapshot = this.queue.snapshot(input);
      const continuation = this.db.prepare(`select 1 from agent_queue_operation where workspace_id=? and session_id=? and kind='complete_or_continue'
        and json_extract(result_json,'$.runId')=? and json_extract(result_json,'$.continuationHeadMessageId')=? limit 1`)
        .get(input.workspaceId, input.sessionId, input.runId, head.headMessageId);
      const queued = this.queue.listQueued(input, input.runId);
      const finish = !!continuation && queued.length === 0;
      if (finish && persistRunTerminalIntent(this.db, { ...input, status: "completed", code: "run_completed", detail: null, updatedAt: this.now() }) !== "updated") throw stale("Run cannot finish at this boundary");
      const candidates = queued.slice(0, AGENT_QUEUE_MAX_INJECT_BATCH).map(row => {
        if (!sameQueueIdentity(queueIdentity(row), run)) throw stale("Queued identity differs from the active Run");
        return { receipt: toQueueReceipt(row), identity: queueIdentity(row), text: row.text!, inputText: row.input_text!,
          attachments: this.queue.attachments(input, row.id).map(({ id, position, storageKey, filename, mediaType, byteSize, byteSha256 }) => ({ id, position, filename, mediaType, byteSize, byteSha256, path: agentAttachmentRelativePath(id, storageKey, mediaType) })) };
      });
      if (finish) return this.record<AgentApiPrepareInteractiveInputResponse>(input,"prepare",input,{operationId:input.operationId,decision:"finish",queue:this.queue.snapshot(input)});
      if (!context) return this.record<AgentApiPrepareInteractiveInputResponse>(input,"prepare",input,
        {operationId:input.operationId,decision:"rejected",reason:"cache_capacity",queue:this.queue.snapshot(input)});
      const inputReceiptIds = context.interactiveInput?.inputReceiptIds ?? [];
      const preparationSnapshotHash = queuePayloadHash({ runId: input.runId, headMessageId: head.headMessageId, revision: head.revision, inputReceiptIds,
        candidates, effectiveInputPolicyVersion: AGENT_QUEUE_INPUT_POLICY_VERSION });
      const response: FrozenPrepare = {operationId:input.operationId,context,candidates,inputReceiptIds,preparationSnapshotHash,
        effectiveInputPolicyVersion:AGENT_QUEUE_INPUT_POLICY_VERSION,estimatorVersion:AGENT_QUEUE_INPUT_ESTIMATOR_VERSION,decision:"prepare",queue:this.queue.snapshot(input)};
      const { queue: _queue, ...payload } = response;
      try { publish = this.frozen.stage(this.runKey(input),input.operationId,payload); }
      catch (error) {
        if (!(error instanceof PrepareCapacityError)) throw error;
        return this.record<AgentApiPrepareInteractiveInputResponse>(input,"prepare",input,
          {operationId:input.operationId,decision:"rejected",reason:error.reason,queue:this.queue.snapshot(input)});
      }
      return this.record(input,"prepare",input,response);
    }).immediate();
    publish?.(); // A failed COMMIT never publishes a false success or replaces the old slot.
    if (response.decision === "finish") this.releaseRun(input);
    return response;
  }
  inject(input: AgentApiInjectInteractiveInputRequest): AgentApiInjectInteractiveInputResponse {
    this.assertAccepting();
    const response = this.db.transaction(() => {
      const replay = this.replay<AgentApiInjectInteractiveInputResponse>(input, "inject", input);
      if (replay) return replay;
      const run = this.assertActive(input);
      const snapshot = this.queue.snapshot(input);
      const preparation = this.db.prepare(`select result_json from agent_queue_operation where workspace_id=? and session_id=? and kind='prepare'
        and json_extract(result_json,'$.runId')=? and json_extract(result_json,'$.response.preparationSnapshotHash')=? limit 1`)
        .get(input.workspaceId, input.sessionId, input.runId, input.preparationSnapshotHash) as { result_json: string } | undefined;
      if (!preparation) throw stale("Prepared snapshot is unavailable");
      const stored = JSON.parse(preparation.result_json) as StoredOperation<PrepareMetadata>;
      const prepared = this.minimal("prepare",stored.response) as PrepareMetadata;
      this.db.prepare("update agent_queue_operation set result_json=? where workspace_id=? and session_id=? and kind='prepare' and json_extract(result_json,'$.response.preparationSnapshotHash')=?").run(JSON.stringify({...stored,response:prepared}),input.workspaceId,input.sessionId,input.preparationSnapshotHash);
      const head = getMessageSessionHead(this.db, input)!;
      if (prepared.decision !== "prepare" || head.headMessageId !== input.expectedHeadMessageId || head.revision !== input.expectedRevision
        || head.headMessageId !== prepared.headMessageId || head.revision !== prepared.sessionRevision) throw stale("Prepared revision is stale");
      const prefix = this.queue.listQueued(input, input.runId).slice(0, input.receiptIds.length);
      if (!prefix.length || prefix.length !== input.receiptIds.length || prefix.some((row, index) => row.id !== input.receiptIds[index]
        || row.id !== prepared.candidateReceiptIds?.[index] || !sameQueueIdentity(queueIdentity(row), run))) throw stale("Prepared FIFO prefix changed");
      const at = this.now();
      for (const row of prefix) {
        const current = getMessageSessionHead(this.db, input)!;
        const messageId = `message-queued-${row.id}`;
        const images = this.queue.attachments(input, row.id);
        appendMessage(this.db, { id: messageId, ...input, expectedHeadMessageId: current.headMessageId, expectedRevision: current.revision,
          type: "user", status: "completed", originRunId: input.runId, replacesMessageId: null, createdAt: at,
          parts: [{ id: `part-${row.id}-text`, position: 0, type: "text", text: row.text! }, ...images.map((image, index) => ({
            id: `part-${row.id}-image-${index}`, position: index + 1, type: "image" as const, attachmentId: image.id, mediaType: image.mediaType, filename: image.filename }))] });
        this.db.prepare("update agent_user_message_receipt set status='injected',message_id=?,injected_run_id=?,updated_at=? where id=? and status='queued'")
          .run(messageId, input.runId, at, row.id);
        insertMessageClientRequestDedup(this.db, { ...input, clientRequestId: row.client_request_id, messageId, createdAt: at });
      }
      this.db.prepare("update agent_session_queue_control set queue_version=queue_version+1,updated_at=? where workspace_id=? and session_id=?").run(at, input.workspaceId, input.sessionId);
      const finalHead = getMessageSessionHead(this.db, input)!;
      return this.record(input, "inject", input, { operationId: input.operationId, receipts: prefix.map(row => toQueueReceipt(this.queue.get(input, row.id))),
        headMessageId: finalHead.headMessageId!, revision: finalHead.revision, queue: this.queue.snapshot(input) });
    }).immediate();
    const slot = this.currentFrozen(input);
    if (slot?.preparationSnapshotHash === input.preparationSnapshotHash) this.frozen.release(this.runKey(input));
    return response;
  }
  complete(input: AgentApiCompleteInteractiveAssistantRequest, source: InputBindingSource = "worker_model"): AgentApiCompleteInteractiveAssistantResponse {
    const request = { ...input, source };
    const response = this.db.transaction(() => {
      const replay = this.replay<AgentApiCompleteInteractiveAssistantResponse>(input, "complete_or_continue", request);
      if (replay) return replay;
      this.assertActive(input, true);
      const state = getMessageRunState(this.db, input.workspaceId, input.sessionId)!;
      if (state.activeAssistantMessageId !== input.messageId) throw stale("Assistant is no longer current");
      if (completeAssistantWithExecutions(this.db, { ...input, executions: [], inputSource: source, interactiveDecision: true }) !== "updated") throw stale("Assistant completion rejected");
      const queue = this.queue.snapshot(input);
      const decision = this.queue.listQueued(input, input.runId).length ? "continue" : "finish";
      if (decision === "finish" && persistRunTerminalIntent(this.db, { ...input, status: "completed", code: "run_completed", detail: null }) !== "updated") throw stale("Terminal intent rejected");
      this.db.prepare("update agent_session_queue_control set queue_version=queue_version+1,updated_at=? where workspace_id=? and session_id=?")
        .run(input.updatedAt, input.workspaceId, input.sessionId);
      return this.record<AgentApiCompleteInteractiveAssistantResponse>(input, "complete_or_continue", request, { operationId: input.operationId, decision, queue: this.queue.snapshot(input) }, decision === "continue" ? input.messageId : undefined);
    }).immediate();
    if (response.decision === "finish") this.releaseRun(input);
    return response;
  }
}
