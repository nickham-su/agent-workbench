import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import {
  allocateAnalyticsConfigSource,
  readAnalyticsConfigSource,
} from "./analytics-config-source.js";
import { registerAnalyticsRoutes } from "./analytics.routes.js";
import { AnalyticsSupervisor } from "./analytics-supervisor.js";

const CONFIG_REPLAY_ATTEMPTS = 3;
const CONFIG_REPLAY_DELAY_MS = 25;

export async function registerAnalyticsModule(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const runtime = ctx.analytics;
  const supervisor = runtime?.enabled
    ? new AnalyticsSupervisor({
        dataDir: ctx.dataDir,
        workerFactory: runtime.workerFactory,
        startupTimeoutMs: runtime.startupTimeoutMs,
        queryTimeoutMs: runtime.queryTimeoutMs,
        signalTimeoutMs: runtime.signalTimeoutMs,
        shutdownTimeoutMs: runtime.shutdownTimeoutMs,
        restartLimit: runtime.restartLimit,
        restartDelayMs: runtime.restartDelayMs,
        collectorEnabled: runtime.collectorEnabled,
        collectorIntervalMs: runtime.collectorIntervalMs,
        collectorBatchSize: runtime.collectorBatchSize,
      })
    : null;

  await registerAnalyticsRoutes(app, ctx, supervisor);
  if (supervisor)
    ctx.analyticsDiagnostics = {
      outboxCorrupt: (input) => supervisor.diagnoseOutboxCorrupt(input),
      abandonLocalFallbackGeneration: (input) => supervisor.abandonLocalFallbackGeneration(input),
    };
  if (!supervisor) return;

  const slots = ctx.agentWorkerEnabled
    ? [
        {
          domain: "worker" as const,
          producerNamespace: "worker_observer" as const,
          producerId: "process_manager",
        },
        {
          domain: "execution" as const,
          producerNamespace: "agent_worker" as const,
          producerId: "agent_runner",
        },
        {
          domain: "model" as const,
          producerNamespace: "agent_worker" as const,
          producerId: "agent_runner",
        },
      ]
    : [
        {
          domain: "execution" as const,
          producerNamespace: "api_local_fallback" as const,
          producerId: "api_local_fallback",
        },
        {
          domain: "model" as const,
          producerNamespace: "api_local_fallback" as const,
          producerId: "api_local_fallback",
        },
      ];
  const sourceInput = {
    enabledFactDomains: [
      "run" as const,
      "session" as const,
      "message" as const,
      "tool" as const,
      "execution" as const,
      "model" as const,
      "git" as const,
      ...(ctx.agentWorkerEnabled ? ["worker" as const] : []),
    ],
    slots,
  };
  const replayCurrentSource = async (
    startupSource: NonNullable<Awaited<ReturnType<typeof allocateAnalyticsConfigSource>>>,
  ) => {
    const source = await readAnalyticsConfigSource(ctx.dataDir);
    if (
      !source ||
      source.sourceConfigVersion !== startupSource.sourceConfigVersion ||
      source.effectiveAt !== startupSource.effectiveAt
    ) throw new Error("Analytics source bootstrap unavailable");
    for (let attempt = 0; attempt < CONFIG_REPLAY_ATTEMPTS; attempt += 1) {
      const result = await supervisor.signal({
        kind: "expected_slots_config",
        sentAt: Date.now(),
        requestId: randomUUID().replaceAll("-", ""),
        ...source,
      });
      if (result.accepted) return;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, CONFIG_REPLAY_DELAY_MS),
      );
    }
    throw new Error("Analytics source bootstrap rejected");
  };

  let closed = false;
  let unsubscribe: (() => void) | undefined;
  app.addHook("onClose", async () => {
    closed = true;
    unsubscribe?.();
    ctx.analyticsDiagnostics = undefined;
    await supervisor.close();
  });
  // Each API process start compares its current producer mode with the durable
  // source. Replacements only replay this result; they never allocate again.
  void (async () => {
    const startupSource = await allocateAnalyticsConfigSource(
      ctx.dataDir,
      sourceInput,
    );
    if (closed || !startupSource) return;
    unsubscribe = supervisor.onReady(() => replayCurrentSource(startupSource));
    // A null durable source means Analytics cannot establish its bootstrap
    // contract. Do not start a child that can only serve uncertified data.
    void supervisor.start().catch(() => undefined);
  })();
}
