import type { ChatPolicy } from "./policy.js";

export type RunCompletedEvent = {
  eventId: string;
  eventType: "agent.run.completed.v1";
  occurredAt: number;
  workspaceId: string;
  sessionId: string;
  runId: string;
  finalStatus: "completed" | "failed" | "cancelled";
};

export function shouldBroadcastToChat(input: { policy: ChatPolicy; hasRunMap: boolean }): boolean {
  if (input.hasRunMap) return false;
  return input.policy === "session_all";
}
