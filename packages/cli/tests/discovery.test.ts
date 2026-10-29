import assert from "node:assert/strict";
import test from "node:test";
import { AgentApi, selectAgent } from "../src/agent-api.js";
import { type CliConfigV1, type ConfigStore } from "../src/config.js";
import { CliError } from "../src/errors.js";
import type { HttpResult, HttpTransport } from "../src/http.js";
import { runCli } from "../src/program.js";
import { captureIO, cookieHeader, cookieValue, healthBody } from "./helpers.js";
import { renewedHeader, renewedValue } from "./session-fixture.js";

const connection: CliConfigV1 = { version: 1, apiOrigin: "http://example.test", cookie: { name: "awb_session", value: cookieValue, secure: false } };
const result = (value: unknown, status = 200, setCookies: string[] = []): HttpResult => ({ status, body: JSON.stringify(value), setCookies });
function store(): ConfigStore { return { load: async () => structuredClone(connection), save: async () => {} }; }
function sessionFixture(kind: "primary" | "subtask" = "primary") {
  return { id: "s", workspaceId: "w", title: "标题\n\u001b[31m", kind, forkedFromSessionId: "parent", forkedFromMessageId: "fork",
    headMessageId: "head", contextRootMessageId: "root", revision: 1, createdAt: 1, updatedAt: 2 };
}
function stateFixture(status: "idle" | "running" = "idle") {
  return { workspaceId: "w", sessionId: "s", status, activeRunId: status === "running" ? "r" : null,
    runNoticeText: "private-runtime-notice", retryCount: 0, nextRetryAt: null, activeAssistantMessageId: null,
    nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: 2 };
}
async function execute(args: string[], body: unknown, status = 200) {
  const capture = captureIO();
  const requests: string[] = [];
  const code = await runCli(args, { io: capture.io, createConfigStore: store, http: { request: async (_origin, path) => { requests.push(path); return result(body, status); } } });
  return { code, requests, stdout: capture.output(), stderr: capture.diagnostic() };
}

test("A-DISCOVER-WORKSPACE: stable code-point sorting, narrow projections and empty lists", async () => {
  const data = [{ id: "z", title: "same", repos: [{ url: "private-repo-url" }], dirName: "private-path" },
    { id: "b", title: "\u{10000}" }, { id: "a", title: "same" }, { id: "c", title: "\ue000" }, { id: "empty", title: "" }];
  const output = await execute(["workspace", "list", "--json"], data);
  assert.equal(output.code, 0);
  assert.deepEqual(output.requests, ["/api/workspaces"]);
  assert.deepEqual(JSON.parse(output.stdout), { schemaVersion: 1, ok: true, command: "workspace list", data: { items: [
    { id: "empty", name: "" }, { id: "a", name: "same" }, { id: "z", name: "same" }, { id: "c", name: "\ue000" }, { id: "b", name: "\u{10000}" }
  ], count: 5 } });
  assert.equal(output.stderr, "");
  assert.equal(output.stdout.includes("private-"), false);
  const empty = await execute(["--json", "workspace", "list"], []);
  assert.deepEqual(JSON.parse(empty.stdout).data, { items: [], count: 0 });
});

test("A-DISCOVER-AGENT: config order, minimal fields, empty success and one shared selection rule", async () => {
  const agents = [{ id: "z", name: "z", summary: "摘要\n\u001b[31m", prompt: "private-agent-prompt", defaultModel: { providerId: "private-provider" } }, { id: "a", name: "a", summary: "" }];
  const output = await execute(["agent", "--json", "list", "-w", "w"], { agents });
  assert.equal(output.code, 0);
  assert.deepEqual(output.requests, ["/api/workspaces/w/agents/available?surface=user"]);
  assert.deepEqual(JSON.parse(output.stdout).data, { workspaceId: "w", count: 2, items: agents.map(({ id, name, summary }) => ({ id, name, summary })) });
  assert.equal(output.stdout.includes("private-"), false);
  const human = await execute(["agent", "list", "--workspace", "w"], { agents });
  assert.equal(human.stdout.includes("\u001b"), false);
  assert.ok(human.stdout.includes("摘要\\n\\u001b[31m"));
  assert.match(human.stdout, /Agent 总数：2\n$/);
  assert.doesNotMatch(human.stdout, /不保证|可用仅|可用只|Worker/);
  const empty = await execute(["agent", "list", "-w", "w", "--json"], { agents: [] });
  assert.deepEqual(JSON.parse(empty.stdout).data.items, []);
  assert.equal(selectAgent(agents).id, "z");
  assert.equal(selectAgent(agents, "a").id, "a");
  assert.throws(() => selectAgent([]), (error: unknown) => error instanceof CliError && error.details.code === "NO_AVAILABLE_AGENT");
  assert.throws(() => selectAgent(agents, "unknown"), (error: unknown) => error instanceof CliError && error.details.code === "AGENT_UNAVAILABLE");
});

test("A-SESSIONS-SHOW: primary/subtask metadata, fork provenance and no window requirement", async () => {
  for (const kind of ["primary", "subtask"] as const) {
    const data = { ...sessionFixture(kind), privateExtra: "private-configuration" };
    const output = await execute(["session", "show", "-w", "w", "-s", "s", "--json"], data);
    assert.equal(output.code, 0);
    assert.deepEqual(output.requests, ["/api/agent/sessions/s?workspaceId=w"]);
    assert.deepEqual(JSON.parse(output.stdout).data, sessionFixture(kind));
    assert.equal(output.stdout.includes("private-"), false);
    const human = await execute(["session", "show", "-w", "w", "-s", "s"], data);
    assert.equal(human.stdout.includes("\u001b"), false);
    assert.ok(human.stdout.includes("标题\\n\\u001b[31m"));
  }
});

test("A-CONTROL-STATUS: only busy/idle, no activeRunId, runtime notice or success inference", async () => {
  for (const status of ["idle", "running"] as const) {
    const output = await execute(["--json", "session", "status", "-w", "w", "-s", "s"], stateFixture(status));
    assert.equal(output.code, 0);
    assert.deepEqual(output.requests, ["/api/agent/sessions/s/run-state?workspaceId=w"]);
    assert.deepEqual(JSON.parse(output.stdout).data, { workspaceId: "w", sessionId: "s", status });
    assert.equal(output.stdout.includes("private-"), false);
    const human = await execute(["session", "status", "-w", "w", "-s", "s"], stateFixture(status));
    assert.equal(human.code, 0);
    assert.equal(human.stdout, `Workspace：w\nSession ID：s\n状态：${status}\n`);
    assert.equal(human.stderr, "");
  }
});

test("strict discovery/detail/status DTO errors publish no partial list or guessed identity", async () => {
  const cases: [string[], unknown][] = [
    [["workspace", "list"], [{ id: "a", title: "valid" }, { id: "a", title: "duplicate" }]],
    [["workspace", "list"], [{ id: "a", title: 1 }]],
    [["agent", "list", "-w", "w"], { agents: [{ id: "a", name: "a", summary: "" }, { id: "a", name: "b", summary: "" }] }],
    [["agent", "list", "-w", "w"], { agents: [{ id: "a", name: "", summary: "" }] }],
    [["session", "show", "-w", "w", "-s", "s"], { ...sessionFixture(), workspaceId: "other" }],
    [["session", "show", "-w", "w", "-s", "s"], { ...sessionFixture(), id: "other" }],
    [["session", "show", "-w", "w", "-s", "s"], { ...sessionFixture(), revision: -1 }],
    [["session", "status", "-w", "w", "-s", "s"], { ...stateFixture(), sessionId: "other" }],
    [["session", "status", "-w", "w", "-s", "s"], { ...stateFixture(), activeRunId: "running-despite-idle" }],
    [["session", "status", "-w", "w", "-s", "s"], { ...stateFixture(), retryCount: -1 }]
  ];
  for (const [args, body] of cases) {
    const output = await execute([...args, "--json"], body);
    assert.equal(output.code, 6);
    assert.equal(output.stdout, "");
    assert.equal(output.requests.length, 1);
    assert.equal(JSON.parse(output.stderr).error.code, "RESPONSE_INVALID");
  }
});

test("HTTP 401/404/409/503 return one safe JSON error, never retry, login or switch scope", async () => {
  for (const status of [401, 404, 409, 503]) {
    const output = await execute(["session", "show", "-w", "w", "-s", "s", "--json"], { code: "PRIVATE_SECRET_CODE", message: "private-response-secret" }, status);
    assert.equal(output.code, status === 401 ? 4 : 6);
    assert.equal(output.stdout, "");
    assert.equal(output.stderr.includes("private-response-secret"), false);
    assert.equal(output.stderr.includes("PRIVATE_SECRET_CODE"), false);
    assert.deepEqual(output.requests, ["/api/agent/sessions/s?workspaceId=w"]);
    const error = JSON.parse(output.stderr).error;
    assert.equal(error.phase, "status");
    assert.equal(error.effect, "not_applicable");
    assert.deepEqual(error.context, { workspaceId: "w", sessionId: "s" });
    assert.equal(error.help, "awb session show --help");
  }
});

test("one connection renewal authority persists before success and subsequent requests use the renewed Cookie", async () => {
  let saved = false;
  const cookies: unknown[] = [];
  const api = await AgentApi.connect({ config: { load: async () => connection, save: async () => { saved = true; } }, http: {
    request: async (_origin, _path, request) => { cookies.push(request?.cookie?.value); return result([], 200, saved ? [] : [renewedHeader]); }
  } });
  await api.workspaces();
  assert.equal(saved, true);
  await api.workspaces();
  assert.deepEqual(cookies, [cookieValue, renewedValue]);
});

test("future write interface preserves validated accepted identities when renewal cannot be saved", async () => {
  let requests = 0;
  const api = await AgentApi.connect({ config: { load: async () => connection, save: async () => { throw new Error("private-fs-secret"); } }, http: {
    request: async () => { requests++; return result({ sessionId: "created" }, 201, [renewedHeader]); }
  } });
  await assert.rejects(api.json("/api/agent/sessions", { phase: "create", method: "POST", context: { workspaceId: "w" }, body: { workspaceId: "w" },
    validate: (value) => { assert.deepEqual(value, { sessionId: "created" }); return { sessionId: "created" }; }, identity: (value) => value
  }), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 7);
    assert.equal(error.details.effect, "accepted");
    assert.equal(error.details.phase, "create");
    assert.deepEqual(error.details.context, { workspaceId: "w", sessionId: "created" });
    assert.equal(error.message.includes("private-"), false);
    return true;
  });
  assert.equal(requests, 1);
});

test("write response/transport uncertainty differs from confirmed HTTP rejection without retry", async () => {
  for (const [response, expected] of [[result({}, 409), "rejected"], [result({}, 503), "unknown"], [result({ invalid: true }), "unknown"], [null, "unknown"]] as const) {
    let requests = 0;
    const http: HttpTransport = { request: async () => { requests++; if (!response) throw new Error("private-network-error"); return response; } };
    const api = await AgentApi.connect({ config: store(), http });
    await assert.rejects(api.json("/api/agent/sessions", { method: "POST", phase: "create", validate: () => { throw new CliError(6, "响应结构无效。"); } }), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.details.effect, expected);
      assert.equal(error.message.includes("private-"), false);
      return true;
    });
    assert.equal(requests, 1);
  }
});


test("A-OUTPUT-JSON login modes emit one safe result without loading old credentials", async () => {
  for (const authEnabled of [false, true]) {
    const capture = captureIO("fixture-only-token\n");
    const requests: string[] = [];
    let saves = 0;
    const code = await runCli(["login", "--url", "http://example.test", "--token-stdin", "--json"], {
      io: capture.io,
      createConfigStore: () => ({ load: async () => { throw new Error("Must not load old credentials"); }, save: async () => { saves++; } }),
      http: { request: async (_origin, path) => {
        requests.push(path);
        return path === "/api/health" ? { status: 200, body: healthBody(authEnabled), setCookies: [] } : result({ ok: true }, 200, [cookieHeader]);
      } }
    });
    assert.equal(code, 0);
    assert.equal(saves, 1);
    assert.deepEqual(requests, authEnabled ? ["/api/health", "/api/auth/login"] : ["/api/health"]);
    assert.deepEqual(JSON.parse(capture.output()), { schemaVersion: 1, ok: true, command: "login", data: { authEnabled, authenticated: authEnabled } });
    assert.equal(capture.diagnostic(), "");
    assert.equal(capture.output().includes("fixture-only-token"), false);
    assert.equal(capture.output().includes(cookieValue), false);
  }
});

test("config failures carry CONFIG phase/code without leaking raw exceptions or performing requests", async () => {
  const capture = captureIO();
  let requests = 0;
  const code = await runCli(["workspace", "list", "--json"], { io: capture.io,
    createConfigStore: () => ({ load: async () => { throw new Error("private-config-error"); }, save: async () => {} }),
    http: { request: async () => { requests++; throw new Error("Must not request"); } }
  });
  assert.equal(code, 3);
  assert.equal(requests, 0);
  assert.equal(capture.output(), "");
  const error = JSON.parse(capture.diagnostic()).error;
  assert.equal(error.category, "CONFIG");
  assert.equal(error.code, "CONFIG_INVALID");
  assert.equal(error.phase, "config");
  assert.equal(capture.diagnostic().includes("private-config-error"), false);
});
