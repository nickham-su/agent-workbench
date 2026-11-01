import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { CliError, errorDiagnostic } from "../src/errors.js";
import { FollowLifetime } from "../src/follow-lifetime.js";
import { FollowOutput } from "../src/follow-output.js";
import { MessageRenderer, messageBody } from "../src/message-render.js";
import { parseMessage, projectMessage } from "../src/messages.js";
import { writeText } from "../src/output.js";
import { agentMessage, agentSession, connectionStore, jsonResult, messagePart, timelineFixture } from "./agent-fixture.js";
import { page, run, state } from "./follow-fixture.js";
import { runCli } from "../src/program.js";
import { captureIO, messageIds } from "./helpers.js";

function view(text: string, revision = 1, status = "streaming", parts?: ReturnType<typeof messagePart>[]) {
  return parseMessage(agentMessage(0, { id: "draft-secret", status, updatedRevision: revision,
    parts: parts ?? [messagePart("draft-secret", "text", { text, updatedRevision: revision })] }), "w");
}
function rendered(mode: "follow" | "snapshot" = "follow") {
  const chunks: string[] = [];
  const renderer = new MessageRenderer(async (text) => { chunks.push(text); }, mode);
  return { chunks, renderer, text: () => chunks.join("") };
}

test("ACC-RENDER-APPEND/NOCHANGE/FAST: exact suffix writes, independent revisions and terminal footer", async () => {
  const x = rendered();
  await x.renderer.message(view("你好")); assert.deepEqual(x.chunks, ["助手回复（生成中）：\n", "你好"]);
  await x.renderer.message(view("你好，我是", 2)); assert.equal(x.chunks.at(-1), "，我是");
  await x.renderer.message(view("你好，我是", 3)); assert.equal(x.chunks.length, 3);
  await x.renderer.message(view("你好，我是助手", 4, "completed"));
  assert.equal(x.chunks.at(-2), "助手"); assert.equal(x.chunks.at(-1), "\n—— 本条回复已完成 ——\n消息 ID：draft-secret\n");
  const length = x.chunks.length; await x.renderer.message(view("你好，我是助手", 4, "completed"));
  await x.renderer.message(view("你好，我是助手", 5, "completed")); assert.equal(x.chunks.length, length);
  assert.deepEqual(messageIds(x.text()), ["draft-secret"]);
  const fast = rendered(); await fast.renderer.message(view("already done", 1, "completed"));
  assert.doesNotMatch(fast.text(), /生成中/); assert.deepEqual(messageIds(fast.text()), ["draft-secret"]);
});

for (const [name, raw, next, expected] of [
  ["CRLF", "A\r", "A\r\nB", "A\nB"],
  ["CR-other", "A\r", "A\rX", "A\\rX"],
  ["SURROGATE", "A\ud83d", "A\ud83d\ude00", "A😀"],
  ["SURROGATE-other", "A\ud83d", "A\ud83dX", "A�X"]
]) test(`ACC-RENDER-FOLLOW-${name}-PAIR: cross-version stable prefix uses exact UTF-8`, async () => {
  const x = rendered(); await x.renderer.message(view(raw)); assert.equal(x.chunks[1], "A");
  assert.equal(Buffer.from(x.text()).includes(Buffer.from("�")), false);
  await x.renderer.message(view(next, 2, "completed"));
  assert.deepEqual(Buffer.from(x.chunks.slice(1, -1).join("")), Buffer.from(expected));
  assert.equal(messageBody(view(next, 2, "completed"), "snapshot"), expected);
});

for (const [name, text, expected] of [["CR", "A\r", "A\\r"], ["SURROGATE", "A\ud83d", "A�"]]) {
  test(`ACC-RENDER-SNAPSHOT-${name}: local flush includes tail without sealing or releasing identity`, async () => {
    const x = rendered("snapshot"); const raw = view(text); await x.renderer.message(raw);
    assert.deepEqual(Buffer.from(x.chunks[1]), Buffer.from(expected));
    assert.equal(raw.status, "streaming"); assert.equal(x.renderer.released.size, 0); assert.deepEqual(messageIds(x.text()), []);
    assert.equal(x.renderer.states.get(raw.id)?.localFlushComplete, true);
    assert.equal(x.renderer.states.get(raw.id)?.businessSealed, false);
    assert.match(x.text(), /仍在生成/);
  });
}

test("ACC-RENDER-ESCAPE/UNICODE: controls, backslashes, low surrogates and body JSON remain safe", async () => {
  const raw = 'JSON {"a":1}\n\\\t\u001b[31m\r\udc00\u0000';
  const x = rendered(); await x.renderer.message(view(raw, 1, "completed"));
  assert.equal(x.chunks[1], 'JSON {"a":1}\n\\\\\\t\\u001b[31m\\r�\\u0000');
  assert.equal(x.text().includes("\u001b"), false);
});

test("ACC-RENDER-PARTS/SEALED/SEAL-TAIL: layout order, hidden seals, and duplicate image attachments", async () => {
  const id = "draft-secret";
  const text = (value: string, position: number, revision = 1) => messagePart(id, "text", { id: `p${position}`, position, text: value, updatedRevision: revision });
  const hidden = messagePart(id, "reasoning", { id: "hidden", position: 2, text: "private reasoning" });
  const image = (position: number) => messagePart(id, "image", { id: `p${position}`, position });
  const initial = view("", 1, "streaming", [text("A\r", 0)]);
  const x = rendered(); await x.renderer.message(initial);
  const nextParts = [text("A\r", 0), hidden, image(3), image(4), text("Z\ud83d", 5, 2)];
  const next = view("", 2, "streaming", nextParts);
  await x.renderer.message(next);
  assert.equal(x.chunks.at(-1), "\\r\n[图片 attachmentId=attachment mediaType=image/png filename=picture.png]\n[图片 attachmentId=attachment mediaType=image/png filename=picture.png]\nZ");
  assert.doesNotMatch(x.text(), /private reasoning|hidden/);
  const parsed = JSON.stringify(next); assert.equal(parsed.includes("private reasoning"), false);
  assert.equal(next.layoutParts.find((part) => part.type === "hidden")?.id, "hidden");
  await assert.rejects(x.renderer.message(view("", 3, "streaming", [text("A\rMORE", 0, 3), hidden, image(3), image(4), text("Z\ud83d", 5, 2)])), { exitCode: 6 });
  await x.renderer.message(view("", 3, "failed", nextParts));
  assert.ok(x.text().includes("Z�\n—— 本条回复失败"));
});

for (const kind of ["id", "type", "position", "delete", "prepend", "image", "revision", "same-revision", "rewrite", "terminal"]) {
  test(`ACC-RENDER-LAYOUT: rejects ${kind} rather than reprinting revised body`, async () => {
    const id = "draft-secret";
    const parts = [messagePart(id, "text", { id: "text", position: 0, text: "original" }), messagePart(id, "image", { id: "image", position: 1 })];
    const x = rendered(); await x.renderer.message(view("", 2, kind === "terminal" ? "completed" : "streaming", parts));
    const changed = structuredClone(parts); let revision = 3;
    if (kind === "id") changed[0].id = "changed";
    if (kind === "type") changed[0] = messagePart(id, "reasoning", { id: "text" });
    if (kind === "position") changed[0].position = 3;
    if (kind === "delete") changed.pop();
    if (kind === "prepend") changed.push(messagePart(id, "text", { id: "new", position: 0 }));
    if (kind === "image") Object.assign(changed[1], { filename: "changed.png" });
    if (kind === "revision") changed[0].updatedRevision = 0;
    if (kind === "same-revision") { revision = 2; changed.push(messagePart(id, "text", { id: "new", position: 2 })); }
    if (kind === "rewrite") Object.assign(changed[0], { text: "revised" });
    if (kind === "terminal") changed.push(messagePart(id, "text", { id: "new", position: 2 }));
    const before = x.text();
    await assert.rejects(async () => x.renderer.message(view("", revision, kind === "terminal" ? "completed" : "streaming", changed)), (error) => error instanceof CliError && error.exitCode === 6);
    assert.equal(x.text(), before);
  });
}

test("ACC-ID-WRITE/ACC-LIFETIME-BACKPRESSURE: footer is not submitted before the body write callback", async () => {
  const chunks: string[] = []; let finishBody!: () => void;
  const stdout = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
    const text = String(chunk); chunks.push(text);
    if (text === "body") finishBody = done; else done();
  } });
  const renderer = new MessageRenderer((text) => writeText(stdout, text), "follow");
  const operation = renderer.message(view("body", 1, "completed"));
  await setImmediate(); assert.deepEqual(chunks, ["助手回复：\n", "body"]); assert.equal(renderer.released.size, 0);
  assert.equal(chunks.join("").includes("draft-secret"), false);
  finishBody(); await operation; assert.deepEqual(messageIds(chunks.join("")), ["draft-secret"]); assert.equal(renderer.released.has("draft-secret"), true);
});

test("ACC-ID-WRITE-FAIL: body/footer errors do not publish identity or expose it in error context", async () => {
  for (const fail of ["body", "footer"]) {
    const capture = captureIO(); const chunks: string[] = [];
    const stdout = new Writable({ write(chunk, _encoding, done) {
      const text = String(chunk);
      if (fail === "body" && text === "body" || fail === "footer" && text.includes("消息 ID")) done(Object.assign(Error("private-write"), { code: "EPIPE" }));
      else { chunks.push(text); done(); }
    } });
    const lifetime = new FollowLifetime(stdout);
    try {
      const output = new FollowOutput({ ...capture.io, stdout }, lifetime, { workspaceId: "w", sessionId: "s" }, "r");
      await assert.rejects(output.message(view("body", 1, "completed"), "follow"), { exitCode: 141 });
      assert.equal(output.released.size, 0); assert.equal(chunks.join("").includes("draft-secret"), false);
      assert.equal(output.error(new CliError(6, "safe", { context: { messageId: "draft-secret" } })).details.context?.messageId, undefined);
    } finally { lifetime.dispose(); }
    await setImmediate();
  }
});

test("ACC-RENDER-REPLACE/ACC-ID-REPLACE: proven replacement invalidates an old visible segment without draft IDs", async () => {
  const capture = captureIO(); const lifetime = new FollowLifetime(capture.io.stdout);
  try {
    const output = new FollowOutput(capture.io, lifetime, { workspaceId: "w", sessionId: "s" }, "r");
    await output.metadata("session messages", { activeAssistantMessageId: "draft-secret", headMessageId: "draft-secret" });
    await output.message(view("old partial"), "follow"); await output.supersedeDraft("draft-secret");
    assert.equal(output.emitted.has("draft-secret"), false); assert.doesNotMatch(capture.output(), /draft-secret/);
    assert.match(capture.output(), /old partial\n—— 上一段草稿已作废/);
    const successor = { ...view("new answer", 2, "completed"), id: "final-id" };
    await output.message(successor, "follow"); assert.deepEqual(messageIds(capture.output()), ["final-id"]);
    await assert.rejects(output.supersedeDraft("final-id"), { exitCode: 6 });
    const empty = parseMessage(agentMessage(0, { status: "streaming", parts: [messagePart("m0", "reasoning")] }), "w");
    assert.equal(projectMessage(empty), null);
    const before = capture.output(); await output.supersedeDraft(empty.id); assert.equal(capture.output(), before);
  } finally { lifetime.dispose(); }
});

for (const [name, raw, expected] of [["CR", "A\r", "A\\r"], ["SURROGATE", "A\ud83d", "A�"]]) {
  test(`ACC-RENDER-FOLLOW-${name}-PAIR: terminal without a suffix releases pending bytes exactly once`, async () => {
    const x = rendered(); await x.renderer.message(view(raw));
    assert.equal(x.chunks[1], "A"); assert.equal(x.renderer.states.get("draft-secret")?.pendingTail, raw.slice(-1));
    await x.renderer.message(view(raw, 2, "cancelled"));
    assert.deepEqual(Buffer.from(x.chunks.slice(1, -1).join("")), Buffer.from(expected));
    assert.match(x.text(), /本条回复已取消/); assert.deepEqual(messageIds(x.text()), ["draft-secret"]);
  });
}

test("ACC-RENDER-LONG/MULTI: hundreds of revisions have linear output volume, then independent user and assistant bodies", async () => {
  const x = rendered(); const raw = "你好😀\r\n\t\\中文".repeat(40);
  for (let index = 1; index <= raw.length; index++) await x.renderer.message(view(raw.slice(0, index), index));
  await x.renderer.message(view(raw, raw.length + 1, "completed"));
  assert.equal(x.chunks.slice(1, -1).join(""), messageBody(view(raw, raw.length + 1, "completed"), "snapshot"));
  const user = parseMessage(agentMessage(1, { type: "user", originRunId: null, parts: [messagePart("m1", "text", { text: "user history" })] }), "w");
  const assistant = parseMessage(agentMessage(2, { parts: [messagePart("m2", "text", { text: "next answer" })] }), "w");
  await x.renderer.message(user); await x.renderer.message(user); await x.renderer.message(assistant);
  assert.equal(x.text().match(/user history/g)?.length, 1); assert.equal(x.text().match(/next answer/g)?.length, 1);
  assert.deepEqual(messageIds(x.text()), ["draft-secret", "m1", "m2"]);
});

test("ACC-ID-ERROR: diagnostic whitelist omits message and alias pointers while preserving stable codes and accepted user identity", async () => {
  const error = new CliError(6, "safe observation", { code: "RESPONSE_INVALID", phase: "history", effect: "not_applicable",
    context: { workspaceId: "w", sessionId: "s", runId: "r", messageId: "draft-secret", ...{ partId: "part-secret", replacesMessageId: "draft-secret", activeAssistantMessageId: "draft-secret" } } });
  const diagnostic = errorDiagnostic(error);
  assert.doesNotMatch(diagnostic, /draft-secret|part-secret|partId|replacesMessageId|activeAssistantMessageId/);
  assert.match(diagnostic, /错误码：RESPONSE_INVALID/); assert.match(diagnostic, /runId=r/);
  const accepted = errorDiagnostic(new CliError(7, "saved response but local failure", { phase: "send", effect: "accepted", context: { messageId: "user-id" } }));
  assert.match(accepted, /用户消息 ID：user-id/); assert.match(accepted, /effect=accepted/);
});

test("ACC-RENDER-APPEND/ACC-ID-BEFORE: actual follow exposes each suffix before the next request, never a draft ID", async () => {
  const capture = captureIO(); let deltas = 0;
  const raw = (text: string, revision = 1, status = "streaming") => agentMessage(0, { id: "streaming-draft-secret", status, updatedRevision: revision,
    parts: [messagePart("streaming-draft-secret", "text", { text, updatedRevision: revision })] });
  const result = await runCli(["session", "messages", "-w", "w", "-s", "s", "-n", "1", "-f"], {
    io: capture.io, createConfigStore: () => connectionStore(), http: { request: async (_origin, path) => {
      const url = new URL(path, "http://fixture.test");
      if (url.pathname.endsWith("/run-state")) return jsonResult(state("r"));
      if (url.pathname.endsWith("/runs/r")) {
        assert.ok(capture.output().includes("你好，我是")); assert.doesNotMatch(capture.output(), /streaming-draft-secret/);
        return jsonResult(run());
      }
      if (url.searchParams.get("mode") === "snapshot") return jsonResult(page([raw("你好")], 10));
      deltas++;
      assert.doesNotMatch(capture.output(), /streaming-draft-secret/);
      assert.ok(capture.output().includes(deltas === 1 ? "你好" : "你好，我是"));
      return jsonResult(page([raw(deltas === 1 ? "你好，我是" : "你好，我是助手", 10 + deltas, deltas === 1 ? "streaming" : "completed")], 10 + deltas,
        { session: agentSession({ headMessageId: "streaming-draft-secret", revision: 10 + deltas }) }));
    } }
  });
  assert.equal(result, 0, capture.diagnostic()); assert.equal(deltas, 3);
  assert.equal(capture.output().match(/你好/g)?.length, 1); assert.deepEqual(messageIds(capture.output()), ["streaming-draft-secret"]);
});

for (const [name, tail, expected] of [["CR", "\r", "A\\r"], ["SURROGATE", "\ud83d", "A�"]]) {
  test(`ACC-RENDER-SNAPSHOT-${name}: actual non-follow command locally flushes without ID`, async () => {
    const capture = captureIO();
    assert.equal(await runCli(["session", "messages", "-w", "w", "-s", "s", "-n", "1"], {
      io: capture.io, createConfigStore: () => connectionStore(), http: { request: async () => jsonResult(timelineFixture([agentMessage(0, {
        status: "streaming", parts: [messagePart("m0", "text", { text: "A" + tail })]
      })])) }
    }), 0, capture.diagnostic());
    const body = capture.output().split("\n——")[0].slice("助手回复（生成中）：\n".length);
    assert.deepEqual(Buffer.from(body), Buffer.from(expected)); assert.deepEqual(messageIds(capture.output()), []);
    assert.match(capture.output(), /仍在生成/); assert.match(capture.output(), /消息快照结束：已输出 1 条普通消息/);
  });
}

test("M1/ACC-RECONCILE-MANY: 80 large retired drafts retain identities, not raw/layout/body/tail snapshots", async () => {
  let invalidations = 0; let headers = 0; let bodyCharacters = 0; let leakedDraftId = false;
  const renderer = new MessageRenderer(async (text) => {
    if (text.includes("上一段草稿已作废")) invalidations++;
    else if (text.startsWith("助手回复")) headers++;
    else if (!text.includes("消息 ID：")) bodyCharacters += text.length;
    leakedDraftId ||= /PRIVATE-RETIRED-\d+/.test(text);
  }, "follow");
  const ids: string[] = [];
  const makeDraft = (id: string, text: string) => parseMessage(agentMessage(0, { id, status: "streaming",
    parts: [messagePart(id, "text", { text })] }), "w");
  const size = 128 * 1024;
  for (let attempt = 0; attempt < 80; attempt++) {
    const id = `PRIVATE-RETIRED-${attempt}`; ids.push(id);
    await renderer.message(makeDraft(id, "x".repeat(size) + "\r"));
    assert.equal(renderer.states.size, 1, "only the current draft owns a body state");
    assert.equal(renderer.states.get(id)?.writtenBody.length, size);
    assert.equal(renderer.states.get(id)?.pendingTail, "\r");
    await renderer.supersedeDraft(id);
    assert.equal(renderer.states.size, 0, "retirement releases all raw, layout, normalized body and pending-tail state");
    assert.equal(renderer.released.has(id), false);
  }
  assert.equal(headers, 80); assert.equal(invalidations, 80); assert.equal(bodyCharacters, 80 * size);
  assert.equal(leakedDraftId, false);
  for (const id of ids) {
    await assert.rejects(renderer.message(makeDraft(id, "must not replay")), { exitCode: 6 });
    await assert.rejects(renderer.message({ ...makeDraft(id, "terminal must not replay"), status: "completed" }), { exitCode: 6 });
    await assert.rejects(renderer.supersedeDraft(id), { exitCode: 6 });
  }
  assert.equal(invalidations, 80, "repeat retirement is rejected without another separator");
  assert.equal(renderer.states.size, 0);
  const final = { ...view("final answer", 1, "completed"), id: "FINAL-RELEASED" };
  await renderer.message(final);
  assert.equal(renderer.released.has(final.id), true);
  await assert.rejects(renderer.supersedeDraft(final.id), { exitCode: 6 });
  assert.equal(renderer.released.has(final.id), true, "draft tombstones do not clear released terminal identities");
  assert.equal(renderer.states.get(final.id)?.raw, final);
  assert.equal(leakedDraftId, false);
});

test("M1/ACC-ID-INVALIDATED: unseen retired draft gets an identity-only tombstone and no separator", async () => {
  const x = rendered();
  await x.renderer.supersedeDraft("PRIVATE-UNSEEN-DRAFT");
  assert.equal(x.text(), ""); assert.equal(x.renderer.states.size, 0); assert.equal(x.renderer.released.size, 0);
  await assert.rejects(x.renderer.message({ ...view("must not replay"), id: "PRIVATE-UNSEEN-DRAFT" }), { exitCode: 6 });
  await assert.rejects(x.renderer.supersedeDraft("PRIVATE-UNSEEN-DRAFT"), { exitCode: 6 });
  assert.equal(x.text(), "");
});

test("M1/ACC-ID-INVALIDATED: retirement commits only after the separator write callback succeeds", async () => {
  let completeSeparator!: () => void;
  const chunks: string[] = [];
  const renderer = new MessageRenderer(async (text) => {
    chunks.push(text);
    if (text.includes("上一段草稿已作废")) await new Promise<void>((resolve) => { completeSeparator = resolve; });
  }, "follow");
  const old = view("retain until callback\r");
  await renderer.message(old);
  const before = renderer.states.get(old.id);
  const operation = renderer.supersedeDraft(old.id);
  await setImmediate();
  assert.equal(renderer.states.get(old.id), before);
  assert.equal(before?.raw, old); assert.equal(before?.writtenBody, "retain until callback"); assert.equal(before?.pendingTail, "\r");
  completeSeparator(); await operation;
  assert.equal(renderer.states.has(old.id), false); assert.equal(renderer.released.has(old.id), false);
  await assert.rejects(renderer.message(old), { exitCode: 6 });
  await assert.rejects(renderer.supersedeDraft(old.id), { exitCode: 6 });
  assert.equal(chunks.filter((text) => text.includes("上一段草稿已作废")).length, 1);
  assert.equal(chunks.join("").includes(old.id), false);
});

test("M1/ACC-ID-INVALIDATED: FollowOutput retires emitted facts only after the separator callback", async () => {
  const capture = captureIO(); const chunks: string[] = [];
  let completeSeparator!: () => void;
  const stdout = new Writable({ write(chunk, _encoding, done) {
    const text = String(chunk); chunks.push(text);
    if (text.includes("上一段草稿已作废")) completeSeparator = () => done();
    else done();
  } });
  const lifetime = new FollowLifetime(stdout);
  try {
    const output = new FollowOutput({ ...capture.io, stdout }, lifetime, { workspaceId: "w", sessionId: "s" }, "r");
    const old = view("visible old draft"); await output.message(old, "follow");
    const before = output.renderer.states.get(old.id);
    const operation = output.supersedeDraft(old.id);
    await setImmediate();
    assert.equal(output.emitted.get(old.id), old);
    assert.equal(output.renderer.states.get(old.id), before);
    completeSeparator(); await operation;
    assert.equal(output.emitted.has(old.id), false);
    assert.equal(output.renderer.states.has(old.id), false);
    assert.equal(output.released.has(old.id), false);
    const length = chunks.length;
    await assert.rejects(output.message({ ...old, status: "completed" }, "follow"), { exitCode: 6 });
    await assert.rejects(output.supersedeDraft(old.id), { exitCode: 6 });
    assert.equal(chunks.length, length);
    assert.equal(chunks.join("").includes(old.id), false);
    assert.equal(output.emitted.size, 0);
  } finally { lifetime.dispose(); }
});

test("M1/ACC-ID-WRITE-FAIL: failed separator preserves old state/emitted facts and never publishes a draft ID", async () => {
  const capture = captureIO(); const chunks: string[] = []; let failSeparator = true;
  const stdout = new Writable({ write(chunk, _encoding, done) {
    const text = String(chunk);
    if (failSeparator && text.includes("上一段草稿已作废")) done(Object.assign(new Error("fixture separator failure"), { code: "EPIPE" }));
    else { chunks.push(text); done(); }
  } });
  const lifetime = new FollowLifetime(stdout);
  try {
    const output = new FollowOutput({ ...capture.io, stdout }, lifetime, { workspaceId: "w", sessionId: "s" }, "r");
    const old = view("old draft remains known\r");
    await output.message(old, "follow");
    const before = output.renderer.states.get(old.id);
    await assert.rejects(output.supersedeDraft(old.id), { exitCode: 141 });
    assert.equal(output.renderer.states.get(old.id), before, "failed separator cannot commit deletion or tombstone");
    assert.equal(before?.raw, old); assert.equal(before?.writtenBody, "old draft remains known"); assert.equal(before?.pendingTail, "\r");
    assert.equal(output.emitted.get(old.id), old);
    assert.equal(output.released.has(old.id), false);
    assert.equal(chunks.join("").includes(old.id), false);
    // The owning lifetime stops after EPIPE. No automatic retry or footer may follow.
    assert.equal(lifetime.signal.aborted, true);
  } finally { lifetime.dispose(); }
  await setImmediate();
  // At the renderer boundary alone a rejected callback must also leave retirement
  // uncommitted; a later explicit successful call can then install the tombstone.
  const direct = new MessageRenderer(async (text) => {
    if (failSeparator && text.includes("上一段草稿已作废")) throw new CliError(6, "fixture write failure");
  }, "follow");
  const old = view("direct old draft"); await direct.message(old);
  await assert.rejects(direct.supersedeDraft(old.id), { exitCode: 6 });
  await direct.message(old); // No tombstone was committed on the failed write.
  failSeparator = false; await direct.supersedeDraft(old.id);
  assert.equal(direct.states.size, 0);
  await assert.rejects(direct.message(old), { exitCode: 6 });
});
