import assert from "node:assert/strict";
import test from "node:test";
import { CliError } from "../src/errors.js";
import { assertSameRecord } from "../src/follow-chain.js";
import { parseMessage, parseTimeline } from "../src/messages.js";
import { agentSession, jsonResult, messagePart } from "./agent-fixture.js";
import { executeFollow, msg, page, paged, run, state, type RawMessage } from "./follow-fixture.js";
import { messageIds, textField } from "./helpers.js";

const inherited = (id: string, depth: number, previousMessageId: string | null, revision: number, originSessionId: string | null = "source") =>
  msg(id, depth, previousMessageId, { originSessionId, updatedRevision: revision });
const forkSession = (headMessageId: string | null, revision = 0) => agentSession({ headMessageId, revision,
  forkedFromSessionId: "source", forkedFromMessageId: "inherited-204" });
const inheritedHistory = (originSessionId: string | null = "source") => Array.from({ length: 205 }, (_, index) =>
  inherited(`inherited-${index}`, index, index ? `inherited-${index - 1}` : null, index % 2 ? 300 : 500, originSessionId));
const args = ["messages", "-w", "w", "-s", "s"];

test("Fork snapshot and before pages allow inherited revisions above the local watermark and decreasing with depth", async () => {
  const messages = [...inheritedHistory(), msg("local-user", 205, "inherited-204", { type: "user", originRunId: null })];
  const result = await executeFollow([...args, "-n", "206"], (url) => {
    assert.equal(url.pathname.endsWith("/timeline"), true);
    return jsonResult(paged(messages, url, 1, { session: forkSession("local-user", 1) }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(messageIds(result.stdout), messages.map((message) => message.id));
  assert.equal(result.requests.filter(({ url }) => url.searchParams.get("mode") === "snapshot").length, 1);
  assert.equal(result.requests.filter(({ url }) => url.searchParams.get("mode") === "before").length, 2);
});

test("Timeline version, duplicate ID and non-increasing depth failures have distinct diagnostics", () => {
  const first = inherited("first", 0, null, 500);
  const second = inherited("second", 1, "first", 300);
  const cases: [RawMessage[], string][] = [
    [[msg("local", 0, null, { updatedRevision: 1 })], "消息版本高于所属会话版本。"],
    [[first, first], "消息页包含重复 ID。"],
    [[first, { ...second, depth: 0 }], "消息页顺序异常：depth 必须严格递增。"],
    [[second, first], "消息页顺序异常：depth 必须严格递增。"]
  ];
  for (const [messages, expected] of cases) {
    assert.throws(() => parseTimeline(page(messages, 0), "w", "s"),
      (error: unknown) => error instanceof CliError && error.exitCode === 6 && error.message === expected);
  }
});

test("Deleted-origin messages keep valid nullable identity without a cross-session version bound", () => {
  const message = inherited("deleted-origin", 0, null, 500, null);
  const result = parseTimeline(page([message], 0), "w", "s");
  assert.equal(result.messages[0].originSessionId, null);
  assert.equal(result.messages[0].updatedRevision, 500);
});

for (const originSessionId of ["source", null]) test(`Fork idle follow closes once with paged ${originSessionId ?? "deleted-origin"} history`, async () => {
  const messages = inheritedHistory(originSessionId);
  let deltas = 0;
  const result = await executeFollow([...args, "-n", "205", "-f"], (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state());
    assert.equal(url.pathname.endsWith("/timeline"), true, "inherited Run must not be observed as a native Run");
    const session = forkSession("inherited-204");
    if (url.searchParams.get("mode") === "delta") {
      assert.equal(++deltas, 1, "idle closing must not enter a relocation loop");
      assert.equal(url.searchParams.get("sinceRevision"), "0");
      return jsonResult(page(messages, 0, { session }));
    }
    return jsonResult(paged(messages, url, 0, { session }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(textField(result.stdout, "complete"), "true");
  assert.equal(textField(result.stdout, "outcome"), "no_active_run");
  assert.deepEqual(messageIds(result.stdout), messages.map((message) => message.id));
  assert.equal(result.requests.filter(({ url }) => url.searchParams.get("mode") === "before").length, 2);
  assert.equal(deltas, 1);
});

test("Fork active follow initializes across history pages and drains native updates below inherited revisions", async () => {
  const older = inherited("older", 0, null, 500);
  const newer = inherited("newer", 1, "older", 300, "another-source");
  const user = msg("local-user", 2, "newer", { type: "user", originRunId: null, updatedRevision: 1 });
  const draft = msg("local-draft", 3, "local-user", { status: "streaming", updatedRevision: 2,
    parts: [messagePart("local-draft", "text", { text: "partial", updatedRevision: 2 })] });
  const completed = { ...draft, status: "completed", updatedRevision: 3,
    parts: [messagePart("local-draft", "text", { text: "partial finished", updatedRevision: 3 })] };
  let deltas = 0;
  const result = await executeFollow([...args, "-n", "4", "-f"], (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r"));
    if (url.pathname.includes("/runs/")) return jsonResult(run());
    const mode = url.searchParams.get("mode");
    if (mode === "snapshot") return jsonResult(page([draft], 2, { session: forkSession(draft.id, 2), hasMore: true }));
    if (mode === "before") return jsonResult(page([older, newer, user], 2, { session: forkSession(draft.id, 2) }));
    assert.equal(mode, "delta");
    assert.ok(++deltas <= 4, "inherited versions must not cause relocation or extra final-drain passes");
    assert.equal(url.searchParams.get("sinceRevision"), deltas <= 2 ? "2" : "3");
    return jsonResult(page([older, newer, ...(deltas === 2 ? [completed] : [])], deltas === 1 ? 2 : 3,
      { session: forkSession(draft.id, deltas === 1 ? 2 : 3) }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(deltas, 4);
  assert.equal(textField(result.stdout, "complete"), "true");
  assert.equal(textField(result.stdout, "outcome"), "run_completed");
  assert.deepEqual(messageIds(result.stdout), [older.id, newer.id, user.id, draft.id]);
  assert.match(result.stdout, /partial finished/);
});

test("Fork follow observes newly appended native Run messages without comparing them to inherited versions", async () => {
  const history = inherited("history", 0, null, 500);
  const user = msg("new-user", 1, history.id, { type: "user", originRunId: "r", updatedRevision: 1 });
  const answer = msg("new-answer", 2, user.id, { updatedRevision: 2 });
  let deltas = 0;
  const result = await executeFollow([...args, "-n", "1", "-f"], (url) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state("r"));
    if (url.pathname.includes("/runs/")) return jsonResult(run());
    if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([history], 0, { session: forkSession(history.id) }));
    assert.equal(url.searchParams.get("mode"), "delta");
    assert.ok(++deltas <= 3, "new native messages must not create an inherited-version relocation loop");
    assert.equal(url.searchParams.get("sinceRevision"), deltas === 1 ? "0" : "2");
    return jsonResult(page(deltas === 1 ? [history, user, answer] : [history], 2, { session: forkSession(answer.id, 2) }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(deltas, 3);
  assert.equal(textField(result.stdout, "complete"), "true");
  assert.equal(textField(result.stdout, "outcome"), "run_completed");
  assert.deepEqual(messageIds(result.stdout), [history.id, user.id, answer.id]);
});

test("Inherited messages still reject same-message revision rollback, identity changes and terminal body rewrites", () => {
  const raw = inherited("history", 0, null, 500);
  const original = parseMessage(raw, "w");
  for (const mutation of [
    { ...raw, updatedRevision: 499 },
    { ...raw, originSessionId: "different-source" },
    { ...raw, updatedRevision: 501, parts: [messagePart(raw.id, "text", { text: "rewritten" })] }
  ]) {
    assert.throws(() => assertSameRecord(original, parseMessage(mutation, "w")), CliError);
  }
});
