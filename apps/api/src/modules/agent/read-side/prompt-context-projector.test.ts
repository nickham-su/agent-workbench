import assert from "node:assert/strict";
import { test } from "node:test";
import { RunPromptStaticCache } from "../prompt/run-prompt-static-cache.js";
import { PromptContextProjector } from "./prompt-context-projector.js";

test("PromptContextProjector composes cached static data with dynamic locale, messages, and pending tools", async () => {
  const cache = new RunPromptStaticCache<{
    systemStatic: string;
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    externalSkills: Array<{ skillId: string; skillDirectoryPath: string }>;
  }>();
  let assembled = 0;
  let resolvedProfiles = 0;
  const projector = new PromptContextProjector(cache, {
    async resolveDynamicContext() {
      return {
        headMessageId: "resolver-head", sessionRevision: 8,
        run: { runId: "run", subtaskDepth: 0, agentId: "agent", providerId: "provider", modelId: "model", triggerMessageId: "message-9", runKind: "user", executionPhase: "work_in_progress", uiLocale: "en-US" },
        pendingTools: [{ toolExecutionId: "execution-7", callPartId: "part-7", assistantMessageId: "message-7", status: "running" as const, toolName: "bash", toolCallId: "call", args: { command: "pwd" } }],
        lastResponseTotalTokens: 42, uiLocale: "en-US" as const,
        messages: [{ role: "user" as const, content: "dynamic message" }],
      };
    },
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
        externalSkills: [{ skillId: "skills/review", skillDirectoryPath: "/workspace/skills/review" }]
      };
    },
    readWorkspaceRepoNames: () => [],
    resolveSubtaskDescription: () => assert.fail("hidden subtask must not resolve a description"),
    buildRuntimeInstruction: ({ uiLocale }) => `runtime:${uiLocale}`,
    appendRuntimeConstraints: (system, runtime) => `${system}|${runtime}`,
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
    headMessageId: "resolver-head",
    sessionRevision: 8,
    system: "static|runtime:en-US",
    messages: [{ role: "user", content: "dynamic message" }],
    tools: [{ name: "read", description: "Read", inputSchema: {} }],
    pendingTools: [{ toolExecutionId: "execution-7", callPartId: "part-7", assistantMessageId: "message-7", status: "running", toolName: "bash", toolCallId: "call", args: { command: "pwd" } }],
    lastResponseTotalTokens: 42,
    uiLocale: "en-US",
    workspaceRepoNames: [],
    externalSkills: [{ skillId: "skills/review", skillDirectoryPath: "/workspace/skills/review" }]
  });
  assert.deepEqual(second, first);
});

test("PromptContextProjector passes every pending Assistant ID so transcript projection can choose the earliest chain boundary", async () => {
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
    async resolveDynamicContext() {
      return {
        headMessageId: "head", sessionRevision: 4,
        run: { runId: "run", subtaskDepth: null, agentId: "agent", providerId: "provider", modelId: "model", triggerMessageId: "trigger", runKind: "user", executionPhase: "work_pending", uiLocale: null },
        pendingTools, lastResponseTotalTokens: null, uiLocale: null,
        messages: [{ role: "user" as const, content: "history through earliest boundary" }],
      };
    },
    resolveProfile: () => ({ agent: { name: "Agent", tools: [] } }),
    async assembleStatic() {
      return { systemStatic: "static", tools: [], externalSkills: [] };
    },
    readWorkspaceRepoNames: () => [],
    resolveSubtaskDescription: () => assert.fail("hidden subtask must not resolve a description"),
    buildRuntimeInstruction: () => "runtime",
    appendRuntimeConstraints: (system, runtime) => `${system}|${runtime}`,
  });

  const result = await projector.getPromptContextForRun({
    workspaceId: "workspace",
    sessionId: "session",
    session: { kind: "primary", headMessageId: "head", revision: 4 },
    run: { runId: "run", subtaskDepth: null, agentId: "agent", providerId: "provider", modelId: "model", triggerMessageId: "trigger" }
  });

  assert.deepEqual(result.pendingTools, pendingTools);
  assert.deepEqual(result.messages, [{ role: "user", content: "history through earliest boundary" }]);
});

test("PromptContextProjector refuses a response when terminal invalidation races static assembly", async () => {
  const cache = new RunPromptStaticCache<{ systemStatic: string; tools: []; externalSkills: [] }>();
  let releaseAssembly!: () => void;
  const projector = new PromptContextProjector(cache, {
    async resolveDynamicContext() {
      return {
        headMessageId: "head", sessionRevision: 1,
        run: { runId: "run", subtaskDepth: null, agentId: "agent", providerId: "provider", modelId: "model", triggerMessageId: null, runKind: "user", executionPhase: "work_pending", uiLocale: null },
        pendingTools: [], lastResponseTotalTokens: null, uiLocale: null, messages: [],
      };
    },
    resolveProfile: () => ({ agent: { name: "Agent", tools: [] } }),
    async assembleStatic() {
      await new Promise<void>((done) => { releaseAssembly = done; });
      return { systemStatic: "static", tools: [], externalSkills: [] };
    },
    readWorkspaceRepoNames: () => [],
    resolveSubtaskDescription: () => assert.fail("hidden subtask must not resolve a description"),
    buildRuntimeInstruction: () => "runtime",
    appendRuntimeConstraints: (system, runtime) => `${system}|${runtime}`,
  });
  const request = projector.getPromptContextForRun({
    workspaceId: "workspace", sessionId: "session", session: { kind: "primary", headMessageId: "head", revision: 1 },
    run: { runId: "run", subtaskDepth: null, agentId: "agent", providerId: "provider", modelId: "model", triggerMessageId: null },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  cache.clear("run");
  releaseAssembly();
  await assert.rejects(request, /invalidated while assembling context/);
  assert.equal(cache.has("run"), false);
});


test("PromptContextProjector reads fresh registered names on every request despite a same-run static-cache hit", async () => {
  let names = ["old-repo"];
  let assembled = 0;
  const reads: string[] = [];
  const projector = new PromptContextProjector(new RunPromptStaticCache(), {
    async resolveDynamicContext() {
      return {
        headMessageId: "head", sessionRevision: 1,
        run: { runId: "run", subtaskDepth: null, agentId: "agent", providerId: "provider", modelId: "model", triggerMessageId: null, runKind: "user", executionPhase: "work_pending", uiLocale: null },
        pendingTools: [], lastResponseTotalTokens: null, uiLocale: null, messages: [],
      };
    },
    resolveProfile: () => ({ agent: { name: "Agent", tools: ["git"] } }),
    async assembleStatic() {
      assembled += 1;
      return { systemStatic: "static", tools: [{ name: "git", description: "Git base", inputSchema: {} }], externalSkills: [] };
    },
    readWorkspaceRepoNames(workspaceId) { reads.push(workspaceId); return [...names]; },
    resolveSubtaskDescription: () => assert.fail("hidden subtask must not resolve a description"),
    buildRuntimeInstruction: () => "runtime",
    appendRuntimeConstraints: (system) => system,
  });
  const input = {
    workspaceId: "workspace", sessionId: "session", session: { kind: "primary" as const, headMessageId: "head", revision: 1 },
    run: { runId: "run", subtaskDepth: null, agentId: "agent", providerId: "provider", modelId: "model", triggerMessageId: null },
  };
  const first = await projector.getPromptContextForRun(input);
  names = Array.from({ length: 101 }, (_, i) => `new-repo-${i}`);
  const second = await projector.getPromptContextForRun(input);
  names = [];
  const third = await projector.getPromptContextForRun(input);
  assert.deepEqual(first.workspaceRepoNames, ["old-repo"]);
  assert.equal(second.workspaceRepoNames.length, 101);
  assert.equal(second.workspaceRepoNames[100], "new-repo-100");
  assert.deepEqual(third.workspaceRepoNames, []);
  assert.equal(assembled, 1);
  assert.deepEqual(reads, ["workspace", "workspace", "workspace"]);
  assert.equal(first.tools, second.tools);
  assert.equal(second.tools[0]?.description, "Git base");
});

test("PromptContextProjector refreshes only the subtask description without mutating same-run static data", async () => {
  let description = "Available agents: A, B";
  let assembled = 0;
  const reads: string[] = [];
  const staticPrompt = {
    systemStatic: "static instructions and skills",
    tools: [
      { name: "read", description: "Read base", inputSchema: {} },
      Object.freeze({ name: "subtask", description: "Subtask base", inputSchema: { type: "object" } }),
    ],
    externalSkills: [{ skillId: "skill", skillDirectoryPath: "/workspace/skill" }],
  };
  const projector = new PromptContextProjector(new RunPromptStaticCache(), {
    async resolveDynamicContext() {
      return {
        headMessageId: "head", sessionRevision: 1,
        run: { runId: "run", subtaskDepth: 0, agentId: "agent", providerId: "provider", modelId: "model", triggerMessageId: null, runKind: "user", executionPhase: "work_pending", uiLocale: null },
        pendingTools: [], lastResponseTotalTokens: null, uiLocale: null, messages: [],
      };
    },
    resolveProfile: () => ({ agent: { name: "Agent", tools: ["subtask"] } }),
    async assembleStatic() {
      assembled += 1;
      return staticPrompt;
    },
    readWorkspaceRepoNames: () => [],
    resolveSubtaskDescription(workspaceId) { reads.push(workspaceId); return description; },
    buildRuntimeInstruction: () => "runtime",
    appendRuntimeConstraints: (system) => system,
  });
  const input = {
    workspaceId: "workspace", sessionId: "session", session: { kind: "primary" as const, headMessageId: "head", revision: 1 },
    run: { runId: "run", subtaskDepth: 0, agentId: "agent", providerId: "provider", modelId: "model", triggerMessageId: null },
  };
  const snapshots = [];
  for (const next of ["Available agents: A, B", "Available agents: A", "No agents are currently available", "Available agents: B"]) {
    description = next;
    const context = await projector.getPromptContextForRun(input);
    snapshots.push(context);
    assert.equal(context.tools.find((tool) => tool.name === "subtask")?.description, next);
    assert.equal(context.system, staticPrompt.systemStatic);
    assert.equal(context.externalSkills, staticPrompt.externalSkills);
    assert.equal(context.tools[0], staticPrompt.tools[0]);
    assert.equal(context.tools[1]?.inputSchema, staticPrompt.tools[1]?.inputSchema);
  }
  assert.equal(assembled, 1);
  assert.deepEqual(reads, Array(4).fill("workspace"));
  assert.deepEqual(snapshots.map((snapshot) => snapshot.tools[1]?.description), [
    "Available agents: A, B", "Available agents: A", "No agents are currently available", "Available agents: B",
  ]);
  assert.equal(staticPrompt.tools[1]?.description, "Subtask base");
});
