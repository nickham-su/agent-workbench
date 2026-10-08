import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyticsDbPath } from "../../infra/fs/paths.js";
import { LocalAnalyticsProducer } from "../agent/analytics-local-producer.js";
import { AnalyticsSupervisor } from "./analytics-supervisor.js";
import { analyticsFingerprint } from "./signal-store.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check()) && Date.now() < deadline) await sleep(20);
  assert.equal(await check(), true, message);
}

function control(domain: "execution" | "model", generation: string, kind: "register" | "checkpoint", at: number) {
  return { kind, domain, producerNamespace: "api_local_fallback" as const, producerId: "api_local_fallback", producerGeneration: generation, sentAt: at, controlSequence: at, finalSequence: null, committedSequence: 0, maxObservedAt: at, earliestOpenStartedAt: null, openExecutionCount: 0, openModelCount: 0, knownDrop: false, droppedSinceSequence: null, outboxPending: 0, oldestPendingAt: null, lossEpoch: 0 } as const;
}

test("durable local crash intent recovers through real supervisor child IPC and abandons only its old generation", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-local-recovery-child-"));
  const supervisor = new AnalyticsSupervisor({ dataDir, startupTimeoutMs: 5_000, queryTimeoutMs: 1_000, signalTimeoutMs: 1_000, restartLimit: 0, collectorEnabled: false });
  const server = createServer(async (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      const result = await supervisor.signal(JSON.parse(body));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  const apiOrigin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await supervisor.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  // This producer is intentionally never closed: its persisted intent models a crash.
  const old = new LocalAnalyticsProducer({ apiOrigin, internalToken: "test", dataDir });
  await old.start();
  const oldIntent = path.join(dataDir, "analytics", "local-fallback-intents", `${old.producerGeneration}.json`);
  await fs.access(oldIntent);

  const ready = new Promise<void>((resolve) => supervisor.onReady(() => resolve()));
  await supervisor.start();
  await ready;
  const source = {
    kind: "expected_slots_config" as const, sentAt: 1, requestId: "local-recovery-source", sourceConfigVersion: 1, effectiveAt: 1,
    enabledFactDomains: ["execution", "model"] as ("execution" | "model")[],
    slots: [
      { domain: "execution" as const, producerNamespace: "api_local_fallback" as const, producerId: "api_local_fallback" },
      { domain: "model" as const, producerNamespace: "api_local_fallback" as const, producerId: "api_local_fallback" },
    ],
  };
  assert.equal((await supervisor.signal(source)).accepted, true);
  for (const domain of ["execution", "model"] as const) {
    assert.equal((await supervisor.signal(control(domain, old.producerGeneration, "register", 10))).accepted, true);
    assert.equal((await supervisor.signal(control(domain, old.producerGeneration, "checkpoint", 11))).accepted, true);
  }
  const executionBase = { kind: "event" as const, domain: "execution" as const, producerNamespace: "api_local_fallback" as const, producerId: "api_local_fallback", producerGeneration: old.producerGeneration, sequence: 1, eventId: "old-local-execution", payloadVersion: 1 as const, eventType: "execution_started" as const, subjectIdentity: "execution:old-local", observedAt: 12, payload: { executionId: "old-local", runId: "old-run", runtimeKind: "api_local_fallback", runKind: "user", parentRunId: null, queuedAt: null, startedAt: 12, endedAt: null, endTimeQuality: "unknown" as const, endReason: null } };
  assert.equal((await supervisor.signal({ ...executionBase, fingerprint: analyticsFingerprint(executionBase) })).accepted, true);

  const current = new LocalAnalyticsProducer({ apiOrigin, internalToken: "test", dataDir, abandonPriorGeneration: (input) => supervisor.abandonLocalFallbackGeneration(input) });
  await current.start();
  const currentIntent = path.join(dataDir, "analytics", "local-fallback-intents", `${current.producerGeneration}.json`);
  await waitFor(async () => (await fs.stat(oldIntent).then(() => false, () => true)), "old local intent was not acknowledged and deleted");
  await waitFor(async () => {
    const reader = new Database(analyticsDbPath(dataDir), { readonly: true });
    try {
      const oldGenerations = reader.prepare("SELECT COUNT(*) AS count FROM analytics_producer_generation WHERE producer_generation=? AND lifecycle='abandoned'").get(old.producerGeneration) as { count: number };
      const gaps = reader.prepare("SELECT COUNT(*) AS count FROM analytics_signal_coverage_gap WHERE producer_generation=? AND domain IN ('execution','model') AND gap_to IS NULL").get(old.producerGeneration) as { count: number };
      const newGeneration = reader.prepare("SELECT COUNT(*) AS count FROM analytics_producer_generation WHERE producer_generation=? AND lifecycle='registered'").get(current.producerGeneration) as { count: number };
      return oldGenerations.count === 2 && gaps.count === 2 && newGeneration.count === 2;
    } finally { reader.close(); }
  }, "child did not persist old abandonment gaps and new generation registration");
  assert.notEqual(current.producerGeneration, old.producerGeneration);
  await fs.access(currentIntent);
  await current.close();
});
