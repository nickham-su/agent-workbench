import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { FileConfigStore, type CliConfigV1 } from "../src/config.js";
import { HttpClient, type HttpResult, type HttpTransport } from "../src/http.js";
import { CliError } from "../src/errors.js";
import { login } from "../src/login.js";
import { captureIO, cookieHeader, cookieValue, healthBody, httpServer, readRequestBody, runBuiltCli, temporaryDirectory } from "./helpers.js";

const exitCode = (code: number) => (error: unknown) => error instanceof CliError && error.exitCode === code;

test("auth disabled initialization happens before TTY checks and never consumes stdin or logs in", async (t) => {
  for (const tokenStdin of [false, true]) {
    const home = await temporaryDirectory("auth-disabled");
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const config = new FileConfigStore(home);
    const capture = captureIO("must-not-read-test-token\n");
    let stdinReads = 0;
    const originalRead = capture.io.stdin.read.bind(capture.io.stdin);
    capture.io.stdin.read = (size?: number) => { stdinReads++; return originalRead(size); };
    let healthCalls = 0;
    const server = await httpServer((request, response) => {
      assert.equal(request.url, "/api/health");
      assert.equal(request.headers.cookie, undefined);
      healthCalls++;
      response.end(healthBody(false));
    });
    t.after(server.close);
    await login({ url: `${server.origin}/`, tokenStdin }, { config, http: new HttpClient(), io: capture.io });
    assert.equal(healthCalls, 1);
    assert.equal(stdinReads, 0);
    assert.deepEqual(await config.load(), { version: 1, apiOrigin: server.origin, cookie: null });
    assert.match(capture.output(), /初始化成功/);
    assert.equal(capture.diagnostic(), "");
  }
});

test("stdin login sends remember true with no old Cookie, stores Cookie only, and origin replacement is explicit", async (t) => {
  const home = await temporaryDirectory("stdin-login");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = new FileConfigStore(home);
  await config.save({ version: 1, apiOrigin: "https://old.example.test", cookie: { name: "awb_session", value: cookieValue, secure: false } });
  const capture = captureIO(" generated-test-token \r\n");
  const calls: string[] = [];
  const server = await httpServer(async (request, response) => {
    calls.push(request.url!);
    assert.equal(request.headers.cookie, undefined);
    if (request.url === "/api/health") response.end(healthBody(true));
    else {
      assert.equal(request.method, "POST");
      assert.deepEqual(await readRequestBody(request), { token: " generated-test-token ", remember: true });
      response.setHeader("Set-Cookie", cookieHeader);
      response.end('{"ok":true}');
    }
  });
  t.after(server.close);
  await login({ url: server.origin, tokenStdin: true }, { config, http: new HttpClient(), io: capture.io });
  assert.deepEqual(calls, ["/api/health", "/api/auth/login"]);
  assert.deepEqual(await config.load(), { version: 1, apiOrigin: server.origin, cookie: { name: "awb_session", value: cookieValue, secure: false } });
  assert.ok(!(await fs.readFile(config.filePath, "utf8")).includes("generated-test-token"));
  assert.ok(!capture.output().includes(cookieValue));
  assert.ok(!capture.output().includes("generated-test-token"));
  assert.equal(capture.diagnostic(), "");
});

test("auth enabled noninteractive login errors only after health and never reads token or sends login", async (t) => {
  const home = await temporaryDirectory("noninteractive-login");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const capture = captureIO("generated-test-token");
  let calls = 0;
  const server = await httpServer((request, response) => { calls++; assert.equal(request.url, "/api/health"); response.end(healthBody(true)); });
  t.after(server.close);
  await assert.rejects(login({ url: server.origin }, { config: new FileConfigStore(home), http: new HttpClient(), io: capture.io }), exitCode(2));
  assert.equal(calls, 1);
  assert.equal(capture.output(), "");
});

test("failed login responses, inputs and cache saves preserve old configuration", async (t) => {
  const home = await temporaryDirectory("failed-login");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = new FileConfigStore(home);
  const old: CliConfigV1 = { version: 1, apiOrigin: "https://old.example.test", cookie: null };
  await config.save(old);
  const bytes = await fs.readFile(config.filePath, "utf8");
  const responses: Array<[HttpResult, number]> = [
    [{ status: 401, body: '{"message":"generated-test-token"}', setCookies: [cookieHeader] }, 4],
    [{ status: 302, body: "redirect", setCookies: [cookieHeader] }, 6],
    [{ status: 200, body: "invalid", setCookies: [cookieHeader] }, 6],
    [{ status: 200, body: '{"ok":false}', setCookies: [cookieHeader] }, 6],
    [{ status: 200, body: '{"ok":true}', setCookies: [] }, 6],
    [{ status: 200, body: '{"ok":true}', setCookies: [`${cookieHeader}; Domain=example.test`] }, 6],
    [{ status: 200, body: '{"ok":true}', setCookies: [`${cookieHeader}; Secure`] }, 6]
  ];
  for (const [response, code] of responses) {
    const http: HttpTransport = { request: async (_origin, path) => path === "/api/health" ? { status: 200, body: healthBody(true), setCookies: [] } : response };
    const capture = captureIO("generated-test-token\n");
    await assert.rejects(login({ url: "http://example.test", tokenStdin: true }, { config, http, io: capture.io }), (error: unknown) => exitCode(code)(error) && !String(error).includes("generated-test-token"));
    assert.equal(await fs.readFile(config.filePath, "utf8"), bytes);
    assert.equal(capture.output(), "");
  }
  const badHealth: HttpTransport = { request: async () => ({ status: 200, body: '{"authEnabled":false}', setCookies: [] }) };
  await assert.rejects(login({ url: "http://example.test" }, { config, http: badHealth, io: captureIO().io }), exitCode(6));
  const normal: HttpTransport = { request: async (_origin, path) => path === "/api/health" ? { status: 200, body: healthBody(true), setCookies: [] } : { status: 200, body: '{"ok":true}', setCookies: [cookieHeader] } };
  await assert.rejects(login({ url: "http://example.test", tokenStdin: true }, { config, http: normal, io: captureIO("a\nb").io }), exitCode(2));
  const failing = new FileConfigStore(home, { ...fs, rename: async () => { throw new Error("test failure"); } });
  const capture = captureIO("generated-test-token\n");
  await assert.rejects(login({ url: "http://example.test", tokenStdin: true }, { config: failing, http: normal, io: capture.io }), exitCode(7));
  assert.equal(await fs.readFile(config.filePath, "utf8"), bytes);
  assert.equal(capture.output(), "");
});

test("built CLI initializes or logs in over real HTTP with independent process HOME", async (t) => {
  for (const authEnabled of [false, true]) {
    const home = await temporaryDirectory("binary-login");
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const calls: string[] = [];
    const server = await httpServer(async (request, response) => {
      calls.push(request.url!);
      assert.equal(request.headers.cookie, undefined);
      if (request.url === "/api/health") response.end(healthBody(authEnabled));
      else {
        assert.deepEqual(await readRequestBody(request), { token: "binary-generated-test-token", remember: true });
        response.setHeader("Set-Cookie", cookieHeader);
        response.end('{"ok":true}');
      }
    });
    t.after(server.close);
    const args = ["login", "--url", server.origin];
    if (authEnabled) args.push("--token-stdin");
    const result = await runBuiltCli(args, home, authEnabled ? "binary-generated-test-token\n" : "");
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes("binary-generated-test-token"));
    assert.ok(!result.stdout.includes(cookieValue));
    assert.deepEqual(calls, authEnabled ? ["/api/health", "/api/auth/login"] : ["/api/health"]);
    const saved = await new FileConfigStore(home).load();
    assert.equal(saved.apiOrigin, server.origin);
    assert.deepEqual(saved.cookie, authEnabled ? { name: "awb_session", value: cookieValue, secure: false } : null);
  }
});

test("network failure during login preserves old connection and has no success output", async () => {
  let saves = 0;
  const capture = captureIO("generated-test-token\n");
  const http: HttpTransport = { request: async (_origin, path) => {
    if (path === "/api/health") return { status: 200, body: healthBody(true), setCookies: [] };
    throw new CliError(5, "测试网络中断。");
  } };
  await assert.rejects(login({ url: "http://example.test", tokenStdin: true }, {
    http, io: capture.io, config: { load: async () => { throw new Error("Must not read old configuration"); }, save: async () => { saves++; } }
  }), exitCode(5));
  assert.equal(saves, 0);
  assert.equal(capture.output(), "");
});
