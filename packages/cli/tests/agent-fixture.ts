import type { CliConfigV1, ConfigStore } from "../src/config.js";
import type { HttpResult } from "../src/http.js";

export function connectionStore(origin = "http://example.test"): ConfigStore {
  const value: CliConfigV1 = { version: 1, apiOrigin: origin, cookie: null };
  return { load: async () => structuredClone(value), save: async () => {} };
}
export function jsonResult(value: unknown, status = 200, setCookies: string[] = []): HttpResult {
  return { status, body: JSON.stringify(value), setCookies };
}
export function agentSession(overrides: Record<string, unknown> = {}) {
  return { id: "s", workspaceId: "w", title: "fixture", kind: "primary", forkedFromSessionId: null, forkedFromMessageId: null,
    headMessageId: null, contextRootMessageId: null, revision: 10_000, createdAt: 1, updatedAt: 2, ...overrides };
}
export function messagePart(messageId: string, type = "text", overrides: Record<string, unknown> = {}) {
  return { id: `${messageId}-p`, messageId, position: 0, updatedRevision: 1, createdAt: 1, updatedAt: 2,
    type, ...(type === "text" || type === "reasoning" ? { text: `text ${messageId}` } : type === "tool_call" ? { toolName: "read", input: { secret: "hidden tool input" }, providerToolCallId: null } : { attachmentId: "attachment", mediaType: "image/png", filename: "picture.png" }), ...overrides };
}
export function agentMessage(index: number, overrides: Record<string, unknown> = {}) {
  const id = `m${index}`;
  return { id, workspaceId: "w", previousMessageId: index ? `m${index - 1}` : null, replacesMessageId: null,
    depth: index, type: "assistant", status: "completed", originSessionId: "s", originRunId: "r", updatedRevision: 1,
    createdAt: 1, updatedAt: 2, parts: [messagePart(id)], ...overrides };
}
export function timelineFixture(messages: ReturnType<typeof agentMessage>[], overrides: Record<string, unknown> = {}) {
  return { session: agentSession({ headMessageId: messages.at(-1)?.id ?? null }), timelineReset: false, messages, toolExecutions: [],
    hasMore: false, nextBeforeMessageId: messages[0]?.id ?? null, ...overrides };
}
