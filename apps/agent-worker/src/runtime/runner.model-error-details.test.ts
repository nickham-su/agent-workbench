import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "ai";
import type { AgentModelRequestError } from "@agent-workbench/shared";
import { AgentProviderReplayUpdateError } from "@agent-workbench/shared/internal-contracts/agent-api";
import { AgentRunner } from "./runner.js";

type Notice = { runNoticeText: string; modelRequestError?: AgentModelRequestError | null; nextRetryAt: number | null };
type Deps = NonNullable<ConstructorParameters<typeof AgentRunner>[4]>;
const key = "synthetic-worker-key";
function httpError(body: string) {
  return new APICallError({ message: "upstream failed", statusCode: 503, responseBody: body,
    url: "https://example.invalid", requestBodyValues: {} });
}
function fixture(errors: unknown[], partial = false) {
  const notices: Notice[] = [], replacements: Notice[] = [];
  let calls = 0;
  const runner = new AgentRunner({
    async createStreamingAssistant() { return { result: "created" }; },
    async flushAssistantParts() { return { result: "updated" }; },
    async completeTerminalAssistant() { return { result: "updated" }; },
    async completeAssistant() { return { result: "updated" }; },
    async replaceStreamingAssistant(input: Notice) { replacements.push(input); return { result: "updated" }; },
    async updateRunNotice(input: Notice) { notices.push(input); return { result: "updated" }; },
  } as unknown as ConstructorParameters<typeof AgentRunner>[0], {} as ConstructorParameters<typeof AgentRunner>[1],
  { info() {}, warn() {}, error() {} }, 1, {
    modelRetrySleep: async () => true,
    streamText: (() => {
      const attempt = calls++;
      return {
        fullStream: (async function* () {
          if (partial || attempt >= errors.length) yield { type: "text-delta", id: "text", text: "answer" };
          if (attempt < errors.length) throw errors[attempt];
        })(),
        reasoningText: Promise.resolve(""), usage: Promise.resolve(null), totalUsage: Promise.resolve(null), response: Promise.resolve(null),
      };
    }) as unknown as Deps["streamText"],
  });
  const access = runner as unknown as {
    toolRegistry: { listTools: () => Promise<[]> };
    runModelStep: (input: unknown) => Promise<unknown>;
  };
  access.toolRegistry.listTools = async () => [];
  return { notices, replacements, get calls() { return calls; }, invoke(retries = 0) {
    return access.runModelStep({ profile: {
      model: { id: "model" }, provider: { id: "provider", npm: "@ai-sdk/anthropic", options: { apiKey: key } },
      agent: { tools: [], pluginTools: [], mcpServers: [] },
      runtime: { modelIdleTimeoutMs: 0, modelTotalTimeoutMs: 0, modelRequestMaxRetries: retries, modelRequestRetryBackoffMaxMs: 1 },
    }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: process.cwd(), workspaceRepoDirNames: [], inputText: "hello" },
    context: { pendingTools: [], tools: [], headMessageId: null, sessionRevision: 0, system: "", messages: [], providerReplay: [],
      lastResponseTotalTokens: null, uiLocale: null, workspaceRepoNames: [], externalSkills: [] },
    step: 1, signal: new AbortController().signal, repeatedToolCallCounter: new Map() });
  } };
}

test("零次重试也发布最终响应体详情，保持原始失败与无重试语义", async () => {
  const error = httpError(`upstream failure ${key}`);
  const state = fixture([error]);
  await assert.rejects(state.invoke(), (actual) => actual === error);
  assert.equal(state.calls, 1);
  assert.equal(state.replacements.length, 0);
  assert.equal(state.notices.length, 1);
  assert.match(state.notices[0]!.runNoticeText, /^Request failed:/);
  assert.equal(state.notices[0]!.modelRequestError!.responseBody, "upstream failure ***");
  assert.equal(state.notices[0]!.nextRetryAt, null);
});

for (const partial of [false, true]) test(`重试详情覆盖${partial ? "部分输出替换" : "无输出通知"}链路并在恢复输出时清理`, async () => {
  const state = fixture([httpError("service busy")], partial);
  await state.invoke(1);
  assert.equal(state.calls, 2);
  const retry = partial ? state.replacements[0]! : state.notices[0]!;
  assert.equal(retry.modelRequestError!.responseBody, "service busy");
  assert.notEqual(retry.nextRetryAt, null);
  assert.equal(state.notices.at(-1)!.runNoticeText, "");
  assert.equal(state.notices.at(-1)!.modelRequestError, null);
});

test("耗尽重试发布最后一次失败：无响应体不能错用前一次内容", async () => {
  const last = new TypeError("private error text");
  const state = fixture([httpError("first response"), last]);
  await assert.rejects(state.invoke(1), (actual) => actual === last);
  assert.equal(state.notices.length, 2);
  assert.equal(state.notices[0]!.modelRequestError!.responseBody, "first response");
  assert.equal(state.notices[1]!.modelRequestError!.responseBody, null);
  assert.equal(state.notices[1]!.nextRetryAt, null);
  assert.doesNotMatch(JSON.stringify(state.notices[1]), /first response|private error text/);
});

test("本地 replay 不变量失败不伪装成模型响应体错误", async () => {
  const error = new AgentProviderReplayUpdateError("local invariant");
  const state = fixture([error]);
  await assert.rejects(state.invoke(), (actual) => actual === error);
  assert.equal(state.notices.length, 0);
});
