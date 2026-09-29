import assert from "node:assert/strict";
import test from "node:test";
import type { streamText } from "ai";
import { AgentRunner, processRunForTest } from "./runner.js";

function baseProfile() {
  return {
    model: { id: "gpt-4o-mini" },
    provider: { npm: "@ai-sdk/openai", options: { apiKey: "test-key" } },
    agent: { tools: [], pluginTools: [], mcpServers: [] },
    runtime: { modelRequestRetryBackoffMaxMs: 60_000 }
  };
}

function baseRun() {
  return {
    workspaceId: "ws_test",
    sessionId: "sess_test",
    runId: "run_test",
    workspacePath: process.cwd(),
    workspaceRepoDirNames: [],
    inputText: "image message"
  };
}

function imageContext() {
  return {
    pendingTools: [],
    tools: [],
    headMessageId: null,
    sessionRevision: 0,
    system: "",
    messages: [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: "describe this" },
        { type: "attachment_ref" as const, workspaceId: "ws_test", attachmentId: "att_test-image", mediaType: "image/png" as const, filename: "image.png", path: ".awb/agent/attachments/att_test-image.png" }
      ]
    }],
    lastResponseTotalTokens: null,
    uiLocale: null,
    externalSkills: []
  };
}

function createApiClient(context = imageContext()) {
  const completed: Array<{ status: string; code: string }> = [];
  const created: Array<Record<string, unknown>> = [];
  return {
    completed,
    created,
    client: {
      async getExecutionProfile() { return baseProfile(); },
      async getPromptContext() { return context; },
      async createStreamingAssistant(input: Record<string, unknown>) { created.push(input); return { result: "updated" }; },
      async flushAssistantParts() { return { result: "updated" }; },
      async completeAssistant() { return { result: "updated" }; },
      async completeTerminalAssistant() { return { result: "updated" as const }; },
      async updateRunNotice() { return { result: "updated" }; },
      async markRunWorkInProgress() { return { result: "updated" as const }; },
      async persistRunTerminalIntent(input: { status: string; code: string }) { completed.push({ status: input.status, code: input.code }); return { result: "updated" as const }; },
      async convergeRunTerminal() { return { kind: "transitioned" as const, finalStatus: "completed" as const }; }
    }
  };
}

const logger = { info() {}, warn() {}, error() {} };

test("AgentRunner materializes only attachment_ref parts into AI SDK file parts", async () => {
  const api = createApiClient();
  const context = imageContext();
  const requests: Record<string, unknown>[] = [];
  let reads = 0;
  const runner = new AgentRunner(api.client as any, {} as any, logger, 1, {
    attachmentStorage: {
      async read() {
        reads += 1;
        return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mediaType: "image/png" as const };
      }
    },
    streamText: ((input: Record<string, unknown>) => {
      requests.push(input);
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "image described" };
          yield { type: "raw", rawValue: { type: "response.completed", response: { output: [] } } };
          yield { type: "finish" };
        })()
      };
    }) as unknown as typeof streamText
  });
  (runner as any).toolRegistry.listTools = async () => [];

  await (runner as any).runModelStep({
    profile: baseProfile(), run: baseRun(), context, step: 1,
    signal: new AbortController().signal, repeatedToolCallCounter: new Map()
  });

  assert.equal(reads, 1);
  const messages = requests[0]?.messages as Array<{ content: Array<Record<string, unknown>> }>;
  assert.equal(messages[0]?.content[0]?.type, "text");
  assert.deepEqual(messages[0]?.content[1], {
    type: "file",
    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    mediaType: "image/png",
    filename: "image.png"
  });
  assert.equal((context.messages[0]?.content[1] as { type: string }).type, "attachment_ref");
});

test("each Provider retry reopens user images and local read errors never become Provider retries", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  try {
    for (const next of ["overwritten", "deleted"] as const) {
      const api = createApiClient();
      let reads = 0;
      const requests: Array<Record<string, unknown>> = [];
      const runner = new AgentRunner(api.client as any, {} as any, logger, 1, {
        attachmentStorage: { async read() {
          reads += 1;
          if (reads === 2 && next === "deleted") throw new Error("image disappeared");
          return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, reads]), mediaType: "image/png" as const };
        } },
        streamText: ((request: Record<string, unknown>) => {
          requests.push(request);
          return { fullStream: (async function* () {
            if (requests.length === 1) yield { type: "error", error: new Error("remote rejected request") };
            else { yield { type: "text-delta", text: "ok" }; yield { type: "raw", rawValue: { type: "response.completed", response: { output: [] } } }; yield { type: "finish" }; }
          })() };
        }) as unknown as typeof streamText,
      });
      (runner as any).toolRegistry.listTools = async () => [];
      const execute = (runner as any).runModelStep({
        profile: { ...baseProfile(), runtime: { ...baseProfile().runtime, modelRequestMaxRetries: 1 } },
        run: baseRun(), context: imageContext(), step: 1,
        signal: new AbortController().signal, repeatedToolCallCounter: new Map(),
      });
      if (next === "deleted") await assert.rejects(execute, /cannot read a valid user image/);
      else await execute;
      assert.equal(reads, 2);
      assert.equal(requests.length, next === "deleted" ? 1 : 2);
      if (requests.length === 2) {
        const first = ((requests[0]!.messages as any[])[0].content[1] as { data: Uint8Array }).data;
        const second = ((requests[1]!.messages as any[])[0].content[1] as { data: Uint8Array }).data;
        assert.notDeepEqual(first, second);
      }
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("AgentRunner attachment read failure does not call streamText or enter model retry and finishes failed", async () => {
  const api = createApiClient();
  let streamCalls = 0;
  const runner = new AgentRunner(api.client as any, {} as any, logger, 1, {
    attachmentStorage: { async read() { throw new Error("attachment missing"); } },
    streamText: ((() => {
      streamCalls += 1;
      throw new Error("must not be called");
    }) as unknown) as typeof streamText
  });

  await processRunForTest(runner, baseRun(), new AbortController().signal);

  assert.equal(streamCalls, 0);
  assert.deepEqual(api.completed, [{ status: "failed", code: "run_failed" }]);
  assert.equal(api.created.length, 0, "local materialization fails before creating an assistant item");
});
