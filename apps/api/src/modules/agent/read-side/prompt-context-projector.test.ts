import assert from "node:assert/strict";
import { test } from "node:test";
import { RunPromptStaticCache } from "../prompt/run-prompt-static-cache.js";
import { PromptContextProjector } from "./prompt-context-projector.js";

test("PromptContextProjector composes cached static data with dynamic locale, messages, and pending tools", async () => {
  const cache = new RunPromptStaticCache<{
    systemStatic: string;
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    externalSkillRoots: Array<{ sourceType: "workspace" | "repo"; repoId?: string; rootDir: string; rootPath: string }>;
  }>();
  let assembled = 0;
  let resolvedProfiles = 0;
  const projector = new PromptContextProjector(cache, {
    getRunState: () => ({ activeRunId: "active-run", lastResponseTotalTokens: 42 }),
    resolveUiLocale: ({ activeRunId }) => activeRunId === "active-run" ? "en-US" : null,
    resolveProfile: () => {
      resolvedProfiles += 1;
      return { agent: { name: "Agent", tools: [] } };
    },
    async assembleStatic(input) {
      assembled += 1;
      assert.equal(input.uiLocale, "en-US");
      return {
        systemStatic: "static",
        tools: [{ name: "read", description: "Read", inputSchema: {} }],
        externalSkillRoots: [{ sourceType: "workspace", rootDir: "skills", rootPath: "/workspace/skills" }]
      };
    },
    buildRuntimeInstruction: ({ uiLocale }) => `runtime:${uiLocale}`,
    appendRuntimeConstraints: (system, runtime) => `${system}|${runtime}`,
    listPendingTools: () => [
      {
        toolExecutionId: "execution-7",
        callPartId: "part-7",
        assistantMessageId: "message-7",
        status: "running",
        toolName: "bash",
        toolCallId: "call",
        args: { command: "pwd" }
      }
    ],
    async buildMessages({ compactionSnippetUiLocale, triggerMessageId, pendingAssistantMessageIds }) {
      assert.equal(compactionSnippetUiLocale, "en-US");
      assert.equal(triggerMessageId, "message-9");
      assert.deepEqual([...pendingAssistantMessageIds], ["message-7"]);
      return { messages: [{ role: "user" as const, content: "dynamic message" }] };
    }
  });
  const input = {
    workspaceId: "workspace",
    sessionId: "session",
    session: { kind: "primary" as const, headMessageId: "message-3", revision: 3 },
    run: { runId: "run", subtaskDepth: 0, agentId: "agent", providerId: "provider", modelId: "model", triggerMessageId: "message-9" }
  };

  const first = await projector.getPromptContextForRun(input);
  const second = await projector.getPromptContextForRun(input);

  assert.equal(assembled, 1, "same run must reuse cached static assembly");
  assert.equal(resolvedProfiles, 2, "profile validation must remain dynamic when static prompt data is cached");
  assert.deepEqual(first, {
    headMessageId: "message-3",
    sessionRevision: 3,
    system: "static|runtime:en-US",
    messages: [{ role: "user", content: "dynamic message" }],
    tools: [{ name: "read", description: "Read", inputSchema: {} }],
    pendingTools: [{ toolExecutionId: "execution-7", callPartId: "part-7", assistantMessageId: "message-7", status: "running", toolName: "bash", toolCallId: "call", args: { command: "pwd" } }],
    lastResponseTotalTokens: 42,
    uiLocale: "en-US",
    externalSkillRoots: [{ sourceType: "workspace", rootDir: "skills", rootPath: "/workspace/skills" }]
  });
  assert.deepEqual(second, first);
});

test("PromptContextProjector passes every pending Assistant ID so transcript projection can choose the earliest chain boundary", async () => {
  const observedPendingAssistantMessageIds: string[][] = [];
  const pendingTools = [
    {
      toolExecutionId: "execution-later",
      callPartId: "call-later",
      assistantMessageId: "assistant-later",
      status: "running" as const,
      toolName: "bash" as const,
      toolCallId: "call-later",
      args: { command: "printf later" }
    },
    {
      toolExecutionId: "execution-earlier-completed",
      callPartId: "call-earlier-completed",
      assistantMessageId: "assistant-earlier",
      status: "queued" as const,
      toolName: "bash" as const,
      toolCallId: "call-earlier-completed",
      args: { command: "printf completed" }
    },
    {
      toolExecutionId: "execution-earlier-pending",
      callPartId: "call-earlier-pending",
      assistantMessageId: "assistant-earlier",
      status: "running" as const,
      toolName: "bash" as const,
      toolCallId: "call-earlier-pending",
      args: { command: "printf pending" }
    }
  ];
  const projector = new PromptContextProjector(new RunPromptStaticCache(), {
    getRunState: () => ({ activeRunId: "run", lastResponseTotalTokens: null }),
    resolveUiLocale: () => null,
    resolveProfile: () => ({ agent: { name: "Agent", tools: [] } }),
    async assembleStatic() {
      return { systemStatic: "static", tools: [], externalSkillRoots: [] };
    },
    buildRuntimeInstruction: () => "runtime",
    appendRuntimeConstraints: (system, runtime) => `${system}|${runtime}`,
    listPendingTools: () => pendingTools,
    async buildMessages({ pendingAssistantMessageIds }) {
      observedPendingAssistantMessageIds.push([...pendingAssistantMessageIds]);
      return { messages: [{ role: "user" as const, content: "history through earliest boundary" }] };
    }
  });

  const result = await projector.getPromptContextForRun({
    workspaceId: "workspace",
    sessionId: "session",
    session: { kind: "primary", headMessageId: "head", revision: 4 },
    run: { runId: "run", subtaskDepth: null, agentId: "agent", providerId: "provider", modelId: "model", triggerMessageId: "trigger" }
  });

  assert.deepEqual(observedPendingAssistantMessageIds, [["assistant-later", "assistant-earlier"]]);
  assert.deepEqual(result.pendingTools, pendingTools);
  assert.deepEqual(result.messages, [{ role: "user", content: "history through earliest boundary" }]);
});
