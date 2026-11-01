import type { AgentRunKind } from "@agent-workbench/shared";
import { AgentApi } from "./agent-api.js";
import type { ReadCommandDependencies } from "./discovery.js";
import { CliError, withErrorDetails, type CliExitCode, type ErrorContext } from "./errors.js";
import { FollowState, TerminalObserved } from "./follow-state.js";
import { finalizeIdle } from "./follow-idle.js";
import { FollowLifetime, type FollowOptions } from "./follow-lifetime.js";
import { FollowOutput } from "./follow-output.js";
import { FollowReadRetry } from "./follow-read-retry.js";
import { startHistory, type MessageSelection } from "./messages.js";
import { readRun, type ObservedRun } from "./run-status.js";
import { acceptSend, type PreparedSend, type SendOptions } from "./send.js";

async function observe(api: AgentApi, state: FollowState, output: FollowOutput, lifetime: FollowLifetime, expectedKind?: AgentRunKind): Promise<CliExitCode> {
  const probe = () => lifetime.wait(readRun(api, state.frame.workspaceId, state.frame.sessionId, output.runId!, expectedKind));
  const finish = async (run: ObservedRun): Promise<CliExitCode> => {
    try {
      await lifetime.wait(state.finalDrain(api));
      const code = run.status === "completed" ? 0 : run.status === "failed" ? 8 : 9;
      await output.terminal(`run_${run.status}`, true, code, run);
      return code;
    } catch (error) { throw new ObservationFailure(error, run); }
  };
  try {
    await lifetime.wait(state.initialize(api, probe));
    for (;;) {
      lifetime.check();
      await lifetime.wait(state.refresh(api, probe));
      const run = await probe();
      if (run.status !== "running") return finish(run);
      await lifetime.delay();
    }
  } catch (error) {
    if (error instanceof TerminalObserved) return finish(error.run);
    throw error;
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
    lifetime.begin(options.followTimeoutMs);
    const api = await AgentApi.connect({ ...dependencies, signal: lifetime.signal, followReadRetry: new FollowReadRetry(lifetime, dependencies.io.stderr) });
    const frame = await lifetime.wait(startHistory(api, workspaceId, sessionId));
    const active = await lifetime.wait(api.runState(workspaceId, sessionId));
    const output = new FollowOutput(dependencies.io, lifetime, { workspaceId, sessionId }, active.activeRunId);
    publish(output);
    await output.metadata("session messages");
    if (active.activeRunId === null) {
      const selected = await lifetime.wait(finalizeIdle(api, frame, selection, output));
      for (const message of selected) await output.message(message, "history");
      await output.terminal("no_active_run", true, 0, null);
      return 0;
    }
    const state = new FollowState(frame, active.activeRunId, { anchor: selection.mode === "after" ? selection.messageId : null, selection, includeInitialRun: false }, output);
    return observe(api, state, output, lifetime);
  });
}
export async function followSend(options: SendOptions, prepared: PreparedSend, follow: FollowOptions, dependencies: ReadCommandDependencies): Promise<CliExitCode> {
  const lifetime = new FollowLifetime(dependencies.io.stdout, dependencies.signal);
  return protect(lifetime, async (publish) => {
    const { api, data } = await acceptSend(options, prepared, { ...dependencies, signal: lifetime.signal, followReadRetry: new FollowReadRetry(lifetime, dependencies.io.stderr) });
    lifetime.begin(follow.followTimeoutMs);
    const identity = { workspaceId: data.workspaceId, sessionId: data.sessionId, agentId: data.agentId, messageId: data.messageId, runId: data.runId, clientRequestId: data.clientRequestId };
    const output = new FollowOutput(dependencies.io, lifetime, identity, data.runId);
    publish(output); await output.metadata("session send", { accepted: true, sessionCreated: data.sessionCreated, deduplicated: false });
    const frame = await lifetime.wait(startHistory(api, data.workspaceId, data.sessionId));
    const state = new FollowState(frame, data.runId, { anchor: data.messageId, includeInitialRun: true }, output);
    return observe(api, state, output, lifetime, "user");
  });
}
export interface AcceptedObservation { api: AgentApi; identity: ErrorContext & { workspaceId: string; sessionId: string; runId: string }; anchor: string | null; }
/** Shared lifetime/observation entry used by compact, while acceptance stays in control.ts. */
export async function followAccepted(command: string, accept: (signal: AbortSignal, readRetry: FollowReadRetry) => Promise<AcceptedObservation>, options: FollowOptions, dependencies: ReadCommandDependencies): Promise<CliExitCode> {
  const lifetime = new FollowLifetime(dependencies.io.stdout, dependencies.signal);
  return protect(lifetime, async (publish) => {
    const { api, identity, anchor } = await accept(lifetime.signal, new FollowReadRetry(lifetime, dependencies.io.stderr));
    lifetime.begin(options.followTimeoutMs);
    const output = new FollowOutput(dependencies.io, lifetime, identity, identity.runId);
    publish(output); await output.metadata(command, { accepted: true });
    const frame = await lifetime.wait(startHistory(api, identity.workspaceId, identity.sessionId));
    const state = new FollowState(frame, identity.runId, { anchor, includeInitialRun: true }, output);
    return observe(api, state, output, lifetime, "manual_compaction");
  });
}
