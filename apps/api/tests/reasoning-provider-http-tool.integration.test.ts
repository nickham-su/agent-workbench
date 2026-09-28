import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createAgentTestFixture, createTestWorkspace } from "../src/modules/agent/testkit/agent-testkit.js";
import {
  appendMessage, createMessageRunRecord, createMessageSession, getMessageSessionHead,
  getRunRecord, startMessageRun,
} from "../src/modules/agent/agent-message.store.js";
import { AgentApiEndpoints, parseAgentProviderReplay } from "@agent-workbench/shared/internal-contracts/agent-api";
import { AgentApiClient, type ExecutionProfile } from "../../agent-worker/src/runtime/apiClient.js";
import { AgentRunner, processRunForTest } from "../../agent-worker/src/runtime/runner.js";
import { McpManager } from "../../agent-worker/src/runtime/mcpManager.js";

// The production Runner lives in this test process. All Worker API calls still
// traverse a real Fastify HTTP server with the internal token.
const providers = [
  { npm: "@ai-sdk/moonshotai", model: "kimi-k2.6", namespace: "moonshotai" },
  { npm: "@ai-sdk/deepseek", model: "deepseek-v4-pro", namespace: "deepseek" },
] as const;

function sse(model: string, toolCall: boolean): string {
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
    id: "http-tool-fixture", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason }],
  });
  const chunks = toolCall ? [
    chunk({ reasoning_content: "inspect fixture file" }),
    chunk({ content: "Reading the fixture." }),
    chunk({ tool_calls: [{ index: 0, id: "call-http-read", type: "function",
      function: { name: "read", arguments: '{"filePath":"note.txt"}' } }] }),
    chunk({}, "tool_calls"),
  ] : [
    chunk({ reasoning_content: "fixture read finished" }),
    chunk({ content: "Done reading." }),
    chunk({}, "stop"),
  ];
  return `${chunks.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join("")}data: [DONE]\n\n`;
}

for (const provider of providers) {
  test(`${provider.npm}: Fastify protected Worker API -> builtin read -> next SDK request`, async () => {
    const logger = { info() {}, warn() {}, error() {} };
    const fixture = await createAgentTestFixture({ dataDirPrefix: "reasoning-http-tool-", withApp: true });
    const app = fixture.app!;
    const requests: Array<Record<string, any>> = [];
    const llm = createServer(async (request, response) => {
      try {
        const body: Buffer[] = [];
        for await (const part of request) body.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
        requests.push(JSON.parse(Buffer.concat(body).toString("utf8")) as Record<string, any>);
        assert.equal(request.url, "/v1/chat/completions");
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        response.end(sse(provider.model, requests.length === 1));
      } catch {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "fixture request rejected" }));
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        llm.once("error", reject);
        llm.listen(0, "127.0.0.1", resolve);
      });
      const llmAddress = llm.address();
      assert.ok(llmAddress && typeof llmAddress !== "string");
      const llmBaseURL = `http://127.0.0.1:${llmAddress.port}/v1`;
      const workspace = await createTestWorkspace(fixture);
      await fs.writeFile(`${workspace.path}/note.txt`, "test fixture content\n", "utf8");
      createMessageSession(fixture.db, { workspaceId: workspace.id, id: "http-session",
        title: "Cross-layer reasoning", kind: "primary", createdAt: Date.now() });
      const apiOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
      const put = async (path: string, payload: unknown) => {
        const reply = await app.inject({ method: "PUT", url: path, payload });
        assert.equal(reply.statusCode, 200, `${path}: settings request failed`);
      };
      await put("/api/settings/agent/providers", {
        default: { providerId: "fixture-provider", modelId: provider.model },
        providers: [{ id: "fixture-provider", name: "fixture-provider", npm: provider.npm,
          options: { baseURL: llmBaseURL, apiKey: "fixture-key" },
          models: [{ id: provider.model, name: provider.model, contextWindowTokens: 128000 }] }],
      });
      await put("/api/settings/agent/agents", {
        default: { agentId: "fixture-agent" },
        agents: [{ id: "fixture-agent", name: "fixture-agent", summary: "", prompt: "Read the fixture.",
          tools: ["read"], pluginTools: [], mcpServers: [],
          defaultModel: { providerId: "fixture-provider", modelId: provider.model }, scope: "both", order: 0 }],
      });

      const head = getMessageSessionHead(fixture.db, { workspaceId: workspace.id, sessionId: "http-session" });
      assert.ok(head);
      appendMessage(fixture.db, { workspaceId: workspace.id, sessionId: "http-session", id: "http-user",
        expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
        type: "user", status: "completed", createdAt: Date.now(),
        parts: [{ id: "http-user-part", position: 0, type: "text", text: "Read note.txt" }] });
      const runId = `run-${provider.namespace}`;
      createMessageRunRecord(fixture.db, { workspaceId: workspace.id, sessionId: "http-session",
        runId, triggerMessageId: "http-user", agentId: "fixture-agent",
        providerId: "fixture-provider", modelId: provider.model, status: "running", createdAt: Date.now() });
      startMessageRun(fixture.db, { workspaceId: workspace.id, sessionId: "http-session", runId,
        updatedAt: Date.now() });
      // The actual protected route rejects unauthenticated callers; only AgentApiClient has the test token.
      const unauthorized = await app.inject({ method: "POST", url: AgentApiEndpoints.getPromptContext.path,
        payload: { workspaceId: workspace.id, sessionId: "http-session", runId } });
      assert.equal(unauthorized.statusCode, 401);
      const api = new AgentApiClient({ apiOrigin, internalToken: fixture.internalToken,
        responseValidation: "strict", internalRpcTimeoutMs: 10_000, logger });
      const runner = new AgentRunner(api, new McpManager(api, logger), logger, 1);
      const originalComplete = api.completeAssistant.bind(api);
      let observedAtomicCompletion = false;
      api.completeAssistant = async (input) => {
        const previous = fixture.db.prepare("select id, status from agent_message where origin_run_id=? and type='assistant' order by depth").all(runId) as Array<{ id: string; status: string }>;
        if (previous.length === 1) {
          assert.equal(previous[0]?.status, "streaming");
          assert.equal((fixture.db.prepare("select count(*) as count from agent_tool_execution where call_part_id in (select id from agent_message_part where message_id=?)").get(previous[0]!.id) as { count: number }).count, 0);
        }
        const result = await originalComplete(input);
        if (previous.length === 1) {
          const finished = fixture.db.prepare("select status from agent_message where id=?").get(previous[0]!.id) as { status: string };
          const execution = fixture.db.prepare("select status from agent_tool_execution where call_part_id in (select id from agent_message_part where message_id=?)").get(previous[0]!.id) as { status: string };
          assert.equal(finished.status, "completed");
          assert.equal(execution.status, "queued");
          observedAtomicCompletion = true;
        }
        return result;
      };
      await processRunForTest(runner, { workspaceId: workspace.id, sessionId: "http-session", runId,
        workspacePath: workspace.path, workspaceRepoDirNames: [], inputText: "Read note.txt" },
      new AbortController().signal);
      assert.equal(observedAtomicCompletion, true);
      assert.equal(getRunRecord(fixture.db, runId)?.status, "completed");
      const messages = fixture.db.prepare("select id, status from agent_message where origin_run_id=? and type='assistant' order by depth").all(runId) as Array<{ id: string; status: string }>;
      assert.equal(messages.length, 2);
      assert.deepEqual(messages.map((message) => message.status), ["completed", "completed"]);
      const callPart = fixture.db.prepare("select id, provider_tool_call_id as toolCallId, provider_replay_json as replay from agent_message_part where message_id=? and type='tool_call'").get(messages[0]!.id) as { id: string; toolCallId: string; replay: string } | undefined;
      assert.equal(callPart?.toolCallId, "call-http-read");
      assert.ok(callPart?.replay);
      // A valid tool-call envelope must not be accepted on a text Part over HTTP.
      const mismatched = await app.inject({ method: "POST", url: AgentApiEndpoints.flushAssistantParts.path,
        headers: { "x-awb-agent-internal-token": fixture.internalToken },
        payload: { workspaceId: workspace.id, sessionId: "http-session", runId,
          messageId: messages[0]!.id, updatedAt: Date.now(),
          parts: [{ id: "invalid-part", position: 0, type: "text", text: "invalid",
            providerReplay: JSON.parse(callPart.replay) }] } });
      assert.equal(mismatched.statusCode, 400);
      const execution = fixture.db.prepare("select status, result_preview as resultPreview from agent_tool_execution where call_part_id=?").get(callPart.id) as { status: string; resultPreview: string } | undefined;
      assert.equal(execution?.status, "completed");
      assert.match(execution.resultPreview, /test fixture content/);
      assert.equal(requests.length, 2);
      assert.equal(requests[0]?.thinking?.type, "enabled");
      if (provider.npm === "@ai-sdk/moonshotai") assert.equal(requests[0]?.thinking?.keep, "all");
      const nextMessages = requests[1]?.messages as Array<Record<string, any>>;
      assert.deepEqual(nextMessages.slice(-3).map((message) => message.role), ["user", "assistant", "tool"]);
      const assistantIndex = nextMessages.findIndex((message) => message.role === "assistant");
      assert.ok(assistantIndex >= 0);
      assert.equal(nextMessages[assistantIndex]?.reasoning_content, "inspect fixture file");
      assert.equal(nextMessages[assistantIndex]?.tool_calls?.[0]?.id, "call-http-read");
      assert.equal(nextMessages[assistantIndex + 1]?.role, "tool");
      assert.equal(nextMessages[assistantIndex + 1]?.tool_call_id, "call-http-read");
      assert.match(JSON.stringify(nextMessages[assistantIndex + 1]?.content), /test fixture content/);
    } finally {
      await new Promise<void>((resolve) => llm.close(() => resolve()));
      await fixture.dispose();
    }
  });
}

test("protected HTTP flush rejects unauthenticated writes and retains legacy OpenAI encrypted replay", async () => {
  const fixture = await createAgentTestFixture({ dataDirPrefix: "reasoning-http-openai-", withApp: true });
  try {
    const workspace = await createTestWorkspace(fixture);
    const apiOrigin = await fixture.app!.listen({ host: "127.0.0.1", port: 0 });
    const sessionId = "openai-http-session";
    const runId = "openai-http-run";
    const messageId = "openai-http-assistant";
    const userId = "openai-http-user";
    createMessageSession(fixture.db, { workspaceId: workspace.id, id: sessionId,
      title: "OpenAI replay transport", kind: "primary", createdAt: Date.now() });
    const head = getMessageSessionHead(fixture.db, { workspaceId: workspace.id, sessionId });
    assert.ok(head);
    appendMessage(fixture.db, { workspaceId: workspace.id, sessionId, id: userId,
      expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
      type: "user", status: "completed", createdAt: Date.now(),
      parts: [{ id: "openai-http-user-part", position: 0, type: "text", text: "Continue" }] });
    createMessageRunRecord(fixture.db, { workspaceId: workspace.id, sessionId,
      runId, triggerMessageId: userId, agentId: "fixture-agent",
      providerId: "fixture-openai", modelId: "gpt-5", status: "running", createdAt: Date.now() });
    startMessageRun(fixture.db, { workspaceId: workspace.id, sessionId, runId, updatedAt: Date.now() });

    const api = new AgentApiClient({ apiOrigin, internalToken: fixture.internalToken,
      responseValidation: "strict", internalRpcTimeoutMs: 10_000,
      logger: { info() {}, warn() {}, error() {} } });
    await api.createStreamingAssistant({ workspaceId: workspace.id, sessionId, runId,
      messageId, createdAt: Date.now() });
    const replay = {
      version: 1, provider: { npm: "@ai-sdk/openai", api: "responses",
        providerId: "fixture-openai", model: "gpt-5" },
      item: { type: "reasoning", itemId: "rs-http-fixture",
        encryptedContent: "synthetic-encrypted-fixture", summaryIndex: 0 },
    } as const;
    const payload = { workspaceId: workspace.id, sessionId, runId, messageId, updatedAt: Date.now(),
      parts: [{ id: "openai-http-reasoning-part", position: 0, type: "reasoning" as const,
        text: "", providerReplay: replay }] };
    const partCount = () => (fixture.db.prepare("select count(*) as count from agent_message_part where message_id=?")
      .get(messageId) as { count: number }).count;
    assert.equal(partCount(), 0);
    const unauthenticated = await fixture.app!.inject({ method: "POST",
      url: AgentApiEndpoints.flushAssistantParts.path, payload });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(partCount(), 0, "unauthenticated flush must not persist any parts");

    const accepted = await api.flushAssistantParts(payload);
    assert.equal(accepted.result, "updated");
    assert.equal(partCount(), 1);
    const row = fixture.db.prepare("select provider_replay_json as replay from agent_message_part where id=? and message_id=?")
      .get(payload.parts[0]!.id, messageId) as { replay: string | null } | undefined;
    assert.ok(row?.replay, "authenticated flush must persist replay");
    // Do not place encrypted content in assertion errors or HTTP diagnostic output.
    assert.ok(isDeepStrictEqual(parseAgentProviderReplay(row.replay), replay),
      "OpenAI itemId, summaryIndex and encryptedContent must round-trip through HTTP and SQLite");
  } finally {
    await fixture.dispose();
  }
});
