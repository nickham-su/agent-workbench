import test from "node:test";
import assert from "node:assert/strict";
import { isSessionCookie, readResponseCookie, requestCookieHeader } from "../src/cookie.js";
import { CliError } from "../src/errors.js";
import { cookieHeader, cookieValue } from "./helpers.js";

const cookieError = (error: unknown) => error instanceof CliError && error.exitCode === 6;

test("fixed cookie accepts target only, preserves Secure, ignores browser and unknown attributes", () => {
  const expected = { name: "awb_session", value: cookieValue, secure: false };
  assert.deepEqual(readResponseCookie(["other=x; Domain=other.test; Expires=Thu, 01 Jan 1970 00:00:00 GMT", cookieHeader], "http://example.test"), expected);
  assert.deepEqual(readResponseCookie([`awb_session=${cookieValue}; pAtH=/; hTtPoNlY; sAmEsItE=Lax; mAx-AgE=2592000; Custom=ignored`], "https://example.test"), expected);
  assert.deepEqual(readResponseCookie([`${cookieHeader}; Secure`], "https://example.test"), { ...expected, secure: true });
  assert.deepEqual(readResponseCookie([`awb_session=${cookieValue}; Path=/`], "http://example.test"), expected);
  assert.equal(readResponseCookie(["AWB_SESSION=wrong; Domain=bad"], "http://example.test"), null);
  assert.equal(readResponseCookie([], "http://example.test"), null);
});

test("fixed cookie rejects invalid values, same-name duplicates and unsupported attributes", () => {
  const invalid = [
    `awb_session=${cookieValue}`, `awb_session=${cookieValue}; Path=/other`,
    `${cookieHeader}; Domain=example.test`, `${cookieHeader}; Domain=`,
    `${cookieHeader}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    `awb_session=${cookieValue}; Path=/; Max-Age=0`, `awb_session=${cookieValue}; Path=/; Max-Age=-1`,
    `awb_session=${cookieValue}; Path=/; Max-Age=100`, `awb_session=${cookieValue}; Path=/; Max-Age=02592000`,
    `${cookieHeader}; PATH=/`, `${cookieHeader}; HttpOnly`, `${cookieHeader}; SameSite=None`,
    `${cookieHeader}; Max-Age=2592000`, `${cookieHeader}; Secure; secure`, `${cookieHeader}; Secure=false`,
    "awb_session=; Path=/", "awb_session=v1..sig; Path=/", "awb_session=v2.payload.sig; Path=/",
    "awb_session=v1.payload.sig\n; Path=/", "awb_session=v1.payload.sig; extra-value; Path=/; Path=/"
  ];
  for (const header of invalid) assert.throws(() => readResponseCookie([header], "https://example.test"), cookieError);
  assert.throws(() => readResponseCookie([cookieHeader, cookieHeader], "http://example.test"), cookieError);
  assert.throws(() => readResponseCookie([`${cookieHeader}; Secure`], "http://example.test"), cookieError);
});

test("outbound Cookie is only value, never sends Secure over HTTP, rejects malformed cached value", () => {
  const cookie = { name: "awb_session" as const, value: cookieValue, secure: false };
  assert.equal(requestCookieHeader("http://example.test", cookie), `awb_session=${cookieValue}`);
  assert.equal(requestCookieHeader("http://example.test", { ...cookie, secure: true }), undefined);
  assert.equal(requestCookieHeader("https://example.test", { ...cookie, secure: true }), `awb_session=${cookieValue}`);
  assert.equal(requestCookieHeader("http://example.test", null), undefined);
  assert.equal(isSessionCookie({ ...cookie, extra: "x" }), false);
  assert.equal(isSessionCookie({ ...cookie, value: "v1.a.b\r\nHeader: x" }), false);
  assert.throws(() => requestCookieHeader("http://example.test", { ...cookie, value: "invalid" }), cookieError);
});
