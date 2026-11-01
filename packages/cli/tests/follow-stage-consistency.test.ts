import assert from "node:assert/strict";
import test from "node:test";
import { agentSession, jsonResult, messagePart } from "./agent-fixture.js";
import { executeFollow, msg, page, run, state, type RawMessage } from "./follow-fixture.js";
import { messageIds, textField } from "./helpers.js";

const args = ["messages", "-w", "w", "-s", "s", "-n", "2", "-f"];
const history = (revision = 20, text = "observed terminal history", status = "completed") =>
  msg("SELECTED-HISTORY", 0, null, { status, updatedRevision: revision, originRunId: "older-run",
    parts: [messagePart("SELECTED-HISTORY", "text", { text, updatedRevision: revision })] });
const head = msg("TARGET-HEAD", 1, "SELECTED-HISTORY", { status: "completed", updatedRevision: 10, originRunId: "r1" });
const tail = (revision: number, reset = false) => page([head], revision, { timelineReset: reset, hasMore: true });
const before = (revision: number, item = history()) => page([item], revision,
  { session: agentSession({ revision, headMessageId: head.id }) });
const reset = (revision: number, item = history()) => page([item, head], revision, { timelineReset: true });
const unchanged = (revision: number) => page([], revision, { session: agentSession({ revision, headMessageId: head.id }) });
const mutations: [string, () => RawMessage][] = [
  ["revision rollback", () => history(5, "STALE ILLEGAL BODY")],
  ["terminal body rewrite", () => history(25, "REWRITTEN ILLEGAL BODY")],
  ["identity rewrite", () => ({ ...history(25), originRunId: "different-origin" })],
  ["Part layout rewrite", () => ({ ...history(25), parts: [messagePart("SELECTED-HISTORY", "text", { id: "DIFFERENT-PART", text: "observed terminal history", updatedRevision: 25 })] })]
];

for (const phase of ["ordinary", "FinalDrain"] as const) {
  for (const [name, mutate] of mutations) test(`ACC-STAGE-RETAIN/RESET: ${phase} rejects selected before-page ${name}`, async () => {
    let deltas = 0; let pages = 0; let probes = 0;
    const result = await executeFollow(args, (url) => {
      if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
      if (url.pathname.includes("/runs/")) { probes++; return jsonResult(run("r1", phase === "FinalDrain" ? "completed" : "running")); }
      const mode = url.searchParams.get("mode");
      if (mode === "snapshot") return jsonResult(tail(10));
      if (mode === "before") { pages++; return jsonResult(before(phase === "FinalDrain" && pages === 2 ? 24 : 20)); }
      assert.equal(mode, "delta"); deltas++;
      if (phase === "ordinary") {
        assert.equal(deltas, 1, "invalid closing reset must fail before any next coordination read");
        return jsonResult(reset(name === "revision rollback" ? 15 : 30, mutate()));
      }
      if (deltas === 1) return jsonResult(tail(21, true)); // Yield to the fixed terminal Run before another ordinary read.
      if (deltas === 2) return jsonResult(tail(22, true)); // OPEN, still uses committed snapshot cursor 10.
      assert.equal(deltas, 3, "invalid CHECK must not trigger another pass or a post-CHECK page");
      assert.equal(url.searchParams.get("sinceRevision"), "22");
      return jsonResult(reset(30, mutate()));
    });
    assert.equal(result.code, 6, result.stderr); assert.equal(textField(result.stdout, "complete"), "false");
    assert.deepEqual(messageIds(result.stdout), []);
    for (const text of ["observed terminal history", "ILLEGAL BODY", `body ${head.id}`]) assert.equal(result.stdout.includes(text), false);
    assert.match(result.stderr, /RESPONSE_INVALID|TIMELINE_CHANGED/);
    assert.equal(pages, phase === "ordinary" ? 1 : 2); assert.equal(probes, 1);
    if (phase === "FinalDrain") {
      assert.equal(textField(result.stdout, "runStatus"), "completed");
      assert.equal(textField(result.stdout, "resultCode"), "run_completed");
      assert.deepEqual(result.requests.filter(({ url }) => url.searchParams.get("mode") === "delta").map(({ url }) => url.searchParams.get("sinceRevision")), ["10", "10", "22"]);
    }
  });

  test(`ACC-STAGE-RETAIN/RESET-LEGAL: ${phase} accepts unchanged terminal history at a newer revision`, async () => {
    let deltas = 0; let pages = 0;
    const result = await executeFollow(args, (url) => {
      if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
      if (url.pathname.includes("/runs/")) return jsonResult(run("r1", phase === "ordinary" && deltas === 1 ? "running" : "completed"));
      const mode = url.searchParams.get("mode");
      if (mode === "snapshot") return jsonResult(tail(10));
      if (mode === "before") { pages++; return jsonResult(before(pages === 1 ? 20 : 24)); }
      deltas++;
      if (phase === "ordinary") return jsonResult(deltas === 1 ? reset(30, history(25)) : unchanged(30));
      if (deltas === 1) return jsonResult(tail(21, true));
      if (deltas === 2) return jsonResult(tail(22, true));
      return jsonResult(reset(30, history(25)));
    });
    assert.equal(result.code, 0, result.stderr); assert.equal(textField(result.stdout, "complete"), "true");
    assert.deepEqual(messageIds(result.stdout), ["SELECTED-HISTORY", head.id]);
    assert.equal(result.stdout.split("observed terminal history").length, 2);
    assert.equal(pages, phase === "ordinary" ? 1 : 2);
    assert.equal(deltas, phase === "ordinary" ? 4 : 3);
  });
}

test("ACC-STAGE-RETAIN/PASS: second FinalDrain OPEN cannot erase first-pass selected raw facts", async () => {
  let deltas = 0; let pages = 0;
  const result = await executeFollow(args, (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(tail(10));
    if (url.searchParams.get("mode") === "before") { pages++; return jsonResult(before(pages === 1 ? 20 : 24)); }
    deltas++;
    if (deltas === 1) return jsonResult(tail(21, true));
    if (deltas === 2) return jsonResult(tail(22, true));
    if (deltas === 3) return jsonResult(tail(25, true)); // First CHECK lacks required history, so only pass two may recover it.
    assert.equal(deltas, 4);
    return jsonResult(reset(30, history(25, "SECOND PASS ILLEGAL BODY")));
  });
  assert.equal(result.code, 6, result.stderr); assert.equal(textField(result.stdout, "complete"), "false");
  assert.equal(textField(result.stdout, "runStatus"), "completed"); assert.deepEqual(messageIds(result.stdout), []);
  assert.equal(result.stdout.includes("ILLEGAL BODY"), false);
  assert.equal(pages, 2); assert.equal(deltas, 4);
});

test("ACC-STAGE-RETAIN/TERMINAL-YIELD: FinalDrain OPEN preserves unpublished ordinary-page terminal facts", async () => {
  let deltas = 0; let pages = 0;
  const result = await executeFollow(args, (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(tail(10));
    if (url.searchParams.get("mode") === "before") { pages++; return jsonResult(before(20)); }
    deltas++;
    if (deltas === 1) return jsonResult(tail(21, true));
    assert.equal(deltas, 2);
    return jsonResult(reset(30, history(25, "TERMINAL YIELD ILLEGAL BODY")));
  });
  assert.equal(result.code, 6, result.stderr); assert.equal(textField(result.stdout, "complete"), "false");
  assert.equal(textField(result.stdout, "runStatus"), "completed"); assert.deepEqual(messageIds(result.stdout), []);
  assert.equal(result.stdout.includes("ILLEGAL BODY"), false); assert.equal(pages, 1);
});

for (const final of [false, true]) for (const [name, mutate] of mutations) {
  test(`ACC-STAGE-RETAIN/REFRESH: ${final ? "FinalDrain" : "ordinary refresh"} rejects newly discovered target ${name}`, async () => {
    const selected = { ...history(), originRunId: "r1" };
    const later = msg("UNSELECTED-R2", 2, head.id, { status: "streaming", updatedRevision: 22, originRunId: "r2" });
    let deltas = 0; let pages = 0; let probes = 0;
    const result = await executeFollow([...args.slice(0, -3), "-n", "1", "-f"], (url) => {
      if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
      if (url.pathname.includes("/runs/")) { probes++; return jsonResult(run("r1", final && deltas >= 2 ? "completed" : "running")); }
      const mode = url.searchParams.get("mode");
      if (mode === "snapshot") return jsonResult(tail(10)); // Last 1 is already satisfied: only H is committed and released.
      if (mode === "before") {
        pages++;
        return jsonResult(page([selected, head], pages === 1 ? 24 : 34,
          { session: agentSession({ revision: pages === 1 ? 24 : 34, headMessageId: later.id }) }));
      }
      deltas++;
      if (deltas === 1 || final && deltas === 3) return jsonResult(page([later], deltas === 1 ? 22 : 32, { timelineReset: true, hasMore: true }));
      if (final && deltas === 2) return jsonResult(page([later], 30, { timelineReset: true, hasMore: true })); // Yield at ordinary CHECK.
      const invalid = mutate();
      if (name !== "identity rewrite") invalid.originRunId = "r1";
      return jsonResult(page([invalid, head, later], final ? 36 : 30, { timelineReset: true }));
    });
    assert.equal(result.code, 6, result.stderr); assert.equal(textField(result.stdout, "complete"), "false");
    assert.deepEqual(messageIds(result.stdout), [head.id], "the already committed message must not be replayed and new invalid history gets no ID");
    assert.equal(result.stdout.split(`body ${head.id}`).length, 2);
    assert.equal(result.stdout.includes("ILLEGAL BODY"), false); assert.equal(result.stdout.includes("observed terminal history"), false);
    assert.equal(result.stdout.includes(later.id), false); assert.equal(pages, final ? 2 : 1); assert.equal(deltas, final ? 4 : 2);
    assert.equal(probes, 2);
    if (final) assert.equal(textField(result.stdout, "runStatus"), "completed");
    assert.deepEqual(result.requests.filter(({ url }) => url.searchParams.get("mode") === "delta").map(({ url }) => url.searchParams.get("sinceRevision")), final ? ["10", "22", "10", "32"] : ["10", "22"]);
  });
}

test("ACC-STAGE-RETAIN/UNSELECTED-R2: a reset may change the unselected navigation suffix without exempting selected history", async () => {
  const selected = { ...history(), originRunId: "r1" };
  const later = msg("PRIVATE-R2-NAVIGATION", 2, head.id, { status: "completed", updatedRevision: 22, originRunId: "r2" });
  const changed = { ...later, updatedRevision: 30, parts: [messagePart(later.id, "text", { text: "unselected changed body", updatedRevision: 30 })] };
  let deltas = 0; let pages = 0;
  const result = await executeFollow([...args.slice(0, -3), "-n", "1", "-f"], (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1", deltas < 2 ? "running" : "completed"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(tail(10));
    if (url.searchParams.get("mode") === "before") {
      pages++; return jsonResult(page([selected, head], 24, { session: agentSession({ revision: 24, headMessageId: later.id }) }));
    }
    deltas++;
    if (deltas === 1) return jsonResult(page([later], 22, { timelineReset: true, hasMore: true }));
    return jsonResult(page([selected, head, changed], 30, { timelineReset: true }));
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(textField(result.stdout, "complete"), "true");
  assert.deepEqual(messageIds(result.stdout), [head.id, selected.id]);
  assert.equal(result.stdout.split(`body ${head.id}`).length, 2); assert.equal(result.stdout.split("observed terminal history").length, 2);
  assert.equal(result.stdout.includes("PRIVATE-R2"), false); assert.equal(result.stdout.includes("unselected changed body"), false);
  assert.equal(pages, 1); assert.equal(deltas, 4);
});

for (const phase of ["ordinary", "FinalDrain"] as const) for (const kind of ["append", "proof"] as const) {
  test(`ACC-STAGE-RETAIN/LEGAL-${kind.toUpperCase()}: ${phase} keeps selected history checks without rejecting a legal ${kind}`, async () => {
    const draftHead = { ...head, status: "streaming" };
    const observed = kind === "append" ? history(20, "selected streaming prefix", "streaming") : history();
    const closedHistory = kind === "append" ? history(25, "selected streaming prefix plus final suffix") : history(25);
    const finalHead = kind === "proof" ? msg("FINAL-REPLACEMENT", 1, observed.id, { status: "completed", originRunId: "r1", updatedRevision: 30 }) : { ...head, updatedRevision: 30 };
    let deltas = 0; let pages = 0;
    const result = await executeFollow(args, (url) => {
      if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
      if (url.pathname.includes("/runs/")) return jsonResult(run("r1", phase === "ordinary" && deltas === 1 ? "running" : "completed"));
      const mode = url.searchParams.get("mode");
      if (mode === "snapshot") return jsonResult(page([draftHead], 10, { hasMore: true }));
      if (mode === "before") { pages++; return jsonResult(before(pages === 1 ? 20 : 24, observed)); }
      deltas++;
      if (phase === "FinalDrain" && deltas <= 2) return jsonResult(page([draftHead], deltas === 1 ? 21 : 22, { timelineReset: true, hasMore: true }));
      if (phase === "ordinary" && deltas > 1) return jsonResult(page([], 30, { session: agentSession({ revision: 30, headMessageId: finalHead.id }) }));
      return jsonResult(page([closedHistory, finalHead], 30, { timelineReset: true, ...(kind === "proof" ? { headReplacement: {
        workspaceId: "w", sessionId: "s", runId: "r1", fromMessageId: head.id, toMessageId: finalHead.id,
        previousMessageId: observed.id, depth: 1, fromSupersededRevision: 26, toUpdatedRevision: 30,
        toStatus: "completed", replacementCount: 1, atRevision: 30
      } } : {}) }));
    });
    assert.equal(result.code, 0, result.stderr); assert.equal(textField(result.stdout, "complete"), "true");
    assert.deepEqual(messageIds(result.stdout), [observed.id, finalHead.id]);
    assert.equal(result.stdout.split(kind === "append" ? "selected streaming prefix plus final suffix" : "observed terminal history").length, 2);
    assert.equal(pages, phase === "ordinary" ? 1 : 2); assert.equal(deltas, phase === "ordinary" ? 4 : 3);
    if (kind === "proof") assert.equal(messageIds(result.stdout).includes(head.id), false);
  });
}

test("ACC-STAGE-RETAIN/BEFORE-YIELD: a moving before page retains selected terminal facts before the fixed Run probe", async () => {
  let deltas = 0; const steps: string[] = [];
  const result = await executeFollow(args, (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) { steps.push("probe:r1"); return jsonResult(run("r1")); }
    const mode = url.searchParams.get("mode"); steps.push(mode!);
    if (mode === "snapshot") return jsonResult(tail(10));
    if (mode === "before") return jsonResult(page([history()], 20,
      { session: agentSession({ revision: 20, headMessageId: "UNSELECTED-APPENDED-R2" }) }));
    deltas++;
    return jsonResult(reset(30, history(25, "BEFORE YIELD ILLEGAL BODY")));
  });
  assert.equal(result.code, 6, result.stderr); assert.equal(textField(result.stdout, "complete"), "false");
  assert.equal(textField(result.stdout, "runStatus"), "completed"); assert.equal(textField(result.stdout, "resultCode"), "run_completed");
  assert.deepEqual(messageIds(result.stdout), []); assert.equal(result.stdout.includes("ILLEGAL BODY"), false);
  assert.deepEqual(steps, ["snapshot", "before", "probe:r1", "delta"]);
  assert.equal(deltas, 1, "FinalDrain OPEN must reject without an ordinary closing read or another pass");
});
