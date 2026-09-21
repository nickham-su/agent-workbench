import type {
  AgentImagePart,
  AgentMessage,
  AgentMessagePart,
  AgentTimelineDeltaResponse,
  AgentTimelineToolExecution,
} from "@agent-workbench/shared";

/**
 * 前端 Message timeline 的无框架状态操作。
 *
 * 服务端以 Session revision 为权威：普通增量只 upsert `updatedRevision`
 * 更大的 Message/ToolExecution；`timelineReset` 时由调用方整体替换。
 */
export type AgentMessageTimelineState = {
  revision: number;
  messages: AgentMessage[];
  toolExecutions: AgentTimelineToolExecution[];
};

function upsertByRevision<T extends { id: string; updatedRevision: number }>(current: readonly T[], changes: readonly T[]) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const next of changes) {
    const previous = byId.get(next.id);
    if (!previous || next.updatedRevision >= previous.updatedRevision) byId.set(next.id, next);
  }
  return [...byId.values()];
}

function sortMessages(messages: readonly AgentMessage[]) {
  return [...messages].sort((left, right) => {
    if (left.depth !== right.depth) return left.depth - right.depth;
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return left.id.localeCompare(right.id);
  });
}

/** Snapshot 和 reset 都必须替换，而不能将旧分支记录继续 upsert 到新可见链。 */
export function replaceAgentTimelineSnapshot(
  state: AgentMessageTimelineState,
  snapshot: AgentTimelineDeltaResponse,
): AgentMessageTimelineState {
  return {
    revision: Math.max(state.revision, snapshot.session.revision),
    messages: sortMessages(snapshot.messages),
    toolExecutions: upsertByRevision([], snapshot.toolExecutions),
  };
}

/** 在当前最早页之前插入一页；服务端 cursor 所在可见链是唯一顺序权威。 */
export function prependAgentTimelinePage(
  state: AgentMessageTimelineState,
  page: AgentTimelineDeltaResponse,
): AgentMessageTimelineState {
  if (page.timelineReset) return replaceAgentTimelineSnapshot(state, page);
  return {
    revision: Math.max(state.revision, page.session.revision),
    messages: sortMessages(upsertByRevision(state.messages, page.messages)),
    toolExecutions: upsertByRevision(state.toolExecutions, page.toolExecutions),
  };
}

export function applyAgentTimelineDelta(
  state: AgentMessageTimelineState,
  delta: AgentTimelineDeltaResponse,
): AgentMessageTimelineState {
  if (delta.timelineReset) return replaceAgentTimelineSnapshot(state, delta);

  return {
    revision: Math.max(state.revision, delta.session.revision),
    messages: sortMessages(upsertByRevision(state.messages, delta.messages)),
    toolExecutions: upsertByRevision(state.toolExecutions, delta.toolExecutions),
  };
}

export type ConversationPart = {
  message: AgentMessage;
  part: AgentMessagePart | null;
  execution: AgentTimelineToolExecution | null;
  /** 同一消息中的图片只生成一个展示行，并由该行统一打开预览。 */
  imageParts: AgentImagePart[];
  /** 同一消息中连续相邻的 ReasoningPart 合并后的展示文本。 */
  reasoningText: string;
  /** 每条消息只在一个 Conversation row 渲染结构操作。 */
  isFirstRowForMessage: boolean;
};

export function hasAgentMessageTextPart(message: AgentMessage) {
  return message.parts.some((part) => part.type === "text");
}

/** 回退 User 消息时，将其按 Part 顺序还原为输入框文本。 */
export function agentUserMessageDraftText(message: AgentMessage) {
  if (message.type !== "user") return null;
  return [...message.parts]
    .sort((left, right) => left.position - right.position)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** Fork 可从当前物理消息链的历史 User/Assistant 分支继续。 */
export function canForkAgentTimelineMessage(message: AgentMessage) {
  return message.type === "user" || message.type === "assistant";
}

/** Revert 仍只允许作用于当前有效操作范围内的 User 消息。 */
export function canRevertAgentTimelineMessage(message: AgentMessage) {
  return message.inCurrentOperationRange === true && message.type === "user";
}

/** 以 Message 的 Part.position 为唯一显示顺序；ToolCall 通过 callPartId 显式关联 execution。 */
export function buildConversationParts(state: AgentMessageTimelineState): ConversationPart[] {
  const executionByCallPartId = new Map(state.toolExecutions.map((execution) => [execution.callPartId, execution]));
  return state.messages.flatMap<ConversationPart>((message) => {
    const parts = [...message.parts].sort((left, right) => left.position - right.position);
    if (parts.length === 0) {
      return [{ message, part: null, execution: null, imageParts: [], reasoningText: "", isFirstRowForMessage: true }];
    }

    const imageParts = parts.filter((part): part is AgentImagePart => part.type === "image");
    let imageRowAdded = false;
    let previousPartWasReasoning = false;
    const displayParts: Array<{ part: AgentMessagePart; reasoningText: string }> = [];

    for (const part of parts) {
      if (part.type === "reasoning" && previousPartWasReasoning) {
        const previous = displayParts.at(-1);
        if (previous?.part.type === "reasoning") {
          previous.reasoningText = `${previous.reasoningText}\n\n${part.text}`;
          continue;
        }
      }

      previousPartWasReasoning = part.type === "reasoning";
      if (part.type === "image") {
        if (imageRowAdded) continue;
        imageRowAdded = true;
      }

      displayParts.push({
        part,
        reasoningText: part.type === "reasoning" ? part.text : "",
      });
    }

    return displayParts.map(({ part, reasoningText }, index) => ({
      message,
      part,
      execution: part.type === "tool_call" ? executionByCallPartId.get(part.id) ?? null : null,
      imageParts: part.type === "image" ? imageParts : [],
      reasoningText,
      isFirstRowForMessage: index === 0,
    }));
  });
}
