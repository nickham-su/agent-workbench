import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnalyticsControlSignal, AnalyticsGenerationControlSignal, AnalyticsSignal, AnalyticsSignalDomain, AnalyticsSignalEvent, AnalyticsSignalEventType } from "@agent-workbench/shared";
import { AnalyticsSignalResultSchema, AnalyticsSignalSchema } from "@agent-workbench/shared";
import { openSecureAnalyticsRoot } from "@agent-workbench/shared/node/analytics-root";
import { Value } from "@sinclair/typebox/value";

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

type ProducerOptions = { apiOrigin: string; internalToken: string; dataDir: string; namespace: "agent_worker" | "api_local_fallback"; producerId: string; checkpointMs?: number };

/**
 * Best-effort, bounded producer for execution/model slots.  It intentionally
 * never awaits Analytics transport from business code. Model records are
 * persisted before dispatch and only removed after an exact receipt ACK.
 */
export class AnalyticsSignalProducer {
  private sequence = 0;
  private readonly controlSequences: Record<"execution" | "model", number> = { execution: 0, model: 0 };
  private readonly generation = randomUUID();
  private inFlight = 0;
  private droppedSinceSequence: number | null = null;
  private lossEpoch = 0;
  private readonly maxPending = 256;
  private outboxDir: string;
  private readonly openExecutions = new Map<string, number>();
  private readonly openModels = new Map<string, number>();
  private readonly durablePending = new Map<string, number>();
  private checkpointTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly options: ProducerOptions) {
    this.outboxDir = path.join(options.dataDir, "analytics", "model-outbox", options.namespace, options.producerId, this.generation);
  }

  static async recoverModelOutbox(params: { directory: string; dispatch: (signal: AnalyticsSignalEvent) => Promise<boolean>; onLoss?: () => Promise<void> | void }) {
    const lockPath = path.join(params.directory, ".recovery.lock");
    let lock: fs.FileHandle | null = null;
    try {
      lock = await fs.open(lockPath, "wx", 0o600);
      const names = await fs.readdir(params.directory).catch(() => []);
      for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
        const filePath = path.join(params.directory, name);
        let event: unknown;
        try { event = JSON.parse(await fs.readFile(filePath, "utf8")); } catch { await params.onLoss?.(); continue; }
        if (!Value.Check(AnalyticsSignalSchema, event) || (event as { kind?: unknown }).kind !== "event" || (event as AnalyticsSignalEvent).domain !== "model") { await params.onLoss?.(); continue; }
        if (await params.dispatch(event as AnalyticsSignalEvent)) await fs.rm(filePath, { force: true }).catch(() => undefined);
      }
    } catch {
      // Another recovery owner, filesystem failure, or unavailable Analytics is isolated.
    } finally {
      await lock?.close().catch(() => undefined);
      if (lock) await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  get producerGeneration() { return this.generation; }

  start() {
    if (this.started) return;
    this.started = true;
    for (const domain of ["execution", "model"] as const) this.tryControl(this.control("register", domain));
    this.checkpoint();
    this.checkpointTimer = setInterval(() => this.checkpoint(), this.options.checkpointMs ?? 5_000);
    this.checkpointTimer.unref();
  }

  /** Bounded observability seam for orderly shutdown and deterministic tests. */
  async waitForIdle(timeoutMs = 1_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight > 0 && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    return this.inFlight === 0;
  }

  checkpoint() {
    const oldestPendingAt = Math.min(...this.durablePending.values());
    for (const domain of ["execution", "model"] as const) {
      const open = domain === "execution" ? this.openExecutions : this.openModels;
      const earliest = Math.min(...open.values());
      this.tryControl(this.control("checkpoint", domain, {
        maxObservedAt: Date.now(), earliestOpenStartedAt: Number.isFinite(earliest) ? earliest : null,
        openExecutionCount: domain === "execution" ? open.size : 0, openModelCount: domain === "model" ? open.size : 0,
        outboxPending: this.durablePending.size, oldestPendingAt: Number.isFinite(oldestPendingAt) ? oldestPendingAt : null
      }));
    }
  }

  async close() {
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
    this.checkpoint();
    await Promise.all((["execution", "model"] as const).map(async (domain) => {
      const closing = this.control("closing", domain, { finalSequence: this.sequence });
      const closed = this.control("closed", domain, { finalSequence: this.sequence });
      // Shutdown is still bounded and Analytics-only: an unavailable child can
      // lose these controls, but it cannot delay Worker termination forever.
      if (await this.dispatchControlForClose(closing)) await this.dispatchControlForClose(closed);
    }));
  }

  emitExecution(payload: Record<string, unknown>, type: "execution_started" | "execution_finished") {
    this.tryEvent("execution", type, `execution:${String(payload.executionId ?? payload.runId)}`, payload, false);
  }

  emitModel(payload: Record<string, unknown>, type: "model_invoked" | "model_finished", subjectIdentity = `model:${String(payload.modelCallId ?? randomUUID())}`) {
    this.tryEvent("model", type, subjectIdentity, payload, true);
  }

  private control(kind: AnalyticsGenerationControlSignal["kind"], domain: "execution" | "model", extra: Partial<AnalyticsGenerationControlSignal> = {}): AnalyticsGenerationControlSignal {
    return { kind, domain, producerNamespace: this.options.namespace, producerId: this.options.producerId, producerGeneration: this.generation,
      sentAt: Date.now(), controlSequence: ++this.controlSequences[domain], finalSequence: extra.finalSequence ?? null, committedSequence: this.sequence,
      maxObservedAt: extra.maxObservedAt ?? null, earliestOpenStartedAt: extra.earliestOpenStartedAt ?? null,
      openExecutionCount: extra.openExecutionCount ?? 0, openModelCount: extra.openModelCount ?? 0,
      knownDrop: this.droppedSinceSequence !== null, droppedSinceSequence: this.droppedSinceSequence,
      outboxPending: extra.outboxPending ?? this.durablePending.size, oldestPendingAt: extra.oldestPendingAt ?? null, lossEpoch: this.lossEpoch };
  }

  private tryEvent(domain: AnalyticsSignalDomain, eventType: AnalyticsSignalEventType, subjectIdentity: string, payload: Record<string, unknown>, durableModel: boolean) {
    if (eventType === "execution_started") this.openExecutions.set(subjectIdentity, Number(payload.startedAt));
    if (eventType === "execution_finished") this.openExecutions.delete(subjectIdentity);
    if (eventType === "model_invoked") this.openModels.set(subjectIdentity, Number(payload.startedAt));
    if (eventType === "model_finished") this.openModels.delete(subjectIdentity);
    if (this.inFlight >= this.maxPending) { this.recordLoss(this.sequence + 1); return; }
    const sequence = ++this.sequence;
    const base = { kind: "event" as const, domain, producerNamespace: this.options.namespace, producerId: this.options.producerId, producerGeneration: this.generation, sequence, eventId: randomUUID(), payloadVersion: 1 as const, eventType, subjectIdentity, observedAt: Date.now(), payload };
    const signal = { ...base, fingerprint: createHash("sha256").update(canonicalJson(base)).digest("hex") } as AnalyticsSignalEvent;
    this.inFlight += 1;
    if (durableModel) {
      void this.persistOutbox(signal).then((persisted) => persisted ? this.dispatch(signal, true) : (this.inFlight = Math.max(0, this.inFlight - 1)));
    } else this.dispatch(signal, false);
  }

  private recordLoss(sequence: number) { this.droppedSinceSequence ??= sequence; this.lossEpoch += 1; }
  private tryControl(signal: AnalyticsControlSignal) { this.dispatch(signal, false); }
  private async dispatchControlForClose(signal: AnalyticsControlSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const response = await fetch(`${this.options.apiOrigin}/api/analytics/internal/signal`, { method: "POST", headers: { "content-type": "application/json", "x-awb-agent-internal-token": this.options.internalToken }, body: JSON.stringify(signal), signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      return response.ok && Value.Check(AnalyticsSignalResultSchema, payload) && payload.accepted;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  private dispatch(signal: AnalyticsSignal, modelOutbox: boolean) {
    void fetch(`${this.options.apiOrigin}/api/analytics/internal/signal`, { method: "POST", headers: { "content-type": "application/json", "x-awb-agent-internal-token": this.options.internalToken }, body: JSON.stringify(signal), signal: AbortSignal.timeout(750) })
      .then(async (response) => {
        if (!response.ok || signal.kind !== "event") return;
        const payload: unknown = await response.json().catch(() => null);
        if (!Value.Check(AnalyticsSignalResultSchema, payload) || !payload.accepted || payload.receipt?.eventId !== signal.eventId || payload.receipt.fingerprint !== signal.fingerprint) return;
        if (modelOutbox) { await this.removeOutbox(signal); this.durablePending.delete(signal.eventId); }
      }).catch(() => undefined).finally(() => { if (signal.kind === "event") this.inFlight = Math.max(0, this.inFlight - 1); });
  }

  private outboxPath(signal: AnalyticsSignalEvent) { return path.join(this.outboxDir, `${signal.sequence}-${signal.eventId}.json`); }
  private async removeOutbox(signal: AnalyticsSignalEvent) {
    let root: Awaited<ReturnType<typeof openSecureAnalyticsRoot>> | null = null;
    let directory: Awaited<ReturnType<Awaited<ReturnType<typeof openSecureAnalyticsRoot>>["openDirectory"]>> | null = null;
    try {
      root = await openSecureAnalyticsRoot(this.options.dataDir);
      directory = await root.openDirectory(["model-outbox", this.options.namespace, this.options.producerId, this.generation], false);
      await directory.deleteFile(`${signal.sequence}-${signal.eventId}.json`).catch(() => undefined);
    } catch { /* durable cleanup is best effort */ }
    finally { await directory?.close().catch(() => undefined); await root?.close().catch(() => undefined); }
  }
  private async persistOutbox(signal: AnalyticsSignalEvent) {
    let root: Awaited<ReturnType<typeof openSecureAnalyticsRoot>> | null = null;
    let directory: Awaited<ReturnType<Awaited<ReturnType<typeof openSecureAnalyticsRoot>>["openDirectory"]>> | null = null;
    try {
      root = await openSecureAnalyticsRoot(this.options.dataDir);
      directory = await root.openDirectory(
        ["model-outbox", this.options.namespace, this.options.producerId, this.generation],
      );
      this.outboxDir = directory.fdPath;
      await directory.writeExclusiveFile(`${signal.sequence}-${signal.eventId}.json`, JSON.stringify(signal));
      this.durablePending.set(signal.eventId, Date.now());
      return true;
    } catch { this.recordLoss(signal.sequence); return false; }
    finally { await directory?.close().catch(() => undefined); await root?.close().catch(() => undefined); }
  }
}
