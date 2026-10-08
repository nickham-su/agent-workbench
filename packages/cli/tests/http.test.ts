import test from "node:test";
import assert from "node:assert/strict";
import { HttpClient, httpStatusError, parseJson, type HttpResult } from "../src/http.js";
import { CliError } from "../src/errors.js";
import { cookieHeader, cookieValue, httpServer, readRequestBody } from "./helpers.js";

const code = (expected: number) => (error: unknown) => error instanceof CliError && error.exitCode === expected;

test("HTTP uses native fetch, explicit Cookie and JSON body, and independent Set-Cookie headers", async (t) => {
  let calls = 0;
  const server = await httpServer(async (request, response) => {
    calls++;
    assert.equal(request.headers.cookie, `awb_session=${cookieValue}`);
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(await readRequestBody(request), { token: "generated-test-token", remember: true });
    response.setHeader("Set-Cookie", ["other=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT", cookieHeader]);
    response.end('{"ok":true}');
  });
  t.after(server.close);
  const result = await new HttpClient().request(server.origin, "/api/test", { method: "POST", body: { token: "generated-test-token", remember: true }, cookie: { name: "awb_session", value: cookieValue, secure: false } });
  assert.equal(calls, 1);
  assert.deepEqual(result.setCookies, ["other=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT", cookieHeader]);
  assert.deepEqual(parseJson(result), { ok: true });
});

test("manual redirect is never followed and HTTP Secure cache is not sent", async (t) => {
  let targetCalls = 0;
  const target = await httpServer((_request, response) => { targetCalls++; response.end('{"ok":true}'); });
  const source = await httpServer((request, response) => {
    assert.equal(request.headers.cookie, undefined);
    response.writeHead(302, { Location: `${target.origin}/api/target` });
    response.end("redirect");
  });
  t.after(target.close);
  t.after(source.close);
  const result = await new HttpClient().request(source.origin, "/api/source", { cookie: { name: "awb_session", value: cookieValue, secure: true } });
  assert.equal(result.status, 302);
  assert.equal(httpStatusError(result)?.exitCode, 6);
  assert.equal(targetCalls, 0);
  await assert.rejects(new HttpClient().request(source.origin, `${target.origin}/api/target`), code(6));
});

test("timeout covers waiting headers and full body, and interruption exposes no partial cookie", async (t) => {
  const hanging = await httpServer((_request, _response) => {});
  t.after(hanging.close);
  await assert.rejects(new HttpClient(fetch, 40).request(hanging.origin, "/api/hang"), code(5));
  const partial = await httpServer((_request, response) => {
    response.writeHead(200, { "Set-Cookie": cookieHeader, "Content-Type": "application/json" });
    response.write('{"ok":');
  });
  t.after(partial.close);
  await assert.rejects(new HttpClient(fetch, 40).request(partial.origin, "/api/partial"), code(5));
  const broken = await httpServer((_request, response) => {
    response.writeHead(200, { "Set-Cookie": cookieHeader, "Content-Length": "1000" });
    response.write("partial");
    setTimeout(() => response.destroy(), 15);
  });
  t.after(broken.close);
  await assert.rejects(new HttpClient().request(broken.origin, "/api/broken"), code(5));
  await assert.rejects(new HttpClient().request("http://127.0.0.1:1", "/api/none"), code(5));
});

test("HTTP errors retain stable status/code but never dump body or arbitrary code", () => {
  const result = (status: number, body = "test-secret") => ({ status, body, setCookies: [] } satisfies HttpResult);
  assert.equal(httpStatusError(result(200)), null);
  assert.equal(httpStatusError(result(401))?.exitCode, 4);
  assert.match(httpStatusError(result(404, '{"message":"test-secret","code":"WORKSPACE_NOT_FOUND"}'))!.message, /WORKSPACE_NOT_FOUND/);
  for (const status of [300, 302, 307, 400, 500]) {
    const error = httpStatusError(result(status, '{"message":"test-secret","code":"TEST_SECRET"}'))!;
    assert.equal(error.exitCode, 6);
    assert.ok(!error.message.includes("test-secret"));
    assert.ok(!error.message.includes("TEST_SECRET"));
  }
  assert.throws(() => parseJson(result(200)), code(6));
});
