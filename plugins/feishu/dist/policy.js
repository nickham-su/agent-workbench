export function togglePolicyValue(current) {
    return current === "self_only" ? "session_all" : "self_only";
}
export function policyLabel(policy) {
    return policy === "session_all" ? "所有消息" : "仅飞书触发的消息";
}
