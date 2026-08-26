import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPreviewRuntime,
  getPreviewCookieName,
  getPreviewCookiePath,
  PREVIEW_BOOTSTRAP_TTL_MS,
  previewSecretsEqual
} from "./preview-runtime.js";

function createRuntime(options: { now?: number; tokens?: string[]; maxBootstraps?: number; maxSessions?: number } = {}) {
  let now = options.now ?? 1_000;
  const tokens = [...(options.tokens ?? [])];
  let timerCallback: (() => void) | null = null;
  let timerUnrefCalls = 0;
  let timerClearCalls = 0;
  const runtime = createPreviewRuntime({
    publicOrigin: "https://preview.example.test",
    sessionTtlMs: 3_600_000,
    maxBootstraps: options.maxBootstraps,
    maxSessions: options.maxSessions,
    nowMs: () => now,
    randomToken: () => tokens.shift() ?? `token-${tokens.length}`,
    setIntervalFn: (callback) => {
      timerCallback = callback;
      return { unref: () => { timerUnrefCalls += 1; } };
    },
    clearIntervalFn: () => { timerClearCalls += 1; }
  });
  return {
    runtime,
    setNow(value: number) { now = value; },
    runTimer() { timerCallback?.(); },
    get timerUnrefCalls() { return timerUnrefCalls; },
    get timerClearCalls() { return timerClearCalls; }
  };
}

test("bootstrap codes are single-use even when consumed concurrently", async () => {
  const fixture = createRuntime({ tokens: ["code"] });
  const issued = fixture.runtime.issueBootstrap({ workspaceId: "ws", entryPath: "index.html" });
  const results = await Promise.all(Array.from({ length: 8 }, async () => fixture.runtime.consumeBootstrap(issued.code)));

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results[0]?.code, "code");
  fixture.runtime.close();
});

test("bootstrap and session TTLs expire at their exact boundary without sliding session expiry", () => {
  const fixture = createRuntime({ tokens: ["code", "session", "secret"] });
  const bootstrap = fixture.runtime.issueBootstrap({ workspaceId: "ws", entryPath: "index.html" });
  fixture.setNow(1_000 + PREVIEW_BOOTSTRAP_TTL_MS - 1);
  assert.equal(fixture.runtime.consumeBootstrap(bootstrap.code)?.code, "code");

  const session = fixture.runtime.createSession({ workspaceId: "ws", entryPath: "index.html" });
  fixture.setNow(session.expiresAt - 1);
  assert.equal(fixture.runtime.authenticateSession({ sessionId: session.sessionId, cookieSecret: session.cookieSecret })?.expiresAt, session.expiresAt);
  assert.equal(fixture.runtime.getSessionState(session.sessionId), "active");
  fixture.setNow(session.expiresAt);
  assert.equal(fixture.runtime.getSessionState(session.sessionId), "expired");
  fixture.runTimer();
  assert.equal(fixture.runtime.getSessionState(session.sessionId), "expired");
  assert.equal(fixture.runtime.authenticateSession({ sessionId: session.sessionId, cookieSecret: session.cookieSecret }), null);
  assert.equal(fixture.runtime.getSessionState(session.sessionId), "expired");
  assert.equal(fixture.runtime.getSessionState("unknown"), "missing");
  fixture.runtime.close();
});

test("capacity cleanup removes expired records first and then evicts the oldest record", () => {
  const fixture = createRuntime({ tokens: ["old-code", "expired-code", "new-code", "old-session", "old-secret", "new-session", "new-secret"], maxBootstraps: 2, maxSessions: 1 });
  fixture.runtime.issueBootstrap({ workspaceId: "ws", entryPath: "old.html" });
  fixture.setNow(61_001);
  fixture.runtime.issueBootstrap({ workspaceId: "ws", entryPath: "expired.html" });
  fixture.setNow(61_002 + PREVIEW_BOOTSTRAP_TTL_MS);
  const newCode = fixture.runtime.issueBootstrap({ workspaceId: "ws", entryPath: "new.html" });
  assert.equal(fixture.runtime.consumeBootstrap("old-code"), null);
  assert.equal(fixture.runtime.consumeBootstrap("expired-code"), null);
  assert.equal(fixture.runtime.consumeBootstrap(newCode.code)?.entryPath, "new.html");

  fixture.setNow(100_000);
  const oldSession = fixture.runtime.createSession({ workspaceId: "ws", entryPath: "old.html" });
  fixture.setNow(100_001);
  const newSession = fixture.runtime.createSession({ workspaceId: "ws", entryPath: "new.html" });
  assert.equal(fixture.runtime.authenticateSession({ sessionId: oldSession.sessionId, cookieSecret: oldSession.cookieSecret }), null);
  assert.equal(fixture.runtime.authenticateSession({ sessionId: newSession.sessionId, cookieSecret: newSession.cookieSecret })?.entryPath, "new.html");
  fixture.runtime.close();
});

test("runtime unrefs its cleanup timer, cleanup expires records, and close is idempotent", () => {
  const fixture = createRuntime({ tokens: ["code"] });
  assert.equal(fixture.timerUnrefCalls, 1);
  const bootstrap = fixture.runtime.issueBootstrap({ workspaceId: "ws", entryPath: "index.html" });
  fixture.setNow(1_000 + PREVIEW_BOOTSTRAP_TTL_MS);
  fixture.runTimer();
  assert.equal(fixture.runtime.consumeBootstrap(bootstrap.code), null);
  assert.equal(fixture.runtime.getSessionState("unknown"), "missing");
  fixture.runtime.close();
  fixture.runtime.close();
  assert.equal(fixture.timerClearCalls, 1);
  assert.throws(() => fixture.runtime.issueBootstrap({ workspaceId: "ws", entryPath: "index.html" }), /runtime is closed/);
});

test("session cookie helpers and secret comparison have the required semantics", () => {
  const fixture = createRuntime({ tokens: ["session-id", "session-secret"] });
  const session = fixture.runtime.createSession({ workspaceId: "ws", entryPath: "nested/index.html" });
  assert.equal(session.cookieName, getPreviewCookieName("session-id"));
  assert.equal(session.cookiePath, getPreviewCookiePath("session-id"));
  assert.equal(session.redirectPath, "/s/session-id/nested/index.html");
  assert.equal(previewSecretsEqual("same", "same"), true);
  assert.equal(previewSecretsEqual("same", "different"), false);
  assert.equal(previewSecretsEqual("short", "longer"), false);
  assert.equal(fixture.runtime.authenticateSession({ sessionId: session.sessionId, cookieSecret: "wrong" }), null);
  assert.equal(fixture.runtime.authenticateSession({ sessionId: session.sessionId, cookieSecret: session.cookieSecret })?.workspaceId, "ws");
  fixture.runtime.close();
});
