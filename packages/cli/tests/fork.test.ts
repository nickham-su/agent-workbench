import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { runCli } from "../src/program.js";
import { agentSession, connectionStore, jsonResult } from "./agent-fixture.js";
import { executeFollow } from "./follow-fixture.js";
import { captureIO, cookieHeader, textField } from "./helpers.js";

const args = ["fork", "-w", "w", "-s", "s"];
const source = () => agentSession({ headMessageId: "latest" });
const fork = (overrides: Record<string, unknown> = {}) => agentSession({
  id: "new-session", forkedFromSessionId: "s", forkedFromMessageId: "latest", headMessageId: "latest", ...overrides
});

test("fork uses the observed head without a message argument and prints confirmed identities", async () => {
  for (const flags of [["-w", "w", "-s", "s"], ["--workspace", "w", "--session", "s"]]) {
    const result = await executeFollow(["fork", ...flags], (url, request) => {
      if (url.pathname === "/api/agent/sessions/s") {
        assert.equal(request.method ?? "GET", "GET");
        assert.equal(url.searchParams.get("workspaceId"), "w");
        return jsonResult(source());
      }
      assert.equal(url.pathname, "/api/agent/sessions/fork");
      assert.equal(request.method, "POST");
      assert.deepEqual(request.body, { fromSessionId: "s", fromMessageId: "latest" });
      return jsonResult(fork(), 201);
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 2);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Fork 会话已创建/);
    assert.equal(textField(result.stdout, "workspaceId"), "w");
    assert.equal(textField(result.stdout, "sessionId"), "new-session");
    assert.equal(textField(result.stdout, "来源 Session ID"), "s");
    assert.equal(textField(result.stdout, "Fork 消息 ID"), "latest");
  }
});

test("fork invalid arguments fail before config or network, including unsupported message and title flags", async () => {
  for (const invocation of [
    ["fork"], ["fork", "-w", "w"], ["fork", "-s", "s"],
    [...args, "--message-id", "hidden-value"], [...args, "--title", "hidden-value"], [...args, "hidden-value"],
    [...args, "--session", "hidden-value"], ["fork", "-w", "w", "-s", ".."],
    ["fork", "-w", " w", "-s", "s"], [...args, "--json"], [...args, "-f"]
  ]) {
    const capture = captureIO(); let configs = 0; let requests = 0;
    const code = await runCli(["session", ...invocation], {
      io: capture.io,
      createConfigStore: () => { configs++; throw Error("must stay offline"); },
      http: { request: async () => { requests++; throw Error("must stay offline"); } }
    });
    assert.equal(code, 2, invocation.join(" "));
    assert.equal(configs, 0); assert.equal(requests, 0); assert.equal(capture.output(), "");
    assert.doesNotMatch(capture.diagnostic(), /hidden-value/);
    assert.match(capture.diagnostic(), /awb session fork --help/);
  }
});

test("fork rejects invalid source workspace/identity, subtask and empty head without a write", async () => {
  for (const [overrides, expectedCode] of [
    [{ workspaceId: "other" }, 6], [{ id: "other" }, 6], [{ kind: "subtask" }, 2], [{ headMessageId: null }, 2]
  ] as const) {
    const result = await executeFollow(args, (url) => {
      assert.equal(url.pathname, "/api/agent/sessions/s");
      return jsonResult({ ...source(), ...overrides });
    });
    assert.equal(result.code, expectedCode, result.stderr);
    assert.equal(result.requests.length, 1); assert.equal(result.stdout, "");
    assert.equal(textField(result.stderr, "effect"), expectedCode === 2 ? "not_sent" : "not_applicable");
    assert.equal(textField(result.stderr, "phase"), expectedCode === 2 ? "fork" : "status");
  }
});

test("fork never reselects or retries when the server rejects streaming, tools, compaction or a changed branch", async () => {
  for (const [code, status] of [
    ["FORK_TARGET_INVALID", 400], ["FORK_TARGET_HAS_NON_TERMINAL_EXECUTIONS", 409],
    ["FORK_HISTORY_NOT_STABLE", 409], ["MESSAGE_NOT_FOUND", 400]
  ] as const) {
    const result = await executeFollow(args, (url, request) => {
      if (url.pathname === "/api/agent/sessions/s") return jsonResult(source());
      assert.equal(url.pathname, "/api/agent/sessions/fork");
      assert.deepEqual(request.body, { fromSessionId: "s", fromMessageId: "latest" });
      return jsonResult({ code, message: "private-server-body" }, status);
    });
    assert.equal(result.code, 6); assert.equal(result.requests.length, 2); assert.equal(result.stdout, "");
    assert.equal(textField(result.stderr, "phase"), "fork");
    assert.equal(textField(result.stderr, "effect"), "rejected");
    assert.match(result.stderr, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(result.stderr, /private-server-body/);
  }
});

test("fork remains anchored to the read head when the running source appends before POST", async () => {
  let currentHead = "latest";
  const result = await executeFollow(args, (url, request) => {
    if (url.pathname === "/api/agent/sessions/s") {
      const observed = source(); currentHead = "newer";
      return jsonResult(observed);
    }
    assert.equal(url.pathname, "/api/agent/sessions/fork");
    assert.equal(currentHead, "newer");
    assert.deepEqual(request.body, { fromSessionId: "s", fromMessageId: "latest" });
    return jsonResult(fork(), 201);
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.requests.length, 2);
  assert.equal(textField(result.stdout, "Fork 消息 ID"), "latest");
  assert.equal(currentHead, "newer");
});

test("fork POST network failure preserves unknown effect and is not retried", async () => {
  let posts = 0;
  const result = await executeFollow(args, (url) => {
    if (url.pathname === "/api/agent/sessions/s") return jsonResult(source());
    assert.equal(url.pathname, "/api/agent/sessions/fork"); posts++;
    throw Error("private-transport-error");
  });
  assert.equal(result.code, 5); assert.equal(posts, 1); assert.equal(result.requests.length, 2);
  assert.equal(result.stdout, ""); assert.equal(textField(result.stderr, "effect"), "unknown");
  assert.equal(textField(result.stderr, "phase"), "fork");
  assert.equal(textField(result.stderr, "sessionId"), "s");
  assert.doesNotMatch(result.stderr, /private-transport-error/);
});

test("fork validates new primary session identity and exact source boundary before success", async () => {
  for (const overrides of [
    { id: "s" }, { id: ".." }, { workspaceId: "other" }, { kind: "subtask" },
    { forkedFromSessionId: "other" }, { forkedFromMessageId: "other" }, { headMessageId: "other" }
  ]) {
    const result = await executeFollow(args, (url) => jsonResult(url.pathname === "/api/agent/sessions/s" ? source() : fork(overrides)));
    assert.equal(result.code, 6); assert.equal(result.requests.length, 2); assert.equal(result.stdout, "");
    assert.equal(textField(result.stderr, "effect"), "unknown");
    assert.equal(textField(result.stderr, "sessionId"), "s");
  }
});

test("fork retains accepted new identity if cookie persistence or stdout fails", async () => {
  for (const failure of ["cookie", "stdout"]) {
    const capture = captureIO(); let posts = 0;
    const stdout = failure === "stdout" ? new Writable({ write(_chunk, _encoding, done) {
      done(Object.assign(Error("fixture output closed"), { code: "EPIPE" }));
    } }) : capture.io.stdout;
    const store = connectionStore();
    const code = await runCli(["session", ...args], {
      io: { ...capture.io, stdout },
      createConfigStore: () => ({ load: () => store.load(), save: async () => { throw Error("private-save-error"); } }),
      http: { request: async (_origin, path) => {
        if (new URL(path, "http://fixture.test").pathname === "/api/agent/sessions/s") return jsonResult(source());
        posts++; return jsonResult(fork(), 201, failure === "cookie" ? [cookieHeader] : []);
      } }
    });
    assert.equal(code, failure === "cookie" ? 7 : 141); assert.equal(posts, 1);
    assert.equal(capture.output(), "");
    assert.equal(textField(capture.diagnostic(), "effect"), "accepted");
    assert.equal(textField(capture.diagnostic(), "phase"), "fork");
    assert.equal(textField(capture.diagnostic(), "sessionId"), "new-session");
    assert.doesNotMatch(capture.diagnostic(), /private-save-error/);
  }
});
