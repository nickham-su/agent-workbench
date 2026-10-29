import assert from "node:assert/strict";
import test from "node:test";
import { CliError } from "../src/errors.js";
import { agentSession, jsonResult, messagePart } from "./agent-fixture.js";
import { executeFollow, msg, page, paged, run, state, type Handler, type RawMessage } from "./follow-fixture.js";
const args = ["messages", "-w", "w", "-s", "s", "-n", "1", "-f"];
const ids = (result: Awaited<ReturnType<typeof executeFollow>>) => result.events.filter((event) => event.type === "message").map((event) => (event.message as RawMessage).id);
function terminal(result: Awaited<ReturnType<typeof executeFollow>>, code: number, complete: boolean, outcome: string) {
  assert.equal(result.code, code, result.stderr); assert.equal(result.events[0].type, "metadata"); assert.equal(result.events.at(-1)?.type, "terminal");
  assert.equal(result.events.at(-1)?.complete, complete); assert.equal(result.events.at(-1)?.outcome, outcome);
  assert.equal(result.events.filter((event) => event.type === "terminal").length, 1);
  if (result.stderr && result.events[0].runId) assert.equal(JSON.parse(result.stderr).error.context.runId, result.events[0].runId);
  assert.equal(result.requests.filter(({ url }) => url.pathname.endsWith("/cancel")).length, 0);
}
function activeHandler(initial: RawMessage[], updates: (index: number) => ReturnType<typeof page>, terminalStatus = "completed", runId = "r"): Handler {
  let delta = 0;
  return (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state(runId));
    if (url.pathname.includes("/runs/")) { assert.ok(url.pathname.endsWith(`/runs/${runId}`)); return jsonResult(run(runId, terminalStatus)); }
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page(initial, 10));
    assert.equal(url.searchParams.get("mode"), "delta"); return jsonResult(updates(++delta));
  };
}

test("A-FOLLOW-UPDATES/METADATA: revisions are complete JSONL upserts, human prints one marker and final body once", async () => {
  for (const json of [true, false]) {
    const initial = msg("a", 0, null, { status: "streaming", parts: [messagePart("a", "text", { text: "partial" })] });
    const updates = (index: number) => page([msg("a", 0, null, { updatedRevision: 10 + index, status: index === 1 ? "streaming" : "completed", parts: [messagePart("a", "text", { text: index === 1 ? "partial longer" : "final\n完整\u001b[31m" })] })], 10 + index);
    const result = await executeFollow(args, activeHandler([initial], updates), json);
    assert.equal(result.code, 0, result.stderr);
    if (json) {
      terminal(result, 0, true, "run_completed");
      const views = result.events.filter((event) => event.type === "message").map((event) => event.message as RawMessage);
      assert.deepEqual(views.map((view) => view.updatedRevision), [1, 11, 12]);
      assert.deepEqual(result.events.filter((event) => event.type === "message").map((event) => event.source), ["history", "follow", "follow"]);
      assert.equal((views.at(-1)!.parts[0] as { text: string }).text, "final\n完整\u001b[31m");
      assert.equal(result.events[0].agentId, undefined);
    } else { assert.match(result.stdout, /Message ID：a；生成中\n/); assert.doesNotMatch(result.stdout, /尚非最终正文/); assert.equal(result.stdout.split("生成中").length, 2); assert.equal(result.stdout.split("final").length, 2); assert.equal(result.stdout.includes("partial"), false); assert.equal(result.stdout.includes("\u001b"), false); }
  }
});

test("A-FOLLOW-TERMINALS/DRAIN: completed/failed/cancelled drain after status, complete and result are independent", async () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    const initial = msg("a", 0, null);
    const result = await executeFollow(args, activeHandler([initial], () => page([], 11, { session: agentSession({ headMessageId: "a", revision: 11 }) }), status));
    terminal(result, status === "completed" ? 0 : status === "failed" ? 8 : 9, true, `run_${status}`);
    const at = result.requests.findIndex(({ url }) => url.pathname.includes("/runs/"));
    assert.ok(result.requests.slice(at + 1).some(({ url }) => url.searchParams.get("mode") === "delta"));
    assert.equal(result.events.at(-1)?.runStatus, status);
  }
});

test("A-FOLLOW-DRAIN/NETWORK: final read failures override known Run terminal and never retry", async () => {
  for (const code of [4, 5, 6]) {
    let deltas = 0;
    const base = activeHandler([msg("a", 0, null)], () => page([], 11, { session: agentSession({ headMessageId: "a", revision: 11 }) }));
    const result = await executeFollow(args, (url, request) => {
      if (url.searchParams.get("mode") === "delta" && ++deltas === 2) {
        if (code === 5) throw new CliError(5, "fixture interrupted");
        return jsonResult({}, code === 4 ? 401 : 503);
      }
      return base(url, request);
    });
    terminal(result, code, false, "observation_failed"); assert.equal(deltas, 2); assert.equal(result.events.at(-1)?.runStatus, "completed"); assert.equal(result.events.at(-1)?.resultCode, "run_completed");
  }
});

test("A-FOLLOW-SWITCH: later nullable user and other Run messages cannot change fixed target or enter follow", async () => {
  const a = msg("a", 0, null, { status: "streaming", originRunId: "r1" });
  const finished = { ...a, status: "completed", updatedRevision: 11 };
  const later = [finished, msg("u2", 1, "a", { type: "user", originRunId: null }), msg("a2", 2, "u2", { originRunId: "r2" })];
  const result = await executeFollow(args, activeHandler([a], (index) => index === 1 ? page(later, 11) : page([], 11, { session: agentSession({ headMessageId: "a2", revision: 11 }) }), "completed", "r1"));
  terminal(result, 0, true, "run_completed"); assert.deepEqual(ids(result), ["a", "a"]);
  assert.equal(result.requests.some(({ url }) => url.pathname.includes("/runs/r2")), false);
});

test("A-FOLLOW-FAST: accepted send anchors through >500 rows before first polling, all target answers emitted", async () => {
  const all = [msg("u", 0, null, { type: "user", originRunId: null })];
  for (let i = 1; i <= 510; i++) all.push(msg(`a${i}`, i, all.at(-1)!.id));
  const result = await executeFollow(["send", "-w", "w", "-s", "s", "--prompt", "fixture", "-f"], (url, request) => {
    if (url.pathname.endsWith("/agents/available")) return jsonResult({ agents: [{ id: "first", name: "first", summary: "" }, { id: "second", name: "second", summary: "" }] });
    if (url.pathname === "/api/agent/sessions/s") return jsonResult(agentSession());
    if (url.pathname.endsWith("/messages")) { assert.equal(request.method, "POST"); assert.equal((request.body as { agentId: string }).agentId, "first"); return jsonResult({ sessionId: "s", messageId: "u", runId: "r", deduplicated: false }, 201); }
    if (url.pathname.endsWith("/runs/r")) return jsonResult(run());
    if (url.searchParams.get("mode") === "delta") return jsonResult(page([], 10, { session: agentSession({ headMessageId: "a510", revision: 10 }) }));
    return jsonResult(paged(all, url));
  });
  terminal(result, 0, true, "run_completed"); assert.equal(ids(result).length, 510); assert.equal(new Set(ids(result)).size, 510);
  assert.equal(result.events[0].agentId, "first"); assert.ok(result.requests.filter(({ url }) => url.searchParams.get("mode") === "before").length >= 5);
  assert.equal(result.requests.filter(({ request }) => request.method === "POST").length, 1);
});

test("A-FOLLOW-RESET: compaction root reset tail rebuilds through initial/history anchors and never advances to before revision", async () => {
  const initial = [msg("a0", 0, null), msg("a1", 1, "a0"), msg("a2", 2, "a1")];
  const all = [...initial];
  for (let i = 3; i <= 210; i++) all.push(msg(`a${i}`, i, `a${i - 1}`, { updatedRevision: 11, ...(i === 100 ? { type: "compaction", retainedFromMessageId: null } : {}) }));
  let deltas = 0;
  const result = await executeFollow(["messages", "-w", "w", "-s", "s", "-n", "3", "-f"], (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r"));
    if (url.pathname.endsWith("/runs/r")) return jsonResult(run());
    const mode = url.searchParams.get("mode");
    if (mode === "snapshot") return jsonResult(page(initial, 10));
    if (mode === "delta" && ++deltas === 1) return jsonResult(paged(all, url, 11, { timelineReset: true, session: agentSession({ headMessageId: "a210", contextRootMessageId: "a100", revision: 11 }) }));
    if (mode === "before") return jsonResult(paged(all, url, 50, { session: agentSession({ headMessageId: "a210", contextRootMessageId: "a100", revision: 50 }) }));
    assert.equal(mode, "delta"); assert.equal(url.searchParams.get("sinceRevision"), "11");
    return jsonResult(page([], 12, { session: agentSession({ headMessageId: "a210", contextRootMessageId: "a100", revision: 12 }) }));
  });
  terminal(result, 0, true, "run_completed"); assert.equal(ids(result).length, 210); assert.equal(new Set(ids(result)).size, 210);
  assert.equal(ids(result).includes("a100"), false);
  assert.ok(result.requests.filter(({ url }) => url.searchParams.get("mode") === "before").length >= 2);
});

test("A-FOLLOW-UPDATES/TOOLS: delta may exceed limit, duplicate revisions deduplicate, tool-only becomes ordinary", async () => {
  const head = msg("h", 0, null, { parts: [messagePart("h", "tool_call")] });
  const all = [msg("h", 0, null, { updatedRevision: 11 }), ...Array.from({ length: 150 }, (_, index) => msg(`x${index}`, index + 1, index ? `x${index - 1}` : "h", { updatedRevision: 11 }))];
  const result = await executeFollow(args, activeHandler([head], () => page(all, 11)));
  terminal(result, 0, true, "run_completed"); assert.equal(ids(result).length, 151); assert.equal(new Set(ids(result)).size, 151);
});

test("A-FOLLOW-BRANCH/INVARIANT: reset lost anchor, superseded output, bad terminal and terminal streaming fail explicitly", async () => {
  for (const mode of ["lost", "superseded", "streaming", "badcode", "wrongscope", "notfound"]) {
    const a = msg("a", 0, null, { status: mode === "streaming" ? "streaming" : "completed" });
    const base = activeHandler([a], () => mode === "lost" ? page([msg("new", 0, null)], 11, { timelineReset: true }) : mode === "superseded" ? page([{ ...a, status: "superseded", updatedRevision: 11 }], 11) : page([], 11, { session: agentSession({ headMessageId: "a", revision: 11 }) }));
    const result = await executeFollow(args, (url, request) => url.pathname.includes("/runs/") && ["badcode", "wrongscope", "notfound"].includes(mode)
      ? jsonResult(mode === "badcode" ? run("r", "completed", "user", "compaction_completed") : { ...run(), sessionId: "other" }, mode === "notfound" ? 404 : 200) : base(url, request));
    terminal(result, 6, false, "observation_failed");
    assert.equal(JSON.parse(result.stderr).error.code, mode === "lost" || mode === "superseded" ? "TIMELINE_CHANGED" : mode === "streaming" ? "OBSERVATION_INCOMPLETE" : mode === "notfound" ? "HTTP_REJECTED" : "RESPONSE_INVALID");
  }
});

test("A-FOLLOW-DEADLINE: deadline aborts final response body and stops locally, request timeout stays distinct", async () => {
  const initial = msg("a", 0, null);
  for (const whole of [true, false]) {
    let deltas = 0;
    const base = activeHandler([initial], () => page([], 11, { session: agentSession({ headMessageId: "a", revision: 11 }) }));
    const result = await executeFollow([...args, "--follow-timeout", whole ? "1s" : "2s"], async (url, request) => {
      if (url.searchParams.get("mode") === "delta" && ++deltas === 2) {
        if (!whole) throw new CliError(5, "fixture per-request timeout", { code: "REQUEST_TIMEOUT" });
        return new Promise((_resolve, reject) => request.signal!.addEventListener("abort", () => reject(new CliError(5, "aborted fixture", { code: "TRANSPORT_FAILED" })), { once: true }));
      }
      return base(url, request);
    });
    terminal(result, whole ? 10 : 5, false, "observation_failed"); assert.equal(result.events.at(-1)?.runStatus, "completed");
    const diagnostic = JSON.parse(result.stderr).error;
    assert.equal(diagnostic.category, whole ? "FOLLOW_TIMEOUT" : "NETWORK");
    assert.equal(diagnostic.code, whole ? "FOLLOW_TIMEOUT" : "REQUEST_TIMEOUT");
  }
});

test("A-FOLLOW-SIGNALS: injected abort during poll returns 130, clears listeners, never cancels", async () => {
  const controller = new AbortController(); const a = msg("a", 0, null);
  const base = activeHandler([a], () => page([], 11, { session: agentSession({ headMessageId: "a", revision: 11 }) }));
  const result = await executeFollow(args, async (url, request) => {
    if (url.searchParams.get("mode") === "delta") { queueMicrotask(() => controller.abort()); return new Promise((_resolve, reject) => request.signal!.addEventListener("abort", () => reject(new CliError(5, "fixture abort", { code: "TRANSPORT_FAILED" })), { once: true })); }
    return base(url, request);
  }, true, controller.signal);
  terminal(result, 130, false, "interrupted");
  const diagnostic = JSON.parse(result.stderr).error;
  assert.equal(diagnostic.category, "INTERRUPTED"); assert.equal(diagnostic.code, "INTERRUPTED");
});

test("A-FOLLOW-UPDATES: serial running polls retain watermark and duplicate revisions do not repeat bodies", async () => {
  const a = msg("a", 0, null, { status: "streaming" }); let deltas = 0; let runs = 0;
  const result = await executeFollow(args, (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r"));
    if (url.pathname.endsWith("/runs/r")) return jsonResult(run("r", ++runs === 1 ? "running" : "completed"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([a], 10));
    deltas++;
    assert.equal(url.searchParams.get("sinceRevision"), deltas === 1 ? "10" : "11");
    return jsonResult(page([{ ...a, updatedRevision: deltas === 3 ? 12 : 11, status: deltas === 3 ? "completed" : "streaming" }], deltas === 3 ? 12 : 11));
  });
  terminal(result, 0, true, "run_completed"); assert.equal(runs, 2); assert.equal(deltas, 3);
  assert.deepEqual(result.events.filter((event) => event.type === "message").map((event) => (event.message as RawMessage).updatedRevision), [1, 11, 12]);
});

test("A-FOLLOW-INIT-RACE: selected old streaming history updates even when captured target belongs to next Run", async () => {
  const old = msg("old", 0, null, { originRunId: "r0", status: "streaming" });
  const final = [{ ...old, status: "completed", updatedRevision: 11 }, msg("u", 1, "old", { type: "user", originRunId: null, updatedRevision: 11 }), msg("a", 2, "u", { originRunId: "r1", updatedRevision: 11 })];
  let deltas = 0;
  const result = await executeFollow(args, (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) { assert.ok(url.pathname.endsWith("/runs/r1")); return jsonResult(run("r1")); }
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([old], 10));
    return jsonResult(++deltas === 1 ? page(final, 11) : page([], 11, { session: agentSession({ headMessageId: "a", revision: 11 }) }));
  });
  terminal(result, 0, true, "run_completed"); assert.deepEqual(ids(result), ["old", "old", "a"]);
});
