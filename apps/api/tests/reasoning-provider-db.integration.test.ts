import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createAgentTestFixture, createTestWorkspace } from "../src/modules/agent/testkit/agent-testkit.js";
import {
  appendMessage, appendStreamingAssistant, commitCompactionMessageForTest,
  completeAssistantWithExecutions, createMessageRunRecord, createMessageSession,
  flushStreamingParts, forkMessageSession, getMessage, getMessageSessionHead, getToolExecution, replaceStreamingAssistant,
  revertBeforeUserMessage, settleMessageRunIfCurrent, startMessageRun,
  updateToolExecution,
} from "../src/modules/agent/agent-message.store.js";
import { ModelContextResolver, projectModelContextToPrompt } from "../src/modules/agent/read-side/model-context-resolver.js";
import { RuntimeTranscriptProjector } from "../src/modules/agent/read-side/runtime-transcript-projector.js";
import { AgentRunner } from "../../agent-worker/src/runtime/runner.js";
import { DefaultProviderConversationStateAdapterRegistry } from "../../agent-worker/src/runtime/providers/conversation-state/registry.js";

// This integration test lives outside the API's src/ TypeScript build: it exercises the real
// Worker and the API's SQLite store/read-side without introducing a production workspace dependency.
const providers = [
  { npm: "@ai-sdk/moonshotai", model: "kimi-k2.6", id: "moonshot-test", namespace: "moonshotai" },
  { npm: "@ai-sdk/deepseek", model: "deepseek-v4-pro", id: "deepseek-test", namespace: "deepseek" },
] as const;

const logger = { info() {}, warn() {}, error() {} };
function event(model: string, delta: Record<string, unknown>, reason: string | null = null) {
  return { id: "mock-chat", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason: reason }] };
}
function response(model: string, text: string, reasoningOnly = false, multiBlock = false, toolCall = false, omitUsage = false) {
  const events = [
    event(model, { reasoning_content: multiBlock ? `${text} internal ` : `${text} internal reasoning` }),
    ...(multiBlock ? [event(model, { reasoning_content: "reasoning" })] : []),
    ...(reasoningOnly ? [] : [event(model, { content: text })]),
    ...(multiBlock ? [event(model, { reasoning_content: `${text} after text ` }),
      event(model, { reasoning_content: "reasoning" })] : []),
    ...(toolCall ? [event(model, { tool_calls: [{ index: 0, id: "call-db-1", type: "function",
      function: { name: "read", arguments: '{"value":"hello"}' } }] })] : []),
    event(model, {}, toolCall ? "tool_calls" : "stop"),
    ...(omitUsage ? [] : [{ id: "mock-chat", object: "chat.completion.chunk", created: 1, model, choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }]),
  ];
  return events.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join("") + "data: [DONE]\n\n";
}

for (const provider of providers) for (const scenario of ["standard", "reasoning-only", "multi-block", "tool", "tool-finalize-failure", "tool-flush-failure", "endpoint-change", "legacy-tool", "legacy-blank", "legacy-middle", "legacy-invalid"] as const) {
  const reasoningOnly = scenario === "reasoning-only" || scenario === "legacy-blank";
  const multiBlock = scenario === "multi-block";
  const endpointChanged = scenario === "endpoint-change";
  const tool = scenario.startsWith("tool") || scenario === "legacy-tool";
  const failure = scenario === "tool-finalize-failure" || scenario === "tool-flush-failure";
  test(`${provider.npm}: ${scenario} SQLite -> protected PromptContext -> SDK`, async () => {
    const fixture = await createAgentTestFixture({ dataDirPrefix: "reasoning-db-" });
    const requests: Array<Record<string, any>> = [];
    const server = createServer(async (req, res) => {
      const buffers: Buffer[] = [];
      for await (const chunk of req) buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(buffers).toString("utf8")));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(response(provider.model, requests.length === 1 ? "first" : scenario === "legacy-middle" && requests.length === 3 ? "third" : "second",
        requests.length === 1 && reasoningOnly, requests.length === 1 && multiBlock,
        requests.length === 1 && tool, failure));
    });
    try {
      const workspace = await createTestWorkspace(fixture, { id: "ws" });
      createMessageSession(fixture.db, { workspaceId: "ws", id: "session", title: "Reasoning",
        kind: "primary", createdAt: 1 });
      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const baseURL = `http://127.0.0.1:${address.port}/v1`;
      const profile: any = {
        provider: { id: provider.id, npm: provider.npm, options: { apiKey: "mock-not-a-secret", baseURL } },
        model: { id: `local-${provider.model}`, providerModelId: provider.model,
          options: { providerOptionsByKey: { [provider.namespace]: { thinking: { type: "disabled" } } } } },
        agent: { tools: [], pluginTools: [], mcpServers: [] },
        runtime: { modelIdleTimeoutMs: 0, modelTotalTimeoutMs: 0, modelRequestMaxRetries: failure ? 2 : 0 },
      };
      // Use the production Registry; model IDs do not require local admission.
      const registry = new DefaultProviderConversationStateAdapterRegistry();
      if (scenario === "tool-finalize-failure") {
        const resolve = registry.resolve.bind(registry);
        registry.resolve = (input: any) => {
          const adapter = resolve(input)!;
          const createAttempt = adapter.createAttempt.bind(adapter);
          (adapter as any).createAttempt = (context: any) => {
            const attempt = createAttempt(context);
            attempt.finalizeAttempt = () => ({ ok: false, code: "FIXTURE_FINALIZE_FAILURE",
              message: "fixture finalize failure" });
            return attempt;
          };
          return adapter;
        };
      }
      let nextMessageNumber = 0;
      const backend = {
        async createStreamingAssistant(input: any) {
          const head = getMessageSessionHead(fixture.db, { workspaceId: "ws", sessionId: "session" });
          assert.ok(head);
          appendStreamingAssistant(fixture.db, { id: input.messageId, workspaceId: "ws", sessionId: "session",
            runId: input.runId, expectedHeadMessageId: head.headMessageId,
            expectedRevision: head.revision, createdAt: input.createdAt });
          return { result: "created" };
        },
        async flushAssistantParts(input: any) {
          if (scenario === "tool-flush-failure" && input.parts.some((part: any) => part.type === "tool_call")) {
            throw new Error("fixture final flush failure");
          }
          return { result: flushStreamingParts(fixture.db, input) };
        },
        async completeAssistant(input: any) {
          const parts = getMessage(fixture.db, input.messageId)?.parts;
          assert.ok(parts && parts.length > 0);
          if (tool && input.executions.length) assert.deepEqual(parts.map((part) => part.type), ["reasoning", "text", "tool_call"]);
          for (const part of parts) {
            if (part.type !== "text" && part.type !== "reasoning" && part.type !== "tool_call") continue;
            const row = fixture.db.prepare("select provider_replay_json as replay from agent_message_part where id=?")
              .get(part.id) as { replay: string | null } | undefined;
            assert.ok(row?.replay, "all Assistant provenance must be flushed before completion");
          }
          if (input.executions.length) {
            assert.equal(getMessage(fixture.db, input.messageId)?.status, "streaming");
            assert.equal(fixture.db.prepare("select count(*) as count from agent_tool_execution where origin_run_id=?")
              .get(input.runId)?.count, 0);
          }
          const result = completeAssistantWithExecutions(fixture.db, input);
          if (input.executions.length) {
            assert.equal(getMessage(fixture.db, input.messageId)?.status, "completed");
            assert.equal(fixture.db.prepare("select count(*) as count from agent_tool_execution where origin_run_id=? and status='queued'")
              .get(input.runId)?.count, input.executions.length,
              "Assistant and queued executions must become visible in one store transaction");
          }
          return { result };
        },
        async completeTerminalAssistant(input: any) {
          return backend.completeAssistant({ ...input, executions: [] });
        },
        async replaceStreamingAssistant(input: any) {
          const head = getMessageSessionHead(fixture.db, { workspaceId: "ws", sessionId: "session" });
          assert.ok(head);
          return replaceStreamingAssistant(fixture.db, { ...input,
            expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision });
        },
        async updateRunNotice() { return { result: "updated" }; },
        async getPluginRuntimeSnapshots() { return { plugins: [] }; },
      };
      const signals: Array<{ kind: string; attemptNo: number; totalTokens: number | null;
        status: string; inputTokens: number | null; failureKind: string | null }> = [];
      const runner = new AgentRunner(backend as any, { async listTools() { return []; } } as any,
        logger, 1, { providerConversationStateAdapterRegistry: registry as any,
          analyticsSignals: { emitModel(payload: any, kind: string) {
            signals.push({ kind, attemptNo: payload.attemptNo, totalTokens: payload.totalTokens ?? null,
              status: payload.status, inputTokens: payload.inputTokens, failureKind: payload.failureKind });
          } } } as any);
      if (tool) {
        (runner as any).toolRegistry = { async listTools() {
          return [{ name: "read", description: "fixture tool", inputSchema: {
            type: "object", properties: { value: { type: "string" } }, required: ["value"] } }];
        } };
      }
      function addUser(text: string) {
        const head = getMessageSessionHead(fixture.db, { workspaceId: "ws", sessionId: "session" });
        assert.ok(head);
        appendMessage(fixture.db, { workspaceId: "ws", sessionId: "session",
          id: `user-${++nextMessageNumber}`, expectedHeadMessageId: head.headMessageId,
          expectedRevision: head.revision, type: "user", status: "completed",
          parts: [{ id: `user-part-${nextMessageNumber}`, position: 0, type: "text", text }],
          createdAt: Date.now() });
      }
      function getContext() {
        const resolved = new ModelContextResolver(fixture.db).resolve({ workspaceId: "ws", sessionId: "session" });
        const projected = projectModelContextToPrompt({ workspaceId: "ws", resolved, triggerMessageId: null,
          projector: new RuntimeTranscriptProjector(), includeReplayOnlyAssistants: true });
        return { system: "", pendingTools: [], tools: [], headMessageId: null, sessionRevision: 0,
          messages: projected.messages, providerReplay: projected.providerReplay,
          lastResponseTotalTokens: null, uiLocale: null, externalSkills: [] };
      }
      const call = async (runId: string, recover = false, options: { reuseRun?: boolean; leaveOpen?: boolean } = {}) => {
        if (!options.reuseRun) {
          createMessageRunRecord(fixture.db, { workspaceId: "ws", sessionId: "session", runId,
            triggerMessageId: getMessageSessionHead(fixture.db, { workspaceId: "ws", sessionId: "session" })?.headMessageId ?? null,
            agentId: "agent", providerId: provider.id, modelId: profile.model.id,
            status: "running", createdAt: Date.now() });
          startMessageRun(fixture.db, { workspaceId: "ws", sessionId: "session", runId, updatedAt: Date.now() });
        }
        const context = getContext();
        const oldMessageId = recover ? `${runId}:old-streaming` : null;
        if (oldMessageId) {
          const current = getMessageSessionHead(fixture.db, { workspaceId: "ws", sessionId: "session" });
          assert.ok(current);
          appendStreamingAssistant(fixture.db, { id: oldMessageId, workspaceId: "ws", sessionId: "session",
            runId, expectedHeadMessageId: current.headMessageId, expectedRevision: current.revision,
            createdAt: Date.now() });
          assert.equal(flushStreamingParts(fixture.db, { workspaceId: "ws", sessionId: "session", runId,
            messageId: oldMessageId, updatedAt: Date.now(),
            parts: [{ id: `${oldMessageId}:part`, type: "reasoning", position: 0, text: "discarded recovery" }] }), "updated");
        }
        const result = await (runner as any).runModelStep({ profile,
          run: { workspaceId: "ws", sessionId: "session", runId, workspacePath: workspace.path,
            workspaceRepoDirNames: [], inputText: "fixture" }, context, step: 1,
          signal: new AbortController().signal, recoveryContinuation: { messageId: oldMessageId },
          repeatedToolCallCounter: new Map() });
        if (oldMessageId) {
          assert.equal(getMessage(fixture.db, oldMessageId)?.status, "superseded");
          assert.notEqual(result.assistantMessageId, oldMessageId);
        }
        if (!options.leaveOpen) {
          settleMessageRunIfCurrent(fixture.db, { workspaceId: "ws", sessionId: "session", runId,
            updatedAt: Date.now() });
        }
        return result;
      };
      // Simulate a database written by the earlier Chat v1 release, then read it
      // through the upgraded resolver. No test-only providerReplay source is supplied.
      function persistPreDigestMetadata(messageId: string) {
        const parts = getMessage(fixture.db, messageId)?.parts ?? [];
        assert.ok(parts.length > 0);
        for (const part of parts) {
          const row = fixture.db.prepare("select provider_replay_json as replay from agent_message_part where id=?")
            .get(part.id) as { replay: string };
          const envelope = JSON.parse(row.replay) as { provider: Record<string, unknown> };
          assert.match(String(envelope.provider.endpointDigest), /^[a-f0-9]{64}$/);
          delete envelope.provider.endpointDigest;
          fixture.db.prepare("update agent_message_part set provider_replay_json=? where id=?")
            .run(JSON.stringify(envelope), part.id);
        }
      }
      addUser("first request");
      if (failure) {
        await assert.rejects(call("first-run", false, { leaveOpen: true }),
          scenario === "tool-flush-failure" ? /control write permanently failed: flush assistant parts/ : /fixture finalize failure/);
        const messages = fixture.db.prepare("select id, status from agent_message where origin_run_id='first-run' and type='assistant'")
          .all() as Array<{ id: string; status: string }>;
        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.status, "streaming", "failure must not complete Assistant");
        assert.equal(fixture.db.prepare("select count(*) as count from agent_tool_execution where origin_run_id='first-run'")
          .get()?.count, 0, "failure must not create queued tool execution");
        assert.equal(requests.length, 1, "local failure must not consume the remaining retry budget");
        assert.deepEqual(signals.map(({ kind, attemptNo, status, inputTokens, failureKind }) =>
          [kind, attemptNo, status, inputTokens, failureKind]), [["model_invoked", 1, "running", null, null], ["model_finished", 1, "failed", null, "other"]]);
        return;
      }
      const first = await call("first-run", !reasoningOnly && !tool, { leaveOpen: tool });
      const firstRow = getMessage(fixture.db, first.assistantMessageId);
      assert.equal(firstRow?.status, "completed");
      assert.equal(firstRow?.parts.some((part) => part.type === "reasoning"), true);
      if (multiBlock) {
        assert.deepEqual(firstRow?.parts.map((part) => part.type), ["reasoning", "text", "reasoning"]);
        assert.equal(new Set(firstRow?.parts.map((part) => part.id)).size, 3);
        assert.deepEqual(firstRow?.parts.filter((part) => part.type === "reasoning").map((part) => part.text),
          ["first internal reasoning", "first after text reasoning"]);
      }
      if (tool) {
        const callPart = firstRow?.parts.find((part) => part.type === "tool_call");
        assert.ok(callPart && callPart.type === "tool_call");
        assert.equal(callPart.providerToolCallId, "call-db-1");
        const queued = fixture.db.prepare("select id, status from agent_tool_execution where call_part_id=?")
          .get(callPart.id) as { id: string; status: string } | undefined;
        assert.equal(queued?.status, "queued");
        assert.equal(updateToolExecution(fixture.db, { workspaceId: "ws", sessionId: "session",
          runId: "first-run", executionId: queued.id, status: "running", updatedAt: Date.now() }), "updated");
        assert.equal(updateToolExecution(fixture.db, { workspaceId: "ws", sessionId: "session",
          runId: "first-run", executionId: queued.id, status: "completed", resultPreview: "hello",
          updatedAt: Date.now() }), "updated");
        assert.equal(getToolExecution(fixture.db, queued.id)?.status, "completed");
        if (scenario === "legacy-tool") persistPreDigestMetadata(first.assistantMessageId);
        const contextWithTool = getContext();
        assert.deepEqual(contextWithTool.messages.map((message) => message.role), ["user", "assistant", "tool"]);
        if (scenario === "legacy-tool") {
          assert.equal(contextWithTool.providerReplay[0]?.assistantProvenance, null);
          assert.deepEqual(contextWithTool.providerReplay[0]?.parts, []);
        } else {
          assert.equal(contextWithTool.providerReplay[0]?.parts.find((part) => part.type === "reasoning")?.text,
            "first internal reasoning");
        }
        await call("first-run", false, { reuseRun: true });
        assert.equal(requests.length, 2);
        const toolWire = requests[1]?.messages as Array<Record<string, any>>;
        assert.deepEqual(toolWire.map((message) => message.role), ["user", "assistant", "tool"]);
        if (scenario === "legacy-tool") {
          assert.equal(toolWire[1]?.content, "first", "legacy visible text stays in the provider-neutral transcript");
          assert.equal((toolWire[1]?.reasoning_content ?? "").includes("first internal reasoning"), false);
        } else assert.equal(toolWire[1]?.reasoning_content, "first internal reasoning");
        assert.equal(toolWire[1]?.tool_calls?.[0]?.id, "call-db-1");
        assert.equal(toolWire[2]?.tool_call_id, "call-db-1");
        addUser("next user turn after tool");
        await call("next-user-run");
        assert.equal(requests.length, 3);
        const nextWire = requests[2]?.messages as Array<Record<string, any>>;
        if (scenario === "legacy-tool") {
          assert.equal(nextWire.some((message) => message.reasoning_content?.includes("first internal reasoning")), false);
          assert.equal(nextWire.some((message) => message.reasoning_content?.includes("second internal reasoning")), true);
          assert.equal(nextWire.find((message) => message.role === "tool")?.tool_call_id, "call-db-1");
        } else assert.equal(nextWire.filter((message) =>
          message.role === "assistant" && message.reasoning_content?.length > 0).length, 2);
        return;
      }
      if (scenario === "legacy-blank") {
        persistPreDigestMetadata(first.assistantMessageId);
        const protectedContext = getContext();
        assert.deepEqual(protectedContext.messages.find((message) => message.role === "assistant"),
          { role: "assistant", content: [] });
        assert.equal(protectedContext.providerReplay[0]?.assistantProvenance, null);
        assert.deepEqual(protectedContext.providerReplay[0]?.parts, []);
        addUser("after legacy reasoning-only placeholder");
        await call("second-run");
        assert.equal((requests[1]?.messages as Array<Record<string, any>>)
          .some((message) => message.reasoning_content?.includes("first internal reasoning")), false);
        assert.deepEqual((requests[1]?.messages as Array<Record<string, any>>).map((message) => message.role),
          ["user", "user"], "empty legacy Assistant is only a protected boundary, not an SDK message");
        addUser("after new compatible Assistant");
        await call("third-run");
        assert.equal((requests[2]?.messages as Array<Record<string, any>>)
          .some((message) => message.reasoning_content?.includes("first internal reasoning")), false);
        assert.equal((requests[2]?.messages as Array<Record<string, any>>)
          .some((message) => message.reasoning_content?.includes("second internal reasoning")), true);
        return;
      }
      if (scenario === "legacy-invalid") {
        const partId = firstRow?.parts.find((part) => part.type === "reasoning")?.id;
        assert.ok(partId);
        const stored = fixture.db.prepare("select provider_replay_json as replay from agent_message_part where id=?")
          .get(partId) as { replay: string };
        const old = JSON.parse(stored.replay) as { version: number; provider: Record<string, unknown> };
        delete old.provider.endpointDigest;
        for (const invalid of ["{broken", JSON.stringify({ ...old, version: 2 }),
          JSON.stringify({ ...old, provider: { ...old.provider, extra: "unknown" } })]) {
          fixture.db.prepare("update agent_message_part set provider_replay_json=? where id=?").run(invalid, partId);
          assert.throws(getContext, /stored provider replay for part .* is invalid/);
        }
        assert.equal(requests.length, 1, "invalid metadata must fail before a new SDK request");
        return;
      }
      const source = getContext().providerReplay;
      assert.equal(source.length, 1);
      assert.equal(source[0]?.assistantProvenance?.providerNpm, provider.npm);
      assert.equal(source[0]?.parts.some((part) => part.type === "reasoning"), true);
      if (endpointChanged) {
        const storedReplay = fixture.db.prepare("select provider_replay_json as replay from agent_message_part where id=?")
          .get(firstRow?.parts.find((part) => part.type === "reasoning")?.id) as { replay: string };
        assert.match(storedReplay.replay, /"endpointDigest":"[a-f0-9]{64}"/);
        assert.equal(storedReplay.replay.includes(baseURL), false, "replay must not disclose endpoint URL");
        profile.provider.options.baseURL = `${baseURL}/other-endpoint`;
        addUser("switch endpoint");
        await call("second-run");
        assert.equal(requests.length, 2);
        assert.equal((requests[1]?.messages as Array<Record<string, any>>)
          .some((message) => message.reasoning_content?.includes("first internal reasoning")), false);
        profile.provider.options.baseURL = baseURL;
        addUser("switch back: do not look past incompatible Assistant");
        await call("third-run");
        assert.equal((requests[2]?.messages as Array<Record<string, any>>)
          .some((message) => message.reasoning_content?.includes("first internal reasoning")), false);
        return;
      }
      if (scenario === "legacy-middle") {
        addUser("legacy Assistant follows compatible one");
        const middle = await call("second-run");
        persistPreDigestMetadata(middle.assistantMessageId);
        const context = getContext();
        assert.equal(context.providerReplay[0]?.assistantProvenance?.providerNpm, provider.npm);
        assert.equal(context.providerReplay[1]?.assistantProvenance, null);
        addUser("after legacy boundary");
        await call("third-run");
        assert.equal((requests[2]?.messages as Array<Record<string, any>>)
          .some((message) => message.reasoning_content?.includes("first internal reasoning")), false);
        assert.equal((requests[2]?.messages as Array<Record<string, any>>)
          .some((message) => message.reasoning_content?.includes("second internal reasoning")), false);
        addUser("next compatible segment");
        await call("fourth-run");
        assert.equal((requests[3]?.messages as Array<Record<string, any>>)
          .some((message) => message.reasoning_content?.includes("first internal reasoning")), false);
        assert.equal((requests[3]?.messages as Array<Record<string, any>>)
          .some((message) => message.reasoning_content?.includes("second internal reasoning")), false);
        assert.equal((requests[3]?.messages as Array<Record<string, any>>)
          .some((message) => message.reasoning_content?.includes("third internal reasoning")), true);
        return;
      }
      if (reasoningOnly) {
        assert.deepEqual(getContext().messages.find((message) => message.role === "assistant"),
          { role: "assistant", content: [] }, "the API placeholder is only for protected ordinal lookup");
      }
      addUser("second request");
      const second = await call("second-run");
      const secondRow = getMessage(fixture.db, second.assistantMessageId);
      assert.equal(secondRow?.status, "completed");
      assert.notEqual(firstRow?.parts.find((part) => part.type === "reasoning")?.id,
        secondRow?.parts.find((part) => part.type === "reasoning")?.id,
        "reused SDK stream IDs must be scoped to their Assistant in SQLite");
      assert.equal(requests.length, 2);
      const historical = (requests[1]?.messages ?? []).find((message: any) =>
        message.role === "assistant" && message.reasoning_content?.includes("first internal reasoning"));
      assert.ok(historical, "SDK must receive reasoning restored from SQLite and protected PromptContext");
      if (multiBlock) {
        assert.equal(historical.reasoning_content, "first internal reasoningfirst after text reasoning");
        assert.ok(historical.reasoning_content.indexOf("first internal reasoning")
          < historical.reasoning_content.indexOf("first after text reasoning"));
      }
      if (!reasoningOnly) assert.equal(historical.content, "first");
      assert.deepEqual(signals.map(({ kind, attemptNo }) => [kind, attemptNo]), [
        ["model_invoked", 1], ["model_finished", 1], ["model_invoked", 1], ["model_finished", 1],
      ]);
      assert.equal(signals[1]?.totalTokens, 10);

      // Fork and revert inspect the same persisted provenance, never the test's replay fixtures.
      const forkHead = getMessageSessionHead(fixture.db, { workspaceId: "ws", sessionId: "session" });
      assert.ok(forkHead);
      forkMessageSession(fixture.db, { id: "forked", workspaceId: "ws", sourceSessionId: "session",
        expectedHeadMessageId: forkHead.headMessageId, expectedRevision: forkHead.revision,
        targetMessageId: first.assistantMessageId, title: "fork", kind: "primary", createdAt: Date.now() });
      const forked = projectModelContextToPrompt({ workspaceId: "ws", triggerMessageId: null,
        resolved: new ModelContextResolver(fixture.db).resolve({ workspaceId: "ws", sessionId: "forked" }),
        projector: new RuntimeTranscriptProjector(), includeReplayOnlyAssistants: true });
      assert.equal(forked.providerReplay.length, 1);
      assert.equal(forked.providerReplay[0]?.assistantProvenance?.model, provider.model);
      assert.equal(forked.providerReplay[0]?.parts.find((part) => part.type === "reasoning")?.text,
        "first internal reasoning");

      const revertHead = getMessageSessionHead(fixture.db, { workspaceId: "ws", sessionId: "session" });
      assert.ok(revertHead);
      revertBeforeUserMessage(fixture.db, { workspaceId: "ws", sessionId: "session",
        expectedHeadMessageId: revertHead.headMessageId, expectedRevision: revertHead.revision,
        targetMessageId: "user-2", updatedAt: Date.now() });
      assert.equal(getContext().providerReplay.length, 1, "reverted Assistant must not be replayed");

      // A legacy reasoning-only Assistant is invisible in the neutral transcript, but MUST
      // remain an untrusted boundary in protected PromptContext. Nothing before it may replay.
      const head = getMessageSessionHead(fixture.db, { workspaceId: "ws", sessionId: "session" });
      assert.ok(head);
      appendMessage(fixture.db, { workspaceId: "ws", sessionId: "session", id: "legacy-assistant",
        expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
        type: "assistant", status: "completed", createdAt: Date.now(),
        parts: [{ id: "legacy-reasoning", position: 0, type: "reasoning", text: "legacy private thought" }] });
      addUser("after legacy boundary");
      const contextAfterLegacy = getContext();
      assert.equal(contextAfterLegacy.providerReplay.at(-1)?.assistantProvenance, null);
      assert.ok(contextAfterLegacy.messages.some((message) => message.role === "assistant"
        && Array.isArray(message.content) && message.content.length === 0));
      await call("third-run");
      assert.equal(requests.length, 3);
      // DeepSeek's V4 serializer emits an empty reasoning_content for ordinary historical
      // Assistant text even without a reasoning Part; it must not contain earlier reasoning.
      assert.equal((requests[2]?.messages ?? []).some((message: any) =>
        message.role === "assistant" && typeof message.reasoning_content === "string"
          && message.reasoning_content.length > 0), false,
        "legacy boundary must block nonempty reasoning from both prior Assistants");
      assert.equal((requests[2]?.messages ?? []).some((message: any) =>
        message.role === "assistant" && Array.isArray(message.content) && message.content.length === 0), false,
        "internal placeholder must never be sent to the SDK");

      // Only the retained tail is visible after a legal User anchor. In particular the
      // first Assistant must not be retrieved again through the replay side channel.
      const compactHead = getMessageSessionHead(fixture.db, { workspaceId: "ws", sessionId: "session" });
      assert.ok(compactHead);
      commitCompactionMessageForTest(fixture.db, { id: "summary", workspaceId: "ws", sessionId: "session",
        expectedHeadMessageId: compactHead.headMessageId, expectedRevision: compactHead.revision,
        textPartId: "summary-text", text: "summary without old thoughts",
        retainedFromMessageId: "user-3", createdAt: Date.now() });
      const retained = getContext();
      assert.equal(retained.providerReplay.length, 1);
      assert.equal(retained.providerReplay[0]?.parts.find((part) => part.type === "reasoning")?.text,
        "second internal reasoning");

      addUser("recovery replacement fails closed");
      (backend as any).replaceStreamingAssistant = async () => ({ result: "ignored" });
      const previousRequestCount = requests.length;
      const previousSignalCount = signals.length;
      await assert.rejects(call("fourth-run", true), /replace recovery streaming assistant/);
      assert.equal(getMessage(fixture.db, "fourth-run:old-streaming")?.status, "streaming");
      assert.equal(requests.length, previousRequestCount, "failed replacement must not start a model request");
      assert.equal(signals.length, previousSignalCount, "failed replacement must not emit model_invoked");
      assert.equal(fixture.db.prepare("select count(*) as count from agent_tool_execution where origin_run_id=?")
        .get("fourth-run")?.count, 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fixture.dispose();
    }
  });
}
