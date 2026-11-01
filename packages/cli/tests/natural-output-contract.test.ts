import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { CliError, errorDiagnostic } from "../src/errors.js";
import { FollowLifetime } from "../src/follow-lifetime.js";
import { FollowOutput } from "../src/follow-output.js";
import { MessageRenderer } from "../src/message-render.js";
import { parseMessage } from "../src/messages.js";
import { writeText } from "../src/output.js";
import { parseRun } from "../src/run-status.js";
import { agentMessage, jsonResult, messagePart } from "./agent-fixture.js";
import { captureIO, messageIds } from "./helpers.js";
import { executeFollow, page, run, state } from "./follow-fixture.js";

const resumeAdvice = /建议续读|续读位置|续读游标|恢复命令|resume(?:Cursor|From|Command)|nextCursor|continue with|--after\s+\S/i;
const draftId = "unreleased-draft-secret";
function view(text: string, revision: number, status: string) {
  return parseMessage(agentMessage(0, { id: draftId, status, updatedRevision: revision,
    parts: [messagePart(draftId, "text", { text, updatedRevision: revision })] }), "w");
}

for (const [status, marker] of [["failed", "本条回复失败"], ["cancelled", "本条回复已取消"]] as const) {
  test(`ACC-ID-FAIL-CANCEL/SEAL-TAIL: ${status} flushes pending body before its genuine footer and identity`, async () => {
    const chunks: string[] = []; let release!: () => void;
    const stdout = new Writable({ write(chunk, _encoding, done) {
      const text = String(chunk); chunks.push(text);
      if (text === "�") release = done; else done();
    } });
    const renderer = new MessageRenderer((text) => writeText(stdout, text), "follow");
    await renderer.message(view("A\r\ud83d", 1, "streaming"));
    // CR is stable (it precedes the high surrogate), while the surrogate is pending.
    assert.equal(chunks.slice(1).join(""), "A\\r");
    const terminal = renderer.message(view("A\r\ud83d", 2, status));
    await setImmediate();
    // Hold the actual suffix write callback; a known failure/cancellation is not ID permission.
    assert.equal(chunks.at(-1), "�");
    assert.deepEqual(messageIds(chunks.join("")), []);
    assert.equal(renderer.released.size, 0);
    release(); await terminal;
    assert.match(chunks.at(-1)!, new RegExp(marker));
    assert.doesNotMatch(chunks.join(""), /本条回复已完成|成功答案/);
    assert.deepEqual(messageIds(chunks.join("")), [draftId]);
    assert.doesNotMatch(chunks.join(""), resumeAdvice);
  });
}

for (const [name, raw, suffix] of [["CR", "A\r", "\\r"], ["SURROGATE", "A\ud83d", "�"]] as const) {
  test(`ACC-RENDER-FOLLOW-${name}-PAIR/ID-AFTER: unchanged terminal tail waits for its body callback`, async () => {
    const chunks: string[] = []; let release!: () => void;
    const stdout = new Writable({ write(chunk, _encoding, done) {
      const text = String(chunk); chunks.push(text);
      if (text === suffix) release = done; else done();
    } });
    const renderer = new MessageRenderer((text) => writeText(stdout, text), "follow");
    await renderer.message(view(raw, 1, "streaming"));
    assert.deepEqual(Buffer.from(chunks.slice(1).join("")), Buffer.from("A"));
    const terminal = renderer.message(view(raw, 2, "completed"));
    await setImmediate();
    assert.equal(chunks.at(-1), suffix);
    assert.deepEqual(messageIds(chunks.join("")), []);
    assert.equal(renderer.released.size, 0);
    release(); await terminal;
    assert.deepEqual(Buffer.from(chunks.slice(1, -1).join("")), Buffer.from(`A${suffix}`));
    assert.deepEqual(messageIds(chunks.join("")), [draftId]);
  });
}

test("ACC-ID-INTERRUPT/NO-RESUME: task endings and safe diagnostics never introduce draft IDs or continuation advice", async () => {
  for (const ending of ["completed", "failed", "cancelled", "interrupted", "observation_failed", "no_active_run"] as const) {
    const capture = captureIO(); const lifetime = new FollowLifetime(capture.io.stdout);
    const output = new FollowOutput(capture.io, lifetime, { workspaceId: "w", sessionId: "s" }, ending === "no_active_run" ? null : "r");
    try {
      await output.metadata("session messages", { activeAssistantMessageId: draftId, nonTerminalMessageIds: [draftId] });
      if (ending === "interrupted" || ending === "observation_failed") await output.message(view("unfinished body", 1, "streaming"), "follow");
      const run = ending === "completed" || ending === "failed" || ending === "cancelled"
        ? parseRun({ status: ending, code: `run_${ending}`, detail: null, runId: "r", workspaceId: "w", sessionId: "s", runKind: "user", updatedAt: 1 }, "w", "s", "r")
        : null;
      const code = ending === "failed" ? 8 : ending === "cancelled" ? 9 : ending === "interrupted" ? 130 : ending === "observation_failed" ? 6 : 0;
      await output.terminal(ending === "no_active_run" ? ending : run ? `run_${ending}` : ending, Boolean(run) || ending === "no_active_run", code, run);
      const diagnostic = errorDiagnostic(output.error(new CliError(6, "观察失败。", { code: "TIMELINE_CHANGED", context: { messageId: draftId, runId: "r" } })));
      assert.doesNotMatch(capture.output() + diagnostic, new RegExp(draftId));
      assert.doesNotMatch(capture.output() + diagnostic, resumeAdvice);
      assert.equal(capture.output().split("监听结束：").length - 1, 1);
      if (ending === "interrupted") assert.match(capture.output(), /后台任务未因此取消/);
    } finally { lifetime.dispose(); }
  }
});

test("ACC-RENDER-REWRITE: shorter, equal-length, growing edits and terminal rewrites fail closed without retries", async () => {
  for (const [text, initiallyTerminal] of [["orig", false], ["originaL", false], ["rewritten longer", false], ["changed final", true]] as const) {
    let updates = 0;
    const raw = (value: string, revision: number) => agentMessage(0, { id: draftId,
      status: initiallyTerminal ? "completed" : "streaming", updatedRevision: revision,
      parts: [messagePart(draftId, "text", { text: value, updatedRevision: revision })] });
    const result = await executeFollow(["messages", "-w", "w", "-s", "s", "-n", "1", "-f"], (url) => {
      if (url.pathname.endsWith("/run-state")) return jsonResult(state("r"));
      if (url.pathname.endsWith("/runs/r")) return jsonResult(run("r", "running"));
      assert.ok(url.pathname.endsWith("/timeline"));
      const initial = url.searchParams.get("mode") === "snapshot";
      if (!initial) updates++;
      return jsonResult(page([raw(initial ? "original" : text, initial ? 10 : 11)], initial ? 10 : 11));
    });
    assert.equal(result.code, 6, text);
    assert.match(result.stderr, /RESPONSE_INVALID/);
    assert.match(result.stdout, /complete=false/);
    assert.equal(result.stdout.replace("original", "").includes(text), false);
    assert.equal(result.stdout.split("original").length - 1, 1);
    assert.equal(updates, 1, "contract errors are never HTTP-retried");
    assert.deepEqual(messageIds(result.stdout), initiallyTerminal ? [draftId] : []);
  }
});
