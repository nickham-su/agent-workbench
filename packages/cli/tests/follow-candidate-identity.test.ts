import assert from "node:assert/strict";
import test from "node:test";
import { AgentApi } from "../src/agent-api.js";
import { FollowLifetime } from "../src/follow-lifetime.js";
import { FollowOutput } from "../src/follow-output.js";
import { FollowState } from "../src/follow-state.js";
import { parseMessage, parseTimeline, startHistory, type TimelineMessage } from "../src/messages.js";
import type { AgentHeadReplacementProof } from "@agent-workbench/shared";
import { agentSession, connectionStore, jsonResult, messagePart } from "./agent-fixture.js";
import { executeFollow, msg, page, run, state, type RawMessage } from "./follow-fixture.js";
import { captureIO, messageIds, textField } from "./helpers.js";

const args = ["messages", "-w", "w", "-s", "s", "-n", "1", "-f"];
const row = (id: string, depth: number, previous: string | null, revision: number, text: string, status = "completed", originRunId = "r1") =>
  msg(id, depth, previous, { status, originRunId, updatedRevision: revision,
    parts: [messagePart(id, "text", { text, updatedRevision: revision })] });
const h = row("H", 0, null, 1, "navigation H", "completed", "old-run");
const p = row("P", 0, null, 1, "navigation P", "completed", "old-run");
const a = row("PRIVATE-A", 1, h.id, 10, "displayed A draft", "streaming");
const c = row("PRIVATE-C", 1, h.id, 25, "authenticated C answer");
const empty = (head: string, revision: number) => page([], revision, { session: agentSession({ revision, headMessageId: head }) });
function proof(from: RawMessage, to: RawMessage, at: number, superseded = Number(from.updatedRevision) + 1, count = 1) {
  return { workspaceId: "w", sessionId: "s", runId: from.originRunId, fromMessageId: from.id, toMessageId: to.id,
    previousMessageId: from.previousMessageId, depth: from.depth, fromSupersededRevision: superseded,
    toUpdatedRevision: to.updatedRevision, toStatus: to.status, replacementCount: count, atRevision: at };
}
const fields = ["depth", "previous", "run", "session", "workspace", "type", "originSession", "originRun", "self previous"] as const;

for (const rawSeen of [false, true]) for (const field of fields) {
  test(`ACC-CANDIDATE-IDENTITY: ${rawSeen ? "already-raw" : "proof-only"} rejects conflicting ${field} before any invalidation or candidate output`, async () => {
    const previous = field === "previous" ? p.id : field === "self previous" ? c.id : h.id;
    const depth = 2; // D is beyond the protected C slot, so a cursor 404 can legitimately reach CHECK.
    const d = row("PRIVATE-D", depth, previous, 26, "unpublished D draft", "streaming", field === "run" ? "r2" : "r1");
    const badC = row(c.id, depth, previous, 30, "authenticated C answer", "completed", field === "run" || field === "originRun" ? "r2" : "r1");
    if (field === "originSession") badC.originSessionId = "foreign-session";
    if (field === "type") badC.type = "user";
    const closingProof = proof(d, badC, 30);
    if (field === "session") closingProof.sessionId = "foreign-session";
    if (field === "workspace") closingProof.workspaceId = "foreign-workspace";
    const x = row("PRIVATE-R2", 3, d.id, 26, "unselected r2 suffix", "streaming", "r2");
    let deltas = 0; let befores = 0;
    const result = await executeFollow(args, (url) => {
      if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
      if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
      const mode = url.searchParams.get("mode");
      if (mode === "snapshot") return jsonResult(page([a], 10, { hasMore: true }));
      if (mode === "before") {
        befores++; return jsonResult({ code: "TIMELINE_CURSOR_NOT_FOUND", message: "fixture cursor retired" }, 404);
      }
      deltas++;
      if (deltas === 1) return jsonResult(empty(a.id, 10)); // Capture r1 terminal; A was displayed but never released.
      if (rawSeen && deltas === 2) return jsonResult(page([h, c], 25, { timelineReset: true, headReplacement: proof(a, c, 25) }));
      if (rawSeen && deltas === 3) return jsonResult(page([x], 26, { timelineReset: true, hasMore: true }));
      if (deltas === (rawSeen ? 4 : 2)) return jsonResult(page([d], 26,
        { timelineReset: true, hasMore: true, headReplacement: proof(a, c, 26) }));
      return jsonResult(page(field === "self previous" ? [badC] : [previous === p.id ? p : h, badC], 30,
        { timelineReset: true, hasMore: field === "self previous", headReplacement: closingProof }));
    });
    assert.equal(result.code, 6, result.stderr); assert.equal(textField(result.stdout, "complete"), "false");
    assert.equal(textField(result.stdout, "runStatus"), "completed"); assert.equal(textField(result.stdout, "resultCode"), "run_completed");
    assert.deepEqual(messageIds(result.stdout), []);
    assert.equal(result.stdout.split("displayed A draft").length, 2);
    assert.equal(result.stdout.includes("上一段草稿已作废"), false); assert.equal(result.stdout.includes("authenticated C answer"), false);
    for (const id of [a.id, c.id, d.id]) assert.equal((result.stdout + result.stderr).includes(id), false);
    assert.equal(befores, 1, "precise cursor 404 is consumed once; no CHECK recovery page may follow");
    assert.equal(deltas, rawSeen ? 5 : 3, "only the bounded OPEN/CHECK pairs may be used");
  });
}

for (const rawSeen of [false, true]) test(`ACC-CANDIDATE-IDENTITY/VALID: ${rawSeen ? "already-raw" : "proof-only"} same-slot B-to-C and aggregate A-to-C remain compatible`, async () => {
  const b = row("PRIVATE-B", 1, h.id, 12, "unpublished B draft", "streaming");
  const x = row("PRIVATE-R2", 2, c.id, 26, "unselected r2 suffix", "streaming", "r2");
  let deltas = 0; let befores = 0;
  const result = await executeFollow(["messages", "-w", "w", "-s", "s", "-n", "2", "-f"], (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
    const mode = url.searchParams.get("mode");
    if (mode === "snapshot") return jsonResult(page([h, a], 10));
    if (mode === "before") {
      befores++; return jsonResult(page([h], 14, { session: agentSession({ revision: 14, headMessageId: b.id }) }));
    }
    deltas++;
    if (deltas === 1) return jsonResult(empty(a.id, 10));
    if (deltas === 2) return jsonResult(page([b], 12, { timelineReset: true, hasMore: true, headReplacement: proof(a, b, 12) }));
    if (deltas === 3) return jsonResult(page(rawSeen ? [c, x] : [x], 26,
      { timelineReset: true, hasMore: true, headReplacement: proof(b, c, 26, 21) }));
    if (deltas === 4) return jsonResult(page([h, c, x], 26, { timelineReset: true, headReplacement: proof(a, c, 26, 11, 2) }));
    return jsonResult(empty(x.id, 26));
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(textField(result.stdout, "complete"), "true");
  assert.deepEqual(messageIds(result.stdout), [h.id, c.id]);
  assert.equal(result.stdout.split("authenticated C answer").length, 2);
  assert.equal(result.stdout.match(/上一段草稿已作废/g)?.length, 1);
  assert.equal((result.stdout + result.stderr).includes(a.id), false); assert.equal((result.stdout + result.stderr).includes(b.id), false);
  assert.equal(result.stdout.includes("unselected r2 suffix"), false); assert.equal(befores, 1); assert.equal(deltas, 5);
  assert.deepEqual(result.requests.filter(({ url }) => url.searchParams.get("mode") === "delta").map(({ url }) => url.searchParams.get("sinceRevision")), ["10", "10", "12", "10", "26"]);
});

for (const source of ["snapshot", "before"] as const) test(`ACC-CANDIDATE-IDENTITY/SELF: raw ${source} self-predecessor fails without any candidate proof`, async () => {
  const self = row("PRIVATE-SELF", 1, "PRIVATE-SELF", 10, "must not display self-loop");
  const tail = row("PRIVATE-TAIL", 2, self.id, 10, "must not display tail");
  let reads = 0;
  const result = await executeFollow(["messages", "-w", "w", "-s", "s", "-n", source === "snapshot" ? "1" : "2"], (url) => {
    reads++;
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([source === "snapshot" ? self : tail], 10, { hasMore: true }));
    return jsonResult(page([self], 10, { hasMore: true, session: agentSession({ revision: 10, headMessageId: tail.id }) }));
  });
  assert.equal(result.code, 6, result.stderr); assert.equal(result.stdout, ""); assert.equal(reads, source === "snapshot" ? 1 : 2);
  assert.equal(result.stderr.includes(self.id), false); assert.equal(result.stderr.includes(tail.id), false);
});

test("ACC-CANDIDATE-IDENTITY/SELF: a proof-only self-predecessor fails before paging without a prior candidate", async () => {
  const old = { ...a, previousMessageId: c.id };
  const self = { ...c, previousMessageId: c.id };
  const d = row("PRIVATE-D", 2, c.id, 26, "unselected suffix", "streaming", "r2");
  let deltas = 0; let befores = 0;
  const result = await executeFollow(args, (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
    const mode = url.searchParams.get("mode");
    if (mode === "snapshot") return jsonResult(page([old], 10, { hasMore: true }));
    if (mode === "before") {
      befores++; return jsonResult(page([self], 26, { hasMore: true, session: agentSession({ revision: 26, headMessageId: d.id }) }));
    }
    deltas++;
    return jsonResult(deltas === 1 ? empty(old.id, 10) : deltas === 2
      ? page([d], 26, { timelineReset: true, hasMore: true, headReplacement: proof(old, self, 26) }) : empty(d.id, 26));
  });
  assert.equal(result.code, 6, result.stderr); assert.equal(textField(result.stdout, "complete"), "false");
  assert.equal(textField(result.stdout, "runStatus"), "completed"); assert.deepEqual(messageIds(result.stdout), []);
  assert.equal(result.stdout.includes("上一段草稿已作废"), false); assert.equal(result.stdout.includes("authenticated C answer"), false);
  assert.equal(befores, 0); assert.equal(deltas, 2);
});

test("ACC-CANDIDATE-IDENTITY/HEADER: proof-only and raw headers independently enforce every immutable field through one authority", async () => {
  const capture = captureIO(); const lifetime = new FollowLifetime(capture.io.stdout);
  try {
    const api = await AgentApi.connect({ config: connectionStore(), http: { request: async () => { throw new Error("header unit must not read HTTP"); } } });
    const frame = await startHistory(api, "w", "s", parseTimeline(page([h, a], 10), "w", "s"));
    const output = new FollowOutput(capture.io, lifetime, { workspaceId: "w", sessionId: "s" }, "r1");
    const follow = new FollowState(frame, "r1", { anchor: null, selection: { mode: "last", count: 1 }, includeInitialRun: true }, output);
    // Focus the domain guard independently of request/source eligibility, which
    // otherwise rejects many deliberately conflicting headers even earlier.
    const guard = follow as unknown as { assertCandidateIdentity(record: TimelineMessage | AgentHeadReplacementProof, expected: AgentHeadReplacementProof): void };
    const expected = parseTimeline(page([h, c], 25, { headReplacement: proof(a, c, 25) }), "w", "s").headReplacement!;
    const raw = parseMessage(c, "w");
    assert.doesNotThrow(() => guard.assertCandidateIdentity(expected, expected));
    assert.doesNotThrow(() => guard.assertCandidateIdentity(raw, expected));
    assert.doesNotThrow(() => guard.assertCandidateIdentity({ ...expected, fromMessageId: "PRIVATE-B", fromSupersededRevision: 21, atRevision: 30 }, expected), "different authenticated proof paths may share one immutable candidate identity");
    for (const [field, value] of Object.entries({ workspaceId: "foreign-workspace", sessionId: "foreign-session", runId: "foreign-run", depth: 2, previousMessageId: p.id, toMessageId: "OTHER-C" })) {
      assert.throws(() => guard.assertCandidateIdentity({ ...expected, [field]: value }, expected), { exitCode: 6 }, `proof field ${field}`);
    }
    for (const [field, value] of Object.entries({ id: "OTHER-C", type: "user", originSessionId: "foreign-session", originRunId: "foreign-run", depth: 2, previousMessageId: p.id })) {
      assert.throws(() => guard.assertCandidateIdentity({ ...raw, [field]: value }, expected), { exitCode: 6 }, `raw field ${field}`);
    }
    assert.equal(capture.output(), ""); assert.equal(output.emitted.size, 0); assert.equal(output.released.size, 0);
  } finally { lifetime.dispose(); }
});
