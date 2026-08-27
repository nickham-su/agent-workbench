import type { AgentContextItemRecord } from "@agent-workbench/shared";

export type AgentMessageRevertItem = Pick<AgentContextItemRecord, "id" | "prevId" | "kind" | "output">;

export type AgentMessageRevertTarget = {
  toItemId: number | null;
  revertDraft: string;
  isUserTarget: boolean;
};

export function resolveAgentMessageRevertTarget(
  target: AgentMessageRevertItem
): AgentMessageRevertTarget | null {
  if (
    target.kind === "user"
    && (target.output.type === "user_text" || target.output.type === "user_message")
  ) {
    return {
      toItemId: target.prevId,
      revertDraft: target.output.text,
      isUserTarget: true
    };
  }
  if (target.kind === "assistant" && target.output.type === "assistant_text") {
    return { toItemId: target.id, revertDraft: "", isUserTarget: false };
  }
  return null;
}
