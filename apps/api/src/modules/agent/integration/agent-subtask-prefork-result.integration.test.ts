import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { test, type TestContext } from "node:test";
import { setSettingJson } from "../../settings/settings.store.js";
import {
  createRunRecord,
  getAgentSession,
  getRunRecord,
  getSessionTranscriptItems,
  updateRunState
} from "../agent.store.js";
import { newSortableId } from "../../../utils/ids.js";
import {
  createContextItemInternal,
  createP2Fixture,
  createSession,
  createSubtaskSessionForTest,
} from "./subtask.helpers.js";


async function getContextItem(app: FastifyInstance, sessionId: string, itemId: number) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/context-items/${itemId}` });
  assert.equal(res.statusCode, 200, `get context-item failed: ${res.body}`);
  return res.json() as { id: number; status: string; output: Record<string, unknown> };
}

async function getPromptContextInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/prompt-context",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId
    }
  });
  assert.equal(res.statusCode, 200, `get prompt-context failed: ${res.body}`);
  return res.json() as {
    system: string;
    tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    uiLocale: "zh-CN" | "en-US" | null;
    messages: Array<{ role: string; content: unknown }>;
    pendingTools: Array<{ itemId: number; status: string; toolName: string }>;
    externalSkillRoots: Array<{ sourceType: "workspace" | "repo"; repoId?: string; rootDir: string; rootPath: string }>;
  };
}

async function configureAgentDefaults(app: FastifyInstance, contextWindowTokens = 128000) {
  const providersRes = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: {
        providerId: "ppchat",
        modelId: "gpt-5.2"
      },
      providers: [
        {
          id: "ppchat",
          name: "ppchat",
          npm: "@ai-sdk/openai",
          options: {
            baseURL: "https://code.ppchat.vip/v1",
            apiKey: "sk-test"
          },
          models: [
            {
              id: "gpt-5.2",
              name: "gpt-5.2",
              contextWindowTokens
            }
          ]
        }
      ]
    }
  });
  assert.equal(providersRes.statusCode, 200, `configure providers failed: ${providersRes.body}`);

  const agentsRes = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write"],
          pluginTools: [],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);
}

test("agent subtask fork 在复制历史与子任务 prompt 之间插入 system 提示", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write", "subtask"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents with subtask failed: ${agentsRes.body}`);

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const createdAt = Date.now();
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "en-US",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "请调用 subtask 把任务交给另一个 agent。"
    }
  });

  const assistantItem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_fork",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "我会调用工具处理这个任务。"
    }
  });

  const readToolItem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_fork",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "read",
      toolCallId: "call_subtask_read",
      args: { filePath: "README.md" },
      text: "tool: read\nstatus: completed\n\nREADME snippet"
    }
  });

  const toolItem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_fork",
    step: 1,
    prevId: readToolItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_subtask_fork",
      args: {
        description: "研究问题",
        prompt: "请直接完成这个子任务",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const startRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId: parentRunId,
      parentToolItemId: toolItem.item.id,
      description: "研究问题",
      prompt: "请直接完成这个子任务",
      agentId: "default",
      session: { mode: "fork" }
    }
  });
  assert.equal(startRes.statusCode, 200, `start subtask failed: ${startRes.body}`);
  const started = startRes.json() as { sessionId: string; runId: string; agentName: string };
  assert.equal(started.agentName, "default");


  const items = getSessionTranscriptItems(fixture.db, fixture.workspaceId, started.sessionId);
  assert.equal(items.length >= 3, true, "forked subtask session should contain copied user, system guard and prompt user");

  const copiedUser = items[0];
  const systemItem = items[1];
  const promptUser = items[2];
  assert.equal(items.some((item) => item.id !== copiedUser?.id && item.kind === "assistant"), false, "forked subtask session should not copy the triggering assistant turn");
  assert.equal(items.some((item) => item.kind === "tool"), false, "forked subtask session should not copy tool items from the triggering turn");
  assert.equal(copiedUser?.kind, "user");
  assert.equal(copiedUser?.output.type, "user_text");
  assert.equal((copiedUser?.output as { text?: string }).text, "请调用 subtask 把任务交给另一个 agent。");
  assert.equal(systemItem?.kind, "system");
  assert.equal(systemItem?.output.type, "system_text");
  assert.equal(
    String((systemItem?.output as { text?: string }).text || "").includes("All history before this system message was copied from the parent session"),
    true
  );
  assert.equal(promptUser?.kind, "user");
  assert.equal(promptUser?.output.type, "user_text");
  assert.equal((promptUser?.output as { text?: string }).text, "请直接完成这个子任务");

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: started.sessionId,
    runId: started.runId
  });
  assert.equal(
    promptContext.messages.some((message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.includes("All history before this system message was copied from the parent session")
    ),
    true
  );
  assert.equal(promptContext.uiLocale, "en-US");
  assert.equal(
    promptContext.tools.some((tool) => tool.name === "subtask"),
    false,
    "forked subtask session should not expose subtask tool"
  );
  assert.ok(promptContext.system.includes("[runtime_constraints]"));
  assert.equal(promptContext.system.includes("## Runtime Constraints"), false);
  assert.ok(promptContext.system.includes("Language requirement: use English consistently for this run."));
  assert.equal(promptContext.system.includes("Current system time:"), false);
  assert.equal(promptContext.system.includes("Time zone:"), false);
});

test("subtask start with preforkSummaryText should inject summary->guard->prompt without copying parent history", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );

  const parentSessionRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions",
    payload: { workspaceId: fixture.workspaceId, title: "parent-prefork" }
  });
  assert.equal(parentSessionRes.statusCode, 201, `create parent session failed: ${parentSessionRes.body}`);
  const parentSession = parentSessionRes.json() as { id: string };

  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "this is parent history that must not be copied"
    }
  });
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });

  const parentAssistant = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork",
    step: 1,
    prevId: parentUser.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "prepare subtask"
    }
  });

  const subtaskTool = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork",
    step: 1,
    prevId: parentAssistant.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_prefork",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    status: "running",
    activeRunId: parentRunId,
    activeAssistantItemId: null,
    lastResponseTotalTokens: 200000,
    runNoticeText: "",
    updatedAt: Date.now(),
    appliedItemId: subtaskTool.item.id
  });

  const startRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      description: "prefork",
      prompt: "please do prefork task",
      agentId: "default",
       session: { mode: "fork" },
       preforkSummaryText: "prefork summary",
       preforkMeta: {
         thresholdPct: 95,
         parentLastResponseTotalTokens: 200000,
         childContextWindowTokens: 128000,
         extra: true
       }
    }
  });
  assert.equal(startRes.statusCode, 200, `start subtask failed: ${startRes.body}`);
  const started = startRes.json() as { sessionId: string };

  const items = getSessionTranscriptItems(fixture.db, fixture.workspaceId, started.sessionId);
  assert.equal(items.length, 3, "prefork path should only inject summary/guard/prompt items");
  assert.equal(items[0]?.kind, "system");
  assert.equal((items[0]?.output as { text?: string } | undefined)?.text, "prefork summary");
  assert.equal(items[1]?.kind, "system");
  assert.equal(String((items[1]?.output as { text?: string } | undefined)?.text || "").includes("All history before this system message was copied from the parent session"), true);
  assert.equal(items[2]?.kind, "user");
  assert.equal((items[2]?.output as { text?: string } | undefined)?.text, "please do prefork task");
  assert.equal(items.some((item) => item.kind === "user" && (item.output as { text?: string }).text === "this is parent history that must not be copied"), false);
});

test("subtask start should reject preforkSummaryText when mode=new/existing", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "prepare prefork mode reject" }
  });

  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });

  const subtaskTool = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork_mode_reject",
    step: 1,
    prevId: parentUser.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_prefork_mode_reject",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const modeNewRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      description: "prefork",
      prompt: "please do prefork task",
      agentId: "default",
      session: { mode: "new" },
      preforkSummaryText: "prefork summary"
    }
  });
  assert.equal(modeNewRes.statusCode, 400);
  assert.equal((modeNewRes.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_NOT_ALLOWED");

  const existingSession = createSubtaskSessionForTest(fixture, { title: "existing-subtask" });

  const modeExistingRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      description: "prefork",
      prompt: "please do prefork task",
      agentId: "default",
      session: { mode: "existing", sessionId: existingSession.id },
      preforkSummaryText: "prefork summary"
    }
  });
  assert.equal(modeExistingRes.statusCode, 400);
  assert.equal((modeExistingRes.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_NOT_ALLOWED");
});

test("subtask start should reject too long preforkSummaryText", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "prepare prefork too long" }
  });

  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });

  const subtaskTool = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork_too_long",
    step: 1,
    prevId: parentUser.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_prefork_too_long",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const tooLongSummary = "x".repeat(20_001);
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      description: "prefork",
      prompt: "please do prefork task",
      agentId: "default",
      session: { mode: "fork" },
      preforkSummaryText: tooLongSummary
    }
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_SUMMARY_TOO_LONG");
});

test("subtask start should allow description length 50 and silently truncate >50", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "prepare description length boundary" }
  });

  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });

  const subtaskTool = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_description_boundary",
    step: 1,
    prevId: parentUser.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_description_boundary",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const maxAllowedDescription = "d".repeat(50);
  const basePayload = {
    workspaceId: fixture.workspaceId,
    parentSessionId: parentSession.id,
    parentRunId,
    parentToolItemId: subtaskTool.item.id,
    prompt: "please do subtask with max allowed description length",
    agentId: "default",
    session: { mode: "fork" as const }
  };
  const acceptedRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { ...basePayload, description: maxAllowedDescription }
  });
  assert.equal(acceptedRes.statusCode, 200, `description length 50 should be accepted: ${acceptedRes.body}`);
  const acceptedBody = acceptedRes.json() as { sessionId: string };
  const acceptedSession = getAgentSession(fixture.db, acceptedBody.sessionId);
  assert.equal(acceptedSession?.title, `${maxAllowedDescription} (fork)`);

  const tooLongDescription = `  ${"d".repeat(51)}  `;
  const truncatedDescription = "d".repeat(50);
  const truncatedRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { ...basePayload, description: tooLongDescription }
  });
  assert.equal(truncatedRes.statusCode, 200, `description length 51 should be accepted and truncated: ${truncatedRes.body}`);
  const truncatedBody = truncatedRes.json() as { sessionId: string };
  const truncatedSession = getAgentSession(fixture.db, truncatedBody.sessionId);
  assert.equal(truncatedSession?.title, `${truncatedDescription} (fork)`);
});

test("subtask start should reject mismatched preforkMeta", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "prepare prefork meta mismatch" }
  });

  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });

  const subtaskTool = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork_meta_mismatch",
    step: 1,
    prevId: parentUser.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_prefork_meta_mismatch",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const updatedAt = Date.now();
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    status: "running",
    activeRunId: parentRunId,
    activeAssistantItemId: null,
    lastResponseTotalTokens: 200000,
    runNoticeText: "",
    updatedAt,
    appliedItemId: subtaskTool.item.id
  });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      description: "prefork",
      prompt: "please do prefork task",
      agentId: "default",
      session: { mode: "fork" },
      preforkSummaryText: "prefork summary",
      preforkMeta: { thresholdPct: 95, parentLastResponseTotalTokens: 199999, childContextWindowTokens: 128000 }
    }
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_META_MISMATCH");
});

test("subtask prefork-plan should use default threshold and return correct shouldPrefork", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );

  const parentSessionRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions",
    payload: { workspaceId: fixture.workspaceId, title: "parent-prefork-plan" }
  });
  assert.equal(parentSessionRes.statusCode, 201, `create parent session failed: ${parentSessionRes.body}`);
  const parentSession = parentSessionRes.json() as { id: string };

  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "prefork-plan parent user"
    }
  });
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });

  const subtaskTool = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork_plan",
    step: 1,
    prevId: parentUser.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_prefork_plan",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const shouldNotPreforkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      agentId: "default"
    }
  });
  assert.equal(shouldNotPreforkRes.statusCode, 200, `prefork-plan failed: ${shouldNotPreforkRes.body}`);
  const shouldNotPreforkBody = shouldNotPreforkRes.json() as {
    shouldPrefork: boolean;
    thresholdPct: number;
    parentLastResponseTotalTokens: number | null;
    childContextWindowTokens: number;
    thresholdTokens: number;
  };
  assert.equal(shouldNotPreforkBody.thresholdPct, 95);
  assert.equal(shouldNotPreforkBody.childContextWindowTokens, 128000);
  assert.equal(shouldNotPreforkBody.thresholdTokens, 121600);
  assert.equal(shouldNotPreforkBody.parentLastResponseTotalTokens, null);
  assert.equal(shouldNotPreforkBody.shouldPrefork, false);

  const updatedAt = Date.now();
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    status: "running",
    activeRunId: parentRunId,
    activeAssistantItemId: null,
    lastResponseTotalTokens: 200000,
    runNoticeText: "",
    updatedAt,
    appliedItemId: subtaskTool.item.id
  });

  const shouldPreforkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      agentId: "default"
    }
  });
  assert.equal(shouldPreforkRes.statusCode, 200, `prefork-plan failed: ${shouldPreforkRes.body}`);
  const shouldPreforkBody = shouldPreforkRes.json() as {
    shouldPrefork: boolean;
    parentLastResponseTotalTokens: number | null;
  };
  assert.equal(shouldPreforkBody.parentLastResponseTotalTokens, 200000);
  assert.equal(shouldPreforkBody.shouldPrefork, true);

  await configureAgentDefaults(fixture.app, 1);
  const minimumPlanRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, parentSessionId: parentSession.id, parentRunId, parentToolItemId: subtaskTool.item.id, agentId: "default", thresholdPct: 50 }
  });
  assert.equal(minimumPlanRes.statusCode, 200, minimumPlanRes.body);
  assert.deepEqual(minimumPlanRes.json(), { shouldPrefork: true, thresholdPct: 50, parentLastResponseTotalTokens: 200000, childContextWindowTokens: 1, thresholdTokens: 1 });
});

test("subtask prefork-plan should reject invalid thresholdPct", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });
  const subtaskTool = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_prefork_plan_invalid",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_prefork_plan_invalid",
      args: {
        description: "prefork",
        prompt: "please do prefork task",
        agentId: "default",
        session: { mode: "fork" }
      }
    }
  });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId,
      parentToolItemId: subtaskTool.item.id,
      agentId: "default",
      thresholdPct: 49
    }
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_THRESHOLD_INVALID");
});

test("agent subtask fork 对父 run 非法 locale 做归一化回退，避免继续传播非法值", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "You are a helpful coding assistant.",
          tools: ["bash", "read", "write", "subtask"],
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents with subtask failed: ${agentsRes.body}`);

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "fr-FR" as any,
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });
  const toolItem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_invalid_locale",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: { type: "tool", toolName: "subtask", toolCallId: "call_subtask_invalid_locale", args: { description: "研究问题", prompt: "请直接完成这个子任务", agentId: "default", session: { mode: "fork" } } }
  });
  const startRes = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/subtask/start", headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" }, payload: { workspaceId: fixture.workspaceId, parentSessionId: parentSession.id, parentRunId, parentToolItemId: toolItem.item.id, description: "研究问题", prompt: "请直接完成这个子任务", agentId: "default", session: { mode: "fork" } } });
  assert.equal(startRes.statusCode, 200, `start subtask failed: ${startRes.body}`);
  const started = startRes.json() as { sessionId: string; runId: string };
  const subtaskRun = getRunRecord(fixture.db, started.runId);
  assert.equal(subtaskRun?.uiLocale, null);
  const items = getSessionTranscriptItems(fixture.db, fixture.workspaceId, started.sessionId);
  const guardItem = items.find((item) => item.kind === "system" && item.output.type === "system_text");
  assert.ok(guardItem);
  assert.equal(String((guardItem?.output as { text?: string } | undefined)?.text || "").includes("You are working in a subtask session derived from a parent session."), true);
});

test("subtask 失败时 getSubtaskRunResultFromWorker 仍返回 partial text", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const session = createSubtaskSessionForTest(fixture, { title: "it-subtask-result" });
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "failed",
    createdAt
  });

  await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_subtask_failed_partial",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "failed",
    output: {
      type: "assistant_text",
      text: "partial result from subtask",
      error: "failed after 3 retries: timeout"
    }
  });

  const resultRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId
    }
  });
  assert.equal(resultRes.statusCode, 200, `get subtask result failed: ${resultRes.body}`);
  assert.equal((resultRes.json() as { resultText: string }).resultText, "partial result from subtask");
});

test("subtask result follows assistant, then system, then empty fallback and status exposes all terminal states", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const createRun = async (status: "running" | "completed" | "failed" | "cancelled", suffix: string) => {
    const session = await createSession(fixture.app, fixture.workspaceId);
    const runId = newSortableId(`run-${suffix}`);
    createRunRecord(fixture.db, {
      runId,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      status,
      createdAt: Date.now()
    });
    return { session, runId };
  };

  for (const status of ["running", "completed", "failed", "cancelled"] as const) {
    const current = await createRun(status, status);
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/internal/agent/subtask/status",
      headers: { "x-awb-agent-internal-token": fixture.internalToken },
      payload: { workspaceId: fixture.workspaceId, sessionId: current.session.id, runId: current.runId }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { status });
  }

  const assistantPreferred = await createRun("completed", "assistant-preferred");
  const assistantItem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: assistantPreferred.session.id,
    runId: assistantPreferred.runId,
    turnId: "turn_result_priority",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "assistant result" }
  });
  await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: assistantPreferred.session.id,
    runId: assistantPreferred.runId,
    turnId: "turn_result_priority",
    step: 2,
    prevId: assistantItem.item.id,
    kind: "system",
    status: "completed",
    output: { type: "system_text", text: "system fallback" }
  });
  const assistantResult = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: assistantPreferred.session.id, runId: assistantPreferred.runId }
  });
  assert.equal(assistantResult.statusCode, 200);
  assert.deepEqual(assistantResult.json(), { resultText: "assistant result" });

  const systemOnly = await createRun("completed", "system-only");
  const olderSystem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: systemOnly.session.id,
    runId: systemOnly.runId,
    turnId: "turn_result_system",
    step: 1,
    prevId: null,
    kind: "system",
    status: "completed",
    output: { type: "system_text", text: "system result" }
  });
  await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: systemOnly.session.id,
    runId: systemOnly.runId,
    turnId: "turn_result_system",
    step: 2,
    prevId: olderSystem.item.id,
    kind: "system",
    status: "completed",
    output: { type: "system_text", text: "   " }
  });
  const systemResult = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: systemOnly.session.id, runId: systemOnly.runId }
  });
  assert.deepEqual(systemResult.json(), { resultText: "system result" });

  const allBlankSystem = await createRun("completed", "all-blank-system");
  const blankSystem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: allBlankSystem.session.id,
    runId: allBlankSystem.runId,
    turnId: "turn_result_all_blank_system",
    step: 1,
    prevId: null,
    kind: "system",
    status: "completed",
    output: { type: "system_text", text: "" }
  });
  await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: allBlankSystem.session.id,
    runId: allBlankSystem.runId,
    turnId: "turn_result_all_blank_system",
    step: 2,
    prevId: blankSystem.item.id,
    kind: "system",
    status: "completed",
    output: { type: "system_text", text: "\t  " }
  });
  const allBlankSystemResult = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: allBlankSystem.session.id, runId: allBlankSystem.runId }
  });
  assert.deepEqual(allBlankSystemResult.json(), { resultText: "" });

  const blankAssistantWithSystem = await createRun("completed", "blank-assistant-system");
  const blankAssistant = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: blankAssistantWithSystem.session.id,
    runId: blankAssistantWithSystem.runId,
    turnId: "turn_result_blank_assistant_system",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "  " }
  });
  await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: blankAssistantWithSystem.session.id,
    runId: blankAssistantWithSystem.runId,
    turnId: "turn_result_blank_assistant_system",
    step: 2,
    prevId: blankAssistant.item.id,
    kind: "system",
    status: "completed",
    output: { type: "system_text", text: "system after blank assistant" }
  });
  const blankAssistantResult = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: blankAssistantWithSystem.session.id, runId: blankAssistantWithSystem.runId }
  });
  assert.deepEqual(blankAssistantResult.json(), { resultText: "system after blank assistant" });

  const empty = await createRun("running", "empty");
  const emptyResult = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: empty.session.id, runId: empty.runId }
  });
  assert.deepEqual(emptyResult.json(), { resultText: "" });
});

test("failed tool item 可保留 subtask partial result 且 error 不混入 partial 文本", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );
  const session = await createSession(fixture.app, fixture.workspaceId);
  const toolItem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_failed_subtask_tool",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "failed",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_failed_subtask_tool",
      args: { description: "研究问题" },
      text: "tool: subtask\nstatus: failed\n\nsubtask failed",
      result: {
        subtaskSessionId: "sess_subtask_failed",
        resultText: "partial result from subtask"
      },
      error: "subtask failed"
    }
  });

  const single = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(single.output.type, "tool");
  assert.equal(single.status, "failed");
  assert.equal(String(single.output.error || ""), "subtask failed");
  assert.equal(String(single.output.text || "").includes("partial result from subtask"), false);
  assert.equal(
    String((((single.output.result as { resultText?: string } | undefined)?.resultText) || "")),
    "partial result from subtask"
  );
});

test("subtask prefork-plan 在 workspace 全不选时返回 AGENT_DISABLED_IN_WORKSPACE", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );
    setSettingJson(
    fixture.db,
    "workspace_agent_enablement_v1",
    {
      workspaces: {
        [fixture.workspaceId]: {
          mode: "subset",
          enabledAgentIds: [],
          updatedAt: Date.now()
        }
      }
    },
    Date.now()
  );

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "running",
    createdAt: Date.now()
  });
  const subtaskTool = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId,
    turnId: "turn_prefork_no_agent_enabled",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: { type: "tool", toolName: "subtask", toolCallId: "call_prefork_no_agent_enabled", args: { description: "do task", prompt: "do task", agentId: "default", session: { mode: "fork" } } }
  });

  const planRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: parentSession.id,
      parentRunId: runId,
      parentToolItemId: subtaskTool.item.id,
      agentId: "default"
    }
  });
  assert.equal(planRes.statusCode, 400);
  assert.equal((planRes.json() as { code?: string }).code, "AGENT_DISABLED_IN_WORKSPACE");
});

test("subtask start 在 workspace 全不选时返回 AGENT_DISABLED_IN_WORKSPACE", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );
    setSettingJson(
    fixture.db,
    "workspace_agent_enablement_v1",
    {
      workspaces: {
        [fixture.workspaceId]: {
          mode: "subset",
          enabledAgentIds: [],
          updatedAt: Date.now()
        }
      }
    },
    Date.now()
  );

  const parentSession = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const parentUser = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "prepare subtask when no agents enabled" }
  });
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: parentUser.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    uiLocale: null,
    status: "running",
    createdAt: Date.now()
  });
  const subtaskTool = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_no_agent_enabled",
    step: 1,
    prevId: parentUser.item.id,
    kind: "tool",
    status: "queued",
    output: { type: "tool", toolName: "subtask", toolCallId: "call_subtask_no_agent_enabled", args: { description: "do task", prompt: "do task", agentId: "default", session: { mode: "fork" } } }
  });

  const startRes = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/subtask/start", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: { workspaceId: fixture.workspaceId, parentSessionId: parentSession.id, parentRunId: parentRunId, parentToolItemId: subtaskTool.item.id, description: "do task", prompt: "do task", agentId: "default", session: { mode: "fork" } } });
  assert.equal(startRes.statusCode, 400);
  assert.equal((startRes.json() as { code?: string }).code, "AGENT_DISABLED_IN_WORKSPACE");
});
