import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTmuxHasSessionResult } from "./session.js";

test("tmux has-session 仅将明确 not-found 视为不存在", () => {
  assert.equal(classifyTmuxHasSessionResult({ ok: true, code: 0, stdout: "", stderr: "", timedOut: false }), "exists");
  assert.equal(classifyTmuxHasSessionResult({ ok: false, code: 1, stdout: "", stderr: "can't find session: term_x", timedOut: false }), "not_found");
  assert.equal(classifyTmuxHasSessionResult({ ok: false, code: 1, stdout: "no server running on /tmp/tmux-1/default", stderr: "", timedOut: false }), "not_found");
});

test("tmux has-session 的 spawn、timeout、未知错误不可伪装为不存在", () => {
  for (const result of [
    { ok: false, code: null, stdout: "", stderr: "spawn tmux ENOENT", timedOut: false },
    { ok: false, code: null, stdout: "", stderr: "", timedOut: true },
    { ok: false, code: 2, stdout: "", stderr: "server unavailable", timedOut: false },
  ]) {
    assert.throws(() => classifyTmuxHasSessionResult(result), /indeterminate/);
  }
});
