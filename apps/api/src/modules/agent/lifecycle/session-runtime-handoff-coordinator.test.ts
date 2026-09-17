import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionRuntimeHandoffCoordinator } from "./session-runtime-handoff-coordinator.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((currentResolve) => {
    resolve = currentResolve;
  });
  return { promise, resolve };
}

test("SessionRuntimeHandoffCoordinator releases a key after thrown and rejected operations", async () => {
  const coordinator = new SessionRuntimeHandoffCoordinator();
  await assert.rejects(
    coordinator.runExclusive("session", async () => {
      throw new Error("expected throw");
    }),
    /expected throw/,
  );
  await assert.rejects(
    coordinator.runExclusive("session", async () => await Promise.reject(new Error("expected reject"))),
    /expected reject/,
  );
  assert.equal(await coordinator.runExclusive("session", async () => "available"), "available");
});

test("SessionRuntimeHandoffCoordinator canonicalizes opposing multi-lock order without deadlock", async () => {
  const coordinator = new SessionRuntimeHandoffCoordinator();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const secondEntered = deferred();
  const first = coordinator.runExclusiveMany(["session-b", "session-a"], async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
  });
  await firstEntered.promise;
  const second = coordinator.runExclusiveMany(["session-a", "session-b"], async () => {
    secondEntered.resolve();
  });
  await Promise.resolve();
  releaseFirst.resolve();
  await first;
  await secondEntered.promise;
  await second;
});

test("SessionRuntimeHandoffCoordinator deduplicates multi-lock IDs", async () => {
  const coordinator = new SessionRuntimeHandoffCoordinator();
  const entered = deferred();
  const release = deferred();
  const operation = coordinator.runExclusiveMany(["session", "session", "session"], async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let laterEntered = false;
  const later = coordinator.runExclusive("session", async () => {
    laterEntered = true;
  });
  await Promise.resolve();
  assert.equal(laterEntered, false);
  release.resolve();
  await operation;
  await later;
  assert.equal(laterEntered, true);
});

test("SessionRuntimeHandoffCoordinator releases every multi-lock after failure", async () => {
  const coordinator = new SessionRuntimeHandoffCoordinator();
  await assert.rejects(
    coordinator.runExclusiveMany(["session-a", "session-b"], async () => {
      throw new Error("expected multi-lock failure");
    }),
    /expected multi-lock failure/,
  );
  const entered: string[] = [];
  await Promise.all([
    coordinator.runExclusive("session-a", async () => {
      entered.push("a");
    }),
    coordinator.runExclusive("session-b", async () => {
      entered.push("b");
    }),
  ]);
  assert.deepEqual(new Set(entered), new Set(["a", "b"]));
});
