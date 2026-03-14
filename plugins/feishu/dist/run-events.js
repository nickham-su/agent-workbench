export function shouldBroadcastToChat(input) {
    if (input.hasRunMap)
        return false;
    return input.policy === "session_all";
}
