import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import {
  AUTH_COOKIE_NAME,
  AUTH_REMEMBER_RENEW_THRESHOLD_MS,
  AUTH_REMEMBER_TTL_MS,
  AUTH_SESSION_RENEW_THRESHOLD_MS,
  AUTH_SESSION_TTL_MS,
  createSessionCookieValue,
  parseCookieHeader,
  readSessionCookiePayload,
  verifySessionCookieValue
} from "../infra/auth/sessionCookie.js";
import { createAgentTestFixture } from "../modules/agent/testkit/agent-testkit.js";
import { registerAuthGuards } from "./auth.js";
import { isHttpError } from "./errors.js";

const now = 1_800_000_000_000;
const policies = [
  { label: "ordinary", ttlMs: AUTH_SESSION_TTL_MS, thresholdMs: AUTH_SESSION_RENEW_THRESHOLD_MS, remembered: false },
  { label: "remembered", ttlMs: AUTH_REMEMBER_TTL_MS, thresholdMs: AUTH_REMEMBER_RENEW_THRESHOLD_MS, remembered: true }
];

async function createAuthApp(t: TestContext, options: { authToken?: string | null; secure?: boolean; clock?: () => number } = {}) {
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  const ctx = {
    authToken: options.authToken === undefined ? randomUUID() : options.authToken,
    authCookieSecure: options.secure ?? false,
    agentInternalToken: randomUUID()
  };
  await registerAuthGuards(app, ctx, { clock: options.clock ?? (() => now) });
  app.setErrorHandler((err, _req, reply) => {
    if (isHttpError(err)) return reply.code(err.statusCode).send({ message: err.message, code: err.code });
    if (err instanceof Error && "statusCode" in err && typeof err.statusCode === "number" && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ message: err.message });
    }
    return reply.code(500).send({ message: "Internal Server Error" });
  });
  app.get("/api/business", async () => ({ ok: true }));
  for (const status of [400, 403, 404, 500]) {
    app.get(`/api/business-error/${status}`, async (_req, reply) => reply.code(status).send({ message: `business ${status}` }));
  }
  for (const path of ["/api/health", "/api/auth/login", "/api/internal/probe", "/api/analytics/internal/signal",
    "/api/terminals/test/ws", "/static", "/outside-api"]) {
    app.get(path, async () => ({ ok: true }));
  }
  app.get("/api/upgrade", async (_req, reply) => reply.code(101).send());
  app.get("/api/other-cookie", async (_req, reply) => reply.header("set-cookie", "other=1; Path=/").send({ ok: true }));
  app.get("/api/raw-other-cookie", async (_req, reply) => {
    reply.raw.setHeader("set-cookie", "other=1; Path=/");
    return reply.send({ ok: true });
  });
  app.get("/api/raw-same-cookie", async (_req, reply) => {
    reply.raw.setHeader("set-cookie", `${AUTH_COOKIE_NAME}=business; Path=/`);
    return reply.send({ ok: true });
  });
  app.get("/api/multiple-cookies", async (_req, reply) => reply.header("set-cookie", ["other=1; Path=/", "third=2; Path=/"]).send({ ok: true }));
  app.get("/api/same-cookie", async (_req, reply) => reply.header("set-cookie", ["other=1; Path=/", `${AUTH_COOKIE_NAME}=business; Path=/`]).send({ ok: true }));
  app.get("/api/single-same-cookie", async (_req, reply) => reply.header("set-cookie", `${AUTH_COOKIE_NAME}=business; Path=/`).send({ ok: true }));
  app.get("/api/events", async (_req, reply) => reply.type("text/event-stream").send(Readable.from(["data: first\n\n", "data: second\n\n"])));
  return { app, ctx };
}

function cookieHeader(authToken: string, ttlMs: number, remainingMs: number, currentTime = now) {
  return `${AUTH_COOKIE_NAME}=${createSessionCookieValue({ authToken, nowMs: currentTime - ttlMs + remainingMs, ttlMs })}`;
}

function responseCookies(headers: { "set-cookie"?: string | string[] }) {
  const value = headers["set-cookie"];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function assertRenewal(header: string, authToken: string, ttlMs: number, secure: boolean, currentTime = now) {
  const attributes = header.split(";").slice(1).map((part) => part.trim());
  assert.ok(attributes.includes("Path=/"));
  assert.ok(attributes.includes("HttpOnly"));
  assert.ok(attributes.includes("SameSite=Lax"));
  assert.equal(attributes.includes("Secure"), secure);
  assert.equal(attributes.includes("Max-Age=2592000"), ttlMs === AUTH_REMEMBER_TTL_MS);
  assert.equal(attributes.some((part) => part.startsWith("Max-Age=")), ttlMs === AUTH_REMEMBER_TTL_MS);
  assert.equal(attributes.some((part) => /^(Domain|Expires)=/i.test(part)), false);
  const value = parseCookieHeader(header)[AUTH_COOKIE_NAME];
  assert.equal(verifySessionCookieValue({ authToken, value, nowMs: currentTime }), true);
  assert.deepEqual(readSessionCookiePayload({ authToken, value, nowMs: currentTime }), { iat: currentTime, exp: currentTime + ttlMs });
}

for (const policy of policies) {
  test(`ordinary guard handles the ${policy.label} threshold and expiry at exact millisecond boundaries`, async (t) => {
    const { app, ctx } = await createAuthApp(t);
    for (const deltaMs of [1, 0, -1]) {
      const response = await app.inject({ method: "GET", url: "/api/business", headers: {
        cookie: cookieHeader(ctx.authToken!, policy.ttlMs, policy.thresholdMs + deltaMs)
      } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { ok: true });
      const cookies = responseCookies(response.headers);
      assert.equal(cookies.length, deltaMs > 0 ? 0 : 1);
      if (cookies.length) assertRenewal(cookies[0], ctx.authToken!, policy.ttlMs, false);
    }
    for (const remainingMs of [0, -1]) {
      const response = await app.inject({ method: "GET", url: "/api/business", headers: {
        cookie: cookieHeader(ctx.authToken!, policy.ttlMs, remainingMs)
      } });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { message: "Unauthorized" });
      assert.deepEqual(responseCookies(response.headers), []);
    }
  });
}

test("renewal preserves Secure and ordinary/remembered browser persistence independently", async (t) => {
  for (const secure of [false, true]) {
    const { app, ctx } = await createAuthApp(t, { secure });
    for (const policy of policies) {
      const response = await app.inject({ method: "GET", url: "/api/business", headers: {
        cookie: cookieHeader(ctx.authToken!, policy.ttlMs, policy.thresholdMs)
      } });
      const cookies = responseCookies(response.headers);
      assert.equal(response.statusCode, 200);
      assert.equal(cookies.length, 1);
      assertRenewal(cookies[0], ctx.authToken!, policy.ttlMs, secure);
    }
  }
});

test("valid custom TTLs authenticate without renewal; invalid signatures and missing cookies do not renew", async (t) => {
  const { app, ctx } = await createAuthApp(t);
  for (const ttlMs of [60_000, AUTH_SESSION_TTL_MS - 1, AUTH_REMEMBER_TTL_MS + 1]) {
    const response = await app.inject({ method: "GET", url: "/api/business", headers: { cookie: cookieHeader(ctx.authToken!, ttlMs, 1) } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(responseCookies(response.headers), []);
  }
  for (const headers of [{}, { cookie: cookieHeader(randomUUID(), AUTH_SESSION_TTL_MS, 1) }]) {
    const response = await app.inject({ method: "GET", url: "/api/business", headers });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(responseCookies(response.headers), []);
  }
});

test("authenticated business errors, unknown routes and validation failures renew without changing their result", async (t) => {
  const { app, ctx } = await createAuthApp(t);
  app.get("/api/validate", { schema: { querystring: { type: "object", required: ["required"], properties: { required: { type: "string" } } } } },
    async () => ({ ok: true }));
  app.get("/api/throw", async () => { throw new Error("test-only business failure"); });
  const headers = { cookie: cookieHeader(ctx.authToken!, AUTH_SESSION_TTL_MS, AUTH_SESSION_RENEW_THRESHOLD_MS) };
  for (const status of [400, 403, 404, 500]) {
    const response = await app.inject({ method: "GET", url: `/api/business-error/${status}`, headers });
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.json(), { message: `business ${status}` });
    assertRenewal(responseCookies(response.headers)[0], ctx.authToken!, AUTH_SESSION_TTL_MS, false);
  }
  for (const url of ["/api/not-found", "/api/throw", "/api/validate"]) {
    const response = await app.inject({ method: "GET", url, headers });
    assert.equal(response.statusCode, url === "/api/not-found" ? 404 : url === "/api/validate" ? 400 : 500);
    assertRenewal(responseCookies(response.headers)[0], ctx.authToken!, AUTH_SESSION_TTL_MS, false);
  }
});

test("health, login, internal token routes, terminal upgrades, non-API and 101 responses never receive ordinary renewal", async (t) => {
  const { app, ctx } = await createAuthApp(t);
  const headers = {
    cookie: cookieHeader(ctx.authToken!, AUTH_SESSION_TTL_MS, AUTH_SESSION_RENEW_THRESHOLD_MS),
    "x-awb-agent-internal-token": ctx.agentInternalToken
  };
  for (const url of ["/api/health?probe=1", "/api/auth/login", "/api/internal/probe", "/api/analytics/internal/signal?producer=test",
    "/api/terminals/test/ws", "/static", "/outside-api"]) {
    const response = await app.inject({ method: "GET", url, headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(responseCookies(response.headers), []);
  }
  const upgrade = await app.inject({ method: "GET", url: "/api/upgrade", headers });
  assert.equal(upgrade.statusCode, 101);
  assert.deepEqual(responseCookies(upgrade.headers), []);
  const upgradeHeader = await app.inject({ method: "GET", url: "/api/business", headers: { ...headers, upgrade: "websocket" } });
  assert.equal(upgradeHeader.statusCode, 200);
  assert.deepEqual(responseCookies(upgradeHeader.headers), []);
  for (const url of ["/api/internal/probe", "/api/analytics/internal/signal"]) {
    const denied = await app.inject({ method: "GET", url, headers: { cookie: headers.cookie } });
    assert.equal(denied.statusCode, 401);
    assert.deepEqual(responseCookies(denied.headers), []);
  }
});

test("disabled web authentication has no candidates and does not disable internal authentication", async (t) => {
  const { app } = await createAuthApp(t, { authToken: null });
  for (const headers of [{}, { cookie: cookieHeader(randomUUID(), AUTH_SESSION_TTL_MS, 1) }]) {
    const response = await app.inject({ method: "GET", url: "/api/business", headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(responseCookies(response.headers), []);
  }
  const denied = await app.inject({ method: "GET", url: "/api/internal/probe" });
  assert.equal(denied.statusCode, 401);
  assert.deepEqual(responseCookies(denied.headers), []);
});

test("onSend preserves other Set-Cookies and gives an explicit business session Cookie precedence", async (t) => {
  const { app, ctx } = await createAuthApp(t);
  const headers = { cookie: cookieHeader(ctx.authToken!, AUTH_SESSION_TTL_MS, AUTH_SESSION_RENEW_THRESHOLD_MS) };
  for (const [url, otherCount] of [["/api/other-cookie", 1], ["/api/raw-other-cookie", 1], ["/api/multiple-cookies", 2]] as const) {
    const response = await app.inject({ method: "GET", url, headers });
    const cookies = responseCookies(response.headers);
    assert.equal(response.statusCode, 200);
    assert.equal(cookies.length, otherCount + 1);
    assert.equal(cookies[0], "other=1; Path=/");
    if (otherCount === 2) assert.equal(cookies[1], "third=2; Path=/");
    assertRenewal(cookies[otherCount], ctx.authToken!, AUTH_SESSION_TTL_MS, false);
  }
  for (const [url, expected] of [["/api/same-cookie", ["other=1; Path=/", `${AUTH_COOKIE_NAME}=business; Path=/`]],
    ["/api/single-same-cookie", [`${AUTH_COOKIE_NAME}=business; Path=/`]],
    ["/api/raw-same-cookie", [`${AUTH_COOKIE_NAME}=business; Path=/`]]] as const) {
    const response = await app.inject({ method: "GET", url, headers });
    assert.deepEqual(responseCookies(response.headers), expected);
  }
});

test("parallel requests have independent candidates and a renewed polling request returns outside the threshold", async (t) => {
  let currentTime = now;
  const { app, ctx } = await createAuthApp(t, { clock: () => currentTime });
  const oldCookie = cookieHeader(ctx.authToken!, AUTH_SESSION_TTL_MS, AUTH_SESSION_RENEW_THRESHOLD_MS);
  const responses = await Promise.all([
    app.inject({ method: "GET", url: "/api/business", headers: { cookie: oldCookie } }),
    app.inject({ method: "GET", url: "/api/business", headers: { cookie: oldCookie } }),
    app.inject({ method: "GET", url: "/api/business" }),
    app.inject({ method: "GET", url: "/api/health" })
  ]);
  assert.deepEqual(responses.map((response) => response.statusCode), [200, 200, 401, 200]);
  for (const response of responses.slice(0, 2)) assertRenewal(responseCookies(response.headers)[0], ctx.authToken!, AUTH_SESSION_TTL_MS, false);
  for (const response of responses.slice(2)) assert.deepEqual(responseCookies(response.headers), []);
  currentTime += 1;
  const renewedValue = parseCookieHeader(responseCookies(responses[0].headers)[0])[AUTH_COOKIE_NAME];
  const polling = await app.inject({ method: "GET", url: "/api/business", headers: { cookie: `${AUTH_COOKIE_NAME}=${renewedValue}` } });
  assert.equal(polling.statusCode, 200);
  assert.deepEqual(responseCookies(polling.headers), []);
});

test("standard public SSE renews once at the initial HTTP headers, not once per event", async (t) => {
  const { app, ctx } = await createAuthApp(t);
  let sends = 0;
  app.addHook("onSend", async (_req, _reply, payload) => { sends += 1; return payload; });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${origin}/api/events`, { headers: {
    cookie: cookieHeader(ctx.authToken!, AUTH_SESSION_TTL_MS, AUTH_SESSION_RENEW_THRESHOLD_MS)
  } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assertRenewal(cookies[0], ctx.authToken!, AUTH_SESSION_TTL_MS, false);
  assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
  assert.equal(sends, 1);
});

test("the production login and health flow remains compatible and does not receive an extra renewal", async (t) => {
  const authToken = randomUUID();
  const fixture = await createAgentTestFixture({ withApp: true, authToken, dataDirPrefix: "auth-renewal-login-", agentWorkerConcurrency: 0 });
  t.after(() => fixture.dispose());
  const app = fixture.app!;
  const previous = cookieHeader(authToken, AUTH_SESSION_TTL_MS, AUTH_SESSION_RENEW_THRESHOLD_MS, Date.now());
  for (const remember of [false, true]) {
    const response = await app.inject({ method: "POST", url: "/api/auth/login", headers: { cookie: previous }, payload: { token: authToken, remember } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
    const cookies = responseCookies(response.headers);
    assert.equal(cookies.length, 1);
    const value = parseCookieHeader(cookies[0])[AUTH_COOKIE_NAME];
    const payload = readSessionCookiePayload({ authToken, value, nowMs: Date.now() });
    assert.ok(payload);
    assert.equal(payload.exp - payload.iat, remember ? AUTH_REMEMBER_TTL_MS : AUTH_SESSION_TTL_MS);
    const attributes = cookies[0].split(";").slice(1).map((part) => part.trim());
    assert.equal(attributes.includes("Max-Age=2592000"), remember);
    const health = await app.inject({ method: "GET", url: "/api/health", headers: { cookie: previous } });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(responseCookies(health.headers), []);
  }
  const denied = await app.inject({ method: "POST", url: "/api/auth/login", headers: { cookie: previous }, payload: { token: randomUUID(), remember: true } });
  assert.equal(denied.statusCode, 401);
  assert.deepEqual(responseCookies(denied.headers), []);
});
