import assert from "node:assert/strict";
import { test } from "node:test";
import { RunPromptStaticCache, RunPromptStaticCacheInvalidator } from "./run-prompt-static-cache.js";

test("RunPromptStaticCache preserves run key, Promise reuse, access expiry, and explicit invalidation", async () => {
  const cache = new RunPromptStaticCache<string>();
  let created = 0;
  const create = async () => `static-${++created}`;

  const first = cache.getOrCreate("run-a", 100, create);
  const firstEntry = cache.get("run-a");
  assert.ok(firstEntry);
  assert.equal(firstEntry.expiresAt, 100 + 30 * 60 * 1000);
  assert.equal(await first, "static-1");

  const reused = cache.getOrCreate("run-a", 200, create);
  const reusedEntry = cache.get("run-a");
  assert.ok(reusedEntry);
  assert.equal(reused, first, "a fresh run entry must reuse the exact Promise");
  assert.equal(reusedEntry.expiresAt, 200 + 30 * 60 * 1000, "cache access must renew expiry from access time");

  const otherRun = cache.getOrCreate("run-b", 200, create);
  assert.notEqual(otherRun, first, "cache entries remain isolated by runId");
  assert.equal(await otherRun, "static-2");

  const expired = cache.getOrCreate("run-a", 200 + 30 * 60 * 1000, create);
  assert.notEqual(expired, first, "an entry expires at its exact expiry boundary");
  assert.equal(await expired, "static-3");

  const invalidator = new RunPromptStaticCacheInvalidator({
    clearRunStaticPrompt: (runId) => cache.clear(runId)
  });
  invalidator.clear("run-a");
  assert.equal(cache.has("run-a"), false, "lifecycle invalidation clears only the requested run");
  assert.equal(cache.has("run-b"), true);
});
