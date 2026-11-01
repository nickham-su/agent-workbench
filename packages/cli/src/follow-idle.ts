import type { AgentApi } from "./agent-api.js";
import { assertFinal, incomplete, ordered, timelineChanged } from "./follow-chain.js";
import { completeHistory, projectMessage, selectHistory, type HistoryFrame, type MessageSelection, type MessageView, type TimelineMessage } from "./messages.js";
import { readRun } from "./run-status.js";
import { FollowState } from "./follow-state.js";
import type { FollowOutput } from "./follow-output.js";

function source(message: TimelineMessage | MessageView | undefined, sessionId: string): string | null {
  return message?.originSessionId === sessionId && message.originRunId !== null ? message.originRunId : null;
}
/** A single bounded idle finalization. Never discovers a Run by walking past H0. */
export async function finalizeIdle(api: AgentApi, initial: HistoryFrame, selection: MessageSelection, output: FollowOutput): Promise<MessageView[]> {
  const { workspaceId, sessionId } = initial;
  const h0 = initial.initial.session.headMessageId;
  const head = h0 === null ? undefined : initial.initial.messages.find((message) => message.id === h0);
  const k0 = source(head, sessionId);
  // With a native H0, defer prefix loading to the proof-aware FinalDrain. Looking up
  // a replaced H0 during generic snapshot pagination would reject a legitimate retry.
  const selected = k0 === null ? await completeHistory(api, initial, selection)
    : selectHistory(initial, selection) ?? ordered(initial).map(projectMessage).filter((message): message is MessageView => message !== null);
  const known = new Set<string>(k0 === null ? [] : [k0]);
  for (const message of selected) if (message.status === "streaming") {
    const runId = source(message, sessionId);
    if (runId === null) throw incomplete();
    known.add(runId);
  }
  for (const runId of known) if ((await readRun(api, workspaceId, sessionId, runId)).status === "running") throw incomplete();
  const observer = new FollowState(initial, k0, { anchor: selection.mode === "after" ? selection.messageId : null, selection, includeInitialRun: false }, output);
  const final = k0 === null ? await observer.closeIdle(api) : await observer.finalDrain(api, false);
  if (h0 === null) {
    if (final.messages.size) throw incomplete();
    return [];
  }
  const finalH0 = final.messages.get(h0) ?? ordered(final).find((message) => message.depth === head!.depth);
  if (!finalH0) throw timelineChanged();
  let effectiveHead = finalH0;
  if (k0 === null) {
    if (ordered(final).at(-1)?.id !== h0) throw incomplete();
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
