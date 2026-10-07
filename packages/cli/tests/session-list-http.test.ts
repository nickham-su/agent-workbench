import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { FileConfigStore } from "../src/config.js";
import { cookieValue, healthBody, httpServer, runBuiltCli, temporaryDirectory } from "./helpers.js";
import { parseSessionListOptions } from "../src/session-query.js";
import { defaultQuery, queryResponse, renewedHeader, renewedValue } from "./session-fixture.js";

const args = ["session", "list", "--workspace", defaultQuery.workspaceId, "--updated-within", defaultQuery.duration];

function assertPrivateOutput(result: { stdout: string; stderr: string }): void {
  for (const value of [cookieValue, renewedValue, "private-response-body", "unused-test-token"]) {
    assert.ok(!result.stdout.includes(value));
    assert.ok(!result.stderr.includes(value));
  }
}

test("built CLI initializes auth-off connection then returns every 165 Session and leaves no-renewal cache untouched", async (t) => {
  const home = await temporaryDirectory("query-built-full");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const payload = queryResponse(defaultQuery, 165);
  payload.items[0].title = "";
  payload.items[1].title = "任意名称\n不能形成新字段\t\u001b[31m";
  payload.items[1].userMessageCount = 0;
  payload.items[1].completedAssistantMessageCount = 0;
  payload.items[2].kind = "subtask";
  payload.items[2].status = "running";
  const requests: string[] = [];
  const server = await httpServer((request, response) => {
    requests.push(request.url!);
    assert.equal(request.headers.cookie, undefined);
    if (request.url === "/api/health") { response.end(healthBody(false)); return; }
    const url = new URL(request.url!, "http://test.invalid");
    assert.equal(url.pathname, "/api/agent/sessions/query");
    assert.deepEqual([...url.searchParams], [
      ["workspaceId", "workspace-example"], ["updatedWithinSeconds", "86400"], ["kind", "all"], ["status", "all"]
    ]);
    response.end(JSON.stringify(payload));
  });
  t.after(server.close);
  assert.equal((await runBuiltCli(["login", "--url", server.origin], home)).code, 0);
  const store = new FileConfigStore(home);
  const before = await fs.stat(store.filePath);
  const original = await fs.readFile(store.filePath, "utf8");
  const result = await runBuiltCli(args, home, "unused-test-token\n");
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal((result.stdout.match(/^Session ID：/gm) ?? []).length, 165);
  for (const item of payload.items) assert.ok(result.stdout.includes(`Session ID：${item.id}\n`));
  assert.match(result.stdout, /标题：（空标题）/);
  assert.match(result.stdout, /标题：任意名称\\n不能形成新字段\\t\\u001b\[31m/);
  assert.match(result.stdout, /用户消息累计数：0\n已完成助手消息累计数：0/);
  assert.match(result.stdout, /类型：subtask\n状态：running/);
  assert.match(result.stdout, /查询结束：已输出 165 个 Session。\n$/);
  assert.ok(result.stdout.length > 8000);
  assert.equal(await fs.readFile(store.filePath, "utf8"), original);
  assert.equal((await fs.stat(store.filePath)).mtimeMs, before.mtimeMs);
  assert.equal(requests.length, 2);
  assertPrivateOutput(result);
});

test("built CLI encodes original Workspace, filtered duration, and displays only server UTC window", async (t) => {
  const home = await temporaryDirectory("query-built-filtered");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const query = parseSessionListOptions({ workspace: " id/中文+ ", updatedWithin: "30m", kind: "subtask", status: "running" });
  const payload = queryResponse(query);
  payload.updatedFrom = -1800000;
  payload.updatedTo = 0;
  payload.items[0].updatedAt = payload.updatedFrom;
  let calls = 0;
  const server = await httpServer((request, response) => {
    calls++;
    const url = new URL(request.url!, "http://test.invalid");
    assert.deepEqual([...url.searchParams], [["workspaceId", query.workspaceId], ["updatedWithinSeconds", "1800"], ["kind", "subtask"], ["status", "running"]]);
    assert.equal(request.headers.cookie, `awb_session=${cookieValue}`);
    response.setHeader("Set-Cookie", renewedHeader);
    response.end(JSON.stringify(payload));
  });
  t.after(server.close);
  const store = new FileConfigStore(home);
  await store.save({ version: 1, apiOrigin: server.origin, cookie: { name: "awb_session", value: cookieValue, secure: false } });
  const result = await runBuiltCli(["session", "list", "--workspace", query.workspaceId, "--updated-within", "30m", "--kind", "subtask", "--status", "running"], home);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /1969-12-31T23:30:00.000Z 至 1970-01-01T00:00:00.000Z/);
  assert.equal((await store.load()).cookie?.value, renewedValue);
  assert.equal(calls, 1);
  assertPrivateOutput(result);
});

test("built CLI response failure matrix preserves renewal precedence and empty stdout", async (t) => {
  const home = await temporaryDirectory("query-built-failures");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let body = "";
  let cookies: string[] = [];
  let status = 200;
  let calls = 0;
  const server = await httpServer((_request, response) => {
    calls++;
    response.statusCode = status;
    response.setHeader("Set-Cookie", cookies);
    response.end(body);
  });
  t.after(server.close);
  const store = new FileConfigStore(home);
  const original = { version: 1 as const, apiOrigin: server.origin, cookie: { name: "awb_session" as const, value: cookieValue, secure: false } };
  const cases = [
    { status: 200, body: "private-response-body", cookies: [renewedHeader], expected: 6, renewed: true, category: "JSON" },
    { status: 200, body: JSON.stringify({ invalid: true }), cookies: [renewedHeader], expected: 6, renewed: true, category: "响应结构" },
    { status: 200, body: "private-response-body", cookies: [`${renewedHeader}; Domain=localhost`], expected: 6, renewed: false, category: "Cookie" },
    { status: 200, body: "private-response-body", cookies: [renewedHeader, renewedHeader], expected: 6, renewed: false, category: "Cookie" },
    { status: 200, body: JSON.stringify(queryResponse()), cookies: [`${renewedHeader}; Secure`], expected: 6, renewed: false, category: "HTTPS" },
    { status: 401, body: "private-response-body", cookies: [], expected: 4, renewed: false, category: "awb login" },
    { status: 401, body: "private-response-body", cookies: [`${renewedHeader}; Domain=localhost`], expected: 4, renewed: false, category: "Cookie" },
    { status: 500, body: '{"message":"private-response-body","code":"AGENT_SESSION_QUERY_STATE_INVALID"}', cookies: [renewedHeader], expected: 6, renewed: true, category: "AGENT_SESSION_QUERY_STATE_INVALID" },
    { status: 404, body: '{"code":"WORKSPACE_NOT_FOUND"}', cookies: [`${renewedHeader}; Max-Age=0`], expected: 6, renewed: false, category: "WORKSPACE_NOT_FOUND" }
  ];
  for (const row of cases) {
    await store.save(original);
    status = row.status;
    body = row.body;
    cookies = row.cookies;
    const result = await runBuiltCli(args, home, "unused-test-token\n");
    assert.equal(result.code, row.expected);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(row.category));
    if (row.status !== 200) assert.match(result.stderr, new RegExp(`HTTP ${row.status}`));
    assert.equal((await store.load()).cookie?.value, row.renewed ? renewedValue : cookieValue);
    assertPrivateOutput(result);
  }
  assert.equal(calls, cases.length);
});

test("built CLI cache-null authentication transition is noninteractive and keeps configuration", async (t) => {
  const home = await temporaryDirectory("query-built-auth-transition");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let authEnabled = false;
  const paths: string[] = [];
  const server = await httpServer((request, response) => {
    paths.push(request.url!);
    assert.equal(request.headers.cookie, undefined);
    assert.ok(request.url!.startsWith("/api/agent/sessions/query?"));
    if (authEnabled) { response.statusCode = 401; response.end("private-response-body"); }
    else response.end(JSON.stringify(queryResponse(defaultQuery, 0)));
  });
  t.after(server.close);
  const store = new FileConfigStore(home);
  await store.save({ version: 1, apiOrigin: server.origin, cookie: null });
  const original = await fs.readFile(store.filePath, "utf8");
  const first = await runBuiltCli(args, home);
  assert.equal(first.code, 0);
  assert.equal(first.stderr, "");
  assert.match(first.stdout, /匹配总数：0\n\n查询结束：已输出 0 个 Session。\n$/);
  authEnabled = true;
  const second = await runBuiltCli(args, home, "unused-test-token\n");
  assert.equal(second.code, 4);
  assert.equal(second.stdout, "");
  assert.match(second.stderr, /^\[AUTH\].*awb login/);
  assert.equal(paths.length, 2);
  assert.equal(await fs.readFile(store.filePath, "utf8"), original);
  assertPrivateOutput(second);
});

test("built CLI never follows redirect, sends no Secure cookie over HTTP, and ignores partial response renewal", async (t) => {
  const home = await temporaryDirectory("query-built-transport");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let targetCalls = 0;
  const target = await httpServer((_request, response) => { targetCalls++; response.end("{}"); });
  t.after(target.close);
  let mode = "redirect";
  const source = await httpServer((request, response) => {
    assert.equal(request.headers.cookie, undefined);
    if (mode === "redirect") {
      response.writeHead(302, { Location: `${target.origin}/api/target`, "Set-Cookie": renewedHeader });
      response.end("private-response-body");
    } else if (mode === "partial") {
      response.writeHead(200, { "Content-Length": "100000", "Set-Cookie": renewedHeader });
      response.write('{"items":');
      setTimeout(() => response.destroy(), 15);
    } else response.end(JSON.stringify(queryResponse()));
  });
  t.after(source.close);
  const store = new FileConfigStore(home);
  await store.save({ version: 1, apiOrigin: source.origin, cookie: { name: "awb_session", value: cookieValue, secure: true } });
  const original = await fs.readFile(store.filePath, "utf8");
  let result = await runBuiltCli(args, home);
  assert.equal(result.code, 6);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /HTTP 302/);
  assert.equal(targetCalls, 0);
  mode = "normal";
  result = await runBuiltCli(args, home);
  assert.equal(result.code, 0);
  mode = "partial";
  result = await runBuiltCli(args, home);
  assert.equal(result.code, 5);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\[NETWORK\]/);
  assert.equal(await fs.readFile(store.filePath, "utf8"), original);
  assertPrivateOutput(result);
});

test("built CLI missing/corrupt config has exit 3 and isolated homes never share login", async (t) => {
  const home = await temporaryDirectory("query-built-invalid-config");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const store = new FileConfigStore(home);
  const result = await runBuiltCli(args, home);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\[CONFIG\].*awb login/);
  await fs.mkdir(store.directory, { recursive: true });
  await fs.writeFile(store.filePath, "private-response-body");
  const corrupt = await runBuiltCli(args, home);
  assert.equal(corrupt.code, 3);
  assert.equal(corrupt.stdout, "");
  assertPrivateOutput(corrupt);
});
