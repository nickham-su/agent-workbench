import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubtaskSessionIdForDisplay } from "./subtaskSessionId";

test("resolveSubtaskSessionIdForDisplay 优先使用 result.subtaskSessionId", () => {
  const resolved = resolveSubtaskSessionIdForDisplay({
    resultSubtaskSessionId: "sess_from_result",
    outputText: "tool: subtask\nstatus: completed\nsubtask_session_id: sess_from_text\n\nSubtask finished."
  });
  assert.equal(resolved, "sess_from_result");
});

test("resolveSubtaskSessionIdForDisplay 兼容历史 text-only 头部格式", () => {
  const resolved = resolveSubtaskSessionIdForDisplay({
    outputText: "tool: subtask\nstatus: completed\nsubtask_session_id: sess_legacy_1\n\nSubtask finished."
  });
  assert.equal(resolved, "sess_legacy_1");
});

test("resolveSubtaskSessionIdForDisplay 当 output.text 缺失时可回退 fallbackText", () => {
  const resolved = resolveSubtaskSessionIdForDisplay({
    fallbackText: "subtask()\nsubtask_session_id: sess_from_fallback"
  });
  assert.equal(resolved, "sess_from_fallback");
});

test("resolveSubtaskSessionIdForDisplay 无可用来源时返回空字符串", () => {
  const resolved = resolveSubtaskSessionIdForDisplay({
    outputText: "tool: subtask\nstatus: completed\n\nSubtask finished."
  });
  assert.equal(resolved, "");
});
