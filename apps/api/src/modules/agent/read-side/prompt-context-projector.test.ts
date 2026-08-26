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
    listVisibleItems: () => [
      {
        id: 7,
        workspaceId: "workspace",
        sessionId: "session",
        runId: "run",
        turnId: null,
        step: null,
        kind: "tool",
        status: "running",
        output: { type: "tool", toolName: "bash", toolCallId: "call", args: { command: "pwd" } },
        prevId: null,
        archiveAt: null,
        boundaryReason: null,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    async buildMessages({ compactionSnippetUiLocale, triggerItemId }) {
      assert.equal(compactionSnippetUiLocale, "en-US");
      assert.equal(triggerItemId, 9);
      return { messages: [{ role: "user" as const, content: "dynamic message" }] };
    }
  });
  const input = {
    workspaceId: "workspace",
    sessionId: "session",
    session: { kind: "primary" as const, headItemId: 3 },
    run: { runId: "run", subtaskDepth: 0, agentId: "agent", providerId: "provider", modelId: "model", triggerItemId: 9 }
  };

  const first = await projector.getPromptContextForRun(input);
  const second = await projector.getPromptContextForRun(input);

  assert.equal(assembled, 1, "same run must reuse cached static assembly");
  assert.equal(resolvedProfiles, 2, "profile validation must remain dynamic when static prompt data is cached");
  assert.deepEqual(first, {
    headItemId: 3,
    system: "static|runtime:en-US",
    messages: [{ role: "user", content: "dynamic message" }],
    tools: [{ name: "read", description: "Read", inputSchema: {} }],
    pendingTools: [{ itemId: 7, status: "running", toolName: "bash", toolCallId: "call", args: { command: "pwd" } }],
    lastResponseTotalTokens: 42,
    uiLocale: "en-US",
    externalSkillRoots: [{ sourceType: "workspace", rootDir: "skills", rootPath: "/workspace/skills" }]
  });
  assert.deepEqual(second, first);
});
