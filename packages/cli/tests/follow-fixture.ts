import assert from "node:assert/strict";
import type { HttpResult, HttpRequest } from "../src/http.js";
import { runCli } from "../src/program.js";
import { agentMessage, agentSession, connectionStore, jsonResult, messagePart } from "./agent-fixture.js";
import { captureIO } from "./helpers.js";

export type RawMessage = ReturnType<typeof agentMessage>;
export function msg(id: string, depth: number, previousMessageId: string | null, overrides: Record<string, unknown> = {}): RawMessage {
  return agentMessage(depth, { id, depth, previousMessageId, parts: [messagePart(id, "text", { text: `body ${id}` })], ...overrides });
}
export function state(activeRunId: string | null = null) {
  return { workspaceId: "w", sessionId: "s", status: activeRunId ? "running" : "idle", activeRunId, runNoticeText: "", retryCount: 0, nextRetryAt: null,
    activeAssistantMessageId: null, nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: 2 };
}
export function run(runId = "r", status = "completed", runKind = "user", code: string | null = status === "running" ? null : status === "completed" ? "run_completed" : status === "cancelled" ? "run_cancelled" : "run_failed") {
  return { workspaceId: "w", sessionId: "s", runId, runKind, status, code, detail: null, updatedAt: 2 };
}
export function page(messages: RawMessage[], revision = 10, extra: Record<string, unknown> = {}) {
  return { session: agentSession({ revision, headMessageId: messages.at(-1)?.id ?? null }), timelineReset: false, messages, toolExecutions: [], hasMore: false,
    nextBeforeMessageId: messages[0]?.id ?? null, ...extra };
}
export function paged(messages: RawMessage[], url: URL, revision = 10, extra: Record<string, unknown> = {}) {
  const cursor = url.searchParams.get("beforeMessageId");
  const end = cursor ? messages.findIndex((message) => message.id === cursor) : messages.length;
  assert.ok(end >= 0);
  const start = Math.max(0, end - 100);
  return page(messages.slice(start, end), revision, { session: agentSession({ headMessageId: messages.at(-1)?.id ?? null, revision }), hasMore: start > 0, ...extra });
}
export type Handler = (url: URL, request: HttpRequest) => HttpResult | Promise<HttpResult>;
export async function executeFollow(args: string[], handler: Handler, json = true, signal?: AbortSignal) {
  const capture = captureIO(); const requests: { url: URL; request: HttpRequest }[] = [];
  const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
  const code = await runCli(["session", ...args, ...(json ? ["--json"] : [])], { io: capture.io, createConfigStore: () => connectionStore(), ...(signal ? { signal } : {}),
    http: { request: async (_origin, path, request = {}) => { const url = new URL(path, "http://fixture.test"); requests.push({ url, request }); return handler(url, request); } } });
  assert.equal(process.listenerCount("SIGINT"), before.int); assert.equal(process.listenerCount("SIGTERM"), before.term);
  return { code, stdout: capture.output(), stderr: capture.diagnostic(), requests, events: json ? capture.output().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Record<string, unknown>[] : [] };
}
export function idleHandler(first: RawMessage[], final: RawMessage[], extra?: Handler): Handler {
  let snapshots = 0;
  return (url, request) => {
    if (url.pathname.endsWith("/run-state")) return jsonResult(state());
    if (url.pathname.endsWith("/timeline")) {
      const mode = url.searchParams.get("mode");
      if (mode === "snapshot") { snapshots++; return jsonResult(paged(snapshots === 1 ? first : final, url, snapshots === 1 ? 10 : 20)); }
      assert.equal(mode, "before"); return jsonResult(paged(snapshots === 1 ? first : final, url, snapshots === 1 ? 10 : 20));
    }
    if (extra) return extra(url, request);
    assert.fail(`unexpected fixture route ${url.pathname}`);
  };
}
