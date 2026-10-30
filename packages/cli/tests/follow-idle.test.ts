import assert from "node:assert/strict";
import test from "node:test";
import { jsonResult, messagePart } from "./agent-fixture.js";
import { executeFollow, idleHandler, msg, run, type RawMessage } from "./follow-fixture.js";

const args = ["messages", "-w", "w", "-s", "s", "-n", "1", "-f"];
function noWrites(requests: Awaited<ReturnType<typeof executeFollow>>["requests"]) { assert.equal(requests.filter(({ request }) => request.method === "POST").length, 0); }
function finalEvent(result: Awaited<ReturnType<typeof executeFollow>>, complete: boolean, outcome = complete ? "no_active_run" : "observation_failed") {
  assert.equal(result.events[0]?.type, "metadata"); assert.equal(result.events[0]?.runId, null);
  assert.equal(result.events.at(-1)?.type, "terminal"); assert.equal(result.events.at(-1)?.complete, complete); assert.equal(result.events.at(-1)?.outcome, outcome);
  assert.equal(result.events.filter((event) => event.type === "terminal").length, 1); noWrites(result.requests);
}
for (const json of [true, false]) {
  test(`A-FOLLOW-IDLE-EMPTY/USER-STABLE/INHERITED-STABLE: bounded success; json=${json}`, async () => {
    const user = msg("u-only", 0, null, { type: "user", originRunId: null });
    const inherited = msg("a-parent", 1, "u-parent", { originSessionId: "parent", originRunId: "r-parent" });
    const parent = msg("u-parent", 0, null, { type: "user", originSessionId: "parent", originRunId: null });
    for (const [chain, selector, expected] of [
      [[], ["-n", "1"], []], [[user], ["-n", "1"], [user.id]], [[user], ["--after", user.id], []], [[parent, inherited], ["-n", "1"], [inherited.id]]
    ] as [RawMessage[], string[], string[]][]) {
      const result = await executeFollow(["messages", "-w", "w", "-s", "s", ...selector, "-f"], idleHandler(chain, chain), json);
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, "");
      assert.equal(result.requests.filter(({ url }) => url.searchParams.get("mode") === "snapshot").length, 2);
      assert.equal(result.requests.filter(({ url }) => url.pathname.endsWith("/run-state")).length, 1);
      assert.equal(result.requests.filter(({ url }) => url.pathname.includes("/runs/")).length, 0); noWrites(result.requests);
      if (json) {
        finalEvent(result, true); assert.deepEqual(result.events.filter((event) => event.type === "message").map((event) => (event.message as { id: string }).id), expected);
        if (expected[0] === "a-parent") { const view = result.events.find((event) => event.type === "message")!.message as RawMessage; assert.equal(view.originSessionId, "parent"); assert.equal(view.originRunId, "r-parent"); }
      } else { assert.match(result.stdout, /no_active_run；complete=true/); for (const id of expected) assert.ok(result.stdout.includes(`body ${id}`)); }
    }
  });
  test(`A-FOLLOW-IDLE-APPEND-USER/OLD-RUN-BARRIER: nullable user never claims older or inferred Run; json=${json}`, async () => {
    for (const id of ["u1", "r1-user"]) for (const old of [false, true]) {
      const u0 = msg("u0", 0, null, { type: "user", originRunId: null });
      const a0 = msg("a0", 1, "u0", { originRunId: "r0" });
      const user = msg(id, old ? 2 : 0, old ? "a0" : null, { type: "user", originRunId: null });
      const first = old ? [u0, a0, user] : [user];
      const result = await executeFollow(args, idleHandler(first, [...first, msg("a1", user.depth + 1, id, { originRunId: "r1" })]), json);
      assert.equal(result.code, 6); assert.ok(result.stderr.includes("OBSERVATION_INCOMPLETE") || !json && result.stderr.includes("无法证明"));
      assert.equal(result.requests.filter(({ url }) => url.pathname.includes("/runs/")).length, 0);
      if (json) { finalEvent(result, false); assert.equal(result.events.filter((event) => event.type === "message").length, 0); }
      else assert.equal(result.stdout.includes(`body ${id}`), false);
    }
  });
}

test("A-FOLLOW-IDLE-COMPLETED: native streaming source is checked once, final body replaces prefetch", async () => {
  const initial = msg("a", 0, null, { status: "streaming", originRunId: "r1" });
  const final = { ...initial, status: "completed", updatedRevision: 20, parts: [messagePart("a", "text", { text: "最终正文" })] };
  for (const json of [true, false]) {
    const result = await executeFollow(args, idleHandler([initial], [final], (url) => { assert.ok(url.pathname.endsWith("/runs/r1")); return jsonResult(run("r1")); }), json);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.requests.filter(({ url }) => url.pathname.includes("/runs/")).length, 1);
    if (json) { finalEvent(result, true); const views = result.events.filter((event) => event.type === "message"); assert.equal(views.length, 1); assert.equal((views[0].message as RawMessage).status, "completed"); }
    else { assert.equal(result.stdout.split("最终正文").length, 2); assert.equal(result.stdout.includes("生成中"), false); }
  }
});

test("A-FOLLOW-IDLE-APPEND-SOURCED: completed text/tool-only H0 grows across pages; reselect last and after", async () => {
  for (const tools of [false, true]) for (const selector of [["-n", "1"], ["--after", "h0"]]) {
    const user = msg("u", 0, null, { type: "user", originRunId: null });
    const h0 = msg("h0", 1, "u", { originRunId: "r1", ...(tools ? { parts: [messagePart("h0", "tool_call")] } : {}) });
    const all = [user, h0];
    for (let i = 0; i < 205; i++) all.push(msg(`tool${i}`, i + 2, all.at(-1)!.id, { type: "runtime", originRunId: "r1", parts: [] }));
    all.push(msg("final", 207, all.at(-1)!.id, { originRunId: "r1", updatedRevision: 20 }));
    const result = await executeFollow(["messages", "-w", "w", "-s", "s", ...selector, "-f"], idleHandler([user, h0], all, (url) => { assert.ok(url.pathname.endsWith("/runs/r1")); return jsonResult(run("r1")); }));
    assert.equal(result.code, 0, result.stderr); finalEvent(result, true);
    assert.deepEqual(result.events.filter((event) => event.type === "message").map((event) => (event.message as RawMessage).id), ["final"]);
    assert.equal(result.requests.filter(({ url }) => url.pathname.includes("/runs/")).length, 1);
    assert.ok(result.requests.filter(({ url }) => url.searchParams.get("mode") === "before").length >= 2);
  }
});

test("A-FOLLOW-IDLE-NEXT/INCOMPLETE: proven other Run excluded, nullable barrier or interleaved original Run fails", async () => {
  const h0 = msg("h0", 0, null, { originRunId: "r1" });
  for (const kind of ["other", "nullable", "back"]) {
    const next = msg("next", 1, "h0", { originRunId: kind === "nullable" ? null : "r2", ...(kind === "nullable" ? { type: "user" } : {}) });
    const final = kind === "back" ? [h0, next, msg("back", 2, "next", { originRunId: "r1" })] : [h0, next];
    const result = await executeFollow(args, idleHandler([h0], final, (url) => { assert.ok(url.pathname.endsWith("/runs/r1")); return jsonResult(run("r1")); }));
    assert.equal(result.code, kind === "other" ? 0 : 6, result.stderr); finalEvent(result, kind === "other");
    assert.equal(result.requests.filter(({ url }) => url.pathname.includes("/runs/r2")).length, 0);
    if (kind === "other") assert.deepEqual(result.events.filter((event) => event.type === "message").map((event) => (event.message as RawMessage).id), ["h0"]);
  }
});

test("A-FOLLOW-IDLE-UNKNOWN/INCOMPLETE: unknown streaming, still-running source and empty-to-new cannot succeed", async () => {
  const cases: [RawMessage[], RawMessage[], boolean][] = [
    [[msg("a", 0, null, { status: "streaming", originRunId: null })], [msg("a", 0, null)], false],
    [[msg("a", 0, null, { status: "streaming", originSessionId: "parent" })], [msg("a", 0, null)], false],
    [[msg("a", 0, null)], [msg("a", 0, null)], true], [[], [msg("new", 0, null)], false]
  ];
  for (const [first, final, running] of cases) {
    const result = await executeFollow(args, idleHandler(first, final, () => jsonResult(run("r", running ? "running" : "completed"))));
    assert.equal(result.code, 6); finalEvent(result, false); assert.equal(result.events.filter((event) => event.type === "message").length, 0);
  }
});

test("A-FOLLOW-IDLE-READ-FAIL: one-shot source/body failures preserve transport/auth and lost head is timeline change", async () => {
  const h0 = msg("h0", 0, null);
  for (const status of [401, 503]) {
    const result = await executeFollow(args, idleHandler([h0], [h0], () => jsonResult({}, status)));
    assert.equal(result.code, status === 401 ? 4 : 6); finalEvent(result, false);
  }
  const moved = await executeFollow(args, idleHandler([h0], [msg("replacement", 0, null)], () => jsonResult(run())));
  assert.equal(moved.code, 6); finalEvent(moved, false); assert.equal(JSON.parse(moved.stderr).error.code, "TIMELINE_CHANGED");
});

test("A-FOLLOW-IDLE: selected streaming Run is separate evidence and cannot promote unknown nullable head", async () => {
  const a0 = msg("a0", 0, null, { status: "streaming", originRunId: "r0" });
  const user = msg("u1", 1, "a0", { type: "user", originRunId: null });
  const finalA = { ...a0, status: "completed", updatedRevision: 20 };
  for (const append of [false, true]) {
    const final = [finalA, user, ...(append ? [msg("a1", 2, "u1", { originRunId: "r1" })] : [])];
    const result = await executeFollow(["messages", "-w", "w", "-s", "s", "-n", "2", "-f"], idleHandler([a0, user], final, (url) => { assert.ok(url.pathname.endsWith("/runs/r0")); return jsonResult(run("r0")); }));
    assert.equal(result.code, append ? 6 : 0, result.stderr); finalEvent(result, !append);
    assert.equal(result.requests.filter(({ url }) => url.pathname.includes("/runs/")).length, 1);
  }
});
