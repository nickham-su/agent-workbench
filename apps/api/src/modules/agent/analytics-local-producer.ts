import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnalyticsControlSignal, AnalyticsSignal, AnalyticsSignalEvent } from "@agent-workbench/shared";
import { openSecureAnalyticsRoot } from "@agent-workbench/shared/node/analytics-root";

const canonicalJson = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]` : `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
const LOCAL_INTENT_VERSION = 1;
const CLOSE_TIMEOUT_MS = 750;

type LocalLifecycleIntent = {
  version: 1;
  producerGeneration: string;
  createdAt: number;
};

/**
 * API-local fallback producer. Its active generation is persisted before it
 * emits evidence, so an API crash has durable, supervisor-only abandonment
 * work rather than silently certifying an unknown tail on the next startup.
 */
export class LocalAnalyticsProducer {
  private readonly generation = randomUUID();
  private sequence = 0;
  private readonly controlSequences: Record<"execution" | "model", number> = { execution: 0, model: 0 };
  private timer: NodeJS.Timeout | null = null;
  private readonly openExecutions = new Map<string, number>();
  private readonly openModels = new Map<string, number>();
  private intentFile: string | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private enabled = true;
  private closed = false;
  constructor(private readonly options: {
    apiOrigin: string;
    internalToken: string;
    dataDir: string;
    abandonPriorGeneration?: (input: { producerGeneration: string; recordedAt?: number }) => Promise<boolean>;
    diagnoseOutboxCorrupt?: (input: { producerGeneration: string; recordedAt?: number }) => Promise<boolean>;
  }) {}

  get producerGeneration() { return this.generation; }

  async start() {
    if (this.closed) return;
    try { await this.persistActiveIntent(); }
    catch {
      // Analytics filesystem safety is never allowed to prevent local runs.
      // Without a durable intent this generation must emit no evidence.
      this.enabled = false;
      return;
    }
    void this.recoverPriorGenerations().catch(() => undefined);
    for (const domain of ["execution", "model"] as const) void this.send(this.control("register", domain));
    this.checkpoint();
    this.timer = setInterval(() => this.checkpoint(), 5_000);
    this.timer.unref();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    if (!this.enabled) return;
    this.checkpoint();
    const closed = await Promise.all(
      (["execution", "model"] as const).map(async (domain) => {
        const closing = await this.send(this.control("closing", domain), CLOSE_TIMEOUT_MS);
        const final = await this.send(this.control("closed", domain), CLOSE_TIMEOUT_MS);
        return closing && final;
      }),
    );
    // A missing or non-ACKed close is intentionally retained for restart-time
    // abandonment. Never infer a reliable close from a best-effort request.
    if (closed.every(Boolean)) await this.removeOwnIntent();
  }

  checkpoint() { if (this.enabled) for (const domain of ["execution", "model"] as const) void this.send(this.control("checkpoint", domain)); }
  emitExecution(payload: Extract<AnalyticsSignalEvent, { eventType: "execution_started" }> ["payload"], eventType: "execution_started"): void;
  emitExecution(payload: Extract<AnalyticsSignalEvent, { eventType: "execution_finished" }> ["payload"], eventType: "execution_finished"): void;
  emitExecution(payload: Record<string, unknown>, eventType: "execution_started" | "execution_finished") {
    if (!this.enabled) return;
    const subjectIdentity = `execution:${String(payload.executionId)}`;
    if (eventType === "execution_started") this.openExecutions.set(subjectIdentity, Number(payload.startedAt));
    else this.openExecutions.delete(subjectIdentity);
    const base = { kind: "event" as const, domain: "execution" as const, producerNamespace: "api_local_fallback" as const, producerId: "api_local_fallback", producerGeneration: this.generation, sequence: ++this.sequence, eventId: randomUUID(), payloadVersion: 1 as const, eventType, subjectIdentity, observedAt: Date.now(), payload };
    void this.send({ ...base, fingerprint: createHash("sha256").update(canonicalJson(base)).digest("hex") } as AnalyticsSignalEvent);
  }

  private control(kind: "register" | "checkpoint" | "closing" | "closed", domain: "execution" | "model"): AnalyticsControlSignal {
    const open = domain === "execution" ? this.openExecutions : this.openModels;
    const earliest = Math.min(...open.values());
    return { kind, domain, producerNamespace: "api_local_fallback", producerId: "api_local_fallback", producerGeneration: this.generation, sentAt: Date.now(), controlSequence: ++this.controlSequences[domain], finalSequence: kind === "closing" || kind === "closed" ? this.sequence : null, committedSequence: this.sequence, maxObservedAt: Date.now(), earliestOpenStartedAt: Number.isFinite(earliest) ? earliest : null, openExecutionCount: domain === "execution" ? open.size : 0, openModelCount: domain === "model" ? open.size : 0, knownDrop: false, droppedSinceSequence: null, outboxPending: 0, oldestPendingAt: null, lossEpoch: 0 };
  }

  private async persistActiveIntent() {
    let root: Awaited<ReturnType<typeof openSecureAnalyticsRoot>> | null = null;
    let directory: Awaited<ReturnType<Awaited<ReturnType<typeof openSecureAnalyticsRoot>>["openDirectory"]>> | null = null;
    try {
      root = await openSecureAnalyticsRoot(this.options.dataDir);
      directory = await root.openDirectory(["local-fallback-intents"]);
      const intent: LocalLifecycleIntent = { version: LOCAL_INTENT_VERSION, producerGeneration: this.generation, createdAt: Date.now() };
      await directory.publishJson(`${this.generation}.json`, intent);
      this.intentFile = `${this.generation}.json`;
    } finally {
      await directory?.close().catch(() => undefined);
      await root?.close().catch(() => undefined);
    }
  }

  private async removeOwnIntent() {
    if (!this.intentFile) return;
    let root: Awaited<ReturnType<typeof openSecureAnalyticsRoot>> | null = null;
    let directory: Awaited<ReturnType<Awaited<ReturnType<typeof openSecureAnalyticsRoot>>["openDirectory"]>> | null = null;
    try {
      root = await openSecureAnalyticsRoot(this.options.dataDir);
      directory = await root.openDirectory(["local-fallback-intents"], false);
      await directory.deleteFile(this.intentFile);
    } catch { /* retained intent is safer than an unsafe delete */ }
    finally { await directory?.close().catch(() => undefined); await root?.close().catch(() => undefined); }
  }

  private async recoverPriorGenerations() {
    if (this.closed) return;
    const abandon = this.options.abandonPriorGeneration;
    if (!abandon) return;
    let root: Awaited<ReturnType<typeof openSecureAnalyticsRoot>> | null = null;
    let directoryCapability: Awaited<ReturnType<Awaited<ReturnType<typeof openSecureAnalyticsRoot>>["openDirectory"]>> | null = null;
    let retry = false;
    try {
      root = await openSecureAnalyticsRoot(this.options.dataDir);
      directoryCapability = await root.openDirectory(["local-fallback-intents"]);
      const names = await directoryCapability.list().catch(() => []);
      for (const name of names.filter((value) => /^[0-9a-f-]{36}\.json$/i.test(value)).sort()) {
        let intent: LocalLifecycleIntent | null = null;
        try {
          const value: unknown = JSON.parse(await directoryCapability.readFile(name));
          if (value && typeof value === "object" && (value as { version?: unknown }).version === LOCAL_INTENT_VERSION && typeof (value as { producerGeneration?: unknown }).producerGeneration === "string") intent = value as LocalLifecycleIntent;
        } catch { continue; /* retain malformed evidence rather than guessing */ }
        if (!intent || intent.producerGeneration === this.generation) continue;
        try {
          if (await abandon({ producerGeneration: intent.producerGeneration, recordedAt: Date.now() })) await directoryCapability.deleteFile(name).catch(() => undefined);
          else retry = true;
        } catch { retry = true; }
      }
    } catch { retry = true; }
    finally {
      await directoryCapability?.close().catch(() => undefined);
      await root?.close().catch(() => undefined);
    }
    if (!this.closed && retry && !this.recoveryTimer) {
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = null;
        if (!this.closed) void this.recoverPriorGenerations().catch(() => undefined);
      }, 1_000);
      this.recoveryTimer.unref();
    }
  }

  private async send(signal: AnalyticsSignal | AnalyticsSignalEvent, timeoutMs = CLOSE_TIMEOUT_MS) {
    try {
      const response = await fetch(`${this.options.apiOrigin}/api/analytics/internal/signal`, { method: "POST", headers: { "content-type": "application/json", "x-awb-agent-internal-token": this.options.internalToken }, body: JSON.stringify(signal), signal: AbortSignal.timeout(timeoutMs) });
      const result = await response.json() as { accepted?: unknown; receipt?: { eventId?: unknown; fingerprint?: unknown } | null };
      if (!response.ok || result.accepted !== true) return false;
      return signal.kind !== "event" || (result.receipt?.eventId === signal.eventId && result.receipt.fingerprint === signal.fingerprint);
    } catch { return false; }
  }
}
