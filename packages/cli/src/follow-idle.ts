import type { AgentApi } from "./agent-api.js";
import { assertFinal, assertRetained, incomplete, loadThrough, ordered, timelineChanged } from "./follow-chain.js";
import { completeHistory, selectHistory, startHistory, type HistoryFrame, type MessageSelection, type MessageView, type TimelineMessage } from "./messages.js";
import { readRun } from "./run-status.js";

function source(message: TimelineMessage | MessageView | undefined, sessionId: string): string | null {
  return message?.originSessionId === sessionId && message.originRunId !== null ? message.originRunId : null;
}
/** A single bounded idle finalization. Never discovers a Run by walking past H0. */
export async function finalizeIdle(api: AgentApi, initial: HistoryFrame, selection: MessageSelection): Promise<MessageView[]> {
  const { workspaceId, sessionId } = initial;
  const selected = await completeHistory(api, initial, selection);
  const h0 = initial.initial.session.headMessageId;
  const head = h0 === null ? undefined : initial.initial.messages.find((message) => message.id === h0);
  const k0 = source(head, sessionId);
  const known = new Set<string>(k0 === null ? [] : [k0]);
  for (const message of selected) if (message.status === "streaming") {
    const runId = source(message, sessionId);
    if (runId === null) throw incomplete();
    known.add(runId);
  }
  for (const runId of known) if ((await readRun(api, workspaceId, sessionId, runId)).status === "running") throw incomplete();
  const final = await startHistory(api, workspaceId, sessionId); // Exactly one closing snapshot.
  const h1 = final.initial.session.headMessageId;
  if (h0 === null) {
    if (h1 !== null) throw incomplete();
    return [];
  }
  // Re-read enough of the prefix for both the original selector and all H0..H1 additions.
  const anchor = !initial.hasMore ? null : selection.mode === "after" ? selection.messageId : selected[0]?.id ?? h0;
  await loadThrough(api, final, anchor);
  assertRetained(initial, final, [h0, ...selected.map((message) => message.id), ...(selection.mode === "after" ? [selection.messageId] : [])]);
  const finalH0 = final.messages.get(h0)!;
  let effectiveHead = finalH0;
  if (k0 === null) {
    if (h1 !== h0) throw incomplete();
  } else {
    let otherRun = false;
    for (const message of ordered(final).filter((message) => message.depth > finalH0.depth)) {
      const runId = source(message, sessionId);
      if (runId === null || (otherRun && runId === k0)) throw incomplete();
      if (runId === k0) effectiveHead = message;
      else otherRun = true;
    }
  }
  const bounded: HistoryFrame = { ...final, messages: new Map(ordered(final).filter((message) => message.depth <= effectiveHead.depth).map((message) => [message.id, message])) };
  const result = selectHistory(bounded, selection);
  if (result === null) throw timelineChanged();
  if (k0 === null && result.map((message) => message.id).join("\0") !== selected.map((message) => message.id).join("\0")) throw incomplete();
  assertFinal(result);
  return result;
}
