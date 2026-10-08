import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearSessionModelOpenIntent,
  consumeSessionModelOpenIntent,
  markSessionModelOpenIntentReady,
  migrateSessionModelOpenIntent,
  queueSessionModelOpenIntent,
  type SessionModelOpenIntentCache
} from "./agentSessionModelIntent";

test("draft model-modal intent migrates to the real Session and consumes exactly once", () => {
  const cache: SessionModelOpenIntentCache = {};
  queueSessionModelOpenIntent(cache, "draft_1", { agentId: "agent-a", requestId: 1 });

  migrateSessionModelOpenIntent(cache, "draft_1", "session-1");
  assert.equal(cache.draft_1, undefined);
  assert.deepEqual(cache["session-1"], { agentId: "agent-a", requestId: 1, ready: false });

  assert.equal(markSessionModelOpenIntentReady(cache, "session-1", 1), true);
  assert.deepEqual(consumeSessionModelOpenIntent(cache, "session-1", 1), {
    agentId: "agent-a",
    requestId: 1,
    ready: true
  });
  assert.equal(consumeSessionModelOpenIntent(cache, "session-1", 1), null);
});

test("only the latest duplicate click can make a Session intent ready", () => {
  const cache: SessionModelOpenIntentCache = {};
  queueSessionModelOpenIntent(cache, "session-1", { agentId: "agent-a", requestId: 1 });
  queueSessionModelOpenIntent(cache, "session-1", { agentId: "agent-a", requestId: 2 });

  assert.equal(markSessionModelOpenIntentReady(cache, "session-1", 1), false);
  assert.deepEqual(cache["session-1"], { agentId: "agent-a", requestId: 2, ready: false });
  assert.equal(markSessionModelOpenIntentReady(cache, "session-1", 2), true);
  assert.equal(consumeSessionModelOpenIntent(cache, "session-1", 1), null);
  assert.equal(consumeSessionModelOpenIntent(cache, "session-1", 2)?.agentId, "agent-a");
});

test("failed or stale draft requests cannot remove a newer real-Session intent", () => {
  const cache: SessionModelOpenIntentCache = {};
  queueSessionModelOpenIntent(cache, "draft_1", { agentId: "agent-a", requestId: 1 });
  migrateSessionModelOpenIntent(cache, "draft_1", "session-1");
  queueSessionModelOpenIntent(cache, "session-1", { agentId: "agent-b", requestId: 2 });

  assert.equal(clearSessionModelOpenIntent(cache, "draft_1", 1), false);
  assert.equal(clearSessionModelOpenIntent(cache, "session-1", 1), false);
  assert.deepEqual(cache["session-1"], { agentId: "agent-b", requestId: 2, ready: false });
});

test("draft migration never replaces a newer intent already registered on the real Session", () => {
  const cache: SessionModelOpenIntentCache = {};
  queueSessionModelOpenIntent(cache, "draft_1", { agentId: "agent-a", requestId: 1 });
  queueSessionModelOpenIntent(cache, "session-1", { agentId: "agent-b", requestId: 2 });

  migrateSessionModelOpenIntent(cache, "draft_1", "session-1");
  assert.equal(cache.draft_1, undefined);
  assert.deepEqual(cache["session-1"], { agentId: "agent-b", requestId: 2, ready: false });
});
