import test from "node:test";
import assert from "node:assert/strict";
import { ScheduledApiError, normalizeTaskSearch, scheduledErrorPresentation } from "./scheduledUi.js";

test("search trims to 100 Unicode code points without splitting surrogate pairs", () => {
  assert.equal(normalizeTaskSearch(`  ${"🤖".repeat(100)}More`), "🤖".repeat(100));
  assert.equal([...normalizeTaskSearch("🤖".repeat(100))].length, 100);
  assert.equal(normalizeTaskSearch("  task  "), "task");
});
test("documented task errors have safe text and deterministic user actions", () => {
  const matrix = [
    ["SCHEDULE_INVALID","keepForm"], ["TASK_TRIGGER_MODE_INVALID","revalidateSource"],
    ["SOURCE_MESSAGE_INVALID","revalidateSource"], ["SOURCE_UNAVAILABLE","revalidateSource"],
    ["SCHEDULED_TASK_NOT_FOUND","refreshList"], ["CURSOR_INVALID","refreshList"],
    ["TASK_EXECUTION_ALREADY_ACTIVE","refreshHistory"], ["TASK_DELETE_EXECUTION_ACTIVE","wait"],
    ["WORKSPACE_DELETING","stopWrites"], ["AGENT_NOT_READY","keepForm"],
    ["AGENT_WORKER_UNAVAILABLE","refreshHistory"], ["SESSION_ID_CONFLICT","refreshHistory"]
  ] as const;
  for (const [code,action] of matrix) {
    const output=scheduledErrorPresentation(new ScheduledApiError(code,409,null));
    assert.equal(output.action,action,code);
    assert.ok(!output.text.includes(code));
  }
  const secret="private-provider-token";
  assert.deepEqual(scheduledErrorPresentation(new ScheduledApiError(secret,400,null)),{text:"操作失败，请稍后重试。",action:"retry"});
  assert.deepEqual(scheduledErrorPresentation(new Error(secret)),{text:"操作失败，请稍后重试。",action:"retry"});
});
