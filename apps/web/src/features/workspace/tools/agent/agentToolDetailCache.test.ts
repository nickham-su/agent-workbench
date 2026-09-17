import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTimelineToolExecution, AgentToolExecution } from "@agent-workbench/shared";
import { createAgentToolDetailCache } from "./agentToolDetailCache";

function timeline(updatedRevision: number): AgentTimelineToolExecution {
  return { id: "execution", callPartId: "call", status: "running", resultPreview: null, resultTruncated: false, error: null, updatedRevision, startedAt: null, completedAt: null };
}
function detail(updatedRevision: number): AgentToolExecution {
  return { ...timeline(updatedRevision), originSessionId: "session", originRunId: null, resultArtifactPath: null, structuredResult: null, createdAt: 1, updatedAt: 1 };
}

test("completion delta 先到时，旧 detail 晚到不可覆盖当前 execution", () => {
  const cache = createAgentToolDetailCache();
  cache.syncTimeline([timeline(1)]);
  const request = cache.begin("execution");
  assert.ok(request);
  const invalidated = cache.syncTimeline([{ ...timeline(2), status: "completed", completedAt: 2 }]);
  assert.equal(invalidated.has("execution"), true);
  assert.equal(cache.accepts(request!, detail(1)), false);
});

test("同 execution 后发 detail 请求拒绝前一请求的乱序响应", () => {
  const cache = createAgentToolDetailCache();
  cache.syncTimeline([timeline(3)]);
  const first = cache.begin("execution");
  const second = cache.begin("execution");
  assert.ok(first && second);
  assert.equal(cache.accepts(first!, detail(3)), false);
  assert.equal(cache.accepts(second!, detail(3)), true);
});

test("execution 不在可见链时 detail 响应被丢弃", () => {
  const cache = createAgentToolDetailCache();
  cache.syncTimeline([timeline(1)]);
  const request = cache.begin("execution");
  cache.syncTimeline([]);
  assert.equal(cache.accepts(request!, detail(1)), false);
});
