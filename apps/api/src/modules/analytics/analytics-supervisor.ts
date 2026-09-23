import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DashboardQueryErrorResponseSchema,
  DashboardQuerySuccessResponseSchema,
  type DashboardQueryErrorResponse,
  type DashboardQueryRequest,
  type DashboardQuerySuccessResponse
} from "@agent-workbench/shared";
import type { AnalyticsSignal, AnalyticsSignalResult } from "@agent-workbench/shared";
import { Value } from "@sinclair/typebox/value";
import {
  isAnalyticsChildMessage,
  type AnalyticsChildMessage,
  type AnalyticsParentMessage
} from "./analytics.protocol.js";

export type AnalyticsChildProcess = Pick<ChildProcess, "connected" | "send" | "kill" | "on" | "once">;
export type AnalyticsWorkerFactory = () => AnalyticsChildProcess;
export type AnalyticsSupervisorOptions = {
  dataDir: string;
  workerFactory?: AnalyticsWorkerFactory;
  startupTimeoutMs?: number;
  queryTimeoutMs?: number;
  signalTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  restartLimit?: number;
  restartDelayMs?: number;
  collectorEnabled?: boolean;
  collectorIntervalMs?: number;
  collectorBatchSize?: number;
};

type PendingRequest = {
  kind: "dashboard";
  resolve: (response: DashboardQuerySuccessResponse | DashboardQueryErrorResponse) => void;
  timer: NodeJS.Timeout;
};
type PendingSignal = { kind: "signal"; resolve: (result: AnalyticsSignalResult) => void; timer: NodeJS.Timeout };

const UNAVAILABLE: DashboardQueryErrorResponse = { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } };
const SAFE_CHILD_ENV_KEYS = ["NODE_ENV", "TZ"] as const;

function createMinimalChildEnv(dataDir: string, options: Pick<AnalyticsSupervisorOptions, "collectorEnabled" | "collectorIntervalMs" | "collectorBatchSize"> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { AWB_ANALYTICS_DATA_DIR: dataDir };
  env.AWB_ANALYTICS_COLLECTOR_ENABLED = options.collectorEnabled === false ? "0" : "1";
  if (options.collectorIntervalMs !== undefined) env.AWB_ANALYTICS_COLLECTOR_INTERVAL_MS = String(options.collectorIntervalMs);
  if (options.collectorBatchSize !== undefined) env.AWB_ANALYTICS_COLLECTOR_BATCH_SIZE = String(options.collectorBatchSize);
  for (const key of SAFE_CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Explicit child arguments; no inherited inspect or env-file process flags. */
function createSafeChildExecArgv(usesSourceWorker: boolean) {
  return usesSourceWorker ? ["--import", "tsx"] : [];
}

function defaultWorkerFactory(options: AnalyticsSupervisorOptions): AnalyticsChildProcess {
  const compiledPath = fileURLToPath(new URL("./analytics.worker.js", import.meta.url));
  const sourcePath = fileURLToPath(new URL("./analytics.worker.ts", import.meta.url));
  const usesSourceWorker = !existsSync(compiledPath);
  const forkOptions: ForkOptions = {
    serialization: "json",
    env: createMinimalChildEnv(options.dataDir, options),
    execArgv: createSafeChildExecArgv(usesSourceWorker)
  };
  return fork(usesSourceWorker ? sourcePath : compiledPath, [], forkOptions);
}

/**
 * Supervises exactly one Analytics child at a time. A child is either active
 * (eligible for queries) or retiring (must confirm exit before replacement).
 * The API process never opens Analytics SQLite.
 */
export class AnalyticsSupervisor {
  private readonly workerFactory: AnalyticsWorkerFactory;
  private readonly startupTimeoutMs: number;
  private readonly queryTimeoutMs: number;
  private readonly signalTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly restartLimit: number;
  private readonly restartDelayMs: number;
  private activeChild: AnalyticsChildProcess | null = null;
  private retiringChild: AnalyticsChildProcess | null = null;
  private ready = false;
  private serving = false;
  private closing = false;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private retirementTimer: NodeJS.Timeout | null = null;
  private retirementExhausted = false;
  private startPromise: Promise<boolean> | null = null;
  private resolveStart: ((value: boolean) => void) | null = null;
  private closeWaiters = new Set<() => void>();
  private pending = new Map<string, PendingRequest | PendingSignal>();
  private startRequestId: string | null = null;
  private readyListeners = new Set<() => void>();

  constructor(private readonly options: AnalyticsSupervisorOptions) {
    this.workerFactory = options.workerFactory ?? (() => defaultWorkerFactory(options));
    this.startupTimeoutMs = options.startupTimeoutMs ?? 3_000;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 2_000;
    this.signalTimeoutMs = options.signalTimeoutMs ?? Math.min(this.queryTimeoutMs, 1_000);
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    this.restartLimit = options.restartLimit ?? 3;
    this.restartDelayMs = options.restartDelayMs ?? 250;
  }

  get isReady() {
    return this.serving;
  }

  /** Bootstrap hooks run before the child is exposed to Dashboard traffic. */
  onReady(listener: () => void | Promise<void>): () => void {
    this.readyListeners.add(listener);
    if (this.ready) queueMicrotask(() => {
      try { if (this.readyListeners.has(listener)) void listener(); } catch { /* Analytics-only hook */ }
    });
    return () => this.readyListeners.delete(listener);
  }

  start(): Promise<boolean> {
    if (this.closing || this.retiringChild) return Promise.resolve(false);
    if (this.ready) return Promise.resolve(true);
    if (this.startPromise) return this.startPromise;
    if (this.activeChild) return Promise.resolve(false);

    const promise = new Promise<boolean>((resolve) => { this.resolveStart = resolve; });
    this.startPromise = promise;
    let child: AnalyticsChildProcess;
    try {
      child = this.workerFactory();
    } catch {
      // No child was created, so there is no exit to confirm. Do not retry
      // automatically: automatic replacement is strictly exit-driven.
      this.finishStart(false);
      return promise;
    }

    this.activeChild = child;
    child.on("message", (message: unknown) => this.onChildMessage(child, message));
    child.on("error", () => this.beginRetirement(child));
    child.once("exit", () => this.onChildExit(child));

    const requestId = randomUUID();
    this.startRequestId = requestId;
    this.startupTimer = setTimeout(() => this.beginRetirement(child), this.startupTimeoutMs);
    this.send(child, { type: "initialize", requestId }, () => this.beginRetirement(child));
    return promise;
  }

  async query(request: DashboardQueryRequest): Promise<DashboardQuerySuccessResponse | DashboardQueryErrorResponse> {
    const child = this.activeChild;
    if (!this.serving || !child || this.retiringChild || !child.connected) return UNAVAILABLE;
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        if (pending.kind === "dashboard") pending.resolve(UNAVAILABLE);
      else pending.resolve({ accepted: false, receipt: null });
        this.beginRetirement(child);
      }, this.queryTimeoutMs);
      this.pending.set(requestId, { kind: "dashboard", resolve, timer });
      this.send(child, { type: "dashboard_query", requestId, request }, () => this.beginRetirement(child));
    });
  }

  /** A bounded IPC attempt. Business producers must invoke it fire-and-forget. */
  signal(signal: AnalyticsSignal): Promise<AnalyticsSignalResult> {
    const child = this.activeChild;
    if (!this.ready || !child || this.retiringChild || !child.connected) return Promise.resolve({ accepted: false, receipt: null });
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        if (pending.kind === "signal") pending.resolve({ accepted: false, receipt: null });
        this.beginRetirement(child);
      }, this.signalTimeoutMs);
      this.pending.set(requestId, { kind: "signal", resolve, timer });
      this.send(child, { type: "signal", requestId, signal }, () => this.beginRetirement(child));
    });
  }

  /** API-process-only capability; intentionally absent from producer HTTP DTOs. */
  diagnoseOutboxCorrupt(input: { producerGeneration: string; recordedAt?: number }): Promise<boolean> {
    const child = this.activeChild;
    if (!this.ready || !child || this.retiringChild || !child.connected) return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve(false); }, Math.min(this.queryTimeoutMs, 1_000));
      this.pending.set(requestId, { kind: "signal", timer, resolve: (result) => resolve(result.accepted) });
      this.send(child, { type: "outbox_corrupt", requestId, producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: input.producerGeneration, recordedAt: input.recordedAt ?? Date.now() }, () => { clearTimeout(timer); this.pending.delete(requestId); resolve(false); });
    });
  }

  /** API-process-only recovery; no public producer transport can invoke it. */
  abandonLocalFallbackGeneration(input: { producerGeneration: string; recordedAt?: number }): Promise<boolean> {
    const child = this.activeChild;
    if (!this.ready || !child || this.retiringChild || !child.connected) return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve(false); }, Math.min(this.queryTimeoutMs, 1_000));
      this.pending.set(requestId, { kind: "signal", timer, resolve: (result) => resolve(result.accepted) });
      this.send(child, { type: "local_fallback_abandon", requestId, producerNamespace: "api_local_fallback", producerId: "api_local_fallback", producerGeneration: input.producerGeneration, recordedAt: input.recordedAt ?? Date.now() }, () => { clearTimeout(timer); this.pending.delete(requestId); resolve(false); });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.ready = false;
    this.serving = false;
    this.clearRestartTimer();
    this.clearStartupTimer();
    this.finishStart(false);
    this.resolvePendingUnavailable();
    if (this.activeChild) this.beginRetirement(this.activeChild);
    if (!this.retiringChild) return;
    if (this.retirementExhausted) return;
    await new Promise<void>((resolve) => this.closeWaiters.add(resolve));
  }

  private onChildMessage(child: AnalyticsChildProcess, message: unknown) {
    if (!isAnalyticsChildMessage(message)) return this.beginRetirement(child);
    if (this.activeChild !== child) return;

    if (message.type === "ready") {
      if (message.requestId !== this.startRequestId || this.ready) return this.beginRetirement(child);
      this.ready = true;
      this.startRequestId = null;
      void (async () => {
        for (const listener of this.readyListeners) {
          try { await listener(); }
          catch {
            this.beginRetirement(child);
            return;
          }
        }
        if (this.activeChild !== child || this.retiringChild || !this.ready) return;
        this.serving = true;
        this.clearStartupTimer();
        this.finishStart(true);
      })();
      return;
    }
    if (message.type === "initialization_failed") {
      if (message.requestId !== this.startRequestId) return this.beginRetirement(child);
      return this.beginRetirement(child);
    }
    if (message.type === "dashboard_result") {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.kind !== "dashboard") return this.beginRetirement(child);
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.response.kind === "success" && Value.Check(DashboardQuerySuccessResponseSchema, message.response)) {
        pending.resolve(message.response);
        return;
      }
      if (message.response.kind === "error" && Value.Check(DashboardQueryErrorResponseSchema, message.response)) {
        pending.resolve(message.response);
        return;
      }
      return this.beginRetirement(child);
    }
    if (message.type === "signal_result") {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.kind !== "signal") return this.beginRetirement(child);
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message.result);
      return;
    }
    // A shutdown completion is only meaningful during retirement. It is not a
    // substitute for `exit`, which remains the sole replacement permission.
    if (message.type === "shutdown_complete" && this.retiringChild === child) return;
    this.beginRetirement(child);
  }

  /** Stop serving immediately, then retain the child until its exit is confirmed. */
  private beginRetirement(child: AnalyticsChildProcess) {
    if (this.retiringChild === child) return;
    if (this.activeChild !== child) return;
    this.activeChild = null;
    this.retiringChild = child;
    this.retirementExhausted = false;
    this.ready = false;
    this.serving = false;
    this.startRequestId = null;
    this.clearStartupTimer();
    this.finishStart(false);
    this.resolvePendingUnavailable();
    this.requestGracefulShutdown(child);
  }

  private requestGracefulShutdown(child: AnalyticsChildProcess) {
    this.send(child, { type: "shutdown", requestId: randomUUID() }, () => this.sendSigterm(child));
    this.replaceRetirementTimer(() => this.sendSigterm(child));
  }

  private sendSigterm(child: AnalyticsChildProcess) {
    if (this.retiringChild !== child) return;
    this.safeKill(child, "SIGTERM");
    this.replaceRetirementTimer(() => this.sendSigkill(child));
  }

  private sendSigkill(child: AnalyticsChildProcess) {
    if (this.retiringChild !== child) return;
    this.safeKill(child, "SIGKILL");
    this.replaceRetirementTimer(() => this.finishUnconfirmedRetirement(child));
  }

  private finishUnconfirmedRetirement(child: AnalyticsChildProcess) {
    if (this.retiringChild !== child) return;
    // Keep retiringChild populated. It is proof that no replacement may be
    // launched until a later real `exit` event is observed.
    this.clearRetirementTimer();
    this.retirementExhausted = true;
    this.notifyCloseWaiters();
  }

  private onChildExit(child: AnalyticsChildProcess) {
    const wasManaged = this.activeChild === child || this.retiringChild === child;
    if (!wasManaged) return;
    if (this.activeChild === child) {
      // Exit can arrive before a prior error/message failure is observed.
      this.activeChild = null;
      this.ready = false;
      this.startRequestId = null;
      this.clearStartupTimer();
      this.finishStart(false);
      this.resolvePendingUnavailable();
    }
    if (this.retiringChild === child) this.retiringChild = null;
    this.retirementExhausted = false;
    this.clearRetirementTimer();
    this.notifyCloseWaiters();
    // Only this confirmed exit path can schedule an automatic replacement.
    if (!this.closing) this.scheduleRestart();
  }

  private send(child: AnalyticsChildProcess, message: AnalyticsParentMessage, onFailure: () => void) {
    if (!child.connected) return onFailure();
    try {
      child.send(message as Parameters<AnalyticsChildProcess["send"]>[0], (error) => {
        if (error) onFailure();
      });
    } catch {
      onFailure();
    }
  }

  private finishStart(value: boolean) {
    const resolve = this.resolveStart;
    this.resolveStart = null;
    this.startPromise = null;
    resolve?.(value);
  }

  private resolvePendingUnavailable() {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      if (pending.kind === "dashboard") pending.resolve(UNAVAILABLE);
      else pending.resolve({ accepted: false, receipt: null });
    }
  }

  private replaceRetirementTimer(callback: () => void) {
    this.clearRetirementTimer();
    this.retirementTimer = setTimeout(callback, this.shutdownTimeoutMs);
  }

  private clearStartupTimer() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private clearRetirementTimer() {
    if (this.retirementTimer) clearTimeout(this.retirementTimer);
    this.retirementTimer = null;
  }

  private clearRestartTimer() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private safeKill(child: AnalyticsChildProcess, signal: NodeJS.Signals) {
    try {
      child.kill(signal);
    } catch {
      // The final timeout preserves availability isolation even when process
      // manager operations themselves fail.
    }
  }

  private scheduleRestart() {
    if (this.closing || this.retiringChild || this.activeChild || this.restartTimer || this.restartCount >= this.restartLimit) return;
    this.restartCount += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, this.restartDelayMs);
  }

  private notifyCloseWaiters() {
    for (const resolve of this.closeWaiters) resolve();
    this.closeWaiters.clear();
  }
}

/** Test-only launch policy observability; no child secrets are exposed. */
export const __analyticsSupervisorInternals = { createMinimalChildEnv, createSafeChildExecArgv };
