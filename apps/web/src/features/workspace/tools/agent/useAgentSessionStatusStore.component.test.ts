import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, nextTick } from "vue";

/** Exercise the real Axios wrapper and store with explicitly completed requests. */
class StatusXMLHttpRequest {
  static requests: StatusXMLHttpRequest[] = [];
  static responder: (request: StatusXMLHttpRequest) => void = () => undefined;
  method = "";
  url = "";
  status = 0;
  statusText = "";
  responseText = "";
  responseURL = "";
  responseType = "";
  readyState = 0;
  timeout = 0;
  withCredentials = false;
  onloadend: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  upload = { addEventListener() {} };
  open(method: string, url: string) { this.method = method; this.url = this.responseURL = url; }
  setRequestHeader() {}
  getAllResponseHeaders() { return "content-type: application/json\r\n"; }
  addEventListener() {}
  send() { StatusXMLHttpRequest.requests.push(this); StatusXMLHttpRequest.responder(this); }
  abort() { this.onabort?.(); }
  respond(status: number, body: unknown) {
    this.status = status;
    this.statusText = status === 200 ? "OK" : "Request failed";
    this.responseText = JSON.stringify(body);
    queueMicrotask(() => this.onloadend?.());
  }
}
Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, writable: true, value: StatusXMLHttpRequest });
const { createAgentSessionStatusStore } = await import("./useAgentSessionStatusStore");

const prefix = "agent-workbench.workspace.agent.sessionIndicators.v1.";
function runState(workspaceId: string, status: "idle" | "running", updatedAt: number) {
  return { workspaceId, sessionId: "same-id", status, updatedAt, activeRunId: status === "running" ? "run" : null,
    runNoticeText: "", retryCount: 0, nextRetryAt: null, activeAssistantMessageId: null,
    nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [] };
}
async function settle() { await new Promise((resolve) => setImmediate(resolve)); await nextTick(); }
function fixture(holdSettings = false) {
  const requests: StatusXMLHttpRequest[] = [];
  const settings: StatusXMLHttpRequest[] = [];
  const saved = new Map<string, string>();
  const writes: string[] = [];
  let played = 0;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); writes.push(key); }
  } });
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: class {
    currentTime = 0; preload = "";
    play() { played += 1; return Promise.resolve(); }
    pause() {}
  } });
  StatusXMLHttpRequest.requests = [];
  StatusXMLHttpRequest.responder = (request) => {
    if (request.url.includes("/run-state")) requests.push(request);
    else if (request.url.includes("/settings/agent/runtime")) {
      settings.push(request);
      if (!holdSettings) request.respond(200, { sessionTerminalSoundEnabled: true });
    } else request.respond(200, {});
  };
  const scope = effectScope();
  const store = scope.run(createAgentSessionStatusStore)!;
  function bind(workspaceId: string) {
    store.bindWorkspace(workspaceId);
    store.syncSessions({ registeredSessionIds: ["same-id"], visibleSessionIds: ["same-id"], activeSessionId: null });
  }
  return { store, bind, requests, settings, saved, writes, played: () => played, cleanup() {
    store.dispose(); scope.stop();
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
    if (previousAudio) Object.defineProperty(globalThis, "Audio", previousAudio); else Reflect.deleteProperty(globalThis, "Audio");
  } };
}

for (const path of ["A-B", "A-B-A"] as const) {
  test(`StatusStore ${path}: old success cannot sound, persist, or clear the new same-ID request`, async () => {
    const f = fixture();
    try {
      f.saved.set(prefix + "a", JSON.stringify({ historical: { lastTerminalAt: 123, lastSeenTerminalAt: 100 } }));
      f.bind("a");
      const running = f.store.refreshSessionNow("same-id");
      f.requests[0]!.respond(200, runState("a", "running", 1)); await running;
      const old = f.store.refreshSessionNow("same-id");
      f.bind("b");
      if (path === "A-B-A") f.bind("a");
      const currentWorkspace = path === "A-B-A" ? "a" : "b";
      const fresh = f.store.refreshSessionNow("same-id");
      const entry = f.store.getEntry("same-id");
      const writes = f.writes.length;
      f.requests[1]!.respond(200, runState("a", "idle", 99)); await old;
      assert.equal(f.played(), 0);
      assert.equal(f.writes.length, writes);
      assert.equal(entry.inFlight, true, "old finally must not release the new slot");
      assert.equal(entry.fetchedAt, 0);
      f.requests[2]!.respond(200, runState(currentWorkspace, "running", 2)); await fresh;
      assert.equal(entry.inFlight, false);
      assert.equal(entry.runState.workspaceId, currentWorkspace);
      assert.deepEqual(JSON.parse(f.saved.get(prefix + "a")!).historical, { lastTerminalAt: 123, lastSeenTerminalAt: 100 });
    } finally { f.cleanup(); }
  });
}

for (const response of ["success", "failure"] as const) {
  test(`StatusStore dispose: late ${response} has no transition, retry, persistence or sound`, async () => {
    const f = fixture();
    try {
      f.bind("a");
      const first = f.store.refreshSessionNow("same-id");
      f.requests[0]!.respond(200, runState("a", "running", 1)); await first;
      const entry = f.store.getEntry("same-id");
      const pending = f.store.refreshSessionNow("same-id");
      const stamp = entry.fetchedAt;
      f.store.dispose();
      const writes = f.writes.length;
      f.requests[1]!.respond(response === "success" ? 200 : 500, response === "success" ? runState("a", "idle", 99) : {});
      await pending;
      assert.equal(f.played(), 0);
      assert.equal(f.writes.length, writes);
      assert.equal(entry.fetchedAt, stamp);
      assert.equal(entry.runState.status, "running");
      assert.equal(entry.errorRetryAt, null);
      const count = f.requests.length;
      await f.store.refreshSessionNow("same-id");
      assert.equal(f.requests.length, count, "disposed stores cannot restart reads");
    } finally { f.cleanup(); }
  });

  test(`StatusStore same-workspace entry replacement: late ${response} preserves the fresh slot`, async () => {
    const f = fixture();
    try {
      f.bind("a");
      const oldEntry = f.store.getEntry("same-id");
      const old = f.store.refreshSessionNow("same-id");
      f.store.syncSessions({ registeredSessionIds: [], visibleSessionIds: [], activeSessionId: null });
      f.store.syncSessions({ registeredSessionIds: ["same-id"], visibleSessionIds: ["same-id"], activeSessionId: null });
      const freshEntry = f.store.getEntry("same-id");
      assert.notEqual(freshEntry, oldEntry);
      const fresh = f.store.refreshSessionNow("same-id");
      f.requests[0]!.respond(response === "success" ? 200 : 500, response === "success" ? runState("a", "idle", 99) : {});
      await old;
      assert.equal(freshEntry.inFlight, true);
      assert.equal(freshEntry.errorRetryAt, null);
      assert.equal(freshEntry.fetchedAt, 0);
      assert.equal(f.played(), 0);
      f.requests[1]!.respond(200, runState("a", "running", 2)); await fresh;
      assert.equal(freshEntry.inFlight, false);
      assert.equal(freshEntry.runState.status, "running");
    } finally { f.cleanup(); }
  });
}

test("StatusStore old-workspace failure is silent and does not release the current request", async () => {
  const f = fixture();
  try {
    f.bind("a"); const old = f.store.refreshSessionNow("same-id");
    f.bind("b"); const fresh = f.store.refreshSessionNow("same-id");
    f.requests[0]!.respond(500, {}); await old;
    assert.equal(f.store.getEntry("same-id").inFlight, true);
    assert.equal(f.store.getEntry("same-id").errorRetryAt, null);
    f.requests[1]!.respond(200, runState("b", "idle", 3)); await fresh;
  } finally { f.cleanup(); }
});

test("StatusStore current background completion retains sound and unknown historical indicators", async () => {
  const f = fixture();
  try {
    f.saved.set(prefix + "a", JSON.stringify({ historical: { lastTerminalAt: 123, lastSeenTerminalAt: 100 } }));
    f.bind("a");
    const first = f.store.refreshSessionNow("same-id"); f.requests[0]!.respond(200, runState("a", "running", 1)); await first;
    const done = f.store.refreshSessionNow("same-id"); f.requests[1]!.respond(200, runState("a", "idle", 99)); await done;
    assert.equal(f.played(), 1);
    assert.equal(f.store.getEntry("same-id").lastTerminalAt, 99);
    assert.deepEqual(JSON.parse(f.saved.get(prefix + "a")!).historical, { lastTerminalAt: 123, lastSeenTerminalAt: 100 });
  } finally { f.cleanup(); }
});

test("StatusStore settings requests obey the same workspace generation and release only their own loading state", async () => {
  const f = fixture(true);
  try {
    f.bind("a"); f.bind("b");
    assert.equal(f.settings.length, 2, "new context is not blocked by the old settings request");
    f.settings[0]!.respond(200, { sessionTerminalSoundEnabled: false }); await settle();
    assert.equal(f.store.state.runtimeSettings.loading, true);
    assert.equal(f.store.state.runtimeSettings.loadedAt, 0);
    f.settings[1]!.respond(200, { sessionTerminalSoundEnabled: true }); await settle();
    assert.equal(f.store.state.runtimeSettings.loading, false);
    assert.equal(f.store.state.runtimeSettings.sessionTerminalSoundEnabled, true);
    const late = f.store.refreshRuntimeSettings(true);
    f.store.dispose();
    f.settings[2]!.respond(500, {}); await late;
    assert.equal(f.store.state.runtimeSettings.loading, true, "disposed response must not update the old UI state");
  } finally { f.cleanup(); }
});
