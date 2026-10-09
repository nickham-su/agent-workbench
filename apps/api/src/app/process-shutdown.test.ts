import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { installApiShutdownHooks } from "./process-shutdown.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("SIGINT and SIGTERM share in-flight shutdown, then owned handlers are removed", async () => {
  const signals = new EventEmitter() as EventEmitter & { exitCode?: number };
  let closes = 0;
  let release!: () => void;
  const closed = new Promise<void>((resolve) => { release = resolve; });
  const dispose = installApiShutdownHooks(async () => { closes++; await closed; }, () => assert.fail("unexpected close error"), signals as any);
  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  await flush();
  assert.equal(closes, 1);
  assert.equal(signals.listenerCount("SIGINT"), 1);
  assert.equal(signals.listenerCount("SIGTERM"), 1);
  release();
  await flush();
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.emit("SIGINT"), false);
  assert.equal(closes, 1);
  dispose();
  dispose();
});

test("failed shutdown reports once, sets exitCode and removes only its own handlers", async () => {
  const signals = new EventEmitter() as EventEmitter & { exitCode?: number };
  let externalCalls = 0;
  const external = () => { externalCalls++; };
  signals.on("SIGINT", external);
  signals.on("SIGTERM", external);
  let failures = 0;
  let rejectClose!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { rejectClose = reject; });
  const dispose = installApiShutdownHooks(() => pending, () => { failures++; }, signals as any);
  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  await flush();
  assert.equal(signals.listenerCount("SIGINT"), 2);
  rejectClose(new Error("close failed"));
  await flush();
  assert.equal(failures, 1);
  assert.equal(signals.exitCode, 1);
  assert.deepEqual(signals.listeners("SIGINT"), [external]);
  assert.deepEqual(signals.listeners("SIGTERM"), [external]);
  dispose();
  dispose();
  signals.emit("SIGTERM");
  await flush();
  assert.equal(failures, 1);
  assert.equal(externalCalls, 3);
  assert.deepEqual(signals.listeners("SIGTERM"), [external]);
});

for (const reporter of [
  () => { throw new Error("synchronous reporter failed"); },
  async () => { throw new Error("asynchronous reporter failed"); },
]) {
  test(`${reporter.constructor.name} failure reporting cannot leak an unhandled rejection`, async () => {
    const signals = new EventEmitter() as EventEmitter & { exitCode?: number };
    installApiShutdownHooks(async () => { throw new Error("close failed"); }, reporter, signals as any);
    signals.emit("SIGINT");
    await flush();
    assert.equal(signals.exitCode, 1);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  });
}

test("manual disposal is idempotent and preserves unrelated handlers before shutdown", async () => {
  const signals = new EventEmitter();
  const external = () => undefined;
  signals.on("SIGINT", external);
  let closes = 0;
  const dispose = installApiShutdownHooks(async () => { closes++; }, () => undefined, signals as any);
  dispose();
  dispose();
  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  await flush();
  assert.equal(closes, 0);
  assert.deepEqual(signals.listeners("SIGINT"), [external]);
  assert.deepEqual(signals.listeners("SIGTERM"), []);
});
