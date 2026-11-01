import assert from "node:assert/strict";
import test from "node:test";
import { AgentApi } from "../src/agent-api.js";
import { FollowLifetime } from "../src/follow-lifetime.js";
import { FollowOutput } from "../src/follow-output.js";
import { FollowState } from "../src/follow-state.js";
import { parseTimeline, startHistory, type TimelineMessage } from "../src/messages.js";
import { readRun } from "../src/run-status.js";
import { captureIO } from "./helpers.js";
import { agentSession, connectionStore, jsonResult, messagePart } from "./agent-fixture.js";
import { executeFollow, msg, page, run, state, type RawMessage } from "./follow-fixture.js";
import { messageIds, textField } from "./helpers.js";

const args = ["messages", "-w", "w", "-s", "s", "-n", "2", "-f"];
const row = (id: string, depth: number, previous: string | null, revision: number, text: string, status = "streaming", originRunId = "r1") =>
  msg(id, depth, previous, { status, originRunId, updatedRevision: revision,
    parts: [messagePart(id, "text", { text, updatedRevision: revision })] });
const h = row("HISTORY-H", 0, null, 1, "immutable selected history", "completed", "old-run");
const a = row("PRIVATE-A", 1, h.id, 10, "displayed A draft");
const a20 = row(a.id, 1, h.id, 20, "displayed A draft plus unpublished append");
const b = row("PRIVATE-B", 1, h.id, 12, "unpublished intermediate B draft");
const c = row("FINAL-C", 1, h.id, 25, "independent final C answer", "completed");
const x = row("PRIVATE-R2", 2, c.id, 30, "unselected r2 body", "streaming", "r2");
function proof(from: RawMessage, to: RawMessage, superseded: number, at: number, count = 1) {
  return { workspaceId: "w", sessionId: "s", runId: "r1", fromMessageId: from.id, toMessageId: to.id,
    previousMessageId: h.id, depth: 1, fromSupersededRevision: superseded, toUpdatedRevision: to.updatedRevision,
    toStatus: to.status, replacementCount: count, atRevision: at };
}
const empty = (head: string, revision: number, root: string | null = null) => page([], revision,
  { session: agentSession({ revision, headMessageId: head, contextRootMessageId: root }) });
const prefix = (item: RawMessage, revision: number, root: string | null = null) => page([item], revision,
  { hasMore: true, session: agentSession({ revision, headMessageId: item.id, contextRootMessageId: root }) });

type Flow = "two-pass" | "ordinary" | "terminal-yield";
interface FlowOptions {
  historyMutation?: "rollback" | "rewrite";
  candidatePaged?: boolean;
  corruptAggregate?: (candidate: RawMessage, relation: ReturnType<typeof proof>) => { candidate: RawMessage; relation: ReturnType<typeof proof> };
}
async function replacementFlow(kind: "M3" | "M4", flow: Flow, { historyMutation, candidatePaged = false, corruptAggregate }: FlowOptions = {}) {
  const intermediate = kind === "M3" ? b : a20;
  const mark = Number(intermediate.updatedRevision);
  let deltas = 0; let pages = 0; let probes = 0;
  const steps: string[] = [];
  const result = await executeFollow(args, (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) {
      probes++; steps.push("probe:r1");
      return jsonResult(run("r1", flow === "two-pass" || flow === "terminal-yield" && probes >= 2 || flow === "ordinary" && deltas >= 3 ? "completed" : "running"));
    }
    const mode = url.searchParams.get("mode");
    if (mode === "snapshot") return jsonResult(page([h, a], 10));
    if (mode === "before") {
      pages++; steps.push(`before:${url.searchParams.get("beforeMessageId")}`);
      const recovering = pages === 2 && (flow === "ordinary" || candidatePaged);
      return jsonResult(page(recovering ? [h, c] : [h], recovering ? 32 : mark + 2,
        { session: agentSession({ revision: recovering ? 32 : mark + 2,
          headMessageId: recovering ? x.id : intermediate.id,
          contextRootMessageId: flow === "terminal-yield" ? h.id : null }) }));
    }
    deltas++; steps.push(`delta:${url.searchParams.get("sinceRevision")}:${url.searchParams.get("knownHeadMessageId")}`);
    if (flow === "two-pass" && deltas === 1) return jsonResult(empty(a.id, 10)); // Observe fixed r1 terminal after initialization.
    const opening = flow === "two-pass" ? 2 : 1;
    if (deltas === opening) return jsonResult({ ...prefix(intermediate, mark), timelineReset: true,
      ...(kind === "M3" ? { headReplacement: proof(a, b, 11, mark) } : {}) });
    if (flow !== "terminal-yield" && deltas === opening + 1) return jsonResult({ ...prefix(x, 30), timelineReset: true,
      headReplacement: proof(intermediate, c, 21, 30) });
    if (flow !== "ordinary" && deltas === opening + (flow === "two-pass" ? 2 : 1)) {
      const checkedH = historyMutation === "rollback" ? row(h.id, 0, null, 0, "immutable selected history", "completed", "old-run")
        : historyMutation === "rewrite" ? row(h.id, 0, null, 26, "ILLEGAL rewritten selected history", "completed", "old-run") : h;
      const aggregate = proof(a, c, kind === "M3" ? 11 : 21, 30, kind === "M3" ? 2 : 1);
      const final = corruptAggregate?.(c, aggregate) ?? { candidate: c, relation: aggregate };
      const tail = { ...x, previousMessageId: final.candidate.id };
      return jsonResult(page(candidatePaged ? [tail] : [checkedH, final.candidate, tail], 30, { timelineReset: true, hasMore: candidatePaged,
        session: agentSession({ revision: 30, headMessageId: x.id, contextRootMessageId: flow === "terminal-yield" ? h.id : null }),
        headReplacement: final.relation }));
    }
    return jsonResult(empty(x.id, flow === "ordinary" || candidatePaged ? 32 : 30, flow === "terminal-yield" ? h.id : null));
  });
  return { ...result, deltas, pages, probes, steps };
}

for (const kind of ["M3", "M4"] as const) for (const flow of ["two-pass", "ordinary", "terminal-yield"] as const) {
  test(`ACC-PROOF-OBSERVATION/${kind}: ${flow} separates raw baselines, slot aliases and request-bound heads`, async () => {
    const result = await replacementFlow(kind, flow);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(textField(result.stdout, "complete"), "true"); assert.equal(textField(result.stdout, "runStatus"), "completed");
    assert.deepEqual(messageIds(result.stdout), [h.id, c.id]);
    for (const text of ["immutable selected history", "displayed A draft", "independent final C answer"]) assert.equal(result.stdout.split(text).length, 2);
    for (const text of ["unpublished intermediate", "unpublished append", "unselected r2", a.id, b.id, x.id]) assert.equal((result.stdout + result.stderr).includes(text), false);
    assert.equal(result.stdout.match(/上一段草稿已作废/g)?.length, 1);
    assert.equal(result.pages, flow === "ordinary" ? 2 : 1);
    assert.equal(result.deltas, flow === "two-pass" || flow === "ordinary" ? 5 : 3);
    assert.equal(result.requests.filter(({ url }) => url.pathname.endsWith("/run-state")).length, 1);
    assert.ok(result.requests.filter(({ url }) => url.pathname.includes("/runs/")).every(({ url }) => url.pathname.endsWith("/runs/r1")));
    if (flow === "two-pass") {
      const deltas = result.requests.filter(({ url }) => url.searchParams.get("mode") === "delta").map(({ url }) => [url.searchParams.get("sinceRevision"), url.searchParams.get("knownHeadMessageId")]);
      assert.deepEqual(deltas, [["10", a.id], ["10", a.id], [kind === "M3" ? "12" : "20", kind === "M3" ? b.id : a.id], ["10", a.id], ["30", x.id]], "exactly two frozen OPENs and two CHECKs after the ordinary refresh");
    }
    if (flow === "terminal-yield") assert.equal(result.steps.filter((step) => step.startsWith("probe:")).length, 2);
  });
}

for (const mutation of ["rollback", "rewrite"] as const) test(`ACC-PROOF-OBSERVATION/HISTORY: cross-pass aliases do not exempt selected terminal ${mutation}`, async () => {
  const result = await replacementFlow("M3", "two-pass", { historyMutation: mutation });
  assert.equal(result.code, 6, result.stderr); assert.equal(textField(result.stdout, "complete"), "false");
  assert.equal(textField(result.stdout, "runStatus"), "completed");
  assert.deepEqual(messageIds(result.stdout), [h.id]);
  assert.equal(result.stdout.includes("ILLEGAL"), false); assert.equal(result.stdout.includes("independent final C"), false);
  assert.equal(result.stdout.includes("上一段草稿已作废"), false);
});

for (const kind of ["M3", "M4"] as const) test(`ACC-PROOF-OBSERVATION/${kind}-PAGED: second OPEN aggregate is verified when C is only in a before page`, async () => {
  const result = await replacementFlow(kind, "two-pass", { candidatePaged: true });
  assert.equal(result.code, 0, result.stderr); assert.equal(textField(result.stdout, "complete"), "true");
  assert.deepEqual(messageIds(result.stdout), [h.id, c.id]);
  assert.equal(result.stdout.split("independent final C answer").length, 2);
  assert.equal(result.stdout.match(/上一段草稿已作废/g)?.length, 1);
  assert.equal((result.stdout + result.stderr).includes(a.id), false); assert.equal((result.stdout + result.stderr).includes(b.id), false);
  assert.equal(result.deltas, 5); assert.equal(result.pages, 2);
  assert.deepEqual(result.requests.filter(({ url }) => url.searchParams.get("mode") === "before").map(({ url }) => url.searchParams.get("beforeMessageId")), [kind === "M3" ? b.id : a.id, x.id]);
  assert.deepEqual(result.requests.filter(({ url }) => url.searchParams.get("mode") === "delta").map(({ url }) => url.searchParams.get("sinceRevision")), ["10", "10", kind === "M3" ? "12" : "20", "10", "30"]);
});

for (const flow of ["two-pass", "terminal-yield"] as const) for (const invalid of ["superseded before latest", "superseded at latest", "latest terminal"] as const) {
  test(`ACC-PROOF-OBSERVATION/LATEST: ${flow} rejects ${invalid} despite a qualifying A10 request source`, async () => {
    let deltas = 0;
    const latest = invalid === "latest terminal" ? { ...a20, status: "completed" } : a20;
    const result = await executeFollow(args, (url) => {
      if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
      if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
      if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([h, a], 10));
      deltas++;
      if (flow === "two-pass" && deltas === 1) return jsonResult(empty(a.id, 10));
      if (deltas === (flow === "two-pass" ? 2 : 1)) return jsonResult(page([h, latest], 20, { timelineReset: true }));
      if (flow === "two-pass" && deltas === 3) return jsonResult({ ...prefix(x, 30), timelineReset: true });
      return jsonResult(page([h, c, x], 30, { timelineReset: true,
        headReplacement: proof(a, c, invalid === "superseded before latest" ? 19 : invalid === "superseded at latest" ? 20 : 21, 30) }));
    });
    assert.equal(result.code, 6, result.stderr); assert.equal(textField(result.stdout, "complete"), "false");
    assert.equal(textField(result.stdout, "runStatus"), "completed"); assert.equal(textField(result.stdout, "resultCode"), "run_completed");
    assert.deepEqual(messageIds(result.stdout), [h.id]);
    assert.equal(result.stdout.includes("independent final C"), false); assert.equal(result.stdout.includes("上一段草稿已作废"), false);
    assert.equal(deltas, flow === "two-pass" ? 4 : 2);
  });
}

for (const boundary of ["explicit after", "released"] as const) test(`ACC-PROOF-OBSERVATION/HARD: ${boundary} cannot acquire a slot alias through an older request observation`, async () => {
  let deltas = 0;
  const initial = boundary === "released" ? { ...a, status: "completed" } : a;
  const selectedArgs = boundary === "explicit after" ? ["messages", "-w", "w", "-s", "s", "--after", a.id, "-f"] : args;
  const latest = { ...initial, updatedRevision: 20 };
  const result = await executeFollow(selectedArgs, (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([h, initial], 10));
    deltas++;
    if (deltas === 1) return jsonResult(empty(a.id, 10));
    if (deltas === 2) return jsonResult(page([h, latest], 20, { timelineReset: true }));
    if (deltas === 3) return jsonResult({ ...prefix(x, 30), timelineReset: true });
    return jsonResult(page([h, c, x], 30, { timelineReset: true, headReplacement: proof(a, c, 21, 30) }));
  });
  assert.equal(result.code, 6, result.stderr); assert.equal(textField(result.stdout, "complete"), "false");
  assert.deepEqual(messageIds(result.stdout), boundary === "released" ? [h.id, a.id] : []);
  assert.equal(result.stdout.includes("independent final C"), false); assert.equal(result.stdout.includes("上一段草稿已作废"), false);
  assert.equal(deltas, 4); assert.equal(textField(result.stdout, "runStatus"), "completed");
});

for (const invalid of ["superseded revision", "hop count", "terminal candidate", "candidate revision", "retired identity"] as const) {
  test(`ACC-PROOF-OBSERVATION/ALIAS: second OPEN rejects conflicting ${invalid}`, async () => {
    const result = await replacementFlow("M3", "two-pass", { corruptAggregate: (candidate, relation) => {
      if (invalid === "superseded revision") relation.fromSupersededRevision = 15;
      if (invalid === "hop count") relation.replacementCount = 1;
      if (invalid === "terminal candidate") { candidate = { ...candidate, status: "streaming" }; relation.toStatus = "streaming"; }
      if (invalid === "candidate revision") { candidate = { ...candidate, updatedRevision: 24 }; relation.toUpdatedRevision = 24; }
      if (invalid === "retired identity") { candidate = { ...b, updatedRevision: 26 }; relation.toMessageId = b.id; relation.toUpdatedRevision = 26; relation.toStatus = "streaming"; }
      return { candidate, relation };
    } });
    assert.equal(result.code, 6, result.stderr); assert.equal(textField(result.stdout, "complete"), "false");
    assert.equal(textField(result.stdout, "runStatus"), "completed"); assert.equal(result.deltas, 4);
    assert.deepEqual(messageIds(result.stdout), [h.id]);
    assert.equal(result.stdout.includes("上一段草稿已作废"), false); assert.equal(result.stdout.includes("independent final C"), false);
    assert.equal((result.stdout + result.stderr).includes(b.id), false);
  });
}

test("ACC-PROOF-OBSERVATION/MEMORY: 80 unpublished large intermediate drafts retain only current raw and scalar aliases", async () => {
  const capture = captureIO(); const lifetime = new FollowLifetime(capture.io.stdout);
  let current = a; let replacements = 0; let pages = 0;
  let follow!: FollowState;
  type Facts = { observed: Map<string, TimelineMessage>; retired: Map<string, { to: string; count: number; supersededRevision?: number; lastRevision: number }>; candidates: Map<string, unknown> };
  try {
    const api = await AgentApi.connect({ config: connectionStore(), http: { request: async (_origin, path) => {
      const url = new URL(path, "http://fixture.test");
      if (url.pathname.includes("/runs/")) return jsonResult(run("r1", "running"));
      if (url.searchParams.get("mode") === "before") {
        pages++;
        const facts = follow as unknown as Facts;
        assert.ok(facts.observed.size <= 2, "only H and current draft retain raw bodies");
        for (const id of facts.observed.keys()) assert.ok(id === h.id || id === current.id);
        assert.equal(facts.candidates.size, 1);
        for (const fact of facts.retired.values()) {
          assert.deepEqual(Object.keys(fact).sort(), ["count", "lastRevision", "supersededRevision", "to"]);
          assert.equal(typeof fact.to, "string"); assert.equal(typeof fact.count, "number");
          assert.equal(typeof fact.lastRevision, "number"); assert.equal(typeof fact.supersededRevision, "number");
        }
        return jsonResult(page([h], Number(current.updatedRevision), { session: agentSession({ revision: current.updatedRevision, headMessageId: current.id }) }));
      }
      if (replacements === 81) return jsonResult(empty(current.id, Number(current.updatedRevision)));
      const previous = current; const revision = 12 + replacements * 2;
      replacements++;
      current = replacements === 81 ? { ...c, updatedRevision: revision }
        : row(`PRIVATE-LARGE-${replacements}`, 1, h.id, revision, "x".repeat(128 * 1024));
      return jsonResult({ ...prefix(current, revision), timelineReset: true,
        headReplacement: proof(previous, current, revision - 1, revision) });
    } } });
    const frame = await startHistory(api, "w", "s", parseTimeline(page([h, a], 10), "w", "s"));
    const output = new FollowOutput(capture.io, lifetime, { workspaceId: "w", sessionId: "s" }, "r1");
    follow = new FollowState(frame, "r1", { anchor: null, selection: { mode: "last", count: 2 }, includeInitialRun: true }, output);
    const probe = () => readRun(api, "w", "s", "r1");
    await follow.initialize(api, probe); await follow.refresh(api, probe);
    assert.equal(replacements, 81); assert.equal(pages, 81);
    const facts = follow as unknown as Facts;
    assert.equal(facts.observed.size, 0); assert.equal(facts.retired.size, 0); assert.equal(facts.candidates.size, 0);
    assert.deepEqual(messageIds(capture.output()), [h.id, c.id]);
    assert.equal(capture.output().match(/上一段草稿已作废/g)?.length, 1);
    assert.equal(capture.output().split("independent final C answer").length, 2);
    assert.equal(capture.output().includes("PRIVATE-"), false); assert.equal(capture.output().includes("xxxxx"), false);
    assert.equal(output.renderer.states.has(a.id), false); assert.deepEqual([...output.emitted.keys()], [h.id, c.id]);
  } finally { lifetime.dispose(); }
});
