import type {
  AgentTimelineDeltaRequest,
  AgentTimelineDeltaResponse,
} from "@agent-workbench/shared";
import {
  applyAgentTimelineDelta,
  prependAgentTimelinePage,
  replaceAgentTimelineSnapshot,
  type AgentMessageTimelineState,
} from "./agentMessageTimeline";

export type AgentTimelineControllerState = AgentMessageTimelineState & {
  headMessageId: string | null;
  contextRootMessageId: string | null;
  hasMore: boolean;
  nextBeforeMessageId: string | null;
  requestSequence: number;
};

/** 绑定异步请求到当前 workspace/session 代际，阻止 scope 切换后的晚到响应污染新会话。 */
export type AgentRequestScope = {
  workspaceId: string;
  sessionId: string;
  generation: number;
};

export function createAgentRequestScope(
  workspaceId: string,
  sessionId: string,
  generation = 0,
): AgentRequestScope {
  return { workspaceId, sessionId, generation };
}

export function advanceAgentRequestScope(
  scope: AgentRequestScope,
  workspaceId: string,
  sessionId: string,
): AgentRequestScope {
  return createAgentRequestScope(workspaceId, sessionId, scope.generation + 1);
}

export function isCurrentAgentRequestScope(
  current: AgentRequestScope,
  request: AgentRequestScope,
) {
  return (
    current.workspaceId === request.workspaceId &&
    current.sessionId === request.sessionId &&
    current.generation === request.generation
  );
}

export function createAgentTimelineControllerState(): AgentTimelineControllerState {
  return {
    revision: 0,
    messages: [],
    toolExecutions: [],
    headMessageId: null,
    contextRootMessageId: null,
    hasMore: false,
    nextBeforeMessageId: null,
    requestSequence: 0,
  };
}

export function buildTimelineRequest(
  state: AgentTimelineControllerState,
  workspaceId: string,
  mode: "snapshot" | "delta" | "before",
  limit = 100,
): AgentTimelineDeltaRequest {
  if (mode === "snapshot") return { workspaceId, mode, limit };
  if (mode === "before") {
    return {
      workspaceId,
      mode,
      beforeMessageId: state.nextBeforeMessageId ?? undefined,
      limit,
    };
  }
  return {
    workspaceId,
    mode,
    sinceRevision: state.revision,
    knownHeadMessageId: state.headMessageId ?? undefined,
    knownContextRootMessageId: state.contextRootMessageId ?? undefined,
  };
}

/** 乱序异步响应不可覆盖此后发请求已应用的 timeline。 */
export function acceptsTimelineResponse(
  state: AgentTimelineControllerState,
  sequence: number,
) {
  return sequence >= state.requestSequence;
}

export function applyTimelineResponse(
  state: AgentTimelineControllerState,
  response: AgentTimelineDeltaResponse,
  mode: "snapshot" | "delta" | "before",
  sequence: number,
): { state: AgentTimelineControllerState; clearDetailCache: boolean } {
  if (!acceptsTimelineResponse(state, sequence))
    return { state, clearDetailCache: false };
  const mustReplace = mode === "snapshot" || response.timelineReset;
  const timeline = mustReplace
    ? replaceAgentTimelineSnapshot(state, response)
    : mode === "before"
      ? prependAgentTimelinePage(state, response)
      : applyAgentTimelineDelta(state, response);
  // 普通 delta 只同步图数据；它不能重置已加载历史页的分页游标。
  const updatesPagination = mustReplace || mode === "before";
  return {
    state: {
      ...timeline,
      headMessageId: response.session.headMessageId,
      contextRootMessageId: response.session.contextRootMessageId,
      hasMore: updatesPagination ? (response.hasMore ?? false) : state.hasMore,
      nextBeforeMessageId: updatesPagination
        ? (response.nextBeforeMessageId ?? null)
        : state.nextBeforeMessageId,
      requestSequence: sequence,
    },
    clearDetailCache: mustReplace,
  };
}
