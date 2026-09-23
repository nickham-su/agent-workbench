import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isCanonicalAnalyticsSignal, type AnalyticsControlSignal, type AnalyticsSignal, type AnalyticsSignalEvent } from "@agent-workbench/shared";
import { openSecureAnalyticsRoot } from "@agent-workbench/shared/node/analytics-root";

/**
 * Recovery is the sole compatibility boundary for durable worker outboxes.
 * The public signal endpoint deliberately accepts only canonical v6 signals.
 * Older model-event spellings are recognized here, but cannot be safely given
 * v6 semantics without a complete payload; retain the file and emit a
 * checkpoint so the producer reports the resulting uncertainty as loss.
 */
function parseRecoveredModelOutboxSignal(value: unknown, generation: string): AnalyticsSignalEvent | null {
  if (isCanonicalAnalyticsSignal(value)
    && value.kind === "event"
    && value.domain === "model"
    && value.producerNamespace === "agent_worker"
    && value.producerId === "agent_runner"
    && value.producerGeneration === generation) return value;
  const legacy = value as { kind?: unknown; domain?: unknown; eventType?: unknown; producerGeneration?: unknown } | null;
  if (legacy?.kind === "event" && legacy.domain === "model" && legacy.producerGeneration === generation
    && (legacy.eventType === "model_started" || legacy.eventType === "model_completed" || legacy.eventType === "model_failed")) {
    // Deliberately conservative: legacy events lack the v6 observed-state and
    // quality fields required for a fact.  Do not replay them as clean data.
    return null;
  }
  return null;
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};
import { request as httpRequest } from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import { AgentWorkerEndpoints } from "@agent-workbench/shared/internal-contracts/endpoints";

const ANALYTICS_RECOVERY_TIMEOUT_MS = 750;
const LIFECYCLE_REPLAY_TIMEOUT_MS = 750;
type WorkerLifecycleTarget = { domain: "execution" | "model" | "worker"; producerNamespace: "agent_worker" | "worker_observer"; producerId: string; producerGeneration: string };
type WorkerLifecycleCapture = { occurredAt: number; targetIdentityQuality: "exact" | "unknown"; targets: WorkerLifecycleTarget[] };
type WorkerLiveSnapshot = { snapshotAt: number; activeCount: number; queueLength: number; concurrency: number; runnerMode: "agent_worker"; analyticsProducerGeneration: string | null; childEpoch: number };
type WorkerLifecycleIntent = { version: 2; signal: AnalyticsSignalEvent };

/** AbortSignal is advisory for fetch implementations. Recovery must also stay
 * bounded when a test double or a nonconforming transport never settles. */
async function withinAnalyticsRecoveryBudget<T>(deadline: number, operation: (signal: AbortSignal) => Promise<T>) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("analytics recovery budget exhausted");
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("analytics recovery budget exhausted")); }, remaining);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

async function fileExists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function buildAgentWorkerSpawnEnv(params: {
  parentEnv: NodeJS.ProcessEnv;
  repoRoot: string;
  dataDir: string;
  workerHost: string;
  workerPort: number;
  socketPath: string;
  workerConcurrency: number;
  apiOrigin: string;
  internalToken: string;
  responseValidation: "strict" | "warn";
  pidFilePath: string;
}): NodeJS.ProcessEnv {
  return {
    ...params.parentEnv,
    AWB_DATA_DIR: params.dataDir,
    AWB_AGENT_WORKER_HOST: params.workerHost,
    AWB_AGENT_WORKER_PORT: String(params.workerPort),
    AWB_AGENT_WORKER_SOCKET: params.socketPath,
    AWB_AGENT_WORKER_CONCURRENCY: String(params.workerConcurrency),
    AWB_AGENT_API_ORIGIN: params.apiOrigin,
    AWB_AGENT_INTERNAL_TOKEN: params.internalToken,
    AWB_INTERNAL_RPC_RESPONSE_VALIDATION: params.responseValidation,
    AWB_AGENT_WORKER_PID_FILE: params.pidFilePath,
    AWB_AGENT_REPO_ROOT: params.repoRoot
  };
}

/** Keep restart history until health *and* ready orchestration both succeed. */
export async function completeAgentWorkerReady(params: {
  generation: number;
  onReady?: (generation: number) => void | Promise<void>;
      diagnoseOutboxCorrupt?: (input: { producerGeneration: string; recordedAt?: number }) => Promise<boolean>;
  resetRestartState(): void;
}) {
  await params.onReady?.(params.generation);
  params.resetRestartState();
}

export class AgentWorkerProcessManager {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private recentFailureTs: number[] = [];
  private readyGeneration = 0;
  private readonly analyticsGeneration = randomUUID();
  private analyticsSequence = 0;
  private analyticsLastReadyAt: number | null = null;
  private analyticsCheckpointTimer: NodeJS.Timeout | null = null;
  private activeRestartAttemptId: string | null = null;
  private readonly recoveringOutboxGenerations = new Set<string>();
  private analyticsControlSequence = 0;
  private startPromise: Promise<void> | null = null;
  private lastLiveSnapshot: WorkerLiveSnapshot | null = null;
  private childEpoch = 0;
  private nextChildEpoch = 0;
  private lifecycleReplayInFlight = false;
  private readonly lifecycleTasks = new Set<Promise<unknown>>();
  private readonly lifecycleDeliveryOwners = new Map<string, Promise<boolean>>();

  constructor(
    private readonly params: {
      repoRoot: string;
      dataDir: string;
      workerHost: string;
      workerPort: number;
      socketPath: string;
      workerConcurrency: number;
      apiOrigin: string;
      internalToken: string;
      responseValidation: "strict" | "warn";
      pidFilePath: string;
      logger: FastifyBaseLogger;
      onReady?: (generation: number) => void | Promise<void>;
      diagnoseOutboxCorrupt?: (input: { producerGeneration: string; recordedAt?: number }) => Promise<boolean>;
      /** Injectable only to make recovery ordering observable without spawning a real worker. */
      spawnWorker?: typeof spawn;
      waitForWorkerReady?: () => Promise<void>;
      /** Test-only cadence override; production always uses the five-second default. */
      analyticsCheckpointIntervalMs?: number;
    }
  ) {}

  private trackLifecycle(task: Promise<unknown>) {
    this.lifecycleTasks.add(task);
    void task.catch(() => this.params.logger.warn({ operation: "lifecycle_task", errorCode: "ANALYTICS_LIFECYCLE_TASK_FAILED" }, "Analytics lifecycle task failed"))
      .finally(() => this.lifecycleTasks.delete(task));
    return task;
  }

  private async drainLifecycleTasks(timeoutMs = 1_000) {
    await Promise.race([Promise.allSettled([...this.lifecycleTasks]), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async startInternal() {
    this.stopping = false;
    if (this.child) return;
    if (!this.analyticsCheckpointTimer) {
      this.tryEmitWorkerControl("register");
      this.tryEmitWorkerControl("checkpoint");
      // Recovery is safe before spawn: the filesystem lock makes the API the
      // sole owner after it has confirmed no current worker is serving work.
      // Lifecycle replay shares the same startup window; Analytics recovery
      // must not become an additional Worker-start dependency.
      await Promise.all([this.trackLifecycle(this.recoverExitedWorkerOutboxes()), this.trackLifecycle(this.replayWorkerLifecycleIntents())]);
      if (this.stopping || this.child) return;
      this.analyticsCheckpointTimer = setInterval(() => { if (this.stopping) return; this.tryEmitWorkerControl("checkpoint"); const child = this.child; if (child) this.trackLifecycle(this.emitWorkerSnapshot(child, this.childEpoch)); this.trackLifecycle(this.replayWorkerLifecycleIntents()); }, this.params.analyticsCheckpointIntervalMs ?? 5_000);
      this.analyticsCheckpointTimer.unref();
    }

    const distEntry = path.join(this.params.repoRoot, "apps", "agent-worker", "dist", "main.js");
    const srcEntry = path.join(this.params.repoRoot, "apps", "agent-worker", "src", "main.ts");
    const tsxBin = path.join(this.params.repoRoot, "node_modules", ".bin", "tsx");
    const preferSource =
      String(process.env.npm_lifecycle_event || "").includes("dev") ||
      String(process.argv[1] || "").endsWith(".ts");

    let command = process.execPath;
    let args: string[] = [];

    if (!preferSource && (await fileExists(distEntry))) {
      args = [distEntry];
    } else {
      command = tsxBin;
      args = [srcEntry];
    }

    const child = (this.params.spawnWorker ?? spawn)(command, args, {
      cwd: this.params.repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildAgentWorkerSpawnEnv({
        parentEnv: process.env,
        repoRoot: this.params.repoRoot,
        dataDir: this.params.dataDir,
        workerHost: this.params.workerHost,
        workerPort: this.params.workerPort,
        socketPath: this.params.socketPath,
        workerConcurrency: this.params.workerConcurrency,
        apiOrigin: this.params.apiOrigin,
        internalToken: this.params.internalToken,
        responseValidation: this.params.responseValidation,
        pidFilePath: this.params.pidFilePath
      })
    });
    child.unref();
    // A snapshot belongs to one child lifetime only. Never carry A's producer
    // identity into B while an old async snapshot request is still resolving.
    this.lastLiveSnapshot = null;
    const childEpoch = ++this.nextChildEpoch;
    this.childEpoch = childEpoch;
    this.child = child;

    child.stdout?.on("data", (chunk) => {
      this.params.logger.info({ output: chunk.toString("utf8").trim() }, "agent-worker stdout");
    });
    child.stderr?.on("data", (chunk) => {
      this.params.logger.warn({ output: chunk.toString("utf8").trim() }, "agent-worker stderr");
    });
    child.on("exit", (code, signal) => {
      // An obsolete child may report after its replacement has spawned.
      if (this.child !== child || this.childEpoch !== childEpoch) return;
      this.params.logger.warn({ code, signal }, "agent-worker exited");
      const lifecycle = this.captureWorkerLifecycle(Date.now(), child, childEpoch);
      this.child = null;
      this.lastLiveSnapshot = null;
      if (this.stopping) return;
      this.trackLifecycle(this.recoverExitedWorkerOutboxes().finally(() => {
        if (this.stopping) return;
        this.trackLifecycle(this.persistAndDispatchWorkerLifecycle("unexpected_exit", lifecycle));
        this.handleUnexpectedExit();
      }));
    });

    try {
      await (this.params.waitForWorkerReady?.() ?? this.waitUntilReady());
      await completeAgentWorkerReady({
        generation: ++this.readyGeneration,
        onReady: this.params.onReady,
        // A health endpoint alone is insufficient: a failed ready hook means
        // this generation never became operational, so preserve restart backoff.
        resetRestartState: () => {
          this.restartAttempt = 0;
          this.recentFailureTs = [];
        },
      });
      this.tryEmitWorkerEvent("ready");
      this.trackLifecycle(this.emitWorkerSnapshot(child, childEpoch));
      if (this.activeRestartAttemptId) this.tryEmitWorkerEvent("restart_succeeded", this.activeRestartAttemptId);
      this.activeRestartAttemptId = null;
    } catch (err) {
      this.params.logger.error({ err }, "agent-worker failed to become ready");
      // A late readiness failure from an obsolete child must not detach its
      // replacement (nor its epoch-bound snapshot) from the manager.
      if (this.child === child && this.childEpoch === childEpoch) {
        this.child = null;
        this.lastLiveSnapshot = null;
      }
      child.kill("SIGKILL");
      throw err;
    }
  }

  async stop() {
    this.stopping = true;
    if (this.analyticsCheckpointTimer) clearInterval(this.analyticsCheckpointTimer);
    this.analyticsCheckpointTimer = null;
    this.tryEmitWorkerControl("closing");
    this.tryEmitWorkerControl("closed");
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    const lifecycle = this.captureWorkerLifecycle(Date.now(), child, this.childEpoch);
    if (!child) {
      this.trackLifecycle(this.persistAndDispatchWorkerLifecycle("controlled_stop", lifecycle));
      await this.drainLifecycleTasks();
      return;
    }
    this.child = null;

    child.kill("SIGTERM");
    const done = await Promise.race([
      new Promise<boolean>((resolve) => {
        child.once("exit", () => resolve(true));
      }),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 3000);
      })
    ]);
    if (!done) {
      child.kill("SIGKILL");
    }
    this.trackLifecycle(this.persistAndDispatchWorkerLifecycle("controlled_stop", lifecycle));
    await this.drainLifecycleTasks();
  }

  private tryEmitWorkerControl(kind: "register" | "checkpoint" | "closing" | "closed") {
    const signal: AnalyticsControlSignal = { kind, domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager", producerGeneration: this.analyticsGeneration, sentAt: Date.now(), controlSequence: ++this.analyticsControlSequence, finalSequence: kind === "closing" || kind === "closed" ? this.analyticsSequence : null, committedSequence: this.analyticsSequence, maxObservedAt: Date.now(), earliestOpenStartedAt: null, openExecutionCount: 0, openModelCount: 0, knownDrop: false, droppedSinceSequence: null, outboxPending: 0, oldestPendingAt: null, lossEpoch: 0 };
    this.tryDispatchAnalytics(signal);
  }

  private captureWorkerLifecycle(occurredAt: number, child = this.child, childEpoch = this.childEpoch): WorkerLifecycleCapture {
    const targets: WorkerLifecycleTarget[] = [{ domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager", producerGeneration: this.analyticsGeneration }];
    const snapshot = child && this.lastLiveSnapshot && this.lastLiveSnapshot.childEpoch === childEpoch ? this.lastLiveSnapshot : null;
    const generation = snapshot?.analyticsProducerGeneration;
    if (generation) {
      targets.push({ domain: "execution", producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: generation },
        { domain: "model", producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration: generation });
    }
    return { occurredAt, targetIdentityQuality: generation ? "exact" : "unknown", targets };
  }

  private createWorkerEvent(event: "ready" | "restart_attempted" | "restart_succeeded" | "restart_failed" | "unexpected_exit" | "controlled_stop", restartAttemptId: string | null = null, lifecycle?: WorkerLifecycleCapture): AnalyticsSignalEvent {
    const now = Date.now();
    if (event === "ready") this.analyticsLastReadyAt = now;
    const eventType = event === "ready" ? "worker_ready" as const : event === "unexpected_exit" ? "worker_unexpected_exit" as const : event === "controlled_stop" ? "worker_controlled_stop" as const : `worker_${event}` as const;
    const captured = lifecycle ?? this.captureWorkerLifecycle(now);
    const base = { kind: "event" as const, domain: "worker" as const, producerNamespace: "worker_observer" as const, producerId: "process_manager", producerGeneration: this.analyticsGeneration, sequence: ++this.analyticsSequence, eventId: randomUUID(), payloadVersion: 1 as const, eventType, subjectIdentity: `worker:${event}:${restartAttemptId ?? captured.occurredAt}`, observedAt: now, payload: { occurredAt: captured.occurredAt, event, restartAttemptId, runnerMode: "agent_worker" as const, targetIdentityQuality: captured.targetIdentityQuality, targets: captured.targets } };
    return { ...base, fingerprint: createHash("sha256").update(canonicalJson(base)).digest("hex") } as AnalyticsSignalEvent;
  }

  private tryEmitWorkerEvent(event: "ready" | "restart_attempted" | "restart_succeeded" | "restart_failed", restartAttemptId: string | null = null) {
    this.tryDispatchAnalytics(this.createWorkerEvent(event, restartAttemptId));
  }

  private async emitWorkerSnapshot(child: ChildProcess, childEpoch: number) {
    const snapshot = await this.readWorkerSnapshot();
    // Do not let an in-flight A request populate the snapshot cache for B.
    if (!snapshot || this.child !== child || this.childEpoch !== childEpoch) return;
    this.lastLiveSnapshot = { ...snapshot, childEpoch };
    const now = Date.now();
    const { analyticsProducerGeneration: _producerGeneration, ...snapshotPayload } = snapshot;
    const base = { kind: "event" as const, domain: "worker" as const, producerNamespace: "worker_observer" as const, producerId: "process_manager", producerGeneration: this.analyticsGeneration, sequence: ++this.analyticsSequence, eventId: randomUUID(), payloadVersion: 1 as const, eventType: "worker_snapshot" as const, subjectIdentity: `worker:snapshot:${snapshot.snapshotAt}`, observedAt: now, payload: { ...snapshotPayload, lastReadyAt: this.analyticsLastReadyAt } };
    this.tryDispatchAnalytics({ ...base, fingerprint: createHash("sha256").update(canonicalJson(base)).digest("hex") } as AnalyticsSignalEvent);
  }

  private async readWorkerSnapshot(): Promise<Omit<WorkerLiveSnapshot, "childEpoch"> | null> {
    try {
      if (!this.params.socketPath) {
        const response = await fetch(`http://${this.params.workerHost}:${this.params.workerPort}/_internal/analytics-snapshot`, { headers: { "x-awb-agent-internal-token": this.params.internalToken }, signal: AbortSignal.timeout(750) });
        if (!response.ok) return null;
        const value = await response.json() as Record<string, unknown>;
        return typeof value.snapshotAt === "number" && typeof value.activeCount === "number" && typeof value.queueLength === "number" && typeof value.concurrency === "number" && value.runnerMode === "agent_worker" ? { ...value, analyticsProducerGeneration: typeof value.analyticsProducerGeneration === "string" ? value.analyticsProducerGeneration : null } as WorkerLiveSnapshot : null;
      }
      return await new Promise((resolve) => {
        const req = httpRequest({ socketPath: this.params.socketPath, path: "/_internal/analytics-snapshot", headers: { "x-awb-agent-internal-token": this.params.internalToken } }, (res) => {
          let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => { try { const value = JSON.parse(body) as Record<string, unknown>; resolve((res.statusCode === 200 && typeof value.snapshotAt === "number" && typeof value.activeCount === "number" && typeof value.queueLength === "number" && typeof value.concurrency === "number" && value.runnerMode === "agent_worker") ? { ...value, analyticsProducerGeneration: typeof value.analyticsProducerGeneration === "string" ? value.analyticsProducerGeneration : null } as WorkerLiveSnapshot : null); } catch { resolve(null); } });
        });
        req.setTimeout(750, () => { req.destroy(); resolve(null); }); req.on("error", () => resolve(null)); req.end();
      });
    } catch { return null; }
  }

  private tryEmitModelRecoveryLoss(producerGeneration: string) {
    const now = Date.now();
    this.tryDispatchAnalytics({ kind: "checkpoint", domain: "model", producerNamespace: "agent_worker", producerId: "agent_runner", producerGeneration, sentAt: now, controlSequence: 1, finalSequence: null, committedSequence: 0, maxObservedAt: null, earliestOpenStartedAt: null, openExecutionCount: 0, openModelCount: 0, knownDrop: true, droppedSinceSequence: 1, outboxPending: 0, oldestPendingAt: null, lossEpoch: 1 });
  }

  private tryDispatchAnalytics(signal: AnalyticsSignal) {
    void fetch(`${this.params.apiOrigin}/api/analytics/internal/signal`, { method: "POST", headers: { "content-type": "application/json", "x-awb-agent-internal-token": this.params.internalToken }, body: JSON.stringify(signal), signal: AbortSignal.timeout(750) }).catch(() => undefined);
  }

  private async withLifecycleDirectory<T>(operation: (directory: Awaited<ReturnType<Awaited<ReturnType<typeof openSecureAnalyticsRoot>>["openDirectory"]>>) => Promise<T>) {
    let root: Awaited<ReturnType<typeof openSecureAnalyticsRoot>> | null = null;
    let directory: Awaited<ReturnType<Awaited<ReturnType<typeof openSecureAnalyticsRoot>>["openDirectory"]>> | null = null;
    try {
      root = await openSecureAnalyticsRoot(this.params.dataDir);
      directory = await root.openDirectory(["lifecycle-intents"]);
      return await operation(directory);
    } finally { await directory?.close().catch(() => undefined); await root?.close().catch(() => undefined); }
  }

  /** Lifecycle evidence is API-owned and published atomically through its FD. */
  private async writeLifecycleIntent(fileName: string, intent: WorkerLifecycleIntent) {
    await this.withLifecycleDirectory((directory) => directory.publishJson(path.basename(fileName), intent));
  }
  private async deleteLifecycleIntent(fileName: string) {
    await this.withLifecycleDirectory((directory) => directory.deleteFile(path.basename(fileName)));
  }

  private async persistAndDispatchWorkerLifecycle(event: "unexpected_exit" | "controlled_stop", lifecycle?: WorkerLifecycleCapture) {
    const signal = this.createWorkerEvent(event, null, lifecycle);
    const filePath = `${signal.eventId}.json`;
    const intent: WorkerLifecycleIntent = { version: 2, signal };
    try {
      // Persist the complete signed DTO first. Same-process retries replay this
      // exact eventId/fingerprint/sequence/observer generation.
      await this.writeLifecycleIntent(filePath, intent);
    } catch {
      this.params.logger.warn({ operation: "lifecycle_intent_persist", errorCode: "ANALYTICS_LIFECYCLE_INTENT_PERSIST_FAILED" }, "failed to persist Analytics worker lifecycle intent");
      this.tryDispatchAnalytics(signal);
      return;
    }
    await this.deliverLifecycleIntent(filePath, intent, LIFECYCLE_REPLAY_TIMEOUT_MS);
  }

  private parseLifecycleIntent(value: unknown): WorkerLifecycleIntent | null {
    const raw = value as { version?: unknown; signal?: unknown } | null;
    const signal = raw?.signal;
    if (!signal || typeof signal !== "object") return null;
    const candidate = signal as AnalyticsSignalEvent;
    if (candidate.kind !== "event" || candidate.domain !== "worker" || candidate.producerNamespace !== "worker_observer"
      || candidate.producerId !== "process_manager" || (candidate.eventType !== "worker_unexpected_exit" && candidate.eventType !== "worker_controlled_stop")) return null;
    // Version 2 is canonical at rest. Version 1 is replayed conservatively by
    // converting its historical observer target to an unknown-target v2 event.
    if (raw?.version === 2 && isCanonicalAnalyticsSignal(candidate)) return { version: 2, signal: candidate };
    if (raw?.version === 1) return { version: 2, signal: candidate };
    return null;
  }

  private lifecycleCaptureFromIntent(intent: WorkerLifecycleIntent): WorkerLifecycleCapture {
    const payload = intent.signal.payload as Record<string, unknown>;
    const targets = Array.isArray(payload.targets) ? payload.targets.filter((target): target is WorkerLifecycleTarget => Boolean(target) && typeof target === "object"
      && (["execution", "model", "worker"] as string[]).includes(String((target as Record<string, unknown>).domain))
      && (["agent_worker", "worker_observer"] as string[]).includes(String((target as Record<string, unknown>).producerNamespace))
      && typeof (target as Record<string, unknown>).producerId === "string" && typeof (target as Record<string, unknown>).producerGeneration === "string") : [];
    return { occurredAt: typeof payload.occurredAt === "number" ? payload.occurredAt : intent.signal.observedAt,
      targetIdentityQuality: targets.length >= 3 && payload.targetIdentityQuality === "exact" ? "exact" : "unknown",
      targets: targets.length ? targets : [{ domain: "worker", producerNamespace: "worker_observer", producerId: "process_manager", producerGeneration: intent.signal.producerGeneration }] };
  }

  /** One owner serializes direct delivery and timer/startup replay per intent. */
  private async deliverLifecycleIntent(filePath: string, intent: WorkerLifecycleIntent, timeoutMs: number) {
    filePath = path.basename(filePath);
    const existing = this.lifecycleDeliveryOwners.get(filePath);
    if (existing) return existing;
    const owner = (async () => {
      let deliver = intent;
      if (deliver.signal.producerGeneration !== this.analyticsGeneration || !isCanonicalAnalyticsSignal(deliver.signal)) {
        // API observer generations are process-scoped. Convert once, atomically
        // replace the durable intent, then retry that exact converted DTO.
        const event = deliver.signal.eventType === "worker_unexpected_exit" ? "unexpected_exit" : "controlled_stop";
        deliver = { version: 2, signal: this.createWorkerEvent(event, null, this.lifecycleCaptureFromIntent(deliver)) };
        try { await this.writeLifecycleIntent(filePath, deliver); }
        catch { this.params.logger.warn({ operation: "lifecycle_intent_replace", errorCode: "ANALYTICS_LIFECYCLE_INTENT_REPLACE_FAILED" }, "failed to atomically update Analytics lifecycle intent"); return false; }
      }
      if (!await this.dispatchAnalyticsForReceipt(deliver.signal, timeoutMs)) return false;
      await this.deleteLifecycleIntent(filePath).catch(() => undefined);
      return true;
    })().finally(() => { this.lifecycleDeliveryOwners.delete(filePath); });
    this.lifecycleDeliveryOwners.set(filePath, owner);
    return owner;
  }

  private async replayWorkerLifecycleIntents() {
    if (this.lifecycleReplayInFlight) return;
    this.lifecycleReplayInFlight = true;
    try {
      const names = await this.withLifecycleDirectory((directory) => directory.list());
      const deadline = Date.now() + LIFECYCLE_REPLAY_TIMEOUT_MS;
      for (const filePath of names.filter((name) => /^[A-Za-z0-9._:-]{1,160}\.json$/.test(name))) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        let intent: WorkerLifecycleIntent | null = null;
        try { intent = this.parseLifecycleIntent(JSON.parse(await this.withLifecycleDirectory((directory) => directory.readFile(filePath)))); }
        catch { /* retain malformed evidence for diagnosis rather than guessing */ }
        if (intent) await this.deliverLifecycleIntent(filePath, intent, remaining);
      }
    } catch {
      // An unsafe or unavailable intent capability degrades Analytics only;
      // worker startup and shutdown must remain available and external paths
      // must never be followed to "recover" durable evidence.
      this.params.logger.warn({ operation: "lifecycle_intent_replay", errorCode: "ANALYTICS_LIFECYCLE_INTENT_REPLAY_FAILED" }, "failed to replay Analytics worker lifecycle intents");
    } finally { this.lifecycleReplayInFlight = false; }
  }

  private async dispatchAnalyticsForReceipt(signal: AnalyticsSignalEvent, timeoutMs: number) {
    try {
      const response = await fetch(`${this.params.apiOrigin}/api/analytics/internal/signal`, { method: "POST", headers: { "content-type": "application/json", "x-awb-agent-internal-token": this.params.internalToken }, body: JSON.stringify(signal), signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
      const value = await response.json() as { accepted?: unknown; receipt?: { eventId?: unknown; fingerprint?: unknown } | null };
      return response.ok && value.accepted === true && value.receipt?.eventId === signal.eventId && value.receipt.fingerprint === signal.fingerprint;
    } catch {
      return false;
    }
  }

  /** This manager is the only process that invokes recovery after child exit. */
  private async recoverExitedWorkerOutboxes() {
    const root = await openSecureAnalyticsRoot(this.params.dataDir);
    let outboxes: Awaited<ReturnType<typeof root.openDirectory>> | null = null;
    try {
      outboxes = await root.openDirectory(["model-outbox", "agent_worker", "agent_runner"], false);
      const deadline = Date.now() + ANALYTICS_RECOVERY_TIMEOUT_MS;
      for (const generation of await outboxes.list()) {
        if (this.recoveringOutboxGenerations.has(generation)) continue;
        let directory: Awaited<ReturnType<typeof root.openDirectory>>;
        try { directory = await outboxes.openDirectory([generation], false); } catch { continue; }
        this.recoveringOutboxGenerations.add(generation);
        let lock: fs.FileHandle | null = null;
        try {
          lock = await fs.open(directory.path(".recovery.lock"), "wx", 0o600);
          for (const name of (await directory.list()).filter((item) => item.endsWith(".json"))) {
            let event: AnalyticsSignalEvent | null = null;
            try { event = parseRecoveredModelOutboxSignal(JSON.parse(await directory.readFile(name)), generation); } catch { event = null; }
            if (!event) { await withinAnalyticsRecoveryBudget(deadline, async () => await this.params.diagnoseOutboxCorrupt?.({ producerGeneration: generation }) ?? false); continue; }
            try {
              const outcome = await withinAnalyticsRecoveryBudget(deadline, async (signal) => {
                const response = await fetch(`${this.params.apiOrigin}/api/analytics/internal/signal`, { method: "POST", headers: { "content-type": "application/json", "x-awb-agent-internal-token": this.params.internalToken }, body: JSON.stringify(event), signal });
                return { ok: response.ok, result: await response.json().catch(() => null) as { accepted?: boolean; receipt?: { eventId?: string; fingerprint?: string } | null } | null };
              });
              if (outcome.ok && outcome.result?.accepted && outcome.result.receipt?.eventId === event.eventId && outcome.result.receipt.fingerprint === event.fingerprint) await directory.deleteFile(name);
            } catch { break; }
          }
        } catch { /* lock or malformed child directory: retain evidence */ }
        finally { await lock?.close().catch(() => undefined); if (lock) await directory.deleteFile(".recovery.lock").catch(() => undefined); await directory.close(); this.recoveringOutboxGenerations.delete(generation); }
      }
    } catch { /* no outbox root yet or it is unsafe */ }
    finally { await outboxes?.close().catch(() => undefined); await root.close().catch(() => undefined); }
  }

  private handleUnexpectedExit() {
    const now = Date.now();
    this.recentFailureTs.push(now);
    this.recentFailureTs = this.recentFailureTs.filter((ts) => now - ts <= 60_000);
    if (this.recentFailureTs.length >= 8) {
      this.params.logger.error(
        {
          failuresInWindow: this.recentFailureTs.length,
          windowMs: 60_000
        },
        "agent-worker restart paused by circuit breaker"
      );
      if (!this.restartTimer) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.recentFailureTs = [];
          this.scheduleRestart();
        }, 30_000);
      }
      return;
    }
    this.scheduleRestart();
  }

  private scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    this.activeRestartAttemptId = randomUUID();
    this.tryEmitWorkerEvent("restart_attempted", this.activeRestartAttemptId);
    const base = 500;
    const cap = 10_000;
    const jitter = Math.floor(Math.random() * 200);
    const delay = Math.min(cap, base * 2 ** this.restartAttempt) + jitter;
    this.restartAttempt += 1;

    this.params.logger.warn(
      {
        delayMs: delay,
        attempt: this.restartAttempt
      },
      "agent-worker restart scheduled"
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      void this.start().catch((err) => {
        this.params.logger.error({ err }, "agent-worker restart failed");
        this.tryEmitWorkerEvent("restart_failed", this.activeRestartAttemptId);
        this.handleUnexpectedExit();
      });
    }, delay);
  }

  private async waitUntilReady() {
    const origin = `http://${this.params.workerHost}:${this.params.workerPort}`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        if (this.params.socketPath) {
          const ok = await new Promise<boolean>((resolve) => {
            const req = httpRequest(
              {
                socketPath: this.params.socketPath,
                path: AgentWorkerEndpoints.health.path,
                method: AgentWorkerEndpoints.health.method,
                headers: {
                  "x-awb-agent-internal-token": this.params.internalToken
                }
              },
              (res) => {
                res.resume();
                resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
              }
            );
            req.setTimeout(1500, () => {
              req.destroy();
              resolve(false);
            });
            req.on("error", () => resolve(false));
            req.end();
          });
          if (ok) return;
        } else {
          const response = await fetch(`${origin}${AgentWorkerEndpoints.health.path}`, {
            method: AgentWorkerEndpoints.health.method,
            headers: {
              "x-awb-agent-internal-token": this.params.internalToken
            }
          });
          if (response.ok) return;
        }
      } catch {
        // wait
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error("agent-worker did not become ready in time");
  }
}
