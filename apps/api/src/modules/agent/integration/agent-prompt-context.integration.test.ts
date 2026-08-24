import { test, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { createRunRecord, getAgentSession, getRunRecord, updateRunState } from "../agent.store.js";
import { newSortableId } from "../../../utils/ids.js";
import { createP4Fixture } from "./p4-fixture.helpers.js";
import { createSession, createContextItemInternal, updateContextItemInternal } from "./context-writeback.helpers.js";
import { createSubtaskSessionForTest, sendMessage } from "./subtask.helpers.js";
import Ajv from "ajv";
import assert from "node:assert/strict";





























function extractPromptSection(system: string, tag: string) {
  const marker = `[${tag}]`;
  const start = system.indexOf(marker);
  if (start < 0) return "";
  const afterMarker = system.indexOf("\n\n", start);
  if (afterMarker < 0) return "";
  const bodyStart = afterMarker + 2;
  const nextSection = system.indexOf("\n\n---\n[", bodyStart);
  if (nextSection < 0) {
    return system.slice(bodyStart).trim();
  }
  return system.slice(bodyStart, nextSection).trim();
}

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

test("agent prompt-context 仅在 agent.tools 显式包含 scratchpad 时暴露该工具", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const hiddenRunId = newSortableId("run");
  await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [{ id: "default", name: "default", summary: "", prompt: "", tools: ["bash", "subtask"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "both", order: 0 }]
    }
  });
  createRunRecord(fixture.db, { runId: hiddenRunId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerItemId: 1, agentId: "default", providerId: "ppchat", uiLocale: "en-US", modelId: "gpt-5.2", subtaskDepth: 0, parentRunId: null, parentToolItemId: null, status: "running", createdAt: Date.now() });
  const hiddenContext = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId: hiddenRunId });
  assert.equal(hiddenContext.tools.some((item) => item.name === "scratchpad"), false);

  const visibleRunId = newSortableId("run");
  const visibleRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [{ id: "default", name: "default", summary: "", prompt: "", tools: ["bash", "scratchpad", "subtask"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "both", order: 0 }]
    }
  });
  assert.equal(visibleRes.statusCode, 200, `update agents failed: ${visibleRes.body}`);
  createRunRecord(fixture.db, { runId: visibleRunId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerItemId: 1, agentId: "default", providerId: "ppchat", uiLocale: "en-US", modelId: "gpt-5.2", subtaskDepth: 0, parentRunId: null, parentToolItemId: null, status: "running", createdAt: Date.now() });
  const visibleContext = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId: visibleRunId });
  const scratchpadTool = visibleContext.tools.find((item) => item.name === "scratchpad");
  assert.ok(scratchpadTool);
  assert.ok(String(scratchpadTool.description || "").includes("Suggested <= 200 characters"));
  assert.equal((scratchpadTool.inputSchema as any)?.properties?.content?.maxLength, 200);
});

test("agent prompt-context 生成 subtask 描述时仅暴露 subtask/both agent", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        { id: "user-only", name: "User Only", summary: "for user", prompt: "", tools: ["bash", "subtask"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "user", order: 0 },
        { id: "subtask-only", name: "Subtask Only", summary: "for subtask", prompt: "", tools: ["bash", "subtask"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "subtask", order: 1 },
        { id: "shared", name: "Shared", summary: "shared", prompt: "", tools: ["bash", "subtask"], pluginTools: [], mcpServers: [], defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" }, scope: "both", order: 2 }
      ]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);

  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerItemId: 1, agentId: "shared", providerId: "ppchat", uiLocale: "en-US", modelId: "gpt-5.2", subtaskDepth: 0, status: "running", createdAt: Date.now()
  });

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const subtaskTool = promptContext.tools.find((item) => item.name === "subtask");
  assert.ok(subtaskTool, "subtask tool should exist");
  const description = String((subtaskTool as { description?: string } | undefined)?.description || "");
  assert.equal(description.includes("user-only"), false, "user-only agent should be hidden from subtask description");
  assert.equal(description.includes("subtask-only"), true, "subtask-only agent should be visible");
  assert.equal(description.includes("shared"), true, "shared agent should be visible");
});

test("agent prompt-context 中的工具描述与 schema 说明使用英文", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
            id: "default",
             name: "default",
             summary: "",
            prompt: "",
             tools: ["bash", "read", "scratchpad", "subtask", "todolist", "apply_patch"],
             pluginTools: [],
             mcpServers: [],
             defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
            scope: "both",
            order: 0
         }
       ]
     }
   });
  assert.equal(agentsRes.statusCode, 200, `update agents failed: ${agentsRes.body}`);
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "zh-CN",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });
  const promptContext = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId });
  const bashTool = promptContext.tools.find((item) => item.name === "bash");
  const readTool = promptContext.tools.find((item) => item.name === "read");
  const subtaskTool = promptContext.tools.find((item) => item.name === "subtask");
  const todolistTool = promptContext.tools.find((item) => item.name === "todolist");
  const scratchpadTool = promptContext.tools.find((item) => item.name === "scratchpad");
  const skillTool = promptContext.tools.find((item) => item.name === "skill");
  const applyPatchTool = promptContext.tools.find((item) => item.name === "apply_patch");
  assert.ok(String(bashTool?.description || "").includes("Run a bash command and return stdout/stderr."));
  assert.ok(String((bashTool?.inputSchema as any)?.properties?.timeout?.description || "").includes("Timeout in seconds"));
  const readLimit = (readTool?.inputSchema as any)?.properties?.limit;
  assert.equal(readLimit?.default, 500);
  assert.equal(readLimit?.maximum, 2000);
  assert.ok(String(readLimit?.description || "").includes("Default: 500"));
  assert.ok(String(readLimit?.description || "").includes("Maximum: 2000"));
  assert.ok(String(subtaskTool?.description || "").includes("Available agents:"));
  assert.equal(String(subtaskTool?.description || "").includes("可选Agent"), false);
  assert.ok(String(todolistTool?.description || "").includes("Example input:"));
  assert.ok(String(scratchpadTool?.description || "").includes("Suggested <= 200 characters"));
  assert.equal((scratchpadTool?.inputSchema as any)?.properties?.content?.maxLength, 200);
  assert.ok(String(skillTool?.description || "").includes("stable logical identifier"));
  assert.ok(String(skillTool?.description || "").includes("skillId"));
  assert.ok(String(skillTool?.description || "").includes("filePath"));
  const skillProperties = (skillTool?.inputSchema as any)?.properties;
  assert.deepEqual((skillTool?.inputSchema as any)?.required, ["skillId"]);
  assert.deepEqual(Object.keys(skillProperties || {}).sort(), ["filePath", "skillId"]);
  assert.equal(skillProperties?.id, undefined);
  assert.equal(skillProperties?.skill, undefined);
  assert.equal(skillProperties?.path, undefined);
  assert.equal(skillProperties?.skill_id, undefined);
  assert.equal(skillProperties?.file_path, undefined);
  assert.equal(skillProperties?.skillId?.minLength, undefined);
  assert.ok(String(skillProperties?.skillId?.description || "").includes("Stable logical skill identifier"));
  assert.ok(String(skillProperties?.filePath?.description || "").includes("spaces/tabs"));
  const validateSkillArgs = new Ajv({ allErrors: true, strict: false }).compile(skillTool?.inputSchema as Record<string, unknown>);
  assert.equal(validateSkillArgs({ skillId: "builtin/skill-authoring" }), true);
  assert.equal(validateSkillArgs({ skillId: "builtin/skill-authoring", filePath: "reference.md" }), true);
  for (const legacyPayload of [
    { id: "builtin/skill-authoring" },
    { skill: "builtin/skill-authoring" },
    { skill: "builtin/skill-authoring", path: "reference.md" },
    { skill_id: "builtin/skill-authoring" },
    { skill_id: "builtin/skill-authoring", file_path: "reference.md" },
    { skillId: "builtin/skill-authoring", path: "reference.md" },
    { skillId: "builtin/skill-authoring", file_path: "reference.md" },
    { skillId: "builtin/skill-authoring", skill_id: "builtin/skill-authoring" },
    { skillId: "builtin/skill-authoring", id: "builtin/skill-authoring" }
  ]) {
    assert.equal(validateSkillArgs(legacyPayload), false, `legacy payload must fail schema validation: ${JSON.stringify(legacyPayload)}`);
    assert.ok(
      validateSkillArgs.errors?.some((error) => error.keyword === "required" || error.keyword === "additionalProperties"),
      `legacy payload should fail required/additional-property validation: ${JSON.stringify(legacyPayload)}`
    );
  }
  assert.equal(String(todolistTool?.description || "").includes("完成 todolist goal 增强"), false);
  assert.equal(String(todolistTool?.description || "").includes("梳理需求与约束"), false);
  assert.ok(
    String((applyPatchTool?.inputSchema as any)?.properties?.patchText?.description || "").includes(
      "patchText must be a git unified diff text"
    )
  );
  const sessionSchema = (subtaskTool?.inputSchema as any)?.properties?.session;
  const subtaskDescriptionSchema = (subtaskTool?.inputSchema as any)?.properties?.description;
  const subtaskPromptSchema = (subtaskTool?.inputSchema as any)?.properties?.prompt;
  const subtaskAgentIdSchema = (subtaskTool?.inputSchema as any)?.properties?.agentId;
  assert.equal(subtaskDescriptionSchema?.minLength, 1);
  assert.equal(subtaskDescriptionSchema?.maxLength, undefined);
  assert.ok(String(subtaskDescriptionSchema?.description || "").includes("Longer values will be truncated to 50 characters."));
  assert.ok(String(subtaskPromptSchema?.description || "").includes("goal, scope or constraints, and deliverable boundary"));
  assert.ok(String(subtaskAgentIdSchema?.description || "").includes("assignee role template"));
  assert.ok(String(subtaskAgentIdSchema?.description || "").includes("not a specific assignee instance"));
  assert.ok(String(sessionSchema?.description || "").includes("background context or reuses prior session memory"));

  const oneOf = Array.isArray(sessionSchema?.oneOf) ? sessionSchema.oneOf : [];
  assert.ok(oneOf.length >= 3, "subtask.session.oneOf should contain multiple options");
  const newOption = oneOf.find((item: any) => item?.properties?.mode?.const === "new");
  const existingOption = oneOf.find((item: any) => item?.properties?.mode?.const === "existing");
  const forkOption = oneOf.find((item: any) => item?.properties?.mode?.const === "fork");
  assert.equal(
    oneOf.every((item: any) => typeof item?.description === "string" && !/[\u4e00-\u9fff]/.test(item.description)),
    true,
    "subtask.session.oneOf descriptions should be English"
  );
  assert.ok(String(newOption?.description || "").includes("no parent-session or prior subtask background"));
  assert.ok(String(existingOption?.description || "").includes("follow-up research"));
  assert.ok(String(existingOption?.properties?.sessionId?.description || "").includes("existing subtask session ID"));
  assert.ok(String(forkOption?.description || "").includes("full current parent-session history"));
  const subtaskDescription = String(subtaskTool?.description || "");
  assert.ok(subtaskDescription.includes("Recommended use cases:"));
  assert.ok(subtaskDescription.includes("Preserve parent-session context quality"));
  assert.ok(subtaskDescription.includes("Focus on results instead of process"));
  assert.ok(subtaskDescription.includes("Divide complex work"));
  assert.ok(subtaskDescription.includes("Usage guidance:"));
  assert.ok(subtaskDescription.includes("multiple independent tasks"));
  assert.ok(subtaskDescription.includes("implementation and code review cannot be delegated in parallel"));
  assert.ok(subtaskDescription.includes("prefer fork so the user's intent can be passed"));
  assert.ok(subtaskDescription.includes("full parent-session context"));
  assert.ok(subtaskDescription.includes("todolists"));
  assert.ok(subtaskDescription.includes("same agentId"));
  assert.ok(subtaskDescription.includes("same existing sessionId"));
  assert.ok(subtaskDescription.includes("fails after a session ID has already been created"));
  assert.ok(subtaskDescription.includes("succeeds but returns no summary"));
});

test("agent prompt-context 根据 run uiLocale 注入语言与时间运行时约束", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    payload: {
      workspaceId: fixture.workspaceId,
      text: "hello",
      clientRequestId: "req_locale_prompt",
      uiLocale: "en-US"
    }
  });
  assert.equal(res.statusCode, 201, `send message failed: ${res.body}`);
  const body = res.json() as { runId: string };

  const runRecord = getRunRecord(fixture.db, body.runId);
  assert.ok(runRecord, "run record should exist");
  assert.equal(runRecord?.uiLocale, "en-US");

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: body.runId
  });
  const outputSection = extractPromptSection(prompt.system, "output_format_instructions");
  const runtimeSection = extractPromptSection(prompt.system, "runtime_constraints");

  assert.ok(prompt.system.includes("[output_format_instructions]"), "system should include output format instructions section");
  assert.ok(prompt.system.includes("[runtime_constraints]"), "system should include runtime constraints section");
  assert.equal(prompt.system.includes("## Runtime Constraints"), false, "system should not include legacy runtime constraints heading");
  assert.ok(outputSection.includes("Output format requirements:"));
  assert.ok(runtimeSection.includes("Language requirement: use English consistently for this run."));
  assert.ok(runtimeSection.includes("If you call todolist, the goal and todos[].content must also be in English."));
  assert.equal(runtimeSection.includes("Current system time:"), false);
  assert.equal(runtimeSection.includes("Time zone:"), false);
  assert.equal(outputSection.includes("Completion constraints:"), false, "output format instructions should not contain completion constraints");
});

test("agent prompt-context 在 zh-CN locale 下使用中文 output/runtime sections 且完成判定约束只在 runtime_constraints 中", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "running",
    createdAt: Date.now()
  });

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const outputSection = extractPromptSection(prompt.system, "output_format_instructions");
  const runtimeSection = extractPromptSection(prompt.system, "runtime_constraints");

  assert.ok(outputSection.includes("输出格式要求："));
  assert.ok(runtimeSection.includes("语言要求：本轮对话请统一使用简体中文。"));
  assert.equal(runtimeSection.includes("当前系统时间："), false);
  assert.equal(runtimeSection.includes("当前时区："), false);
  assert.equal(outputSection.includes("完成判定约束："), false, "output format instructions should not contain completion constraints");
});

test("agent prompt-context 在缺省 locale 下使用 locale-neutral 英文 output/runtime sections 且不附加语言要求", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const msg = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hi",
    clientRequestId: "req_locale_null_prompt"
  });

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: msg.runId
  });
  const outputSection = extractPromptSection(prompt.system, "output_format_instructions");
  const runtimeSection = extractPromptSection(prompt.system, "runtime_constraints");

  assert.ok(outputSection.includes("Output format requirements:"));
  assert.equal(runtimeSection.includes("Current system time:"), false);
  assert.equal(runtimeSection.includes("Time zone:"), false);
  assert.equal(runtimeSection.includes("Language requirement: use English consistently for this run."), false, "null locale should not add English language requirement");
  assert.equal(outputSection.includes("输出格式要求："), false, "null locale should not mix Chinese output instruction text");
});

test("agent prompt-context 对 store 中非法 uiLocale 回退为 locale-neutral 英文，避免中英混用", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "fr-FR" as any,
    status: "running",
    createdAt: Date.now()
  });

  const runRecord = getRunRecord(fixture.db, runId);
  assert.ok(runRecord, "run record should exist");
  assert.equal(runRecord?.uiLocale, null, "run mapper should fail closed for invalid locale data");

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const outputSection = extractPromptSection(prompt.system, "output_format_instructions");
  const runtimeSection = extractPromptSection(prompt.system, "runtime_constraints");

  assert.ok(outputSection.includes("Output format requirements:"));
  assert.equal(outputSection.includes("输出格式要求："), false, "invalid locale fallback should not use Chinese output text");
  assert.equal(runtimeSection.includes("语言要求：本轮对话请统一使用简体中文。"), false, "invalid locale fallback should not use Chinese runtime text");
});

test("agent prompt-context 在当前 run uiLocale 为空时回退到当前 session 最近 run 的 uiLocale", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "completed",
    createdAt: Date.now() - 20_000
  });
  const targetRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: targetRunId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "running",
    createdAt: Date.now() - 10_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "en-US",
    status: "completed",
    createdAt: Date.now()
  });

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: targetRunId
  });
  const runtimeSection = extractPromptSection(prompt.system, "runtime_constraints");

  assert.equal(prompt.uiLocale, "en-US");
  assert.ok(runtimeSection.includes("Language requirement: use English consistently for this run."));
});

test("agent prompt-context 在当前 session 无可用 locale 时回退到全局最近 run 的 uiLocale", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const targetSession = await createSession(fixture.app, fixture.workspaceId);
  const otherSession = await createSession(fixture.app, fixture.workspaceId);

  const targetRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: targetRunId,
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "running",
    createdAt: Date.now() - 20_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: otherSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "completed",
    createdAt: Date.now()
  });

  const prompt = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id,
    runId: targetRunId
  });
  const runtimeSection = extractPromptSection(prompt.system, "runtime_constraints");

  assert.equal(prompt.uiLocale, "zh-CN");
  assert.ok(runtimeSection.includes("语言要求：本轮对话请统一使用简体中文。"));
});

test("agent prompt-context 在 depth 达到上限时隐藏 subtask 工具", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

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

  const session = createSubtaskSessionForTest(fixture);

  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "en-US",
    modelId: "gpt-5.2",
    subtaskDepth: 1,
    status: "running",
    createdAt: Date.now()
  });

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const toolNames = promptContext.tools.map((item) => item.name);
  assert.equal(toolNames.includes("subtask"), false, "subtask tool should be hidden at the configured depth limit");
  assert.equal(toolNames.includes("bash"), true, "other enabled tools should remain visible");
});

test("agent prompt-context 在 depth=1、max=2 的 subtask run 中保留 subtask 工具", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const settingsRes = await fixture.app.inject({ method: "PUT", url: "/api/settings/agent/runtime", payload: { maxSubtaskDepth: 2 } });
  assert.equal(settingsRes.statusCode, 200, settingsRes.body);
  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [{
        id: "default",
        name: "default",
        summary: "",
        prompt: "",
        tools: ["bash", "subtask"],
        pluginTools: [],
        mcpServers: [],
        defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
        scope: "both",
        order: 0
      }]
    }
  });
  assert.equal(agentsRes.statusCode, 200, agentsRes.body);
  const session = createSubtaskSessionForTest(fixture, { title: "nested" });
  const sessionId = session.id;
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 1,
    parentRunId: newSortableId("run"),
    parentToolItemId: 1,
    status: "running",
    createdAt: Date.now()
  });
  const context = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId, runId });
  assert.equal(context.tools.some((item) => item.name === "subtask"), true);
});

test("agent prompt-context 对 primary 会话保留 subtask 工具", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

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

  const primarySession = await createSession(fixture.app, fixture.workspaceId);
  const seedRunId = newSortableId("run");
  const seedUser = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: primarySession.id,
    runId: seedRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "primary 会话内容" }
  });
  const forkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: {
      fromSessionId: primarySession.id,
      fromItemId: seedUser.item.id,
      mode: "with_archive"
    }
  });
  assert.equal(forkRes.statusCode, 201, `fork primary session failed: ${forkRes.body}`);
  const forkedPrimary = forkRes.json() as { id: string };

  for (const sessionId of [primarySession.id, forkedPrimary.id]) {
    const runId = newSortableId("run");
    createRunRecord(fixture.db, {
      runId,
      workspaceId: fixture.workspaceId,
      sessionId,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      modelId: "gpt-5.2",
      subtaskDepth: 0,
      status: "running",
      createdAt: Date.now()
    });
    const promptContext = await getPromptContextInternal({
      app: fixture.app,
      internalToken: fixture.internalToken,
      workspaceId: fixture.workspaceId,
      sessionId,
      runId
    });
    assert.equal(promptContext.tools.some((tool) => tool.name === "subtask"), true, "primary session should keep subtask tool");
  }
});

test("agent prompt-context 使用结构化 tool-call/tool-result 消息", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
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
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "测试结构化工具调用"
    }
  });

  const assistantToolCall = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_structured",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "我先写文件"
    }
  });

  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_structured",
    step: 1,
    prevId: assistantToolCall.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "write",
      toolCallId: "call_write_1",
      args: {
        filePath: "tool_test.txt",
        content: "hello"
      },
      result: {
        summary: "Wrote file tool_test.txt",
        content: "ok"
      }
    }
  });

  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_after",
    step: 2,
    prevId: toolItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "写入成功,准备继续"
    }
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const assistantWithToolCall = context.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string }).type === "tool-call";
    });
  });
  assert.ok(assistantWithToolCall, "assistant message should include tool-call part");

  const toolResultMessage = context.messages.find((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string }).type === "tool-result";
    });
  });
  assert.ok(toolResultMessage, "tool message should include tool-result part");

  const toolResultPart = Array.isArray(toolResultMessage?.content)
    ? toolResultMessage.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string }).type === "tool-result";
      })
    : null;
  assert.ok(toolResultPart && typeof toolResultPart === "object", "tool-result part should exist");
  assert.equal(
    String((toolResultPart as { output?: { type?: string } }).output?.type || ""),
    "text",
    "tool-result output should be ai-sdk structured output"
  );
});

test("agent prompt-context 对 apply_patch 保留 patchText 输入,并使用文本结果", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
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
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "请应用补丁"
    }
  });

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_apply_patch",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "开始应用补丁"
    }
  });

  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_apply_patch",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_1",
      args: {
        patchText: "*** Begin Patch\n*** Update File: foo.ts\n@@\n-console.log('a')\n+console.log('b')\n*** End Patch"
      },
      text: "apply_patch queued"
    }
  });

  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  await updateContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: toolItem.item.id,
    status: "completed",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch_1",
      args: {
        patchText: "*** Begin Patch\n*** Update File: foo.ts\n@@\n-console.log('a')\n+console.log('b')\n*** End Patch"
      },
      result: {
        text: "Success. Updated the following files:\nM foo.ts",
        summary: {
          fileCount: 1,
          additions: 1,
          deletions: 1
        },
        files: [
          {
            type: "update",
            path: "foo.ts",
            before: "console.log('a')\n",
            after: "console.log('b')\n",
            additions: 1,
            deletions: 1
          }
        ]
      },
      text: "Success. Updated the following files:\nM foo.ts"
    }
  });

  const storedTool = await getContextItem(fixture.app, session.id, toolItem.item.id);
  const storedResult = (storedTool.output?.result ?? {}) as Record<string, unknown>;
  const storedFiles = Array.isArray(storedResult.files) ? storedResult.files : [];
  const first = (storedFiles[0] ?? {}) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(first, "before"), false, "DB apply_patch result should strip before");
  assert.equal(Object.prototype.hasOwnProperty.call(first, "after"), false, "DB apply_patch result should strip after");

  const artifactRes = await fixture.app.inject({
    method: "GET",
    url: `/api/agent/sessions/${session.id}/context-items/${toolItem.item.id}/apply-patch-artifact`
  });
  assert.equal(artifactRes.statusCode, 200, `apply_patch artifact fetch failed: ${artifactRes.body}`);
  const artifact = artifactRes.json() as { files?: Array<Record<string, unknown>> };
  const artifactFiles = Array.isArray(artifact.files) ? artifact.files : [];
  const artifactFirst = artifactFiles[0] ?? {};
  assert.equal(typeof artifactFirst.before, "string");
  assert.equal(typeof artifactFirst.after, "string");

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const assistantWithToolCall = context.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string }).type === "tool-call";
    });
  });
  assert.ok(assistantWithToolCall, "assistant message should include tool-call part");

  const toolCallPart = Array.isArray(assistantWithToolCall?.content)
    ? assistantWithToolCall.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "apply_patch";
      })
    : null;
  assert.ok(toolCallPart && typeof toolCallPart === "object", "apply_patch tool-call should exist");
  assert.equal(
    typeof (toolCallPart as { input?: { patchText?: unknown } }).input?.patchText,
    "string",
    "apply_patch tool-call input should keep patchText"
  );

  const toolResultMessage = context.messages.find((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-result" &&
        (part as { toolName?: string }).toolName === "apply_patch";
    });
  });
  assert.ok(toolResultMessage, "tool message should include apply_patch tool-result part");

  const toolResultPart = Array.isArray(toolResultMessage?.content)
    ? toolResultMessage.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-result" &&
          (part as { toolName?: string }).toolName === "apply_patch";
      })
    : null;
  assert.ok(toolResultPart && typeof toolResultPart === "object", "apply_patch tool-result part should exist");

  const output = (toolResultPart as { output?: { type?: string; value?: string } }).output;
  assert.equal(String(output?.type || ""), "text");
  assert.equal(String(output?.value || "").includes("Success. Updated the following files"), true);
});

test("agent prompt-context 支持 todolist 工具输入输出", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
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
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "请维护任务清单"
    }
  });

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "更新任务清单"
    }
  });

  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "todolist",
      toolCallId: "call_todolist_1",
      args: {
        goal: "完成 todolist goal 增强与展示",
        todos: [
          { content: "梳理需求", status: "completed" },
          { content: "实现功能", status: "in_progress" }
        ]
      },
      result: {
        goal: "完成 todolist goal 增强与展示",
        summary: {
          total: 2,
          pending: 0,
          inProgress: 1,
          completed: 1,
          cancelled: 0
        },
        todos: [
          { content: "梳理需求", status: "completed" },
          { content: "实现功能", status: "in_progress" }
        ]
      },
      text: "Todo list updated: total=2"
    }
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const assistantWithToolCall = context.messages.find((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-call" &&
        (part as { toolName?: string }).toolName === "todolist";
    });
  });
  assert.ok(assistantWithToolCall, "assistant message should include todolist tool-call part");

  const toolCallPart = Array.isArray(assistantWithToolCall?.content)
    ? assistantWithToolCall.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-call" &&
          (part as { toolName?: string }).toolName === "todolist";
      })
    : null;
  const input = (toolCallPart as { input?: Record<string, unknown> } | null)?.input ?? {};
  assert.equal(String(input.goal || ""), "完成 todolist goal 增强与展示");
  assert.equal(Array.isArray(input.todos), true, "todolist tool-call input should include todos");

  const toolResultMessage = context.messages.find((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { type?: string; toolName?: string }).type === "tool-result" &&
        (part as { toolName?: string }).toolName === "todolist";
    });
  });
  assert.ok(toolResultMessage, "tool message should include todolist tool-result part");

  const toolResultPart = Array.isArray(toolResultMessage?.content)
    ? toolResultMessage.content.find((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { type?: string; toolName?: string }).type === "tool-result" &&
          (part as { toolName?: string }).toolName === "todolist";
      })
    : null;
  const output = (toolResultPart as { output?: { type?: string; value?: string } } | null)?.output;
  assert.equal(String(output?.type || ""), "text", "todolist tool-result output should be text");
  assert.equal(String(output?.value || "").includes("Todo list updated"), true, "todolist tool-result should be summary text");

  const updatedSession = getAgentSession(fixture.db, session.id);
  assert.ok(updatedSession, "updated session should exist");
  assert.equal(updatedSession?.title, "完成 todolist goal 增强与展示");
});

test("agent prompt-context: todolist goal 超长时自动截断并更新 session title", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const longGoal = "这是一个非常长的 todolist goal，用来验证超过五十个字符后会被自动截断而不是直接报错失败，需要继续追加更多文字";
  const normalizedGoal = "这是一个非常长的 todolist goal，用来验证超过五十个字符后会被自动截断而不是直接报错失…";
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
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "请维护任务清单" }
  });

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist_goal_truncate",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "更新任务清单" }
  });

  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist_goal_truncate",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "todolist",
      toolCallId: "call_todolist_goal_truncate",
      args: { goal: longGoal, todos: [{ content: "实现功能", status: "in_progress" }] },
      result: { goal: longGoal, summary: { total: 1, pending: 0, inProgress: 1, completed: 0, cancelled: 0 }, todos: [{ content: "实现功能", status: "in_progress" }] }
    }
  });

  const updatedSession = getAgentSession(fixture.db, session.id);
  assert.ok(updatedSession, "updated session should exist");
  assert.equal(updatedSession?.title, normalizedGoal);
});

test("agent prompt-context: todolist goal 为空白时不更新 session title", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerItemId: 1, agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", status: "running", createdAt
  });

  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_todolist_goal_blank",
    step: 1,
    prevId: null,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "todolist",
      toolCallId: "call_todolist_goal_blank",
      args: { goal: "   ", todos: [{ content: "实现功能", status: "in_progress" }] },
      result: { goal: "   ", summary: { total: 1, pending: 0, inProgress: 1, completed: 0, cancelled: 0 }, todos: [{ content: "实现功能", status: "in_progress" }] }
    }
  });

  const updatedSession = getAgentSession(fixture.db, session.id);
  assert.ok(updatedSession, "updated session should exist");
  assert.equal(updatedSession?.title, "it-session");
});
