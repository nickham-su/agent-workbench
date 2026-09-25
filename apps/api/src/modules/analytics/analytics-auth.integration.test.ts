import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createSessionCookieValue, AUTH_COOKIE_NAME } from "../../infra/auth/sessionCookie.js";
import { createAgentTestFixture } from "../agent/testkit/agent-testkit.js";

const signalPath = "/api/analytics/internal/signal";
const dashboardPath = "/api/analytics/dashboard/query";

function assertUnauthorized(response: { statusCode: number; json(): unknown }) {
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { message: "Unauthorized" });
}

test("Analytics producers use internal-token auth without a web session", async (t) => {
  const webAuth = randomUUID();
  const fixture = await createAgentTestFixture({ withApp: true, authToken: webAuth, dataDirPrefix: "analytics-auth-" });
  t.after(() => fixture.dispose());
  const app = fixture.app!;
  const internalHeaders = { "x-awb-agent-internal-token": fixture.ctx.agentInternalToken };
  const webCookie = `${AUTH_COOKIE_NAME}=${createSessionCookieValue({ authToken: webAuth, nowMs: Date.now(), ttlMs: 60_000 })}`;

  // Analytics is disabled in this fixture. A 200 with the contract-valid rejection
  // proves that the request reached the handler instead of failing cookie auth.
  for (const url of [signalPath, `${signalPath}?source=worker`]) {
    const response = await app.inject({ method: "POST", url, headers: internalHeaders, payload: {} });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { accepted: false, receipt: null });
  }

  for (const headers of [
    {},
    { "x-awb-agent-internal-token": randomUUID() },
    { cookie: webCookie },
    { cookie: webCookie, "x-awb-agent-internal-token": randomUUID() },
  ]) {
    assertUnauthorized(await app.inject({ method: "POST", url: signalPath, headers, payload: {} }));
  }

  // The internal token never grants access to the user-facing Dashboard API.
  const dashboard = await app.inject({
    method: "POST", url: dashboardPath, headers: internalHeaders,
    payload: { rangeKind: "preset_7d", timezone: "UTC" },
  });
  assertUnauthorized(dashboard);
});

test("Analytics producer token remains required when web login is disabled", async (t) => {
  const fixture = await createAgentTestFixture({ withApp: true, dataDirPrefix: "analytics-internal-auth-" });
  t.after(() => fixture.dispose());
  const app = fixture.app!;

  assertUnauthorized(await app.inject({ method: "POST", url: signalPath, payload: {} }));
  const allowed = await app.inject({
    method: "POST", url: signalPath,
    headers: { "x-awb-agent-internal-token": fixture.ctx.agentInternalToken },
    payload: {},
  });
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.json(), { accepted: false, receipt: null });
});
