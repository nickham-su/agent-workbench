import { computed, onBeforeUnmount, ref, shallowReactive, shallowRef, watch } from "vue";
import type { AgentMessageQueueSnapshot, AgentAcceptUserMessageMultipartPayload } from "@agent-workbench/shared";
import * as queueApi from "@/shared/api/agentMessageQueueApi";
import { ApiError } from "@/shared/api/api";
import { createAgentClientRequestId } from "./agentClientRequestId";
import { createAgentMessageFormData, type PendingAgentImage } from "./agentImageAttachments";

type Scope = { workspaceId: string; sessionId: string; active: boolean; running: boolean };
export type QueueSubmission = {
  sessionId: string;
  composerId: string;
  payload: AgentAcceptUserMessageMultipartPayload;
  images: PendingAgentImage[];
  draft: string;
  draftRevision: number;
  // Presentation-only hint, carried to the real Session's Pane during draft handoff.
  idleStartup?: boolean;
};
// Keep exact submissions (including Files) across session switches and KeepAlive
// remounts. Never persist private message contents to browser storage.
export type QueueSubmissionHandoff = {
  submission: QueueSubmission;
  phase: "sending" | "unknown" | "rejected" | "accepted";
  status?: number;
  queue?: AgentMessageQueueSnapshot;
};
// A real Session can mount before its draft Pane publishes the first attempt.
// Reactive publication, not a one-time lookup at mount, is the ownership handoff.
const submissionHandoffs = shallowReactive(new Map<string, QueueSubmissionHandoff>());
const uncertainStops = new Map<string, string>();
const keyOf = (scope: Scope) => JSON.stringify([scope.workspaceId, scope.sessionId]);
const uncertain = (error: unknown) => !(error instanceof ApiError) || error.status == null || (error.status >= 500 && error.status !== 507);

// Compare only queueVersion-owned fields, including the four public Stop aggregates.
// Runtime-derived inputIdentity and internal proof metadata are not versioned here.
function versionedQueueFields(q: AgentMessageQueueSnapshot) {
  const identity = (value: AgentMessageQueueSnapshot["pendingIdentity"]) => value ? [value.agentId, value.providerId, value.modelId] : null;
  return JSON.stringify([q.stopGeneration, q.pendingCount, q.pendingBytes, identity(q.pendingIdentity),
    [q.stop.state, q.stop.unresolvedOperationCount, q.stop.unresolvedTargetCount, q.stop.code],
    q.items.map(item => [item.id, item.clientRequestId, item.sequence, item.createdAt, item.updatedAt,
      item.status, item.messageId, item.runId, item.textPreview, item.attachmentCount])]);
}

export function useAgentMessageQueue(getScope: () => Scope, api = queueApi) {
  const snapshot = shallowRef<AgentMessageQueueSnapshot | null>(null);
  const error = ref<unknown>(null);
  const handoff = computed(() => submissionHandoffs.get(keyOf(getScope())) ?? null);
  const unknownSubmission = computed(() => handoff.value && (handoff.value.phase === "sending" || handoff.value.phase === "unknown") ? handoff.value.submission : null);
  const unknownStop = ref(false);
  const busy = ref(false);
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;
  let stopped = false;
  let diagnosedConflictVersion: number | null = null;
  const stopBlocked = computed(() => unknownStop.value || snapshot.value?.stop.state === "pending" || snapshot.value?.stop.state === "unknown");
  const historyBlocked = computed(() => !snapshot.value || stopBlocked.value || !!unknownSubmission.value || snapshot.value.pendingCount > 0);
  const identity = computed(() => snapshot.value?.inputIdentity ?? snapshot.value?.pendingIdentity ?? null);
  function apply(next: AgentMessageQueueSnapshot, scope = getScope(), token = generation) {
    const current = getScope();
    if (stopped || token !== generation || keyOf(scope) !== keyOf(current) || next.workspaceId !== current.workspaceId || next.sessionId !== current.sessionId) return;
    if (snapshot.value && next.queueVersion < snapshot.value.queueVersion) return;
    if (snapshot.value && next.queueVersion === snapshot.value.queueVersion && versionedQueueFields(next) !== versionedQueueFields(snapshot.value)) {
      if (diagnosedConflictVersion !== next.queueVersion) {
        diagnosedConflictVersion = next.queueVersion;
        // No scope IDs, identity values, message text, attachment data or hashes.
        console.warn("AGENT_QUEUE_SAME_VERSION_CONFLICT", { queueVersion: next.queueVersion });
      }
      error.value = new ApiError({ message: "Message queue snapshots disagree for the same version", code: "AGENT_QUEUE_SAME_VERSION_CONFLICT" });
      return;
    }
    snapshot.value = next;
    error.value = null;
  }
  function schedule() {
    clearTimeout(timer);
    if (stopped || !getScope().active) return;
    const q = snapshot.value;
    const frequent = getScope().running || !q || q.pendingCount > 0 || (q.stop.state === "pending" || q.stop.state === "unknown") || unknownSubmission.value || unknownStop.value;
    timer = setTimeout(() => void refresh(), frequent ? 800 : 3000);
  }
  async function refresh() {
    clearTimeout(timer);
    const scope = { ...getScope() };
    if (stopped || !scope.active) return;
    const token = generation;
    abort?.abort();
    const request = new AbortController();
    abort = request;
    try { apply(await api.getAgentMessageQueue(scope.sessionId, scope.workspaceId, request.signal), scope, token); }
    catch (cause) { if (token === generation && !request.signal.aborted) error.value = cause; }
    finally { if (token === generation && abort === request) schedule(); }
  }
  async function scopedAction<T>(action: (scope: Scope, token: number, key: string) => Promise<T>): Promise<T> {
    if (busy.value) throw new ApiError({ message: "A queue action is already in progress", code: "AGENT_QUEUE_ACTION_BUSY" });
    const scope = { ...getScope() }, token = generation;
    busy.value = true;
    try { return await action(scope, token, keyOf(scope)); }
    finally { if (token === generation) { busy.value = false; void refresh(); } }
  }
  function publishSubmission(submission: QueueSubmission, phase: QueueSubmissionHandoff["phase"], extra: Partial<QueueSubmissionHandoff> = {}) {
    const key = keyOf({ ...getScope(), workspaceId: submission.payload.workspaceId, sessionId: submission.sessionId });
    const current = submissionHandoffs.get(key);
    // A late outcome must not retire a different submission's retained draft.
    if (phase !== "sending" && current?.submission !== submission) return;
    submissionHandoffs.set(key, { submission, phase, ...extra });
  }
  function acknowledgeHandoff(submission: QueueSubmission) {
    const key = keyOf({ ...getScope(), workspaceId: submission.payload.workspaceId, sessionId: submission.sessionId });
    if (submissionHandoffs.get(key)?.submission === submission) submissionHandoffs.delete(key);
  }
  async function submit(submission: QueueSubmission) {
    return scopedAction(async (scope, token) => {
      if (submission.payload.workspaceId !== scope.workspaceId) throw new Error("AGENT_QUEUE_SCOPE_CHANGED");
      // Admission metadata must already be frozen by the user action, never
      // fetched here: an awaited snapshot may belong to a later Stop generation.
      if (!submission.payload.stopGeneration)
        throw new ApiError({ message: "Queue state is unavailable; send again after it loads", code: "AGENT_QUEUE_STATE_UNKNOWN" });
      // Publish before the first await: ensureSession may have replaced the draft Pane.
      publishSubmission(submission, "sending");
      let attempted = false;
      try {
        attempted = true;
        const body = submission.images.length ? createAgentMessageFormData(submission.payload, submission.images) : { ...submission.payload, text: submission.payload.text! };
        const result = await api.acceptAgentUserMessage(submission.sessionId, body);
        publishSubmission(submission, "accepted", { queue: result.queue });
        apply(result.queue, scope, token);
        return { result, submission };
      } catch (cause) {
        if (submission.payload.targetRunId) acknowledgeHandoff(submission);
        else publishSubmission(submission, attempted && uncertain(cause) ? "unknown" : "rejected", { status: cause instanceof ApiError ? cause.status : undefined });
        throw cause;
      }
    });
  }
  async function resolveUnknown(retry: boolean) {
    const submission = handoff.value?.submission;
    if (!submission || handoff.value?.phase === "accepted" || handoff.value?.phase === "sending") return null;
    if (retry) return submit(submission);
    return scopedAction(async (scope, token) => {
      const result = await api.getAgentReceiptByRequest(submission.sessionId, scope.workspaceId, submission.payload.clientRequestId);
      publishSubmission(submission, "accepted", { queue: result.queue });
      apply(result.queue, scope, token);
      return { result, submission };
    });
  }
  watch(handoff, entry => {
    if (entry?.phase === "accepted" && entry.queue) apply(entry.queue);
  }, { immediate: true, flush: "sync" });
  async function clear() {
    return scopedAction(async (scope, token) => {
      const receiptIds = snapshot.value?.items.map(item => item.id);
      if (!receiptIds?.length) return;
      const result = await api.clearAgentMessageQueue(scope.sessionId, { workspaceId: scope.workspaceId, receiptIds });
      apply(result.queue, scope, token);
      return result;
    });
  }
  async function stop() {
    return scopedAction(async (scope, token, key) => {
      const operationId = uncertainStops.get(key) ?? createAgentClientRequestId();
      uncertainStops.set(key, operationId);
      unknownStop.value = true;
      try {
        const result = await api.stopAgentMessageQueue(scope.sessionId, { workspaceId: scope.workspaceId, operationId });
        uncertainStops.delete(key);
        if (token === generation) unknownStop.value = false;
        apply(result.queue, scope, token);
      } catch (cause) {
        if (!uncertain(cause)) { uncertainStops.delete(key); if (token === generation) unknownStop.value = false; }
        throw cause;
      }
    });
  }
  async function cancel(receiptId: string) {
    return scopedAction(async (scope, token) => {
      const result = await api.cancelAgentQueuedReceipt(scope.sessionId, scope.workspaceId, receiptId);
      apply(result.queue, scope, token);
    });
  }
  const visible = () => { if (document.visibilityState !== "hidden") void refresh(); };
  document.addEventListener("visibilitychange", visible);
  // getScope also reads Run state. Compare primitive sources, not a fresh array,
  // so an unrelated Run snapshot cannot reset the scope or in-flight controls.
  watch([() => getScope().workspaceId, () => getScope().sessionId], () => {
    generation++; diagnosedConflictVersion = null; abort?.abort(); clearTimeout(timer); snapshot.value = null; error.value = null; busy.value = false;
    const key = keyOf(getScope());
    unknownStop.value = uncertainStops.has(key);
    void refresh();
  }, { immediate: true });
  watch([() => getScope().active, () => getScope().running], () => { if (getScope().active) void refresh(); else { clearTimeout(timer); abort?.abort(); } });
  onBeforeUnmount(() => { stopped = true; generation++; clearTimeout(timer); abort?.abort(); document.removeEventListener("visibilitychange", visible); });
  return { handoff, acknowledgeHandoff, snapshot, error, busy, identity, stopBlocked, historyBlocked, unknownSubmission, unknownStop, apply, refresh, submit, resolveUnknown, clear, stop, cancel };
}
