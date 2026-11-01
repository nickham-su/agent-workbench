import { textField, messageIds } from "./helpers.js";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { AgentApi } from "../src/agent-api.js";
import type { ConfigStore } from "../src/config.js";
import { CliError, errorDiagnostic, errorObject, responseError, withErrorDetails } from "../src/errors.js";
import { FollowState } from "../src/follow-state.js";
import { FollowLifetime } from "../src/follow-lifetime.js";
import { FollowOutput } from "../src/follow-output.js";
import { FollowReadRetry } from "../src/follow-read-retry.js";
import { HttpClient, type HttpRequest, type HttpTransport } from "../src/http.js";
import { completeHistory, parseTimeline, startHistory } from "../src/messages.js";
import { runCli } from "../src/program.js";
import { readRun } from "../src/run-status.js";
import { agentSession, connectionStore, jsonResult } from "./agent-fixture.js";
import { msg, page, paged, run, state } from "./follow-fixture.js";
import { captureIO, cookieHeader, cookieValue } from "./helpers.js";

// Mock the same monotonic clock used by FollowLifetime as well as request/backoff timers.
function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
}
async function flush() { await setImmediate(); }
async function advance(t: TestContext, milliseconds: number) { t.mock.timers.tick(milliseconds); await flush(); }
async function finish<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  for (let n = 0; !settled && n < 150; n++) await advance(t, 1000);
  assert.ok(settled, "the operation must finish with finite retry budgets");
  return promise;
}
async function connection(t: TestContext, http: HttpTransport, config: ConfigStore = connectionStore(), stderr?: Writable) {
  const capture = captureIO();
  const external = new AbortController();
  const lifetime = new FollowLifetime(capture.io.stdout, external.signal);
  const retry = new FollowReadRetry(lifetime, stderr ?? capture.io.stderr);
  t.after(() => { lifetime.dispose(); capture.io.stdout.destroy(); capture.io.stderr.destroy(); stderr?.destroy(); });
  const api = await AgentApi.connect({ config, http, signal: lifetime.signal, followReadRetry: retry });
  return { api, capture, lifetime, retry, external };
}
const read = (api: AgentApi, path = "/api/read") => api.json(path, { phase: "history", context: { workspaceId: "w", sessionId: "s" }, validate: (value) => value });
const classified = (kind: "transport" | "request_timeout") => new CliError(5, "安全的传输失败。", { code: kind === "transport" ? "TRANSPORT_FAILED" : "REQUEST_TIMEOUT" }, { kind });

for (const kind of ["transport", "request_timeout"] as const) test(`ACC-RETRY-TRANSPORT/BUDGET/PARAMS: ${kind} uses exact 1/2/4 seconds independently per GET`, async (t) => {
  clock(t);
  const calls: { path: string; time: number; signal: AbortSignal | undefined; request: HttpRequest }[] = [];
  const { api, capture } = await connection(t, { request: async (_origin, path, request = {}) => {
    calls.push({ path, time: Date.now(), signal: request.signal, request });
    if (calls.length % 4) throw classified(kind);
    return jsonResult({ ok: true });
  } });
  for (const path of ["/api/timeline?mode=delta&sinceRevision=12&knownHeadMessageId=private-draft", "/api/before?beforeMessageId=private-cursor"]) {
    const baseline = calls.length;
    const promise = read(api, path);
    await flush();
    assert.equal(calls.length, baseline + 1);
    for (const delay of [1000, 2000, 4000]) {
      const count = calls.length;
      await advance(t, delay - 1); assert.equal(calls.length, count);
      await advance(t, 1); assert.equal(calls.length, count + 1);
    }
    assert.deepEqual(await promise, { ok: true });
    const attempts = calls.slice(baseline);
    assert.ok(attempts.every((call) => call.path === path && call.signal === attempts[0].signal));
    assert.deepEqual(attempts.map((call) => call.time - attempts[0].time), [0, 1000, 3000, 7000]);
  }
  assert.equal(capture.output(), "");
  assert.equal(capture.diagnostic(), "读取暂时失败，正在有限重试。\n读取已恢复。\n".repeat(2));
  assert.doesNotMatch(capture.diagnostic(), /private-|\/api\/|cookie|transport|request_timeout/i);
});

test("ACC-RETRY-ERROR-PRESERVE/HISTORY: completeHistory head-detail exhaustion preserves HTTP 503 without replaying before", async (t) => {
  clock(t); let pages = 0; let details = 0;
  const { api } = await connection(t, { request: async (_origin, path) => {
    if (path.includes("/messages/")) { details++; return jsonResult({}, 503); }
    pages++;
    return jsonResult(page([msg("base", 0, null), msg("previous", 1, "base")], 20,
      { session: agentSession({ revision: 20, headMessageId: "later" }) }));
  } });
  const frame = await startHistory(api, "w", "s", parseTimeline(page([msg("tail", 2, "previous")], 10, { hasMore: true }), "w", "s"));
  const error = await finish(t, completeHistory(api, frame, { mode: "last", count: Number.MAX_SAFE_INTEGER }).catch((error: unknown) => error));
  assert.ok(error instanceof CliError); assert.equal(error.details.code, "HTTP_REJECTED");
  assert.deepEqual(error.retryEvidence, { kind: "http_status", status: 503 });
  assert.equal(pages, 1); assert.equal(details, 4); assert.deepEqual([...frame.messages.keys()], ["tail"]);
});

test("ACC-RETRY-SCOPE: actual ordinary query commands do not opt in", async () => {
  for (const args of [["workspace", "list"], ["agent", "list", "-w", "w"],
    ["session", "show", "-w", "w", "-s", "s"], ["session", "status", "-w", "w", "-s", "s"],
    ["session", "messages", "-w", "w", "-s", "s", "-n", "1"]]) {
    const capture = captureIO(); let calls = 0;
    assert.equal(await runCli([...args], { io: capture.io, createConfigStore: () => connectionStore(),
      http: { request: async () => { calls++; return jsonResult({}, 503); } } }), 6);
    assert.equal(calls, 1); assert.doesNotMatch(capture.diagnostic(), /有限重试/);
  }
});

test("ACC-RETRY-SCOPE: new-session send never replays creation after preparation recovers", async (t) => {
  clock(t); const capture = captureIO(); let agents = 0; const posts: string[] = [];
  const code = runCli(["session", "send", "-w", "w", "--prompt", "hello", "-f"], {
    io: capture.io, createConfigStore: () => connectionStore(), http: { request: async (_origin, path, request) => {
      if (request!.method === "POST") { posts.push(path); return jsonResult({}, 503); }
      agents++; return agents === 1 ? jsonResult({}, 502) : jsonResult({ agents: [{ id: "a", name: "Agent", summary: "" }] });
    } }
  });
  assert.equal(await finish(t, code), 6); assert.equal(agents, 2); assert.deepEqual(posts, ["/api/agent/sessions"]);
});

test("ACC-RETRY-OUTPUT: stdout write failure stops the CLI without another read or remote cancellation", async (t) => {
  clock(t); const capture = captureIO(); const paths: string[] = [];
  const stdout = new Writable({ write(_text, _encoding, callback) { callback(Object.assign(new Error("private output failure"), { code: "EPIPE" })); } });
  const result = runCli(["session", "messages", "-w", "w", "-s", "s", "-n", "1", "-f"], {
    io: { ...capture.io, stdout }, createConfigStore: () => connectionStore(), http: { request: async (_origin, path) => {
      paths.push(path); return path.includes("/run-state") ? jsonResult(state("r")) : jsonResult(page([msg("m", 0, null)]));
    } }
  });
  assert.equal(await finish(t, result), 141); assert.equal(paths.length, 2);
  assert.ok(paths.every((path) => !path.includes("/cancel") && !path.includes("mode=delta")));
  assert.doesNotMatch(capture.diagnostic(), /有限重试|private output/);
});

test("ACC-RETRY-INTERRUPT/OUTPUT: lifetime deadline interrupts a blocked diagnostic before its 250ms budget", async (t) => {
  clock(t); let calls = 0; let writes = 0;
  const stderr = new Writable({ write(_text, _encoding, _callback) { writes++; } });
  const { api, lifetime } = await connection(t, { request: async () => { calls++; return jsonResult({}, 503); } }, connectionStore(), stderr);
  lifetime.begin(100);
  const result = read(api).catch((error: unknown) => error); await flush();
  await advance(t, 99); assert.equal(stderr.destroyed, false);
  await advance(t, 1);
  const error = await result;
  assert.ok(error instanceof CliError); assert.equal(error.exitCode, 10); assert.equal(stderr.destroyed, true);
  await advance(t, 10_000); assert.equal(calls, 1); assert.equal(writes, 1);
});

test("ACC-RETRY-CONTRACT/RENEW: malformed renewal blocks a retryable status; configuration is never retried", async (t) => {
  clock(t); let calls = 0;
  const { api } = await connection(t, { request: async () => { calls++; return jsonResult({}, 503, ["awb_session=invalid; Path=/"]); } });
  await assert.rejects(read(api), (error: unknown) => error instanceof CliError
    && error.details.code === "HTTP_REJECTED" && error.retryEvidence?.kind === "blocked");
  assert.equal(calls, 1);
  let loads = 0;
  await assert.rejects(AgentApi.connect({
    config: { load: async () => { loads++; throw new Error("private config failure"); }, save: async () => assert.fail("no save") },
    http: { request: async () => assert.fail("no request") }
  }), (error: unknown) => error instanceof CliError && error.exitCode === 3 && !error.message.includes("private"));
  assert.equal(loads, 1);
});

for (const status of [429, 502, 503, 504]) test(`ACC-RETRY-HTTP/FIXED: HTTP ${status} exhausts four attempts without parsing its body`, async (t) => {
  clock(t); const times: number[] = [];
  const http = new HttpClient(async () => {
    times.push(Date.now());
    return new Response("private invalid JSON body", { status, headers: { "Retry-After": "86400" } });
  });
  const { api, capture } = await connection(t, http);
  const failure = read(api).catch((error: unknown) => error);
  const error = await finish(t, failure);
  assert.ok(error instanceof CliError);
  assert.equal(error.details.code, "HTTP_REJECTED");
  assert.equal(error.details.phase, "history");
  assert.deepEqual(error.retryEvidence, { kind: "http_status", status });
  assert.deepEqual(times, [0, 1000, 3000, 7000]);
  assert.equal(capture.diagnostic(), "读取暂时失败，正在有限重试。\n");
  assert.doesNotMatch(errorDiagnostic(error), /private|86400|retryEvidence|http_status/);
});

for (const status of [300, 302, 400, 401, 403, 404, 409, 500, 501]) test(`ACC-RETRY-HTTP: non-whitelisted HTTP ${status} is one attempt`, async (t) => {
  clock(t); let calls = 0;
  const { api, capture } = await connection(t, { request: async () => { calls++; return jsonResult({ code: "TIMELINE_CURSOR_NOT_FOUND" }, status); } });
  await assert.rejects(read(api), (error: unknown) => error instanceof CliError && error.details.code === (status === 401 ? "AUTH_REQUIRED" : "HTTP_REJECTED"));
  assert.equal(calls, 1); assert.equal(capture.diagnostic(), "");
});

test("ACC-RETRY-CONTRACT: invalid JSON/schema/identity/result and numeric exit code alone never enable retry", async (t) => {
  clock(t);
  for (const failure of [undefined, responseError("响应身份无效。"), new CliError(5, "不含来源证据。"), new CliError(6, "输出失败。"), new CliError(7, "保存失败。", {}, { kind: "blocked" })]) {
    let calls = 0;
    const { api } = await connection(t, { request: async () => { calls++; return { status: 200, body: failure ? "{}" : "not JSON", setCookies: [] }; } });
    await assert.rejects(api.json("/api/read", { phase: "history", validate: () => { throw failure; } }));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const { api } = await connection(t, { request: async () => { calls++; return jsonResult({ runId: "wrong", status: "completed", code: "not_allowed" }); } });
  await assert.rejects(api.json("/api/read", { phase: "follow", validate: () => { throw responseError("Run 身份或终态码无效。"); } }));
  assert.equal(calls, 1);
});

test("ACC-RETRY-TRANSPORT: real HttpClient distinguishes fetch failure, body interruption, and fresh attempt timeout", async (t) => {
  clock(t);
  let calls = 0; const signals: AbortSignal[] = []; const starts: number[] = [];
  const http = new HttpClient(async (_url, options) => {
    calls++; starts.push(Date.now()); signals.push(options!.signal!);
    if (calls === 1) throw new TypeError("private fetch reason");
    if (calls === 2) return new Response(new ReadableStream({ start(controller) { controller.error(new Error("private body reason")); } }));
    if (calls === 3) return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("private timeout reason")), { once: true }));
    return new Response('{"ok":true}');
  }, 50);
  const { api } = await connection(t, http);
  const pending = read(api); await flush();
  await advance(t, 1000); assert.equal(calls, 2);
  await advance(t, 2000); assert.equal(calls, 3);
  await advance(t, 49); assert.equal(calls, 3);
  await advance(t, 1); assert.equal(signals[2].aborted, true);
  await advance(t, 3999); assert.equal(calls, 3);
  await advance(t, 1);
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(starts, [0, 1000, 3000, 7050]);
  assert.equal(new Set(signals).size, 4, "each native attempt owns a new timeout/controller");
});

test("ACC-RETRY-RENEW: persisted renewal feeds only the next attempt without changing business parameters", async (t) => {
  clock(t); let calls = 0; const saved: unknown[] = [];
  const config = connectionStore(); config.save = async (value) => { saved.push(value); };
  const { api } = await connection(t, { request: async (_origin, path, request) => {
    calls++; assert.equal(path, "/api/read?sinceRevision=4&run=r");
    assert.equal(request!.cookie?.value, calls === 1 ? undefined : cookieValue);
    return calls === 1 ? jsonResult({}, 503, [cookieHeader]) : jsonResult({ ok: true });
  } }, config);
  const result = await finish(t, read(api, "/api/read?sinceRevision=4&run=r"));
  assert.deepEqual(result, { ok: true }); assert.equal(calls, 2); assert.equal(saved.length, 1);
});

for (const status of [200, 401, 500, 503]) test(`ACC-RETRY-RENEW/ERROR-PRESERVE: HTTP ${status} plus failed local save is blocked`, async (t) => {
  clock(t); let calls = 0; let saves = 0;
  const config = connectionStore(); config.save = async () => { saves++; throw new Error("private storage exception"); };
  const { api, capture } = await connection(t, { request: async () => { calls++; return jsonResult({ ok: true }, status, [cookieHeader]); } }, config);
  await assert.rejects(read(api), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, status === 200 ? 7 : status === 401 ? 4 : 6);
    assert.equal(error.details.code, status === 200 ? "COOKIE_SAVE_FAILED" : status === 401 ? "AUTH_REQUIRED" : "HTTP_REJECTED");
    assert.deepEqual(error.retryEvidence, { kind: "blocked" });
    assert.match(error.message, /保存续签凭证/); assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.equal(calls, 1); assert.equal(saves, 1); assert.equal(capture.diagnostic(), "");
});

test("ACC-RETRY-SCOPE: opt-in API never retries POST or stream and ordinary API remains single-shot", async (t) => {
  clock(t); let calls = 0; let streams = 0;
  const http: HttpTransport = {
    request: async () => { calls++; return jsonResult({}, 503); },
    stream: async (_origin, _path, _request, consume) => { streams++; return consume({ status: 503, headers: new Headers(), setCookies: [], body: null, signal: new AbortController().signal }); }
  };
  const { api, capture } = await connection(t, http);
  await assert.rejects(api.json("/api/write", { method: "POST", body: { clientRequestId: "same" }, phase: "send", validate: (v) => v }));
  await assert.rejects(api.stream("/api/download", { phase: "download", context: {}, consume: async () => assert.fail("no successful body") }));
  const ordinary = await AgentApi.connect({ config: connectionStore(), http });
  await assert.rejects(read(ordinary));
  assert.equal(calls, 2); assert.equal(streams, 1); assert.equal(capture.diagnostic(), "");
});

test("ACC-RETRY-ERROR-PRESERVE: wrapping retains evidence internally; lifetime stop overrides it without publishing it", async (t) => {
  const { capture, lifetime } = await connection(t, { request: async () => jsonResult({}) });
  const original = classified("request_timeout");
  const wrapped = withErrorDetails(original, { phase: "follow", effect: "accepted", context: { workspaceId: "w", sessionId: "s", runId: "r" } });
  const output = new FollowOutput(capture.io, lifetime, { workspaceId: "w", sessionId: "s", runId: "r", clientRequestId: "request" }, "r");
  const final = output.error(wrapped);
  assert.deepEqual(final.retryEvidence, { kind: "request_timeout" });
  assert.equal(final.details.effect, "accepted");
  assert.doesNotMatch(JSON.stringify(errorObject(final)) + errorDiagnostic(final), /retryEvidence|request_timeout/);
  lifetime.begin(0);
  const stopped = lifetime.failure(final);
  assert.ok(stopped instanceof CliError); assert.equal(stopped.exitCode, 10); assert.deepEqual(stopped.retryEvidence, { kind: "blocked" });
  assert.equal(stopped.details.effect, "accepted"); assert.deepEqual(stopped.details.context, final.details.context);
});

for (const stop of ["SIGINT", "SIGTERM", "EPIPE", "deadline"] as const) for (const position of [0, 1, 2, "inflight"] as const) {
  test(`ACC-RETRY-INTERRUPT/TIMEOUT: ${stop} interrupts ${position === "inflight" ? "in-flight request" : `backoff ${position + 1}`}`, async (t) => {
    clock(t); let calls = 0;
    const { api, capture, lifetime, external } = await connection(t, { request: async (_origin, _path, request) => {
      calls++;
      if (position === "inflight") return new Promise((_resolve, reject) => request!.signal!.addEventListener("abort", () => reject(classified("transport")), { once: true }));
      return jsonResult({}, 503);
    } });
    const result = read(api).catch((error: unknown) => error); await flush();
    if (position !== "inflight") for (let n = 0; n < position; n++) await advance(t, [1000, 2000][n]);
    const expectedCalls = calls;
    if (stop === "SIGINT") external.abort();
    else if (stop === "SIGTERM") process.emit("SIGTERM");
    else if (stop === "EPIPE") capture.io.stdout.emit("error", Object.assign(new Error("private pipe reason"), { code: "EPIPE" }));
    else lifetime.begin(0);
    const error = await result;
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, stop === "SIGINT" ? 130 : stop === "SIGTERM" ? 143 : stop === "EPIPE" ? 141 : 10);
    assert.deepEqual(error.retryEvidence, { kind: "blocked" });
    await advance(t, 10_000); assert.equal(calls, expectedCalls);
  });
}

test("ACC-RETRY-OUTPUT: unread stderr has a 250ms bound and disables future hints without failing reads", async (t) => {
  clock(t); let writes = 0; const stderr = new Writable({ write(_text, _encoding, _callback) { writes++; } });
  let calls = 0; const times: number[] = [];
  const { api } = await connection(t, { request: async () => { calls++; times.push(Date.now()); return jsonResult({ ok: true }, calls % 2 ? 503 : 200); } }, connectionStore(), stderr);
  const first = read(api); await flush(); assert.equal(calls, 1);
  await advance(t, 249); assert.equal(calls, 1); assert.equal(stderr.destroyed, false);
  await advance(t, 1); assert.equal(stderr.destroyed, true);
  await advance(t, 999); assert.equal(calls, 1);
  await advance(t, 1); assert.deepEqual(await first, { ok: true });
  const second = read(api); await flush(); await advance(t, 1000); assert.deepEqual(await second, { ok: true });
  assert.equal(writes, 1); assert.deepEqual(times, [0, 1250, 1250, 2250]);
});

for (const broken of ["closed", "error"] as const) test(`ACC-RETRY-OUTPUT: ${broken} stderr cannot replace a request result or restart retry`, async (t) => {
  clock(t); let writes = 0; let calls = 0;
  const stderr = new Writable({ write(_text, _encoding, callback) { writes++; callback(Object.assign(new Error("private diagnostic failure"), { code: "EPIPE" })); } });
  if (broken === "closed") { stderr.destroy(); await flush(); }
  const { api } = await connection(t, { request: async () => { calls++; return jsonResult({ ok: true }, calls === 1 ? 503 : 200); } }, connectionStore(), stderr);
  assert.deepEqual(await finish(t, read(api)), { ok: true });
  assert.equal(calls, 2); assert.equal(writes, broken === "closed" ? 0 : 1);
});

// Actual CLI entry paths, not merely HttpClient tests: every failed logical GET
// keeps its original route while successful pages/refreshes are not replayed.
test("ACC-RETRY-INIT-DRAIN/NO-REPLAY/PARAMS: initialization, third page, Run read and terminal drain all opt in", async (t) => {
  clock(t); const capture = captureIO();
  const messages = Array.from({ length: 230 }, (_, n) => msg(`m${n}`, n, n === 0 ? null : `m${n - 1}`));
  const calls: { path: string; time: number }[] = [];
  const counts = new Map<string, number>();
  const result = runCli(["session", "messages", "-w", "w", "-s", "s", "-n", "230", "-f"], {
    io: capture.io, createConfigStore: () => connectionStore(), http: { request: async (_origin, path) => {
      calls.push({ path, time: Date.now() });
      const n = (counts.get(path) ?? 0) + 1; counts.set(path, n);
      if (n % 4) return jsonResult({}, 503);
      const url = new URL(path, "http://fixture.test");
      if (url.pathname.endsWith("/run-state")) return jsonResult(state("r"));
      if (url.pathname.endsWith("/runs/r")) return jsonResult(run());
      if (url.searchParams.get("mode") === "delta") return jsonResult(page([], 10, { session: agentSession({ revision: 10, headMessageId: "m229" }) }));
      return jsonResult(paged(messages, url));
    } }
  });
  assert.equal(await finish(t, result), 0, capture.diagnostic());
  assert.equal(counts.size, 6, "snapshot, two before pages, run-state, fixed Run, one fixed delta query");
  for (const [path, count] of counts) {
    assert.equal(count, path.includes("mode=delta") ? 16 : 4, path);
    const attempts = calls.filter((call) => call.path === path);
    for (let n = 0; n < count; n += 4) assert.deepEqual(attempts.slice(n, n + 4).map((call) => call.time - attempts[n].time), [0, 1000, 3000, 7000]);
  }
  assert.equal(capture.output().match(/Session ID：s/g)?.length, 1);
  assert.equal(messageIds(capture.output()).length, 230);
  assert.equal(capture.output().match(/监听结束：/g)?.length, 1);
  assert.equal(textField(capture.output(), "complete"), "true");
  assert.equal(capture.diagnostic(), "读取暂时失败，正在有限重试。\n读取已恢复。\n".repeat(9));
});

test("ACC-RETRY-INIT-DRAIN: idle bounded OPEN and CHECK can recover without becoming a future Run listener", async (t) => {
  clock(t); const capture = captureIO(); let snapshots = 0;
  const code = runCli(["session", "messages", "-w", "w", "-s", "s", "-n", "1", "-f"], {
    io: capture.io, createConfigStore: () => connectionStore(), http: { request: async (_origin, path) => {
      if (path.includes("/run-state")) return jsonResult(state());
      if (path.includes("/runs/r")) return jsonResult(run());
      snapshots++; return snapshots > 1 && snapshots < 5 ? jsonResult({}, 502) : jsonResult(page([msg("m", 0, null)]));
    } }
  });
  assert.equal(await finish(t, code), 0, capture.diagnostic()); assert.equal(snapshots, 6);
  assert.match(capture.output(), /no_active_run/);
});

test("ACC-RETRY-INIT-DRAIN: terminal exhaustion preserves known Run result and original HTTP classification", async (t) => {
  clock(t); const capture = captureIO(); let deltas = 0;
  const code = runCli(["session", "messages", "-w", "w", "-s", "s", "-n", "1", "-f"], {
    io: capture.io, createConfigStore: () => connectionStore(), http: { request: async (_origin, path) => {
      if (path.includes("/run-state")) return jsonResult(state("r"));
      if (path.includes("/runs/r")) return jsonResult(run());
      if (path.includes("mode=delta") && ++deltas > 1) return jsonResult({}, 503);
      return jsonResult(page([msg("m", 0, null)]));
    } }
  });
  assert.equal(await finish(t, code), 6); assert.equal(deltas, 5);
  const terminal = capture.output();
  assert.equal(textField(terminal, "complete"), "false"); assert.equal(textField(terminal, "runStatus"), "completed"); assert.equal(textField(terminal, "resultCode"), "run_completed");
  const diagnostic = capture.diagnostic();
  assert.equal(textField(diagnostic, "code"), "HTTP_REJECTED"); assert.equal(textField(diagnostic, "phase"), "history");
});

test("ACC-RETRY-TIMEOUT: messages overall deadline includes initialization and its retry wait", async (t) => {
  clock(t); const capture = captureIO(); let calls = 0;
  const code = runCli(["session", "messages", "-w", "w", "-s", "s", "-n", "1", "-f", "--follow-timeout", "1s"], {
    io: capture.io, createConfigStore: () => connectionStore(), http: { request: async () => { calls++; return jsonResult({}, 503); } }
  });
  assert.equal(await finish(t, code), 10); assert.equal(calls, 1); assert.equal(capture.output(), "");
  assert.equal(textField(capture.diagnostic(), "code"), "FOLLOW_TIMEOUT");
});

for (const command of ["send", "compact"] as const) test(`ACC-RETRY-SCOPE: ${command} follow retries read preparation but never its POST`, async (t) => {
  clock(t); const capture = captureIO(); const counts = new Map<string, number>(); let posts = 0;
  const code = runCli(["session", command, "-w", "w", "-s", "s", ...(command === "send" ? ["--prompt", "hello"] : []), "-f"], {
    io: capture.io, createConfigStore: () => connectionStore(), http: { request: async (_origin, path, request) => {
      const n = (counts.get(path) ?? 0) + 1; counts.set(path, n);
      if (request!.method === "POST") { posts++; return jsonResult({}, 503); }
      if (n === 1) return jsonResult({}, 503);
      if (path.includes("/agents/available")) return jsonResult({ agents: [{ id: "a", name: "Agent", summary: "" }] });
      if (path.includes("/run-state")) return jsonResult(state());
      return jsonResult(agentSession());
    } }
  });
  assert.equal(await finish(t, code), 6); assert.equal(posts, 1);
  for (const [path, count] of counts) assert.equal(count, path.includes("/messages") || path.includes("/compact") ? 1 : 2, path);
  assert.equal(capture.output(), "");
});

test("ACC-RETRY-ERROR-PRESERVE/HISTORY: completeHistory before exhaustion preserves HTTP 503 and its fixed cursor", async (t) => {
  clock(t); let calls = 0;
  const { api } = await connection(t, { request: async () => { calls++; return jsonResult({}, 503); } });
  const frame = await startHistory(api, "w", "s", parseTimeline(page([msg("tail", 2, "previous")], 10, { hasMore: true }), "w", "s"));
  const result = completeHistory(api, frame, { mode: "last", count: Number.MAX_SAFE_INTEGER }).catch((error: unknown) => error);
  const error = await finish(t, result);
  assert.ok(error instanceof CliError); assert.equal(error.details.code, "HTTP_REJECTED"); assert.equal(error.details.phase, "history");
  assert.deepEqual(error.retryEvidence, { kind: "http_status", status: 503 }); assert.equal(calls, 4);
  assert.deepEqual([...frame.messages.keys()], ["tail"]);
  assert.equal(frame.initial.session.revision, 10); assert.equal(frame.nextBeforeMessageId, "tail");
});

for (const failure of ["exhausted HTTP 503", "successful response save failure", "HTTP 503 save failure"] as const) {
  test(`ACC-RETRY-ERROR-PRESERVE/STATE: FollowState ${failure} retains committed cursor and never replays body or ID`, async (t) => {
    clock(t); let failing = true; let attempts = 0; let saves = 0;
    const deltaMarks: string[] = [];
    const config = connectionStore(); config.save = async () => { saves++; throw new Error("fixture local save failure"); };
    const old = msg("ALREADY-RELEASED", 1, "BASE", { status: "completed", originRunId: "r", updatedRevision: 10 });
    const next = msg("NEXT-ANSWER", 2, old.id, { status: "completed", originRunId: "r", updatedRevision: 20 });
    const fullBefore = page([msg("BASE", 0, null, { originRunId: null }), old], 20,
      { session: agentSession({ revision: 20, headMessageId: next.id }) });
    const { api, capture, lifetime } = await connection(t, { request: async (_origin, path) => {
      const url = new URL(path, "http://fixture.test");
      if (url.pathname.includes("/runs/")) return jsonResult(run("r", "running"));
      if (url.searchParams.get("mode") === "delta") {
        const mark = url.searchParams.get("sinceRevision")!; deltaMarks.push(mark);
        return jsonResult(mark === "10" ? page([next], 20, { timelineReset: true, hasMore: true })
          : page([], 20, { session: agentSession({ revision: 20, headMessageId: next.id }) }));
      }
      assert.equal(url.searchParams.get("mode"), "before"); attempts++;
      if (!failing) return jsonResult(fullBefore);
      return failure === "exhausted HTTP 503" ? jsonResult({}, 503)
        : jsonResult(fullBefore, failure === "successful response save failure" ? 200 : 503, [cookieHeader]);
    } }, config);
    const frame = await startHistory(api, "w", "s", parseTimeline(page([old], 10, { hasMore: true }), "w", "s"));
    const output = new FollowOutput(capture.io, lifetime, { workspaceId: "w", sessionId: "s" }, "r");
    const follow = new FollowState(frame, "r", { anchor: null, selection: { mode: "last", count: 1 }, includeInitialRun: true }, output);
    const probe = () => readRun(api, "w", "s", "r");
    await follow.initialize(api, probe);
    const committedFrame = follow.frame;
    const beforeOutput = capture.output();
    const error = await finish(t, follow.refresh(api, probe).catch((error: unknown) => error));
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, failure === "successful response save failure" ? 7 : 6);
    assert.equal(error.details.code, failure === "successful response save failure" ? "COOKIE_SAVE_FAILED" : "HTTP_REJECTED");
    assert.equal(error.details.phase, "history");
    assert.deepEqual(error.retryEvidence, failure === "exhausted HTTP 503" ? { kind: "http_status", status: 503 } : { kind: "blocked" });
    assert.equal(attempts, failure === "exhausted HTTP 503" ? 4 : 1); assert.equal(saves, failure === "exhausted HTTP 503" ? 0 : 1);
    assert.equal(follow.frame, committedFrame); assert.equal(follow.frame.initial.session.revision, 10);
    assert.deepEqual([...follow.frame.messages.keys()], [old.id]); assert.equal(follow.frame.nextBeforeMessageId, old.id);
    assert.equal(capture.output(), beforeOutput); assert.deepEqual([...output.emitted.keys()], [old.id]);
    assert.deepEqual([...output.released], [old.id]); assert.deepEqual(deltaMarks, ["10"]);
    // This explicit caller-driven resume is not an automatic retry after exhaustion.
    // Its first read must still use committed 10, not the failed reset's 20.
    failing = false; await finish(t, follow.refresh(api, probe));
    assert.deepEqual(deltaMarks, ["10", "10", "20"]);
    assert.deepEqual(messageIds(capture.output()), [old.id, next.id]);
    assert.equal(capture.output().split(`body ${old.id}`).length, 2);
    assert.equal(capture.output().split(`body ${next.id}`).length, 2);
  });
}

for (const kind of ["cursor missing", "ordinary 404", "renewal save", "HTTP 503 plus save"] as const) {
  test(`ACC-RETRY-ERROR-PRESERVE/HISTORY: completeHistory classifies ${kind} at its production reader boundary`, async (t) => {
    clock(t); let calls = 0;
    const config = connectionStore(); config.save = async () => { throw new Error("fixture save failure"); };
    const { api } = await connection(t, { request: async () => {
      calls++;
      if (kind === "cursor missing") return jsonResult({ code: "TIMELINE_CURSOR_NOT_FOUND", message: "fixture missing" }, 404);
      if (kind === "ordinary 404") return jsonResult({}, 404);
      return jsonResult(page([msg("BASE", 0, null)], 10), kind === "renewal save" ? 200 : 503, [cookieHeader]);
    } }, config);
    const frame = await startHistory(api, "w", "s", parseTimeline(page([msg("TAIL", 1, "BASE")], 10, { hasMore: true }), "w", "s"));
    const error = await finish(t, completeHistory(api, frame, { mode: "last", count: 2 }).catch((error: unknown) => error));
    assert.ok(error instanceof CliError);
    assert.equal(error.details.code, kind === "cursor missing" ? "TIMELINE_CHANGED" : kind === "renewal save" ? "COOKIE_SAVE_FAILED" : "HTTP_REJECTED");
    assert.equal(error.details.phase, "history"); assert.equal(calls, 1);
    assert.equal(frame.initial.session.revision, 10); assert.deepEqual([...frame.messages.keys()], ["TAIL"]);
    if (kind.includes("save")) assert.deepEqual(error.retryEvidence, { kind: "blocked" });
  });
}
