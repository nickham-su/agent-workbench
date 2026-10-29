import type { AgentRunKind } from "@agent-workbench/shared";
import { AgentApi } from "./agent-api.js";
import type { ReadCommandDependencies } from "./discovery.js";
import { CliError, withErrorDetails, type CliExitCode, type ErrorContext } from "./errors.js";
import { assertFinal, assertRetained, assertSameRecord, assertVisible, incomplete, loadThrough, ordered, timelineChanged } from "./follow-chain.js";
import { finalizeIdle } from "./follow-idle.js";
import { FollowLifetime, type FollowOptions } from "./follow-lifetime.js";
import { FollowOutput } from "./follow-output.js";
import { completeHistory, projectMessage, readTimeline, startHistory, type HistoryFrame, type MessageSelection } from "./messages.js";
import { readRun, type ObservedRun } from "./run-status.js";
import { acceptSend, type PreparedSend, type SendOptions } from "./send.js";

interface Cursor {
  frame: HistoryFrame;
  revision: number;
  head: string | null;
  root: string | null;
  anchor: string | null;
  historyIds: Set<string>;
  initialRevision: number;
  includeInitialRun: boolean;
}
function cursor(frame: HistoryFrame, anchor: string | null, historyIds: string[], includeInitialRun: boolean): Cursor {
  return { frame, revision: frame.initial.session.revision, head: frame.initial.session.headMessageId,
    root: frame.initial.session.contextRootMessageId, anchor, historyIds: new Set(historyIds), initialRevision: frame.initial.session.revision, includeInitialRun };
}
/** Merge every delta row (the public endpoint may legitimately exceed the requested limit). */
async function refresh(api: AgentApi, state: Cursor, output: FollowOutput): Promise<void> {
  const { workspaceId, sessionId } = state.frame;
  const page = await readTimeline(api, workspaceId, sessionId, { mode: "delta", sinceRevision: state.revision,
    ...(state.head === null ? {} : { knownHeadMessageId: state.head }),
    ...(state.root === null ? { knownContextRootIsNull: true } : { knownContextRootMessageId: state.root }) });
  if (page.session.revision < state.revision) throw timelineChanged();
  let next: HistoryFrame;
  if (page.timelineReset) {
    // A reset response is a tail snapshot, not a complete delta. Rebuild to the fixed
    // anchor and every selected/emitted historical row before advancing the watermark.
    next = await startHistory(api, workspaceId, sessionId, { ...page, timelineReset: false });
    const required = [state.anchor, ...state.historyIds, ...output.emitted.keys()].filter((id): id is string => id !== null);
    const oldest = required.map((id) => state.frame.messages.get(id)).filter((message) => message !== undefined).sort((a, b) => a.depth - b.depth)[0];
    await loadThrough(api, next, oldest?.id ?? state.anchor);
    assertRetained(state.frame, next, required);
  } else {
    next = { ...state.frame, messages: new Map(state.frame.messages) };
    for (const message of page.messages) {
      const old = next.messages.get(message.id);
      if (old) assertSameRecord(old, message);
      if (message.updatedRevision > page.session.revision) throw incomplete();
      next.messages.set(message.id, message);
    }
    const raw = ordered(next);
    if (page.session.headMessageId !== (raw.at(-1)?.id ?? null)) throw timelineChanged();
    for (let i = 1; i < raw.length; i++) if (raw[i].previousMessageId !== raw[i - 1].id || raw[i].depth <= raw[i - 1].depth) throw timelineChanged();
    assertRetained(state.frame, next, [state.anchor, ...state.historyIds, ...output.emitted.keys()].filter((id): id is string => id !== null));
  }
  assertVisible(next, output.emitted.values());
  state.frame = next;
  // Advance only to the fully consumed response, never to a newer before-page revision.
  state.revision = page.session.revision;
  state.head = page.session.headMessageId;
  state.root = page.session.contextRootMessageId;
  await emitUpdates(state, output);
}
async function emitUpdates(state: Cursor, output: FollowOutput): Promise<void> {
  for (const raw of ordered(state.frame)) {
    const selected = state.historyIds.has(raw.id);
    const target = raw.originSessionId === state.frame.sessionId && raw.originRunId === output.runId
      && (state.includeInitialRun || raw.updatedRevision > state.initialRevision);
    if (!selected && !target) continue;
    const message = projectMessage(raw);
    if (message) await output.message(message, "follow");
  }
}
async function observe(api: AgentApi, state: Cursor, output: FollowOutput, lifetime: FollowLifetime, expectedKind?: AgentRunKind): Promise<CliExitCode> {
  for (;;) {
    lifetime.check();
    await lifetime.wait(refresh(api, state, output));
    const run = await lifetime.wait(readRun(api, state.frame.workspaceId, state.frame.sessionId, output.runId!, expectedKind));
    if (run.status !== "running") {
      try {
        await lifetime.wait(refresh(api, state, output)); // Mandatory post-terminal final drain.
        assertFinal(output.emitted.values());
        for (const raw of state.frame.messages.values()) if (raw.originSessionId === state.frame.sessionId && raw.originRunId === output.runId && raw.status === "streaming") throw incomplete();
        await output.terminal(`run_${run.status}`, true, run.status === "completed" ? 0 : run.status === "failed" ? 8 : 9, run);
        return run.status === "completed" ? 0 : run.status === "failed" ? 8 : 9;
      } catch (error) { throw new ObservationFailure(error, run); }
    }
    await lifetime.delay();
  }
}
class ObservationFailure { constructor(readonly cause: unknown, readonly run: ObservedRun | null = null) {} }
async function protect(lifetime: FollowLifetime, work: (publish: (output: FollowOutput) => void) => Promise<CliExitCode>): Promise<CliExitCode> {
  let output: FollowOutput | undefined;
  try { return await work((value) => { output = value; }); }
  catch (failure) {
    const run = failure instanceof ObservationFailure ? failure.run : null;
    const cause = failure instanceof ObservationFailure ? failure.cause : failure;
    const error = output ? output.error(cause) : withErrorDetails(lifetime.failure(cause), { phase: "follow", effect: "not_sent" });
    try { await output?.terminal(error.exitCode === 130 || error.exitCode === 143 ? "interrupted" : "observation_failed", false, error.exitCode, run); }
    catch { /* A broken stdout cannot carry a terminal; preserve the primary observation error. */ }
    throw error;
  } finally { lifetime.dispose(); }
}
export async function followMessages(workspaceId: string, sessionId: string, selection: MessageSelection, options: FollowOptions, dependencies: ReadCommandDependencies): Promise<CliExitCode> {
  const lifetime = new FollowLifetime(dependencies.io.stdout, dependencies.signal);
  return protect(lifetime, async (publish) => {
    const api = await AgentApi.connect({ ...dependencies, signal: lifetime.signal });
    const frame = await lifetime.wait(startHistory(api, workspaceId, sessionId));
    const active = await lifetime.wait(api.runState(workspaceId, sessionId));
    lifetime.begin(options.followTimeoutMs);
    const output = new FollowOutput(dependencies.io, Boolean(dependencies.json), lifetime, { workspaceId, sessionId }, active.activeRunId);
    publish(output);
    await output.metadata("session messages");
    if (active.activeRunId === null) {
      const selected = await lifetime.wait(finalizeIdle(api, frame, selection));
      for (const message of selected) await output.message(message, "history");
      await output.terminal("no_active_run", true, 0, null);
      return 0;
    }
    const selected = await lifetime.wait(completeHistory(api, frame, selection));
    for (const message of selected) await output.message(message, "history");
    return observe(api, cursor(frame, frame.initial.session.headMessageId, selected.map((message) => message.id), false), output, lifetime);
  });
}
export async function followSend(options: SendOptions, prepared: PreparedSend, follow: FollowOptions, dependencies: ReadCommandDependencies): Promise<CliExitCode> {
  const lifetime = new FollowLifetime(dependencies.io.stdout, dependencies.signal);
  return protect(lifetime, async (publish) => {
    const { api, data } = await acceptSend(options, prepared, { ...dependencies, signal: lifetime.signal });
    lifetime.begin(follow.followTimeoutMs);
    const identity = { workspaceId: data.workspaceId, sessionId: data.sessionId, agentId: data.agentId, messageId: data.messageId, runId: data.runId, clientRequestId: data.clientRequestId };
    const output = new FollowOutput(dependencies.io, Boolean(dependencies.json), lifetime, identity, data.runId);
    publish(output); await output.metadata("session send", { accepted: true, sessionCreated: data.sessionCreated, deduplicated: false });
    const frame = await lifetime.wait(startHistory(api, data.workspaceId, data.sessionId));
    await lifetime.wait(loadThrough(api, frame, data.messageId));
    const state = cursor(frame, data.messageId, [], true);
    await emitUpdates(state, output);
    return observe(api, state, output, lifetime, "user");
  });
}
export interface AcceptedObservation { api: AgentApi; identity: ErrorContext & { workspaceId: string; sessionId: string; runId: string }; anchor: string | null; }
/** Shared lifetime/observation entry used by compact, while acceptance stays in control.ts. */
export async function followAccepted(command: string, accept: (signal: AbortSignal) => Promise<AcceptedObservation>, options: FollowOptions, dependencies: ReadCommandDependencies): Promise<CliExitCode> {
  const lifetime = new FollowLifetime(dependencies.io.stdout, dependencies.signal);
  return protect(lifetime, async (publish) => {
    const { api, identity, anchor } = await accept(lifetime.signal);
    lifetime.begin(options.followTimeoutMs);
    const output = new FollowOutput(dependencies.io, Boolean(dependencies.json), lifetime, identity, identity.runId);
    publish(output); await output.metadata(command, { accepted: true });
    const frame = await lifetime.wait(startHistory(api, identity.workspaceId, identity.sessionId));
    if (anchor !== null) await lifetime.wait(loadThrough(api, frame, anchor));
    else await lifetime.wait(loadThrough(api, frame, null));
    const state = cursor(frame, anchor, [], true);
    await emitUpdates(state, output);
    return observe(api, state, output, lifetime, "manual_compaction");
  });
}
