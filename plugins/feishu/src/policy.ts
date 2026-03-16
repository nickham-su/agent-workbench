export type ChatPolicy = "self_only" | "session_all";

export function togglePolicyValue(current: ChatPolicy): ChatPolicy {
  return current === "self_only" ? "session_all" : "self_only";
}

export function policyLabel(policy: ChatPolicy): string {
  return policy === "session_all" ? "所有消息" : "仅飞书触发的消息";
}
