import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import Fastify from "fastify";
import { readAnalyticsConfigSource } from "./analytics-config-source.js";
import { registerAnalyticsModule } from "./analytics.module.js";
import type { AnalyticsChildProcess } from "./analytics-supervisor.js";
import { createAgentTestFixture } from "../agent/testkit/agent-testkit.js";

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

class RecordingAnalyticsChild extends EventEmitter {
  connected = true;
  readonly configSignals: Array<Record<string, unknown>> = [];

  send(message: unknown, callback?: (error: Error | null) => void) {
    const envelope = message as {
      type?: string;
      requestId?: string;
      signal?: Record<string, unknown>;
    };
    if (envelope.type === "initialize" && envelope.requestId)
      queueMicrotask(() =>
        this.emit("message", { type: "ready", requestId: envelope.requestId }),
      );
    if (envelope.type === "signal" && envelope.requestId) {
      if (envelope.signal?.kind === "expected_slots_config")
        this.configSignals.push(envelope.signal);
      queueMicrotask(() =>
        this.emit("message", {
          type: "signal_result",
          requestId: envelope.requestId,
          result: { accepted: true, receipt: null },
        }),
      );
    }
    if (envelope.type === "shutdown") queueMicrotask(() => this.exit());
    callback?.(null);
    return true;
  }

  kill() {
    this.exit();
    return true;
  }

  exit() {
    if (!this.connected) return;
    this.connected = false;
    this.emit("exit", 1, null);
  }
}

async function waitForConfig(child: RecordingAnalyticsChild, count = 1) {
  const deadline = Date.now() + 1_000;
  while (child.configSignals.length < count && Date.now() < deadline)
    await sleep(5);
  assert.equal(child.configSignals.length >= count, true, "config replay missing");
}

test("each API startup allocates current mode once while replacements replay that same source", async (t) => {
  const fixture = await createAgentTestFixture({
    dataDirPrefix: "analytics-config-startup-",
  });
  t.after(() => fixture.dispose());

  const start = async (agentWorkerEnabled: boolean) => {
    const child = new RecordingAnalyticsChild();
    fixture.ctx.agentWorkerEnabled = agentWorkerEnabled;
    fixture.ctx.analytics = {
      enabled: true,
      workerFactory: () => child as unknown as AnalyticsChildProcess,
      startupTimeoutMs: 100,
      signalTimeoutMs: 100,
      restartLimit: 0,
    };
    const app = Fastify();
    await registerAnalyticsModule(app, fixture.ctx);
    await waitForConfig(child);
    const source = await readAnalyticsConfigSource(fixture.dataDir);
    assert.ok(source);
    await app.close();
    return { child, source };
  };

  const local = await start(false);
  assert.equal(local.source.sourceConfigVersion, 1);
  assert.equal(local.source.enabledFactDomains.includes("worker"), false);
  assert.deepEqual(local.source.slots.map((slot) => slot.domain), ["execution", "model"]);

  const worker = await start(true);
  assert.equal(worker.source.sourceConfigVersion, 2);
  assert.equal(worker.source.enabledFactDomains.includes("worker"), true);
  assert.deepEqual(worker.source.slots.map((slot) => slot.domain), ["worker", "execution", "model"]);

  const localAgain = await start(false);
  assert.equal(localAgain.source.sourceConfigVersion, 3);
  assert.equal(localAgain.source.enabledFactDomains.includes("worker"), false);
  assert.deepEqual(localAgain.source.slots.map((slot) => slot.domain), ["execution", "model"]);
});

test("replacement replays the startup source without allocating another version", async (t) => {
  const fixture = await createAgentTestFixture({
    dataDirPrefix: "analytics-config-replacement-",
  });
  t.after(() => fixture.dispose());
  const first = new RecordingAnalyticsChild();
  const replacement = new RecordingAnalyticsChild();
  let launched = 0;
  fixture.ctx.agentWorkerEnabled = true;
  fixture.ctx.analytics = {
    enabled: true,
    workerFactory: () => (launched++ === 0 ? first : replacement) as unknown as AnalyticsChildProcess,
    startupTimeoutMs: 100,
    signalTimeoutMs: 100,
    restartLimit: 1,
    restartDelayMs: 1,
  };
  const app = Fastify();
  await registerAnalyticsModule(app, fixture.ctx);
  t.after(() => app.close());
  await waitForConfig(first);
  const before = await readAnalyticsConfigSource(fixture.dataDir);
  assert.ok(before);
  first.exit();
  await waitForConfig(replacement);
  const after = await readAnalyticsConfigSource(fixture.dataDir);
  assert.deepEqual(after, before);
  assert.deepEqual(
    (({ sentAt: _sentAt, requestId: _requestId, ...source }) => source)(
      replacement.configSignals[0],
    ),
    (({ sentAt: _sentAt, requestId: _requestId, ...source }) => source)(
      first.configSignals[0],
    ),
  );
});
