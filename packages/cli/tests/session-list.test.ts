import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { FileConfigStore, type CliConfigV1, type ConfigStore } from "../src/config.js";
import { CliError } from "../src/errors.js";
import { HttpClient, type HttpResult } from "../src/http.js";
import { runCli } from "../src/program.js";
import { listSessions } from "../src/session-list.js";
import { parseSessionListOptions } from "../src/session-query.js";
import { captureIO, cookieValue, httpServer, temporaryDirectory } from "./helpers.js";
import { defaultQuery, queryResponse, renewedHeader, renewedValue } from "./session-fixture.js";

const base: CliConfigV1 = { version: 1, apiOrigin: "http://example.test", cookie: { name: "awb_session", value: cookieValue, secure: false } };
const args = ["session", "list", "--workspace", defaultQuery.workspaceId, "--updated-within", defaultQuery.duration];
const response = (status: number, body: string, setCookies: string[] = []): HttpResult => ({ status, body, setCookies });

function memoryConfig(saveFailure = false): { store: ConfigStore; current: () => CliConfigV1; writes: () => number } {
  let current = structuredClone(base);
  let writes = 0;
  return {
    store: { load: async () => current, save: async (next) => { writes++; if (saveFailure) throw new Error("must-not-echo-test-error"); current = next; } },
    current: () => current, writes: () => writes
  };
}

test("invalid query values fail before configuration creation or network and never echo input", async () => {
  for (const bad of [
    ["--workspace", " ", "--updated-within", "1s"], ["--workspace", "id", "--updated-within", "1h\n"],
    ["--workspace", "id", "--updated-within", "91d"], ["--workspace", "id", "--updated-within", "1s", "--kind", "test-secret"],
    ["--workspace", "id", "--updated-within", "1s", "--status", ""],
    ["--workspace", "id", "--updated-within", "1s", "--updated-within=2s"],
    ["--workspace", "id", "--updated-within", "1s", "--limit=2"]
  ]) {
    const capture = captureIO();
    const code = await runCli(["session", "list", ...bad], {
      io: capture.io, createConfigStore: () => { throw new Error("Must not create config"); },
      http: { request: async () => { throw new Error("Must not request"); } }
    });
    assert.equal(code, 2);
    assert.equal(capture.output(), "");
    assert.match(capture.diagnostic(), /^\[USAGE\]/);
    assert.ok(!capture.diagnostic().includes("test-secret"));
  }
});

test("successful query sends only normalized server parameters, saves renewal before any output, and does not read stdin", async () => {
  const query = parseSessionListOptions({ workspace: " id/中文+ ", updatedWithin: "30m", kind: "subtask", status: "running" });
  const memory = memoryConfig();
  const capture = captureIO("must-not-read-test-token\n");
  let reads = 0;
  capture.io.stdin.read = () => { reads++; throw new Error("Must not read stdin"); };
  let requests = 0;
  const originalWrite = capture.io.stdout.write.bind(capture.io.stdout);
  capture.io.stdout.write = ((chunk: string | Uint8Array) => {
    assert.equal(memory.current().cookie?.value, renewedValue);
    return originalWrite(chunk);
  }) as typeof capture.io.stdout.write;
  await listSessions(query, {
    config: memory.store, io: capture.io,
    http: { request: async (origin, path, request) => {
      requests++;
      assert.equal(origin, base.apiOrigin);
      const url = new URL(path, origin);
      assert.equal(url.pathname, "/api/agent/sessions/query");
      assert.deepEqual([...url.searchParams], [
        ["workspaceId", query.workspaceId], ["updatedWithinSeconds", "1800"], ["kind", "subtask"], ["status", "running"]
      ]);
      assert.deepEqual(request, { cookie: base.cookie });
      return response(200, JSON.stringify(queryResponse(query)), ["other=x; Domain=ignored.test; Path=/other", renewedHeader]);
    } }
  });
  assert.equal(requests, 1);
  assert.equal(reads, 0);
  assert.equal(memory.writes(), 1);
  assert.match(capture.output(), /类型：subtask\n状态：running/);
  assert.match(capture.output(), /查询结束：已输出 1 个 Session。\n$/);
  assert.equal(capture.diagnostic(), "");
});

test("2xx renewal/JSON/DTO failure combinations preserve exact precedence and never output partial results", async (t) => {
  for (const body of ["not-json", JSON.stringify({ invalid: true }), JSON.stringify(queryResponse())]) {
    await t.test(`valid renewal and failing save, body ${body === "not-json" ? "text" : body.includes("invalid") ? "invalid DTO" : "valid DTO"}`, async () => {
      const memory = memoryConfig(true);
      const capture = captureIO();
      const code = await runCli(args, { io: capture.io, createConfigStore: () => memory.store, http: { request: async () => response(200, body, [renewedHeader]) } });
      assert.equal(code, 7);
      assert.equal(memory.writes(), 1);
      assert.equal(memory.current().cookie?.value, cookieValue);
      assert.equal(capture.output(), "");
      assert.match(capture.diagnostic(), /^\[PERSISTENCE\]/);
      assert.ok(!capture.diagnostic().includes("JSON"));
      assert.ok(!capture.diagnostic().includes("must-not-echo"));
    });
  }
  for (const body of ["not-json", JSON.stringify({ invalid: true })]) {
    const memory = memoryConfig();
    const capture = captureIO();
    assert.equal(await runCli(args, { io: capture.io, createConfigStore: () => memory.store, http: { request: async () => response(200, body, [renewedHeader]) } }), 6);
    assert.equal(memory.current().cookie?.value, renewedValue);
    assert.equal(memory.writes(), 1);
    assert.equal(capture.output(), "");
    assert.match(capture.diagnostic(), /^\[RESPONSE\]/);
  }
  for (const header of ["awb_session=invalid-test-secret; Path=/", `${renewedHeader}; Domain=example.test`, `${renewedHeader}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`]) {
    const memory = memoryConfig();
    const capture = captureIO();
    assert.equal(await runCli(args, { io: capture.io, createConfigStore: () => memory.store, http: { request: async () => response(200, "not-json", [header]) } }), 6);
    assert.equal(memory.writes(), 0);
    assert.equal(capture.output(), "");
    assert.match(capture.diagnostic(), /Cookie/);
    assert.ok(!capture.diagnostic().includes("JSON"));
    assert.ok(!capture.diagnostic().includes("test-secret"));
  }
});

test("HTTP main errors precede renewal save/attribute errors, keep safe codes, and never clear cached credentials", async () => {
  for (const status of [400, 401, 404, 500]) {
    for (const renewal of ["success", "save-failure", "invalid"] as const) {
      const memory = memoryConfig(renewal === "save-failure");
      const capture = captureIO("unused-test-token\n");
      let requests = 0;
      const result = response(status, JSON.stringify({ message: "must-not-echo-response", code: "WORKSPACE_NOT_FOUND" }), [renewal === "invalid" ? `${renewedHeader}; Path=/duplicate` : renewedHeader]);
      const code = await runCli(args, { io: capture.io, createConfigStore: () => memory.store, http: { request: async () => { requests++; return result; } } });
      assert.equal(code, status === 401 ? 4 : 6);
      assert.equal(requests, 1);
      assert.equal(capture.output(), "");
      assert.match(capture.diagnostic(), new RegExp(`^\\[${status === 401 ? "AUTH" : "RESPONSE"}\\] HTTP ${status}`));
      assert.match(capture.diagnostic(), /WORKSPACE_NOT_FOUND/);
      assert.ok(!capture.diagnostic().includes("must-not-echo-response"));
      assert.ok(!capture.diagnostic().includes(renewedValue));
      assert.ok(!capture.diagnostic().includes(cookieValue));
      if (status === 401) assert.match(capture.diagnostic(), /awb login/);
      if (renewal === "save-failure") assert.match(capture.diagnostic(), /\n\[PERSISTENCE\]/);
      if (renewal === "invalid") assert.match(capture.diagnostic(), /\n\[RESPONSE\].*Cookie/);
      assert.equal(memory.writes(), renewal === "invalid" ? 0 : 1);
      assert.equal(memory.current().cookie?.value, renewal === "success" ? renewedValue : cookieValue);
    }
  }
});

test("redirect is not a renewal source; no target cookie means no writes even for invalid DTO", async () => {
  for (const status of [301, 302, 307, 308]) {
    const memory = memoryConfig();
    const capture = captureIO();
    assert.equal(await runCli(args, { io: capture.io, createConfigStore: () => memory.store, http: { request: async () => response(status, "redirect", [renewedHeader]) } }), 6);
    assert.equal(memory.writes(), 0);
    assert.equal(capture.output(), "");
  }
  for (const body of [JSON.stringify(queryResponse()), "not-json", JSON.stringify({ invalid: true })]) {
    const memory = memoryConfig();
    const capture = captureIO();
    const expected = body === JSON.stringify(queryResponse()) ? 0 : 6;
    assert.equal(await runCli(args, { io: capture.io, createConfigStore: () => memory.store, http: { request: async () => response(200, body, ["other=x; Path=/other; Domain=ignored.test"]) } }), expected);
    assert.equal(memory.writes(), 0);
    if (expected !== 0) assert.equal(capture.output(), "");
  }
});

test("real HTTP renewal with atomic IO faults preserves old file and success/DTO precedence", async (t) => {
  const home = await temporaryDirectory("query-io-fault");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const server = await httpServer((_request, response) => {
    response.setHeader("Set-Cookie", renewedHeader);
    response.end("not-json");
  });
  t.after(server.close);
  const originalStore = new FileConfigStore(home);
  await originalStore.save({ ...base, apiOrigin: server.origin });
  const originalFile = await fs.readFile(originalStore.filePath, "utf8");
  for (const operation of ["write", "rename"] as const) {
    const faultStore = new FileConfigStore(home, {
      ...fs,
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        if (operation === "write") handle.writeFile = async () => { throw new Error("private-test-error"); };
        return handle;
      },
      rename: operation === "rename" ? async () => { throw new Error("private-test-error"); } : fs.rename
    });
    const capture = captureIO();
    assert.equal(await runCli(args, { io: capture.io, createConfigStore: () => faultStore, http: new HttpClient() }), 7);
    assert.equal(capture.output(), "");
    assert.match(capture.diagnostic(), /^\[PERSISTENCE\]/);
    assert.ok(!capture.diagnostic().includes("JSON"));
    assert.ok(!capture.diagnostic().includes("private-test-error"));
    assert.equal(await fs.readFile(originalStore.filePath, "utf8"), originalFile);
    assert.deepEqual(await fs.readdir(originalStore.directory), ["config.json"]);
  }
  const capture = captureIO();
  assert.equal(await runCli(args, { io: capture.io, createConfigStore: () => originalStore, http: new HttpClient() }), 6);
  assert.equal((await originalStore.load()).cookie?.value, renewedValue);
  assert.match(capture.diagnostic(), /JSON/);
  assert.equal(capture.output(), "");
});
