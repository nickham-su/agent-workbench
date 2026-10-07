import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
  AUTH_REMEMBER_RENEW_THRESHOLD_MS,
  AUTH_REMEMBER_TTL_MS,
  AUTH_SESSION_RENEW_THRESHOLD_MS,
  AUTH_SESSION_TTL_MS,
  createSessionCookieValue,
  getSessionCookieRenewalWindow,
  readSessionCookiePayload,
  verifySessionCookieValue
} from "./sessionCookie.js";

const now = 1_800_000_000_000;
const policies = [
  { label: "ordinary", ttlMs: AUTH_SESSION_TTL_MS, thresholdMs: AUTH_SESSION_RENEW_THRESHOLD_MS, maxAgeSeconds: undefined },
  { label: "remembered", ttlMs: AUTH_REMEMBER_TTL_MS, thresholdMs: AUTH_REMEMBER_RENEW_THRESHOLD_MS, maxAgeSeconds: 2_592_000 }
];

for (const policy of policies) {
  for (const deltaMs of [1, 0, -1]) {
    test(`${policy.label} renewal threshold ${deltaMs > 0 ? "+" : ""}${deltaMs}ms preserves its original lifetime`, () => {
      const authToken = crypto.randomUUID();
      const iat = now - policy.ttlMs + policy.thresholdMs + deltaMs;
      const value = createSessionCookieValue({ authToken, nowMs: iat, ttlMs: policy.ttlMs });
      const payload = readSessionCookiePayload({ authToken, value, nowMs: now });
      assert.deepEqual(payload, { iat, exp: iat + policy.ttlMs });
      assert.equal(verifySessionCookieValue({ authToken, value, nowMs: now }), true);
      assert.deepEqual(getSessionCookieRenewalWindow(payload!, now), deltaMs > 0 ? null : {
        ttlMs: policy.ttlMs,
        maxAgeSeconds: policy.maxAgeSeconds
      });
    });
  }

  test(`${policy.label} expired values cannot authenticate or renew, including the exact expiry`, () => {
    const authToken = crypto.randomUUID();
    for (const deltaMs of [0, -1]) {
      const iat = now - policy.ttlMs + deltaMs;
      const value = createSessionCookieValue({ authToken, nowMs: iat, ttlMs: policy.ttlMs });
      assert.equal(readSessionCookiePayload({ authToken, value, nowMs: now }), null);
      assert.equal(verifySessionCookieValue({ authToken, value, nowMs: now }), false);
      assert.equal(getSessionCookieRenewalWindow({ iat, exp: now + deltaMs }, now), null);
    }
  });
}

test("valid nonstandard lifetimes retain authentication without renewal or lifetime upgrades", () => {
  const authToken = crypto.randomUUID();
  for (const ttlMs of [60_000, AUTH_SESSION_TTL_MS - 1, AUTH_REMEMBER_TTL_MS + 1]) {
    const value = createSessionCookieValue({ authToken, nowMs: now - ttlMs + 1, ttlMs });
    const payload = readSessionCookiePayload({ authToken, value, nowMs: now });
    assert.ok(payload);
    assert.equal(verifySessionCookieValue({ authToken, value, nowMs: now }), true);
    assert.equal(getSessionCookieRenewalWindow(payload, now), null);
  }
});

test("verified payload and boolean validation both reject invalid formats, signatures and versions", () => {
  const authToken = crypto.randomUUID();
  const value = createSessionCookieValue({ authToken, nowMs: now - AUTH_SESSION_TTL_MS + 1, ttlMs: AUTH_SESSION_TTL_MS });
  const [version, payload, signature] = value.split(".");
  const alteredSignature = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
  for (const invalid of ["", "v1", `v2.${payload}.${signature}`, `${version}..${signature}`, `${version}.${payload}.`,
    `${version}.${payload}.${alteredSignature}`, `${value}.extra`]) {
    assert.equal(readSessionCookiePayload({ authToken, value: invalid, nowMs: now }), null);
    assert.equal(verifySessionCookieValue({ authToken, value: invalid, nowMs: now }), false);
  }
});

test("signed malformed time payloads are rejected before they can become renewal candidates", () => {
  const authToken = crypto.randomUUID();
  const secret = crypto.createHash("sha256").update(`awb-session:${authToken}`).digest();
  const signPayload = (payload: unknown) => {
    const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const input = `v1.${data}`;
    return `${input}.${crypto.createHmac("sha256", secret).update(input).digest("base64url")}`;
  };
  for (const payload of [null, [], {}, { iat: "bad", exp: now + 1 }, { iat: now, exp: "bad" },
    { iat: null, exp: now + 1 }, { iat: now, exp: null }, { iat: now }, { exp: now + 1 }]) {
    const value = signPayload(payload);
    assert.equal(readSessionCookiePayload({ authToken, value, nowMs: now }), null);
    assert.equal(verifySessionCookieValue({ authToken, value, nowMs: now }), false);
  }
});

test("existing clock-skew allowance and trimming remain compatible", () => {
  const authToken = crypto.randomUUID();
  for (const deltaMs of [0, 1]) {
    const value = createSessionCookieValue({ authToken, nowMs: now + 5 * 60_000 + deltaMs, ttlMs: AUTH_SESSION_TTL_MS });
    assert.equal(verifySessionCookieValue({ authToken, value: ` ${value} `, nowMs: now }), deltaMs === 0);
  }
});

test("v1 values remain stateless across restarts and fail after the login secret changes", () => {
  const authToken = crypto.randomUUID();
  const value = createSessionCookieValue({ authToken, nowMs: now - 1, ttlMs: AUTH_REMEMBER_TTL_MS });
  assert.equal(verifySessionCookieValue({ authToken, value, nowMs: now }), true);
  assert.equal(verifySessionCookieValue({ authToken, value, nowMs: now + 1 }), true);
  assert.equal(verifySessionCookieValue({ authToken: crypto.randomUUID(), value, nowMs: now }), false);
});
