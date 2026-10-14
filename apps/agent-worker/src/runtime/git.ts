import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Value } from "@sinclair/typebox/value";
import {
  GitToolInputSchema, PrepareRepoGitEnvResponseSchema, RepoGitEnvLeaseIdSchema, RepoGitEnvLeaseOwnerSchema,
  GIT_TOOL_DEFAULT_TIMEOUT_SECONDS, type GitToolResult, type PrepareRepoGitEnvRequest,
  type PrepareRepoGitEnvResponse, type ReleaseRepoGitEnvRequest,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import { GitToolError, GIT_ERROR_MESSAGES, type GitErrorCode } from "./gitErrors.js";
import { GitOutputGuard } from "./gitOutput.js";
import { registerGitDiagnosticResult } from "./gitDiagnostic.js";
import { buildGitProcessEnv, prepareGitRepositoryPath, prepareGitOutputGuard, requireGitLeaseTime } from "./gitLeaseGuard.js";
import type { ToolExecutionContext } from "./tools/types.js";

export type GitProcessOps = {
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
};
const nativeOps: GitProcessOps = { spawn, kill: (pid, signal) => { process.kill(pid, signal); } };
const DEFAULT_SETTLEMENT = { termMs: 200, killMs: 1000, drainMs: 250, pollMs: 20 };
type ProcessResult = GitToolResult extends infer Result ? Result extends GitToolResult ? Omit<Result, "repo" | "leaseDisposition" | "warnings"> : never : never;

function abortCheck(signal: AbortSignal) {
  if (signal.aborted) throw new GitToolError("GIT_CANCELLED");
}
function errorCode(error: unknown) { return (error as NodeJS.ErrnoException)?.code; }
function spawnFailure(error: unknown) {
  return new GitToolError(errorCode(error) === "ENOENT" ? "GIT_NOT_AVAILABLE" : "GIT_SPAWN_FAILED");
}

/** Git-only executor. Numeric group supervision is deliberately not a strong OS identity. */
export async function runGitProcess(params: {
  args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number;
  signal: AbortSignal; knownOutputValues: readonly string[];
  ops?: GitProcessOps; platform?: NodeJS.Platform;
  /** Dependency seams only; these are never model inputs or environment settings. */
  settlement?: Partial<typeof DEFAULT_SETTLEMENT>; maxOutputBytes?: number;
}): Promise<ProcessResult> {
  abortCheck(params.signal);
  if ((params.platform ?? process.platform) !== "linux") throw new GitToolError("GIT_EXECUTION_PLATFORM_UNSUPPORTED");
  const ops = params.ops ?? nativeOps;
  const limits = { ...DEFAULT_SETTLEMENT, ...params.settlement };
  const startedAt = performance.now();
  const output = new GitOutputGuard(params.knownOutputValues, params.maxOutputBytes);
  let child: ChildProcess;
  try {
    child = ops.spawn("git", params.args, {
      cwd: params.cwd, env: params.env, shell: false,
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) { throw spawnFailure(error); }

  return new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    let spawned = false;
    let settlementRequested = false;
    let settlementStarted = false;
    let groupAbsentObserved = false;
    let groupTerminationRequested = false;
    let associationUnknown = false;
    let closeObserved = false;
    let timedOut = false;
    let cancelled = false;
    let outputFailed = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let drainResolve: (() => void) | undefined;
    let startUnknownTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => requestSettlement("timeout"), params.timeoutMs);

    const clearListeners = () => {
      clearTimeout(timeout);
      if (startUnknownTimer) clearTimeout(startUnknownTimer);
      params.signal.removeEventListener("abort", onAbort);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.stdout?.removeListener("error", onOutputError);
      child.stderr?.removeListener("error", onOutputError);
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});
      child.removeListener("spawn", onSpawn);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      // Detached, unconfirmed groups remain protected by the API lease. The
      // Worker need not stay alive solely because a child handle remains open.
      child.on("error", () => {});
      child.unref();
    };
    const destroyStreams = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finish = (confirmed: boolean, incomplete: boolean) => {
      if (settled) return;
      settled = true;
      clearListeners();
      destroyStreams();
      let safe: { stdout: string; stderr: string; outputRedacted: boolean };
      try { safe = output.finish(incomplete || outputFailed || cancelled || timedOut || exitSignal !== null || groupTerminationRequested); }
      catch { confirmed = false; safe = { stdout: "", stderr: "", outputRedacted: true }; }
      const base = {
        ...safe,
        exitCode, signal: exitSignal, timedOut, cancelled,
        outputLimitExceeded: output.outputLimitExceeded,
        durationMs: Math.max(0, Math.floor(performance.now() - startedAt)),
      };
      if (!confirmed) {
        resolve({ ...base, ok: false, processStopConfirmed: false, failureCode: "GIT_PROCESS_STOP_UNCONFIRMED" });
      } else if (exitCode === 0 && !timedOut && !cancelled && !output.outputLimitExceeded && !outputFailed) {
        resolve({ ...base, ok: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false,
          processStopConfirmed: true, failureCode: null });
      } else {
        resolve({ ...base, ok: false, processStopConfirmed: true, failureCode: null });
      }
    };
    const observeAbsent = () => { groupAbsentObserved = true; };
    const groupState = (): "present" | "absent" | "unknown" => {
      if (groupAbsentObserved) return "absent";
      if (!spawned || associationUnknown || !child.pid || child.pid <= 0) return "unknown";
      try { ops.kill(-child.pid, 0); return "present"; }
      catch (error) {
        if (errorCode(error) === "ESRCH") { observeAbsent(); return "absent"; }
        associationUnknown = true;
        return "unknown";
      }
    };
    const sendGroupSignal = (signal: NodeJS.Signals) => {
      if (groupAbsentObserved || associationUnknown || !spawned || !child.pid) return;
      groupTerminationRequested = true;
      try { ops.kill(-child.pid, signal); }
      catch (error) {
        if (errorCode(error) === "ESRCH") observeAbsent();
        else associationUnknown = true;
      }
    };
    const waitForAbsence = async (durationMs: number) => {
      const deadline = performance.now() + durationMs;
      while (!groupAbsentObserved && !associationUnknown) {
        const state = groupState();
        if (state !== "present" || performance.now() >= deadline) break;
        await new Promise<void>((done) => setTimeout(done, Math.min(limits.pollMs, Math.max(1, deadline - performance.now()))));
      }
    };
    const drain = async () => {
      if (closeObserved) return false;
      let truncated = false;
      await new Promise<void>((done) => {
        const timer = setTimeout(() => { truncated = true; drainResolve = undefined; done(); }, limits.drainMs);
        drainResolve = () => { clearTimeout(timer); drainResolve = undefined; done(); };
      });
      return truncated;
    };
    const settle = async () => {
      if (settlementStarted || settled || !spawned) return;
      settlementStarted = true;
      if (startUnknownTimer) clearTimeout(startUnknownTimer);
      try {
        const first = groupState();
        if (first === "present") {
          sendGroupSignal("SIGTERM");
          await waitForAbsence(limits.termMs);
          if (!groupAbsentObserved && !associationUnknown) {
            sendGroupSignal("SIGKILL");
            await waitForAbsence(limits.killMs);
          }
        }
        const incomplete = await drain();
        finish(groupAbsentObserved && !associationUnknown, incomplete);
      } catch {
        // Unknown lifecycle or observation errors cannot become stop evidence.
        associationUnknown = true;
        finish(false, true);
      }
    };
    function requestSettlement(reason: "exit" | "abort" | "timeout" | "output" | "error") {
      if (settled) return;
      if (reason === "abort") cancelled = true;
      if (reason === "timeout") timedOut = true;
      if (!settlementRequested) {
        settlementRequested = true;
        clearTimeout(timeout);
        if (!spawned) {
          // Never probe a not-yet-created group: an early ESRCH is not evidence.
          startUnknownTimer = setTimeout(() => finish(false, true), limits.termMs + limits.killMs);
        }
      }
      if (spawned) void settle();
    }
    const onOutputError = () => {
      if (settled || outputFailed) return;
      outputFailed = true;
      // Never copy a stream error's message/cause. The fixed explanation also
      // passes through the bounded guard, and group settlement still runs.
      try { output.write("stderr", Buffer.from(`\n${GIT_ERROR_MESSAGES.GIT_OUTPUT_GUARD_FAILED}\n`)); } catch { /* finish drops unusable output */ }
      requestSettlement("error");
    };
    const onData = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (settled) return;
      try { if (output.write(stream, chunk)) requestSettlement("output"); }
      catch { onOutputError(); }
    };
    const onStdout = (chunk: Buffer) => onData("stdout", chunk);
    const onStderr = (chunk: Buffer) => onData("stderr", chunk);
    const onAbort = () => requestSettlement("abort");
    const onSpawn = () => {
      spawned = true;
      if (!child.pid || child.pid <= 0) associationUnknown = true;
      if (settlementRequested) void settle();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code;
      exitSignal = signal;
      requestSettlement("exit");
    };
    const onClose = () => {
      closeObserved = true;
      drainResolve?.();
      // Closing stdio is never used as managed-group stop evidence.
    };
    const onError = (error: unknown) => {
      if (settled) return;
      if (!spawned && child.pid === undefined && ["ENOENT", "EACCES", "E2BIG"].includes(errorCode(error) ?? "")) {
        settled = true;
        clearListeners();
        destroyStreams();
        reject(spawnFailure(error));
        return;
      }
      if (!spawned) associationUnknown = true;
      requestSettlement("error");
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.stdout?.on("error", onOutputError);
    child.stderr?.on("error", onOutputError);
    child.once("spawn", onSpawn);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.on("error", onError);
    params.signal.addEventListener("abort", onAbort, { once: true });
    if (params.signal.aborted) onAbort();
  });
}

function knownLeaseId(value: unknown) {
  try {
    const descriptor = value != null && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "leaseId") : undefined;
    const id = descriptor && "value" in descriptor ? descriptor.value : undefined;
    return Value.Check(RepoGitEnvLeaseIdSchema, id) ? id : undefined;
  } catch { return undefined; }
}

export async function executeGitTool(args: Record<string, unknown>, ctx: ToolExecutionContext, options: {
  dataDir?: string;
  platform?: NodeJS.Platform;
  processOps?: GitProcessOps;
  now?: () => number;
  /** Internal test seam, not available in the tool schema. */
  runProcess?: typeof runGitProcess;
} = {}): Promise<GitToolResult> {
  if (!Value.Check(GitToolInputSchema, args)) throw new GitToolError("GIT_INPUT_INVALID");
  if (!ctx.profile.agent.tools.includes("git")) throw new GitToolError("GIT_TOOL_DISABLED");
  abortCheck(ctx.signal);
  if ((options.platform ?? process.platform) !== "linux") throw new GitToolError("GIT_EXECUTION_PLATFORM_UNSUPPORTED");
  if (!options.dataDir) throw new GitToolError("RUN_CONTEXT_INVALID");
  const owner = {
    workspaceId: ctx.run.workspaceId, sessionId: ctx.run.sessionId, runId: ctx.run.runId,
    toolExecutionId: ctx.pendingTool.toolExecutionId,
  };
  if (!Value.Check(RepoGitEnvLeaseOwnerSchema, owner) || ctx.pendingTool.toolName !== "git") throw new GitToolError("RUN_CONTEXT_INVALID");
  const timeoutMs = (args.timeout ?? GIT_TOOL_DEFAULT_TIMEOUT_SECONDS) * 1000;
  const now = options.now ?? Date.now;
  const request: PrepareRepoGitEnvRequest = { ...owner, repo: args.repo, timeoutMs };
  let leaseId: string | undefined;
  let processStarted = false;
  let repositoryGuard: Awaited<ReturnType<typeof prepareGitRepositoryPath>> | undefined;
  const release = async (stopEvidence: ReleaseRepoGitEnvRequest["stopEvidence"]) => {
    if (!leaseId) return false;
    try {
      const response = await ctx.apiClient.releaseRepoGitEnvLease({ ...owner, leaseId, stopEvidence });
      return response.ok === true;
    } catch { return false; }
  };
  try {
    repositoryGuard = await prepareGitRepositoryPath({ dataDir: options.dataDir, workspacePath: ctx.run.workspacePath, repo: args.repo });
    abortCheck(ctx.signal);
    let response: PrepareRepoGitEnvResponse;
    try {
      response = await ctx.apiClient.prepareRepoGitEnvLease(request, { abortSignal: ctx.signal });
    } catch (error) {
      leaseId = knownLeaseId(error);
      if (ctx.signal.aborted) throw new GitToolError("GIT_CANCELLED");
      throw new GitToolError("GIT_ENV_RPC_FAILED");
    }
    leaseId = knownLeaseId(response);
    if (!Value.Check(PrepareRepoGitEnvResponseSchema, response)) throw new GitToolError("GIT_ENV_RPC_FAILED");
    if (!response.ok) {
      const code = Object.prototype.hasOwnProperty.call(GIT_ERROR_MESSAGES, response.errorCode)
        ? response.errorCode as GitErrorCode : "GIT_ENV_PREPARE_FAILED";
      throw new GitToolError(code, code === "REPO_NOT_AVAILABLE" ? response.availableRepos : undefined);
    }
    abortCheck(ctx.signal);
    await repositoryGuard.assertWorkspaceIdentity();
    const guard = await prepareGitOutputGuard({ response, repo: args.repo, dataDir: path.resolve(options.dataDir), timeoutMs, now: now() });
    const env = buildGitProcessEnv(response.env);
    abortCheck(ctx.signal);
    await repositoryGuard.assertWorkspaceIdentity();
    await guard.assertPathIdentity();
    // This last asynchronous cwd check deliberately follows all local/RPC
    // preparation. The remaining check-to-spawn TOCTOU window is not a sandbox.
    const cwd = await repositoryGuard.checkFinalPath();
    abortCheck(ctx.signal);
    requireGitLeaseTime(response, timeoutMs, now());
    abortCheck(ctx.signal);
    let result: ProcessResult;
    const processStartedAt = performance.now();
    try {
      // A returned process result includes unknown startup as retained; only
      // explicit native no-start errors are thrown by runGitProcess.
      processStarted = true;
      result = await (options.runProcess ?? runGitProcess)({
        args: args.args, cwd, env, timeoutMs, signal: ctx.signal,
        knownOutputValues: guard.knownValues, ops: options.processOps, platform: options.platform,
      });
    } catch (error) {
      if (error instanceof GitToolError
        && ["GIT_NOT_AVAILABLE", "GIT_SPAWN_FAILED", "GIT_CANCELLED", "GIT_EXECUTION_PLATFORM_UNSUPPORTED"].includes(error.code)) {
        processStarted = false;
        throw error;
      }
      // An unforeseen executor failure is not affirmative no-start evidence.
      processStarted = true;
      result = {
        ok: false, exitCode: null, signal: null, timedOut: false, cancelled: ctx.signal.aborted,
        outputLimitExceeded: false, processStopConfirmed: false, failureCode: "GIT_PROCESS_STOP_UNCONFIRMED",
        outputRedacted: true, stdout: "", stderr: "", durationMs: Math.max(0, Math.floor(performance.now() - processStartedAt)),
      };
    }
    if (!result.processStopConfirmed) {
      return registerGitDiagnosticResult({ ...result, repo: args.repo, leaseDisposition: "retained", warnings: [] });
    }
    const released = await release("managed_group_absent");
    return registerGitDiagnosticResult({
      ...result, repo: args.repo,
      leaseDisposition: released ? "released" : "release_unconfirmed",
      warnings: released ? [] : ["LEASE_CLEANUP_FAILED"],
    });
  } catch (error) {
    if (!processStarted && repositoryGuard && error instanceof GitToolError && error.code === "GIT_OUTPUT_GUARD_FAILED") {
      // A changed trusted root must not be disguised as a lease-file error.
      try { await repositoryGuard.assertWorkspaceIdentity(); }
      catch (pathError) { error = pathError; }
    }
    if (!processStarted && leaseId) await release("not_started");
    if (error instanceof GitToolError) throw error;
    throw new GitToolError("GIT_ENV_PREPARE_FAILED");
  } finally {
    await repositoryGuard?.close();
  }
}
