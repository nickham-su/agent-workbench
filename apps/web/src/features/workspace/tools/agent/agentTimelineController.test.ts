import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTimelineDeltaResponse } from "@agent-workbench/shared";
import {
  advanceAgentRequestScope,
  applyTimelineResponse,
  buildTimelineRequest,
  createAgentRequestScope,
  createAgentTimelineControllerState,
  isCurrentAgentRequestScope,
} from "./agentTimelineController";

function response(params: {
  revision: number;
  ids: string[];
  depthStart?: number;
  reset?: boolean;
  hasMore?: boolean;
  cursor?: string | null;
}): AgentTimelineDeltaResponse {
  return {
    session: {
      id: "session",
      workspaceId: "workspace",
      title: "session",
      kind: "primary",
      headMessageId: params.ids.at(-1) ?? null,
      contextRootMessageId: params.ids[0] ?? null,
      revision: params.revision,
      forkedFromSessionId: null,
      forkedFromMessageId: null,
      createdAt: 1,
      updatedAt: 1,
    },
    timelineReset: params.reset ?? false,
    messages: params.ids.map((id, index) => ({
      id,
      workspaceId: "workspace",
      previousMessageId: index ? params.ids[index - 1] : null,
      replacesMessageId: null,
      depth: (params.depthStart ?? 0) + index,
      type: "assistant",
      status: "completed",
      originSessionId: "session",
      originRunId: null,
      updatedRevision: params.revision,
      createdAt: index,
      updatedAt: index,
      parts: [],
    })),
    toolExecutions: [],
    hasMore: params.hasMore ?? false,
    nextBeforeMessageId: params.cursor ?? null,
  };
}

test("snapshot 与 reset 替换旧链并清理详情缓存", () => {
  let state = createAgentTimelineControllerState();
  ({ state } = applyTimelineResponse(
    state,
    response({ revision: 2, ids: ["old"] }),
    "snapshot",
    1,
  ));
  const result = applyTimelineResponse(
    state,
    response({ revision: 3, ids: ["new"], reset: true }),
    "delta",
    2,
  );
  assert.deepEqual(
    result.state.messages.map((item) => item.id),
    ["new"],
  );
  assert.equal(result.clearDetailCache, true);
});

test("delta 带上 head/root 前提，before 页保留已有尾页", () => {
  let state = createAgentTimelineControllerState();
  ({ state } = applyTimelineResponse(
    state,
    response({
      revision: 2,
      ids: ["tail"],
      depthStart: 2,
      hasMore: true,
      cursor: "tail",
    }),
    "snapshot",
    1,
  ));
  assert.deepEqual(buildTimelineRequest(state, "workspace", "delta"), {
    workspaceId: "workspace",
    mode: "delta",
    sinceRevision: 2,
    knownHeadMessageId: "tail",
    knownContextRootMessageId: "tail",
  });
  ({ state } = applyTimelineResponse(
    state,
    response({ revision: 2, ids: ["head", "middle"], cursor: "head" }),
    "before",
    2,
  ));
  assert.deepEqual(
    state.messages.map((item) => item.id),
    ["head", "middle", "tail"],
  );
});

test("正常 delta 保留已加载历史页的分页元数据", () => {
  let state = createAgentTimelineControllerState();
  ({ state } = applyTimelineResponse(
    state,
    response({
      revision: 2,
      ids: ["tail"],
      hasMore: true,
      cursor: "oldest-loaded",
    }),
    "snapshot",
    1,
  ));
  ({ state } = applyTimelineResponse(
    state,
    response({
      revision: 3,
      ids: ["tail", "new"],
      hasMore: false,
      cursor: null,
    }),
    "delta",
    2,
  ));
  assert.equal(state.hasMore, true);
  assert.equal(state.nextBeforeMessageId, "oldest-loaded");
});

test("陈旧异步响应不能覆盖已接收的新响应", () => {
  let state = createAgentTimelineControllerState();
  ({ state } = applyTimelineResponse(
    state,
    response({ revision: 2, ids: ["new"] }),
    "snapshot",
    2,
  ));
  const stale = applyTimelineResponse(
    state,
    response({ revision: 1, ids: ["old"] }),
    "snapshot",
    1,
  );
  assert.deepEqual(
    stale.state.messages.map((item) => item.id),
    ["new"],
  );
});

test("A pending 后切换 B：B 应用且 A 晚到 timeline/detail 不污染 B", () => {
  const requestA = createAgentRequestScope("workspace-a", "session-a");
  const scopeB = advanceAgentRequestScope(requestA, "workspace-b", "session-b");
  // scope 切换会先清空旧 timeline/detail/loading；B 可立即开始 snapshot。
  let state = createAgentTimelineControllerState();
  let detailByExecutionId: Record<string, { id: string }> = {};
  let detailLoading = new Set(["a-execution"]);
  // B 的 snapshot 先应用。
  if (isCurrentAgentRequestScope(scopeB, scopeB)) {
    ({ state } = applyTimelineResponse(
      state,
      response({ revision: 1, ids: ["b-message"] }),
      "snapshot",
      1,
    ));
    detailByExecutionId = { "b-execution": { id: "b-execution" } };
    detailLoading = new Set(["b-execution"]);
  }
  // A 的晚到 timeline、detail 响应与 finally 都不能写入/清除 B 的状态。
  assert.equal(isCurrentAgentRequestScope(scopeB, requestA), false);
  if (isCurrentAgentRequestScope(scopeB, requestA)) {
    ({ state } = applyTimelineResponse(
      state,
      response({ revision: 9, ids: ["a-message"] }),
      "snapshot",
      9,
    ));
    detailByExecutionId = {
      ...detailByExecutionId,
      "a-execution": { id: "a-execution" },
    };
    detailLoading.delete("a-execution");
  }
  assert.deepEqual(
    state.messages.map((item) => item.id),
    ["b-message"],
  );
  assert.deepEqual(detailByExecutionId, {
    "b-execution": { id: "b-execution" },
  });
  assert.deepEqual([...detailLoading], ["b-execution"]);
});
