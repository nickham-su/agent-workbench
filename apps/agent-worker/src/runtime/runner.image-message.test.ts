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
    headItemId: null,
    system: "",
    messages: [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: "describe this" },
        { type: "attachment_ref" as const, workspaceId: "ws_test", attachmentId: "att_test-image", mediaType: "image/png" as const, filename: "image.png" }
      ]
    }],
    lastResponseTotalTokens: null,
    uiLocale: null,
    externalSkillRoots: []
  };
}

function createApiClient(context = imageContext()) {
  const completed: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  return {
    completed,
    created,
    client: {
      async getExecutionProfile() { return baseProfile(); },
      async getPromptContext() { return context; },
      async createContextItem(input: Record<string, unknown>) { created.push(input); return { item: { id: created.length } }; },
      async updateContextItem() { return { item: { id: 1 } }; },
      async updateRunState() {},
      async completeRun(input: { status: string }) { completed.push(input.status); }
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
      return { fullStream: (async function* () { yield { type: "finish" }; })() };
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
  assert.deepEqual(api.completed, ["failed"]);
  assert.equal(api.created.length, 0, "local materialization fails before creating an assistant item");
});
