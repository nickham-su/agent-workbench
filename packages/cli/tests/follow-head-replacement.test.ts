import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { runCli } from "../src/program.js";
import type { HttpRequest } from "../src/http.js";
import { agentSession, connectionStore, jsonResult, messagePart } from "./agent-fixture.js";
import { executeFollow, msg, page, paged, run, state, type Handler, type RawMessage } from "./follow-fixture.js";
import { captureIO, messageIds, textField } from "./helpers.js";

const args = ["messages", "-w", "w", "-s", "s", "-n", "1", "-f"];
const draftId = "PRIVATE-DRAFT-A";
const body = (id: string, depth: number, previous: string | null, text: string, status = "completed", revision = 10, originRunId: string | null = "r1") =>
  msg(id, depth, previous, { status, updatedRevision: revision, originRunId, parts: [messagePart(id, "text", { text })] });
function proof(from: RawMessage, to: RawMessage, atRevision = Number(to.updatedRevision), replacementCount = 1) {
  return { workspaceId: "w", sessionId: "s", runId: from.originRunId, fromMessageId: from.id, toMessageId: to.id,
    previousMessageId: from.previousMessageId, depth: from.depth, fromSupersededRevision: Number(from.updatedRevision) + 1,
    toUpdatedRevision: to.updatedRevision, toStatus: to.status, replacementCount, atRevision };
}
function empty(head: string | null, revision: number, root: string | null = null) {
  return page([], revision, { session: agentSession({ headMessageId: head, revision, contextRootMessageId: root }) });
}
async function scenario(handler: (url: URL, request: HttpRequest, output: string) => ReturnType<Handler>, selection = ["-n", "1"]) {
  const capture = captureIO(); const requests: URL[] = [];
  const code = await runCli(["session", "messages", "-w", "w", "-s", "s", ...selection, "-f"], {
    io: capture.io, createConfigStore: () => connectionStore(), http: { request: async (_origin, path, request = {}) => {
      const url = new URL(path, "http://fixture.test"); requests.push(url); return handler(url, request, capture.output());
    } }
  });
  return { code, stdout: capture.output(), stderr: capture.diagnostic(), requests };
}
const a = () => body(draftId, 0, null, "old visible draft", "streaming");
const c = () => body("FINAL-C", 0, null, "independent final attempt", "completed", 12);

for (const selector of ["auto", "after"] as const) test(`ACC-RECONCILE-AUTO/EXPLICIT, ACC-PROOF-CHAIN: ${selector} boundary is not conflated`, async () => {
  const old = a(); const next = c(); let deltas = 0; let probes = 0; const observations: string[] = [];
  const result = await scenario((url, _request, output) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.endsWith("/runs/r1")) { observations.push(output); return jsonResult(run("r1", ++probes === 1 ? "running" : "completed")); }
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([old]));
    deltas++;
    return jsonResult(deltas === 1 ? page([next], 12, { timelineReset: true, headReplacement: proof(old, next, 12, 2) }) : empty(next.id, 12));
  }, selector === "after" ? ["--after", old.id] : ["-n", "1"]);
  if (selector === "after") {
    assert.equal(result.code, 6); assert.match(result.stderr, /TIMELINE_CHANGED/);
    assert.equal(result.stdout.includes("independent final attempt"), false); assert.equal(deltas, 1);
  } else {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.match(/old visible draft/g)?.length, 1);
    assert.equal(result.stdout.match(/上一段草稿已作废/g)?.length, 1);
    assert.equal(result.stdout.match(/independent final attempt/g)?.length, 1);
    assert.deepEqual(messageIds(result.stdout), [next.id]);
    assert.equal(observations[0].includes("上一段草稿已作废"), false, "no invalidation before the entire replacement stage validates");
    assert.ok(observations.at(-1)?.includes("消息 ID：FINAL-C"));
  }
  assert.equal((result.stdout + result.stderr).includes(old.id), false);
  assert.equal(result.requests.some((url) => url.pathname.includes("/runs/r2")), false);
});

test("ACC-PROOF-SLOT/RECONCILE-RESET/PAGING: successor outside tail is paged and closed without adopting page watermark", async () => {
  const user = body("USER", 0, null, "user history", "completed", 1); user.type = "user";
  const old = body(draftId, 1, user.id, "old visible draft", "streaming");
  const next = body("FINAL-C", 1, user.id, "nonhead final answer", "completed", 12);
  const d = body("D", 2, next.id, "second target answer", "completed", 12);
  const e = body("E", 3, d.id, "third target answer", "completed", 12);
  let deltas = 0; let probes = 0; const mid: string[] = [];
  const result = await scenario((url, _request, output) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1", ++probes === 1 ? "running" : "completed"));
    const mode = url.searchParams.get("mode");
    if (mode === "snapshot") return jsonResult(page([user, old]));
    if (mode === "before") {
      mid.push(output);
      return jsonResult(page([user, next, d], 19, { session: agentSession({ revision: 19, headMessageId: e.id }) }));
    }
    deltas++;
    return jsonResult(deltas === 1 ? page([e], 12, { timelineReset: true, hasMore: true, headReplacement: proof(old, next, 12, 2) }) : empty(e.id, 20));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(messageIds(result.stdout), [next.id, d.id, e.id]);
  assert.equal(result.stdout.match(/上一段草稿已作废/g)?.length, 1);
  assert.equal(mid[0].includes("nonhead final answer"), false);
  const delta = result.requests.filter((url) => url.searchParams.get("mode") === "delta");
  assert.equal(delta[1].searchParams.get("sinceRevision"), "12");
  assert.equal(delta.some((url) => url.searchParams.get("sinceRevision") === "19"), false);
  assert.equal(result.requests.some((url) => url.pathname.includes(`/messages/${old.id}`)), false);
});

test("ACC-RECONCILE-CURSOR/MANY: C disappears while paging, probe fixed r1 before new proof; no retry of the old 404", async () => {
  const user = body("USER", 0, null, "protected user", "completed", 1); user.type = "user";
  const old = body(draftId, 1, user.id, "first draft", "streaming");
  const intermediate = body("PRIVATE-C", 1, user.id, "unseen retry", "streaming", 12);
  const final = body("FINAL-F", 1, user.id, "last attempt", "completed", 14);
  const steps: string[] = []; let deltas = 0;
  const result = await scenario((url, _request, output) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) { steps.push("run:r1"); return jsonResult(run("r1", output.includes("消息 ID：FINAL-F") ? "completed" : "running")); }
    const mode = url.searchParams.get("mode");
    if (mode === "snapshot") return jsonResult(page([user, old]));
    if (mode === "before") {
      const id = url.searchParams.get("beforeMessageId"); steps.push(`before:${id}`);
      return id === intermediate.id ? jsonResult({ code: "TIMELINE_CURSOR_NOT_FOUND" }, 404)
        : jsonResult(page([user], 16, { session: agentSession({ revision: 16, headMessageId: final.id }) }));
    }
    deltas++; steps.push(`delta:${url.searchParams.get("knownHeadMessageId")}:${url.searchParams.get("sinceRevision")}`);
    if (deltas === 1) return jsonResult(page([intermediate], 12, { timelineReset: true, hasMore: true, headReplacement: proof(old, intermediate) }));
    if (deltas === 2) return jsonResult(page([final], 14, { timelineReset: true, hasMore: true, headReplacement: proof(intermediate, final) }));
    return jsonResult(empty(final.id, 16));
  }, ["-n", "2"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(steps.filter((step) => step === `before:${intermediate.id}`).length, 1);
  const missing = steps.indexOf(`before:${intermediate.id}`);
  assert.deepEqual(steps.slice(missing, missing + 3), [`before:${intermediate.id}`, "run:r1", `delta:${intermediate.id}:12`]);
  assert.equal(steps.some((step) => step.startsWith("delta:FINAL-F:16")), true);
  assert.equal(result.stdout.includes("unseen retry"), false);
  assert.deepEqual(messageIds(result.stdout), [user.id, final.id]);
  assert.equal(result.stdout.match(/上一段草稿已作废/g)?.length, 1);
  for (const id of [old.id, intermediate.id]) assert.equal((result.stdout + result.stderr).includes(id), false);
});

const corruptions: Record<string, (value: ReturnType<typeof proof>) => unknown> = {
  workspace: (p) => ({ ...p, workspaceId: "other" }), session: (p) => ({ ...p, sessionId: "other" }),
  run: (p) => ({ ...p, runId: "r2" }), from: (p) => ({ ...p, fromMessageId: "other" }),
  to: (p) => ({ ...p, toMessageId: p.fromMessageId }), previous: (p) => ({ ...p, previousMessageId: "other" }),
  depth: (p) => ({ ...p, depth: 9 }), future: (p) => ({ ...p, toUpdatedRevision: 99 }),
  older: (p) => ({ ...p, fromSupersededRevision: 10 }), revision: (p) => ({ ...p, atRevision: 11 }),
  countZero: (p) => ({ ...p, replacementCount: 0 }), countHuge: (p) => ({ ...p, replacementCount: 257 }),
  status: (p) => ({ ...p, toStatus: "failed" }), extra: (p) => ({ ...p, privateChain: ["PRIVATE-B"] })
};
for (const [name, corrupt] of Object.entries(corruptions)) test(`ACC-PROOF-CLIENT: reject ${name} without draft identity or output side effects`, async () => {
  const old = a(); const next = c();
  const result = await executeFollow(args, (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1", "running"));
    return jsonResult(url.searchParams.get("mode") === "snapshot" ? page([old])
      : page([next], 12, { timelineReset: true, headReplacement: corrupt(proof(old, next)) }));
  });
  assert.equal(result.code, 6, result.stderr); assert.match(result.stderr, /RESPONSE_INVALID/);
  assert.equal(result.stdout.includes("independent final attempt"), false);
  assert.equal(result.stdout.includes("上一段草稿已作废"), false);
  assert.equal((result.stdout + result.stderr).includes(old.id), false);
});

for (const variant of ["old-api", "published", "foreign-source", "protected-removed", "protected-rewritten"] as const) test(`ACC-RECONCILE-HISTORY/UNRELATED: ${variant} cannot use a matching-slot guess or clear protection`, async () => {
  const user = body("PROTECTED", 0, null, "protected history", "completed", 1, "older-run"); user.type = "user";
  const old = body(draftId, 1, user.id, "old visible draft", variant === "published" ? "completed" : "streaming");
  if (variant === "foreign-source") old.originSessionId = "parent";
  const next = body("FINAL-C", 1, user.id, "must not publish", "completed", 12);
  let finalUser = user;
  if (variant === "protected-rewritten") finalUser = { ...user, updatedRevision: 12, parts: [messagePart(user.id, "text", { text: "rewritten history" })] };
  const result = await executeFollow([...args.slice(0, -3), "-n", "2", "-f"], (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1", "running"));
    return jsonResult(url.searchParams.get("mode") === "snapshot" ? page([user, old]) : page(variant === "protected-removed" ? [next] : [finalUser, next], 12,
      { timelineReset: true, ...(variant === "old-api" ? {} : { headReplacement: proof(old, next) }) }));
  });
  assert.equal(result.code, 6, result.stderr);
  assert.equal(result.stdout.includes("must not publish"), false); assert.equal(result.stdout.includes("上一段草稿已作废"), false);
  if (variant !== "published") assert.equal((result.stdout + result.stderr).includes(old.id), false);
  else assert.equal(messageIds(result.stdout).filter((id) => id === old.id).length, 1);
});

/** A finite fixture models real protocol order, rather than returning success for arbitrary extra reads. */
async function drainScenario(kind: "first" | "append" | "second" | "exhaust" | "cursor" | "retry-ok" | "retry-exhaust", onSecondClose?: (attempt: number) => void) {
  const h = body("HARD-HISTORY", 0, null, "known target answer", "completed", 10);
  const middle = body("R2-MIDDLE", 1, h.id, "hidden later run", "completed", 19, "r2");
  const r2a = body("PRIVATE-R2-A", 2, middle.id, "later draft A", "streaming", 20, "r2");
  const r2b = body("PRIVATE-R2-B", 2, middle.id, "later draft B", "streaming", 22, "r2");
  const r2d = body("PRIVATE-R2-D", 2, middle.id, "later draft D", "streaming", 25, "r2");
  const steps: { name: string; since: string | null; head: string | null; root: string | null; time: number }[] = [];
  let deltaCount = 0; let beforeCount = 0; let closeAttempts = 0;
  const result = await scenario((url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) { steps.push({ name: "run:r1", since: null, head: null, root: null, time: Date.now() }); return jsonResult(run("r1")); }
    const mode = url.searchParams.get("mode");
    if (mode === "snapshot") return jsonResult(page([h]));
    if (mode === "before") {
      beforeCount++;
      steps.push({ name: `before${beforeCount}`, since: null, head: url.searchParams.get("beforeMessageId"), root: null, time: Date.now() });
      if (kind === "cursor") return jsonResult({ code: "TIMELINE_CURSOR_NOT_FOUND" }, 404);
      if (beforeCount === 1 && !["first", "append"].includes(kind)) return jsonResult(page([middle], 21, {
        hasMore: true, session: agentSession({ revision: 21, headMessageId: r2b.id, contextRootMessageId: h.id }) }));
      return jsonResult(page([h, middle], 24, { session: agentSession({ revision: 24,
        headMessageId: beforeCount === 1 ? r2a.id : r2b.id, contextRootMessageId: beforeCount === 1 ? null : h.id }) }));
    }
    deltaCount++;
    const since = url.searchParams.get("sinceRevision"); const head = url.searchParams.get("knownHeadMessageId");
    const root = url.searchParams.get("knownContextRootMessageId");
    if (deltaCount === 1) { steps.push({ name: "refresh", since, head, root, time: Date.now() }); return jsonResult(empty(h.id, 10)); }
    if (deltaCount === 2) { steps.push({ name: "OPEN1", since, head, root, time: Date.now() }); return jsonResult(page([r2a], 20, { timelineReset: true, hasMore: true })); }
    if (deltaCount === 3) {
      steps.push({ name: "CHECK1", since, head, root, time: Date.now() });
      if (["first", "append"].includes(kind)) {
        const extra = body("R2-APPENDED", 3, r2a.id, "unrelated new suffix", "streaming", 25, "r2");
        return jsonResult(kind === "first" ? empty(r2a.id, 25) : page([extra], 25));
      }
      return jsonResult(page([r2b], 22, { timelineReset: true, hasMore: true, headReplacement: proof(r2a, r2b),
        session: agentSession({ revision: 22, headMessageId: r2b.id, contextRootMessageId: h.id }) }));
    }
    if (deltaCount === 4) { steps.push({ name: "OPEN2", since, head, root, time: Date.now() }); return jsonResult(page([r2b], 23,
      { timelineReset: true, hasMore: true, session: agentSession({ revision: 23, headMessageId: r2b.id, contextRootMessageId: h.id }) })); }
    closeAttempts++; onSecondClose?.(closeAttempts);
    steps.push({ name: "CHECK2", since, head, root, time: Date.now() });
    if ((kind === "retry-ok" && closeAttempts < 4) || kind === "retry-exhaust") return jsonResult({}, 503);
    return jsonResult(kind === "second" ? empty(r2b.id, 25, h.id) : page([r2d], 25, { timelineReset: true, hasMore: true,
      headReplacement: proof({ ...r2b, updatedRevision: 23 }, r2d, 25, 2), session: agentSession({ revision: 25, headMessageId: r2d.id, contextRootMessageId: middle.id }) }));
  });
  return { ...result, steps, beforeCount, closeAttempts };
}
for (const kind of ["first", "append", "second", "exhaust", "cursor"] as const) test(`ACC-FINAL-DRAIN-${kind.toUpperCase()}: OPEN/BUILD/CHECK are finite and r2 cannot expand the frozen prefix`, async () => {
  const result = await drainScenario(kind);
  const success = ["first", "append", "second"].includes(kind);
  assert.equal(result.code, success ? 0 : 6, result.stderr);
  assert.equal(textField(result.stdout, "complete"), String(success));
  assert.equal(textField(result.stdout, "runStatus"), "completed"); assert.equal(textField(result.stdout, "resultCode"), "run_completed");
  const names = result.steps.map((step) => step.name);
  assert.deepEqual(names, success && kind !== "second" ? ["refresh", "run:r1", "OPEN1", "before1", "CHECK1"]
    : ["refresh", "run:r1", "OPEN1", "before1", "CHECK1", "OPEN2", "before2", "CHECK2"]);
  for (const name of ["OPEN1", "OPEN2"]) {
    const open = result.steps.find((step) => step.name === name);
    if (open) assert.deepEqual([open.since, open.head], ["10", "HARD-HISTORY"]);
  }
  assert.deepEqual(result.steps.filter((step) => step.name.startsWith("CHECK")).map((step) => [step.since, step.head]),
    kind === "first" || kind === "append" ? [["20", "PRIVATE-R2-A"]] : [["20", "PRIVATE-R2-A"], ["23", "PRIVATE-R2-B"]]);
  assert.deepEqual(messageIds(result.stdout), ["HARD-HISTORY"]);
  assert.equal(result.stdout.includes("later draft"), false);
  assert.equal((result.stdout + result.stderr).includes("PRIVATE-R2"), false);
  assert.equal(result.stdout.match(/监听结束/g)?.length, 1);
  if (!success) assert.match(result.stderr, /OBSERVATION_INCOMPLETE/);
});

function fakeClock(t: TestContext) { t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 }); t.mock.method(performance, "now", () => Date.now()); }
async function finish<T>(t: TestContext, work: Promise<T>): Promise<T> {
  let settled = false; void work.finally(() => { settled = true; });
  await setImmediate();
  for (let n = 0; !settled && n < 40; n++) { t.mock.timers.tick(1000); await setImmediate(); }
  assert.ok(settled, "two-pass drain must end even without a global timeout"); return work;
}
for (const kind of ["retry-ok", "retry-exhaust"] as const) test(`ACC-FINAL-DRAIN-RETRY-BUDGET: ${kind} cannot restart OPEN or CHECK`, async (t) => {
  fakeClock(t);
  const result = await finish(t, drainScenario(kind));
  assert.equal(result.code, 6, result.stderr); assert.equal(result.closeAttempts, 4);
  const closes = result.steps.filter((step) => step.name === "CHECK2");
  assert.deepEqual(closes.map((step) => step.time - closes[0].time), [0, 1000, 3000, 7000]);
  for (const close of closes) assert.deepEqual([close.since, close.head, close.root], ["23", "PRIVATE-R2-B", "HARD-HISTORY"]);
  assert.equal(result.steps.filter((step) => step.name.startsWith("OPEN")).length, 2);
  assert.match(result.stderr, kind === "retry-ok" ? /OBSERVATION_INCOMPLETE/ : /HTTP_REJECTED/);
  assert.equal(textField(result.stdout, "runStatus"), "completed"); assert.equal(textField(result.stdout, "complete"), "false");
});

test("ACC-FINAL-DRAIN-OPEN-FENCE: CHECK can map the actual OPEN streaming head without expanding its slot", async () => {
  const old = a(); const next = c(); let deltas = 0;
  const result = await scenario((url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([old]));
    deltas++;
    return jsonResult(deltas < 3 ? empty(old.id, 10) : page([next], 12, { timelineReset: true, headReplacement: proof(old, next) }));
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(deltas, 3);
  assert.deepEqual(messageIds(result.stdout), [next.id]);
  assert.equal(result.stdout.match(/上一段草稿已作废/g)?.length, 1);
});

test("ACC-SELECTION-IDLE: initial native streaming head can be replaced without becoming an active future-Run listener", async () => {
  const old = a(); const next = c(); let deltas = 0; let runs = 0;
  const result = await scenario((url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state());
    if (url.pathname.includes("/runs/")) { runs++; return jsonResult(run("r1")); }
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([old]));
    deltas++;
    return jsonResult(deltas === 1 ? page([next], 12, { timelineReset: true, headReplacement: proof(old, next, 12, 2) }) : empty(next.id, 12));
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(runs, 1); assert.equal(deltas, 2);
  assert.deepEqual(messageIds(result.stdout), [next.id]); assert.equal(textField(result.stdout, "outcome"), "no_active_run");
  assert.equal(result.stdout.includes("old visible draft"), false); assert.equal(result.stdout.includes("上一段草稿已作废"), false);
});

test("ACC-RECONCILE-MANY: multiple actually observed retry attempts each invalidate exactly their own segment", async (t) => {
  fakeClock(t);
  const old = a(); const middle = body("PRIVATE-OBSERVED-C", 0, null, "second visible attempt", "streaming", 12);
  const final = body("FINAL-F", 0, null, "third final attempt", "completed", 14);
  let deltas = 0;
  const result = await finish(t, scenario((url, _request, output) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1", output.includes("消息 ID：FINAL-F") ? "completed" : "running"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([old]));
    deltas++;
    if (deltas === 1) return jsonResult(page([middle], 12, { timelineReset: true, headReplacement: proof(old, middle) }));
    if (deltas === 2) return jsonResult(page([final], 14, { timelineReset: true, headReplacement: proof(middle, final) }));
    return jsonResult(empty(final.id, 14));
  }));
  assert.equal(result.code, 0, result.stderr); assert.equal(deltas, 4);
  assert.equal(result.stdout.match(/上一段草稿已作废/g)?.length, 2);
  for (const text of ["old visible draft", "second visible attempt", "third final attempt"]) assert.equal(result.stdout.split(text).length, 2);
  assert.deepEqual(messageIds(result.stdout), [final.id]);
  for (const id of [old.id, middle.id]) assert.equal((result.stdout + result.stderr).includes(id), false);
  const second = result.requests.filter((url) => url.searchParams.get("mode") === "delta")[1];
  assert.deepEqual([second.searchParams.get("sinceRevision"), second.searchParams.get("knownHeadMessageId")], ["12", middle.id]);
});

for (const stop of ["terminal", "probe-http", "abort"] as const) test(`ACC-FINAL-DRAIN-PROBE-ESCAPE: ${stop} escapes the ordinary structural loop before another read`, async (t) => {
  fakeClock(t); const capture = captureIO(); const controller = new AbortController();
  const h = body("H", 0, null, "protected answer");
  const m = body("M", 1, h.id, "later run middle", "completed", 11, "r2");
  const x = body("PRIVATE-X", 2, m.id, "later run draft", "streaming", 12, "r2");
  let runs = 0; let deltas = 0; const steps: string[] = [];
  const work = runCli(["session", ...args], { io: capture.io, signal: controller.signal, createConfigStore: () => connectionStore(), http: { request: async (_origin, path) => {
    const url = new URL(path, "http://fixture.test");
    if (path.includes("/run-state")) return jsonResult(state("r1"));
    if (path.includes("/runs/")) {
      runs++; steps.push("probe:r1");
      if (runs > 1 && stop === "probe-http") return jsonResult({}, 503);
      if (runs === 2 && stop === "abort") { controller.abort(); return jsonResult(run("r1", "running")); }
      return jsonResult(run("r1", runs === 1 ? "running" : "completed"));
    }
    const mode = url.searchParams.get("mode");
    if (mode === "snapshot") return jsonResult(page([h]));
    if (mode === "before") { steps.push("before"); return jsonResult(page([m], 13, { hasMore: true,
      session: agentSession({ revision: 13, headMessageId: x.id, contextRootMessageId: h.id }) })); }
    deltas++; steps.push(`delta${deltas}`);
    if (deltas === 1) return jsonResult(page([x], 12, { timelineReset: true, hasMore: true }));
    if (deltas === 2) return jsonResult(page([h, m, x], 14, { timelineReset: true,
      session: agentSession({ revision: 14, headMessageId: x.id, contextRootMessageId: h.id }) }));
    return jsonResult(empty(x.id, 14, h.id));
  } } });
  const code = await finish(t, work);
  assert.equal(code, stop === "terminal" ? 0 : stop === "probe-http" ? 6 : 130, capture.diagnostic());
  assert.deepEqual(steps.slice(0, 4), ["delta1", "probe:r1", "before", "probe:r1"]);
  assert.equal(deltas, stop === "terminal" ? 3 : 1);
  assert.equal(runs, stop === "probe-http" ? 5 : 2);
  if (stop === "terminal") assert.deepEqual(steps, ["delta1", "probe:r1", "before", "probe:r1", "delta2", "delta3"]);
  assert.deepEqual(messageIds(capture.output()), [h.id]);
  assert.equal(capture.output().includes("later run draft"), false);
  if (stop === "probe-http") assert.match(capture.diagnostic(), /HTTP_REJECTED/);
});

test("ACC-FINAL-DRAIN-PROTECTED: known terminal plus valid target proof cannot hide another selected Run rollback", async () => {
  const u = body("PROTECTED-OTHER-RUN", 0, null, "hard historical body", "completed", 1, "old-run");
  const old = body(draftId, 1, u.id, "old visible draft", "streaming");
  const next = body("FINAL-C", 1, u.id, "must remain staged", "completed", 12);
  let deltas = 0;
  const result = await scenario((url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([u, old]));
    deltas++;
    return jsonResult(deltas === 1 ? empty(old.id, 10) : page([next], 12, { timelineReset: true, headReplacement: proof(old, next) }));
  }, ["-n", "2"]);
  assert.equal(result.code, 6); assert.match(result.stderr, /TIMELINE_CHANGED/);
  assert.equal(deltas, 2, "proven hard-history loss fails in OPEN, without CHECK or another pass");
  assert.equal(textField(result.stdout, "runStatus"), "completed");
  assert.equal(result.stdout.includes("must remain staged"), false); assert.equal(result.stdout.includes("上一段草稿已作废"), false);
});

test("ACC-SELECTION-IDLE/RECONCILE-PAGING: native H0 replacement happens before initial last N prefix loads", async () => {
  const before = body("BEFORE", 0, null, "unselected older history", "completed", 1);
  const user = body("USER", 1, before.id, "selected user", "completed", 2); user.type = "user";
  const old = body(draftId, 2, user.id, "old draft", "streaming");
  const final = body("FINAL-C", 2, user.id, "idle final", "completed", 12);
  let deltas = 0; const cursors: string[] = [];
  const result = await scenario((url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state());
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
    const mode = url.searchParams.get("mode");
    if (mode === "snapshot") return jsonResult(page([old], 10, { hasMore: true }));
    if (mode === "before") { cursors.push(url.searchParams.get("beforeMessageId")!); return jsonResult(page([before, user], 12,
      { session: agentSession({ revision: 12, headMessageId: final.id }) })); }
    deltas++; return jsonResult(deltas === 1 ? page([final], 12, { timelineReset: true, hasMore: true, headReplacement: proof(old, final) }) : empty(final.id, 12));
  }, ["-n", "2"]);
  assert.equal(result.code, 0, result.stderr); assert.deepEqual(cursors, [final.id]);
  assert.deepEqual(messageIds(result.stdout), [user.id, final.id]);
  assert.equal(result.stdout.includes("unselected older history"), false);
});

for (const mode of ["head-id-only", "newer-raw", "hidden-final", "user-head"] as const) test(`ACC-FINAL-DRAIN-OPEN-FENCE/PROOF-CLIENT: ${mode} cannot acquire mutable head privilege`, async () => {
  const old = a(); const final = c(); let deltas = 0;
  if (mode === "newer-raw") old.updatedRevision = 11;
  if (mode === "hidden-final") { old.status = "completed"; old.parts = [messagePart(old.id, "reasoning")]; }
  if (mode === "user-head") old.type = "user";
  const result = await scenario((url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(mode === "head-id-only"
      ? page([], 10, { session: agentSession({ revision: 10, headMessageId: old.id }) }) : page([old]));
    deltas++; return jsonResult(page([final], 12, { timelineReset: true, headReplacement: proof({ ...old, updatedRevision: 10 }, final) }));
  });
  assert.equal(result.code, 6, result.stderr); assert.equal(result.stdout.includes("independent final attempt"), false);
  assert.equal(result.stdout.includes("上一段草稿已作废"), false);
  if (mode === "head-id-only" || mode === "newer-raw") assert.equal(deltas, 0);
});

test("ACC-SELECTION-AFTER: unknown initial hard anchor keeps ANCHOR_NOT_FOUND and no historical output", async () => {
  const result = await executeFollow(["messages", "-w", "w", "-s", "s", "--after", "PRIVATE-UNKNOWN", "-f"], (url) => jsonResult(
    url.pathname.endsWith("/run-state") ? state("r1") : page([body("H", 0, null, "must not output")])));
  assert.equal(result.code, 6); assert.match(result.stderr, /ANCHOR_NOT_FOUND/);
  assert.equal(result.stdout.includes("must not output"), false); assert.equal((result.stdout + result.stderr).includes("PRIVATE-UNKNOWN"), false);
});

test("ACC-SELECTION-LAST: a hidden initial slot becoming visible during pagination cannot displace frozen history", async () => {
  const before = body("BEFORE", 0, null, "oldest selected history", "completed", 1, "old-run");
  const selected = body("SELECTED", 1, before.id, "already selected tail history", "completed", 2, "old-run");
  const old = body(draftId, 2, selected.id, "", "streaming"); old.parts = [messagePart(old.id, "reasoning")];
  const final = body("FINAL-C", 2, selected.id, "newly visible current attempt", "completed", 12);
  let deltas = 0; const steps: string[] = [];
  const result = await scenario((url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) { steps.push("probe"); return jsonResult(run("r1")); }
    const mode = url.searchParams.get("mode");
    if (mode === "snapshot") return jsonResult(page([selected, old], 10, { hasMore: true }));
    if (mode === "before") { steps.push("before"); return jsonResult(page([before], 12, { session: agentSession({ revision: 12, headMessageId: final.id }) })); }
    steps.push(++deltas === 1 ? "OPEN" : "CHECK");
    return jsonResult(deltas === 1 ? page([before, selected, final], 12, { timelineReset: true, headReplacement: proof(old, final) }) : empty(final.id, 12));
  }, ["-n", "2"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(steps, ["before", "probe", "OPEN", "CHECK"]);
  assert.deepEqual(messageIds(result.stdout), [before.id, selected.id, final.id]);
  assert.equal(result.stdout.match(/already selected tail history/g)?.length, 1);
});

test("ACC-SELECTION-AFTER/FIXED: metadata-only updates below a hard after boundary cannot enter the selected output", async () => {
  const older = body("OLDER", 0, null, "excluded old answer", "completed", 1);
  const anchor = body("ANCHOR", 1, older.id, "excluded user anchor", "completed", 2); anchor.type = "user";
  let deltas = 0;
  const result = await scenario((url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([older, anchor]));
    deltas++;
    return jsonResult(deltas === 1 ? page([{ ...older, updatedRevision: 11 }], 11,
      { session: agentSession({ revision: 11, headMessageId: anchor.id }) }) : empty(anchor.id, 11));
  }, ["--after", anchor.id]);
  assert.equal(result.code, 0, result.stderr); assert.deepEqual(messageIds(result.stdout), []);
  assert.equal(result.stdout.includes("excluded old answer"), false); assert.equal(result.stdout.includes("excluded user anchor"), false);
});

test("ACC-SELECTION-LATER-RETRY: accepted send never protects an unselected initial r2 tail as its automatic H0", async () => {
  const user = body("ACCEPTED-USER", 0, null, "accepted prompt", "completed", 1, null); user.type = "user";
  const answer = body("TARGET-ANSWER", 1, user.id, "only target output", "completed", 9);
  const later = body("PRIVATE-R2-A", 2, answer.id, "later run body", "streaming", 10, "r2");
  const successor = body("PRIVATE-R2-B", 2, answer.id, "later replacement body", "streaming", 12, "r2");
  let deltas = 0;
  const result = await executeFollow(["send", "-w", "w", "-s", "s", "--prompt", "fixture", "-f"], (url) => {
    if (url.pathname.endsWith("/agents/available")) return jsonResult({ agents: [{ id: "agent", name: "agent", summary: "" }] });
    if (url.pathname === "/api/agent/sessions/s") return jsonResult(agentSession());
    if (url.pathname.endsWith("/messages")) return jsonResult({ sessionId: "s", messageId: user.id, runId: "r1", deduplicated: false }, 201);
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([user, answer, later]));
    deltas++;
    return jsonResult(deltas < 3 ? page([user, answer, successor], 12, { timelineReset: true, headReplacement: proof(later, successor) }) : empty(successor.id, 12));
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(deltas, 3);
  assert.deepEqual(messageIds(result.stdout), [answer.id]);
  assert.equal(result.stdout.includes("later run body"), false); assert.equal(result.stdout.includes("later replacement body"), false);
  assert.equal((result.stdout + result.stderr).includes("PRIVATE-R2"), false);
  assert.equal(result.requests.filter(({ request }) => request.method === "POST").length, 1);
});

test("ACC-FINAL-DRAIN-APPEND-ONLY: many before pages see continuously appended r2 heads but never chase them", async () => {
  const h = body("TARGET-H", 0, null, "fixed target body", "completed", 10);
  const chain = [h];
  for (let depth = 1; depth <= 240; depth++) chain.push(body(`R2-${depth}`, depth, chain.at(-1)!.id, "later history", depth === 240 ? "streaming" : "completed", 20, "r2"));
  const later = [...chain];
  for (let depth = 241; depth <= 243; depth++) later.push(body(`R2-${depth}`, depth, later.at(-1)!.id, "new later suffix", depth === 243 ? "streaming" : "completed", depth - 219, "r2"));
  let deltas = 0; let beforeCount = 0;
  const result = await scenario((url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.pathname.includes("/runs/")) return jsonResult(run("r1"));
    const mode = url.searchParams.get("mode");
    if (mode === "snapshot") return jsonResult(page([h]));
    if (mode === "before") {
      beforeCount++;
      return jsonResult(paged(chain, url, 21 + beforeCount, { session: agentSession({ revision: 21 + beforeCount, headMessageId: `R2-${240 + beforeCount}` }) }));
    }
    deltas++;
    if (deltas === 1) return jsonResult(empty(h.id, 10));
    if (deltas === 2) return jsonResult(paged(chain, url, 20, { timelineReset: true }));
    return jsonResult(page([{ ...chain.at(-1)!, status: "completed", updatedRevision: 21 }, ...later.slice(241)], 24));
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(deltas, 3); assert.equal(beforeCount, 2);
  assert.deepEqual(result.requests.filter((url) => url.searchParams.get("mode") === "before").map((url) => url.searchParams.get("beforeMessageId")), ["R2-141", "R2-41"]);
  assert.deepEqual(messageIds(result.stdout), [h.id]); assert.equal(result.stdout.includes("later history"), false);
});

test("ACC-RECONCILE-UNRELATED: a retained message cannot rewrite its replacement parent under the same ID", async () => {
  const old = a();
  const result = await executeFollow(args, (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r1"));
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([old]));
    return jsonResult(page([msg(old.id, old.depth, old.previousMessageId, { ...old, replacesMessageId: "PRIVATE-UNRELATED-PARENT", updatedRevision: 11 })], 11));
  });
  assert.equal(result.code, 6); assert.match(result.stderr, /TIMELINE_CHANGED/);
  assert.equal((result.stdout + result.stderr).includes("PRIVATE-UNRELATED-PARENT"), false);
});
