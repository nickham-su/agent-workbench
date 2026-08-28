import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeSessionModelOpenIntent, type SessionModelOpenIntentCache } from "./agentSessionModelIntent";
import { requestSessionModelOpen } from "./agentSessionModelOpenFlow";

test("parent model-open flow loads an existing Session before its Pane may consume the intent", async () => {
  const intents: SessionModelOpenIntentCache = {};
  const loads: string[] = [];
  const result = await requestSessionModelOpen({
    intents,
    sourceSessionId: "session-1",
    agentId: "agent-a",
    requestId: 1,
    isPrimaryServerSessionId: (id) => id === "session-1",
    ensureSessionCreated: async () => assert.fail("existing Session must not be created"),
    loadSessionModelStates: async (id) => { loads.push(id); }
  });

  assert.deepEqual(result, { sessionId: "session-1", ready: true });
  assert.deepEqual(loads, ["session-1"]);
  assert.equal(consumeSessionModelOpenIntent(intents, "session-1", 1)?.agentId, "agent-a");
});

test("parent model-open flow converts a draft once and only loads the returned real Session ID", async () => {
  const intents: SessionModelOpenIntentCache = {};
  const loads: string[] = [];
  let creates = 0;
  const result = await requestSessionModelOpen({
    intents,
    sourceSessionId: "draft_1",
    agentId: "agent-a",
    requestId: 1,
    isPrimaryServerSessionId: () => false,
    ensureSessionCreated: async (id) => {
      creates += 1;
      assert.equal(id, "draft_1");
      return "session-1";
    },
    loadSessionModelStates: async (id) => { loads.push(id); }
  });

  assert.deepEqual(result, { sessionId: "session-1", ready: true });
  assert.equal(creates, 1);
  assert.deepEqual(loads, ["session-1"]);
  assert.equal(intents.draft_1, undefined);
  assert.equal(consumeSessionModelOpenIntent(intents, "session-1", 1)?.agentId, "agent-a");
});

test("failed creation or state loading clears its intent and leaves no modal to consume", async () => {
  const intents: SessionModelOpenIntentCache = {};
  await assert.rejects(
    requestSessionModelOpen({
      intents,
      sourceSessionId: "draft_1",
      agentId: "agent-a",
      requestId: 1,
      isPrimaryServerSessionId: () => false,
      ensureSessionCreated: async () => { throw new Error("create failed"); },
      loadSessionModelStates: async () => assert.fail("load must not run after failed creation")
    }),
    /create failed/
  );
  assert.equal(intents.draft_1, undefined);
  assert.equal(intents["session-1"], undefined);
});

test("a stale async request cannot make the latest intent ready or consume it", async () => {
  const intents: SessionModelOpenIntentCache = {};
  let releaseFirstLoad!: () => void;
  const firstLoad = new Promise<void>((resolve) => { releaseFirstLoad = resolve; });
  const first = requestSessionModelOpen({
    intents,
    sourceSessionId: "session-1",
    agentId: "agent-a",
    requestId: 1,
    isPrimaryServerSessionId: () => true,
    ensureSessionCreated: async () => assert.fail("not called"),
    loadSessionModelStates: async () => firstLoad
  });
  const second = requestSessionModelOpen({
    intents,
    sourceSessionId: "session-1",
    agentId: "agent-a",
    requestId: 2,
    isPrimaryServerSessionId: () => true,
    ensureSessionCreated: async () => assert.fail("not called"),
    loadSessionModelStates: async () => undefined
  });

  assert.deepEqual(await second, { sessionId: "session-1", ready: true });
  releaseFirstLoad();
  assert.deepEqual(await first, { sessionId: "session-1", ready: false });
  assert.equal(consumeSessionModelOpenIntent(intents, "session-1", 1), null);
  assert.equal(consumeSessionModelOpenIntent(intents, "session-1", 2)?.requestId, 2);
});
