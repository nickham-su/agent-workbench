import { test, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../../app/createApp.js";
import { openDb } from "../../../infra/db/db.js";
import { ensureDir, rmrf } from "../../../infra/fs/fs.js";
import { workspaceRepoDirPath } from "../../../infra/fs/paths.js";
import { getSettingJson, setSettingJson } from "../../settings/settings.store.js";
import { insertWorkspaceRepo } from "../../workspaces/workspace.store.js";
import { insertRepo } from "../../repos/repo.store.js";
import { createRunRecord } from "../agent.store.js";
import { newSortableId } from "../../../utils/ids.js";
import { createP4Fixture } from "./p4-fixture.helpers.js";
import { createSession } from "./context-writeback.helpers.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";





























function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

test("agent settings 兼容缺省 globalPromptIds", async (t: TestContext) => {
  const fixture = await createP4Fixture(t);
  const res = await fixture.app.inject({
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
          mcpServers: [],
          defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
          scope: "both",
          order: 0
        }
      ]
    }
  });
  assert.equal(res.statusCode, 200, `update agent settings failed: ${res.body}`);
  const body = res.json() as { agents: Array<{ globalPromptIds?: string[] }> };
  assert.deepEqual(body.agents[0]?.globalPromptIds ?? [], []);
});

test("agent global prompts 保存选择指令后展开提示词内容配置", async (t: TestContext) => {
  const fixture = await createP4Fixture(t);
  const res = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        {
          id: "global_system_prompt",
          title: "ignored",
          prompt: "SYSTEM",
          command: "system-command",
          expandOnSelect: true
        },
        {
          id: "gp_expand",
          title: "Expand",
          prompt: "EXPAND_PROMPT",
          command: "expand",
          expandOnSelect: true
        },
        {
          id: "gp_disabled",
          title: "Disabled",
          prompt: "DISABLED_PROMPT",
          command: "disabled",
          expandOnSelect: false
        },
        {
          id: "gp_without_command",
          title: "Without command",
          prompt: "WITHOUT_COMMAND_PROMPT",
          expandOnSelect: true
        }
      ]
    }
  });
  assert.equal(res.statusCode, 200, `update global prompts failed: ${res.body}`);

  const items = (res.json() as {
    items: Array<{ id: string; command?: string; expandOnSelect?: boolean }>;
  }).items;
  assert.deepEqual(items.find((item) => item.id === "gp_expand"), {
    id: "gp_expand",
    title: "Expand",
    prompt: "EXPAND_PROMPT",
    command: "expand",
    expandOnSelect: true
  });
  assert.equal(items.find((item) => item.id === "gp_disabled")?.expandOnSelect, undefined);
  assert.equal(items.find((item) => item.id === "gp_without_command")?.expandOnSelect, undefined);
  assert.equal(items.find((item) => item.id === "gp_without_command")?.command, undefined);
  assert.equal(items.find((item) => item.id === "global_system_prompt")?.expandOnSelect, undefined);
  assert.equal(items.find((item) => item.id === "global_system_prompt")?.command, undefined);

  const getRes = await fixture.app.inject({
    method: "GET",
    url: "/api/settings/agent/global-prompts"
  });
  assert.equal(getRes.statusCode, 200, `get global prompts failed: ${getRes.body}`);
  const getItems = (getRes.json() as {
    items: Array<{ id: string; command?: string; expandOnSelect?: boolean }>;
  }).items;
  assert.equal(getItems.find((item) => item.id === "gp_expand")?.expandOnSelect, true);
  assert.equal(getItems.find((item) => item.id === "gp_disabled")?.expandOnSelect, undefined);
});

test("agent global prompts 拒绝非布尔的选择展开配置", async (t: TestContext) => {
  const fixture = await createP4Fixture(t);
  for (const expandOnSelect of ["true", 1]) {
    const res = await fixture.app.inject({
      method: "PUT",
      url: "/api/settings/agent/global-prompts",
      payload: {
        items: [
          { id: "global_system_prompt", title: "ignored", prompt: "SYSTEM" },
          { id: "gp_invalid", title: "Invalid", prompt: "PROMPT", command: "invalid", expandOnSelect }
        ]
      }
    });
    assert.equal(res.statusCode, 400, `invalid expand-on-select should fail: ${res.body}`);
  }
});

test("agent global prompts 归一化历史选择展开配置且不重写缺失字段", async (t: TestContext) => {
  const legacyUpdatedAt = 123;
  const legacyFixture = await createP4Fixture(t, {
    agentGlobalPromptsStored: {
      items: [
        { id: "global_system_prompt", title: "Global System Prompt", prompt: "SYSTEM" },
        { id: "gp_legacy", title: "Legacy", prompt: "LEGACY", command: "legacy" }
      ]
    },
    agentGlobalPromptsUpdatedAt: legacyUpdatedAt
  });
  assert.equal(
    getSettingJson(legacyFixture.db, "agent_global_prompts_v1")?.updatedAt,
    legacyUpdatedAt,
    "missing expandOnSelect should not trigger a settings rewrite"
  );

  const fixture = await createP4Fixture(t, {
    agentGlobalPromptsStored: {
      items: [
        {
          id: "global_system_prompt",
          title: "Global System Prompt",
          prompt: "SYSTEM",
          expandOnSelect: true
        },
        { id: "gp_enabled", title: "Enabled", prompt: "ENABLED", command: "enabled", expandOnSelect: true },
        { id: "gp_false", title: "False", prompt: "FALSE", command: "false", expandOnSelect: false },
        { id: "gp_invalid", title: "Invalid", prompt: "INVALID", command: "invalid", expandOnSelect: "true" },
        { id: "gp_no_command", title: "No command", prompt: "NO_COMMAND", expandOnSelect: true }
      ]
    },
    agentGlobalPromptsUpdatedAt: legacyUpdatedAt
  });

  const stored = getSettingJson(fixture.db, "agent_global_prompts_v1");
  assert.ok(stored, "normalized settings should be stored");
  assert.ok(stored.updatedAt > legacyUpdatedAt, "invalid historical values should be normalized and persisted");
  const storedItems = (stored?.value as { items: Array<{ id: string; command?: string; expandOnSelect?: boolean }> }).items;
  assert.equal(storedItems.find((item) => item.id === "gp_enabled")?.expandOnSelect, true);
  assert.equal(storedItems.find((item) => item.id === "gp_false")?.expandOnSelect, undefined);
  assert.equal(storedItems.find((item) => item.id === "gp_invalid")?.expandOnSelect, undefined);
  assert.equal(storedItems.find((item) => item.id === "gp_no_command")?.expandOnSelect, undefined);
});

test("agent prompt-context 全局提示词按列表顺序注入(方案A)", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  const initialGlobalPrompts = await fixture.app.inject({
    method: "GET",
    url: "/api/settings/agent/global-prompts"
  });
  assert.equal(initialGlobalPrompts.statusCode, 200, `get global prompts failed: ${initialGlobalPrompts.body}`);
  const seededItems = (initialGlobalPrompts.json() as { items: Array<{ id: string; title: string; prompt: string }> }).items;
  const seededSystemPrompt = seededItems.find((item) => item.id === "global_system_prompt");
  assert.ok(seededSystemPrompt, "seeded global system prompt should exist");
  assert.equal(seededSystemPrompt?.title, "Global System Prompt");
  assert.ok(String(seededSystemPrompt?.prompt || "").trim().length > 0, "seeded global system prompt should be non-empty");

  const globalPromptsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "global_system_prompt", title: "ignored", prompt: "CUSTOM_SYSTEM_BASE" },
        { id: "gp_a", title: "A", prompt: "PROMPT_A" },
        { id: "gp_b", title: "B", prompt: "PROMPT_B" }
      ]
    }
  });
  assert.equal(globalPromptsRes.statusCode, 200, `update global prompts failed: ${globalPromptsRes.body}`);
  const updatedItems = (globalPromptsRes.json() as { items: Array<{ id: string; title: string; prompt: string }> }).items;
  assert.equal(updatedItems.find((item) => item.id === "global_system_prompt")?.title, "Global System Prompt");

  const omitSystemPromptRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "gp_a", title: "A", prompt: "PROMPT_A" },
        { id: "gp_b", title: "B", prompt: "PROMPT_B" }
      ]
    }
  });
  assert.equal(omitSystemPromptRes.statusCode, 200, `update global prompts failed: ${omitSystemPromptRes.body}`);
  const omitSystemPromptItems = (omitSystemPromptRes.json() as { items: Array<{ id: string; title: string; prompt: string }> }).items;
  assert.equal(omitSystemPromptItems.filter((item) => item.id === "global_system_prompt").length, 1);
  assert.equal(omitSystemPromptItems.find((item) => item.id === "global_system_prompt")?.prompt, "CUSTOM_SYSTEM_BASE");

  const emptySystemPromptRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "global_system_prompt", title: "whatever", prompt: "   " }
      ]
    }
  });
  assert.equal(emptySystemPromptRes.statusCode, 400, `empty system prompt should be rejected: ${emptySystemPromptRes.body}`);

  const emptyPromptRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "global_system_prompt", title: "whatever", prompt: "CUSTOM_SYSTEM_BASE" },
        { id: "gp_empty", title: "Empty", prompt: "   " }
      ]
    }
  });
  assert.equal(emptyPromptRes.statusCode, 400, `empty prompt should be rejected: ${emptyPromptRes.body}`);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "AGENT_PROMPT",
          globalPromptIds: ["global_system_prompt", "gp_b", "gp_a"],
          tools: ["bash", "read", "write"],
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
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const idxA = context.system.indexOf("PROMPT_A");
  const idxB = context.system.indexOf("PROMPT_B");
  const idxAgent = context.system.indexOf("AGENT_PROMPT");
  const idxCore = context.system.indexOf("CUSTOM_SYSTEM_BASE");
  assert.ok(idxA >= 0, "system should include PROMPT_A");
  assert.ok(idxB >= 0, "system should include PROMPT_B");
  assert.ok(idxAgent >= 0, "system should include AGENT_PROMPT");
  assert.ok(idxCore >= 0, "system should include global workflow prompt");
  assert.ok(idxCore < idxA, "global workflow prompt should be prepended before global prompts");
  assert.ok(idxA < idxB, "global prompts should follow global list order, not selected id order");
  assert.equal((context.system.match(/CUSTOM_SYSTEM_BASE/g) || []).length, 1, "system prompt base should only appear once");
  assert.ok(idxB < idxAgent, "agent prompt should be appended after global prompts");
});

test("agent prompt-context 同时存在 global/workspace/agent 时按既定顺序拼接", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  await fs.writeFile(path.join(fixture.workspacePath, "AGENTS.md"), "WORKSPACE_RULE", "utf-8");
  setSettingJson(fixture.db, "workspace_agents_instructions_v1", {
    workspaces: {
      [fixture.workspaceId]: {
        enabledSources: [{ sourceType: "workspace", enabledAt: Date.now() }],
        updatedAt: Date.now()
      }
    }
  }, Date.now());

  const globalPromptsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/global-prompts",
    payload: {
      items: [
        { id: "gp_a", title: "A", prompt: "PROMPT_A" },
        { id: "gp_b", title: "B", prompt: "PROMPT_B" }
      ]
    }
  });
  assert.equal(globalPromptsRes.statusCode, 200, `update global prompts failed: ${globalPromptsRes.body}`);

  const agentsRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [
        {
          id: "default",
          name: "default",
          summary: "",
          prompt: "AGENT_PROMPT",
          globalPromptIds: ["gp_b", "gp_a"],
          tools: ["bash", "read", "write"],
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
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  const idxCore = context.system.indexOf("# 工作方式与流程(全局)");
  const idxA = context.system.indexOf("PROMPT_A");
  const idxB = context.system.indexOf("PROMPT_B");
  const idxOutput = context.system.indexOf("[output_format_instructions]");
  const idxRuntime = context.system.indexOf("[runtime_constraints]");
  const idxSystemBaseTag = context.system.indexOf("[system_base]");
  const idxATag = context.system.indexOf("[global_prompt] A");
  const idxBTag = context.system.indexOf("[global_prompt] B");
  const idxWorkspace = context.system.indexOf("[agents_instructions] AGENTS.md");
  const idxAgentTag = context.system.indexOf("[agent_prompt] default");
  const idxAgent = context.system.indexOf("AGENT_PROMPT");

  assert.equal(context.system.includes("## Global Prompt:"), false, "system should not include legacy global prompt headings");
  assert.equal(context.system.includes("## Workspace Instructions:"), false, "system should not include legacy workspace headings");
  assert.equal(context.system.includes("## Agent Prompt:"), false, "system should not include legacy agent headings");
  assert.equal(context.system.includes("## Runtime Constraints"), false, "system should not include legacy runtime heading");
  assert.ok(idxSystemBaseTag >= 0, "system should include system base section tag");
  assert.ok(idxATag >= 0, "system should include global prompt A section tag");
  assert.ok(idxBTag >= 0, "system should include global prompt B section tag");
  assert.ok(idxCore >= 0, "system should include global workflow prompt");
  assert.ok(idxA >= 0, "system should include PROMPT_A");
  assert.ok(idxB >= 0, "system should include PROMPT_B");
  assert.ok(idxWorkspace >= 0, "system should include workspace instructions section");
  assert.ok(idxOutput >= 0, "system should include output format instructions section");
  assert.equal(idxRuntime >= 0, false, "system should not include runtime constraints when runtime instruction is empty");
  assert.ok(context.system.includes("Output format requirements:"), "system should include output format instruction body");
  assert.ok(idxAgent >= 0, "system should include AGENT_PROMPT");

  assert.ok(idxSystemBaseTag < idxATag, "order: system base tag before global prompts");
  assert.ok(idxATag < idxBTag, "order: global prompt tags follow global list order");
  assert.ok(idxBTag < idxWorkspace, "order: global prompts before workspace instructions");
  assert.ok(idxWorkspace < idxAgentTag, "order: workspace instructions before agent prompt");
  assert.ok(idxAgentTag < idxOutput, "order: agent prompt before output format instructions");
  assert.equal(context.system.includes("[runtime_constraints]"), false, "system should not include runtime constraints section");
  assert.ok(idxCore < idxA, "order: system base body before global prompt body");
  assert.ok(idxA < idxB, "order: global prompt bodies follow global list order");
  assert.ok(idxB < context.system.indexOf("WORKSPACE_RULE"), "order: global prompt bodies before workspace instructions body");
  assert.ok(context.system.indexOf("WORKSPACE_RULE") < idxAgent, "order: workspace instructions body before agent prompt body");
});

test("agent prompt-context 在 workspace 根 AGENTS.md 缺失时忽略", async (t: TestContext) => {
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

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  assert.ok(context.system.includes("# 工作方式与流程(全局)"), "system should include global workflow prompt");
  assert.ok(context.system.includes("[system_base]"), "system should include system base section");
  assert.ok(context.system.includes("[agent_prompt] default"), "system should include agent section");
  assert.ok(context.system.includes("[output_format_instructions]"), "system should include output format instructions");
  assert.equal(context.system.includes("[runtime_constraints]"), false, "system should not include runtime constraints when runtime instruction is empty");
  assert.ok(
    context.system.includes("You are a helpful coding assistant."),
    "system should include agent prompt content"
  );
  assert.equal(
    context.system.includes("[workspace_instructions] AGENTS.md"),
    false,
    "system should ignore missing workspace AGENTS.md"
  );
});

test("agent startup seed 会修复脏的 global prompts settings", async () => {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "agent-seed-repair-it-"));
  const internalToken = "test-internal-token";

  const db = await openDb(dataDir);
  let app: FastifyInstance | null = null;
  try {
    setSettingJson(db, "agent_global_prompts_v1", {
      items: [
        null,
        { id: "global_system_prompt", title: "Broken", prompt: "   " },
        { id: "global_system_prompt", title: "Dup", prompt: "dup" },
        { id: "gp_empty", title: "Empty", prompt: "   " },
        { id: "gp_ok", title: "OK", prompt: "PROMPT_OK" }
      ]
    }, Date.now());

    app = await createApp({
      db,
      repoRoot,
      dataDir,
      fileMaxBytes: 1024 * 1024,
      version: "test",
      logLevel: "error",
      serveWeb: false,
      webDistDir: null,
      credentialMasterKey: Buffer.alloc(32, 7),
      credentialMasterKeySource: "generated",
      credentialMasterKeyId: "testkey",
      credentialMasterKeyCreatedAt: Date.now(),
      authToken: null,
      authCookieSecure: false,
      agentWorkerEnabled: false,
      agentWorkerHost: "127.0.0.1",
      agentWorkerPort: 0,
        agentWorkerSocketPath: path.join(dataDir, "agent-worker.sock"),
        agentWorkerConcurrency: 0,
        agentInternalToken: internalToken,
        agentWorkerResponseValidation: "strict",
        agentApiOrigin: "http://127.0.0.1:0",
        agentStartupRecoveryMode: "recover",
        agentPluginHostEnabled: false,
        agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock")
      });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/settings/agent/global-prompts" });
    assert.equal(res.statusCode, 200);
    const items = (res.json() as { items: Array<{ id: string; title: string; prompt: string }> }).items;
    assert.equal(items.filter((item) => item.id === "global_system_prompt").length, 1);
    assert.equal(items.find((item) => item.id === "global_system_prompt")?.title, "Global System Prompt");
    assert.ok(String(items.find((item) => item.id === "global_system_prompt")?.prompt || "").trim().length > 0);
    assert.equal(items.some((item) => item.id === "gp_empty"), false);
    assert.equal(items.some((item) => item.id === "gp_ok" && item.prompt === "PROMPT_OK"), true);
  } finally {
    await app?.close().catch(() => undefined);
    db.close();
    await rmrf(dataDir);
  }
});

test("agent prompt-context 在 agent prompt 为空且无 workspace/global 时仅注入全局系统提示词", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

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
          tools: ["bash", "read", "write", "scratchpad"],
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
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt
  });

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  assert.ok(context.system.includes("# 工作方式与流程(全局)"), "system should include global workflow prompt");
  assert.ok(context.system.includes("[system_base]"), "system should include system base section");
  assert.ok(context.system.includes("[output_format_instructions]"), "system should include output format instructions");
  assert.equal(context.system.includes("[runtime_constraints]"), false, "system should not include runtime constraints when runtime instruction is empty");
  assert.equal(context.system.includes("## Global Prompt:"), false, "system should not include global prompt sections");
  assert.equal(context.system.includes("[global_prompt]"), false, "system should not include global prompt blocks when none selected");
  assert.equal(
    context.system.includes("## Workspace Instructions:"),
    false,
    "system should not include workspace instructions when missing"
  );
  assert.equal(context.system.includes("[workspace_instructions]"), false, "system should not include workspace instructions block when missing");
  assert.equal(context.system.includes("## Agent Prompt:"), false, "system should not include agent prompt section when empty");
  assert.equal(context.system.includes("[agent_prompt]"), false, "system should not include agent prompt block when empty");
});

test("agent prompt-context 对 workspace AGENTS.md 做 32KB 截断并追加标记", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();
  const agentsPath = path.join(fixture.workspacePath, "AGENTS.md");
  await fs.writeFile(agentsPath, `RULE\n${"A".repeat(40 * 1024)}`, "utf-8");
  setSettingJson(fixture.db, "workspace_agents_instructions_v1", {
    workspaces: {
      [fixture.workspaceId]: {
        enabledSources: [{ sourceType: "workspace", enabledAt: Date.now() }],
        updatedAt: Date.now()
      }
    }
  }, Date.now());

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

  const context = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });

  assert.ok(
    context.system.includes("[agents_instructions] AGENTS.md"),
    "system should include workspace section with relative path"
  );
  assert.ok(
    context.system.includes("[AGENTS.md truncated: first 32KB]"),
    "system should include truncation marker"
  );
  assert.ok(context.system.includes("[agent_prompt] default"), "system should include agent section when workspace section exists");
  assert.equal(context.system.includes("## Workspace Instructions:"), false, "system should not include legacy workspace heading when workspace section exists");
});

test("agent prompt-context 注入 skills 摘要并在同 run 缓存静态部分", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  const builtinSkillDir = path.join(fixture.repoRoot, "skills", `it-builtin-${Date.now()}`);
  const wsSkillDir = path.join(fixture.workspacePath, "deploy-skill", "deploy");
  const wsBinarySkillDir = path.join(fixture.workspacePath, "deploy-skill", "nontext");
  const wsInvalidSkillDir = path.join(fixture.workspacePath, "deploy-skill", " invalid");
  const repoId = newSortableId("repo");
  const repoDirName = "repo-it";
  const repoPath = workspaceRepoDirPath(fixture.dataDir, path.basename(fixture.workspacePath), repoDirName);
  const repoSkillsRootDir = "ai-skills";
  const repoTopSkillDir = "ops";
  const repoSkillDir = path.join(repoPath, repoSkillsRootDir);
  try {
    await fs.mkdir(path.join(builtinSkillDir, "child"), { recursive: true });
    await fs.mkdir(wsSkillDir, { recursive: true });
    await fs.mkdir(wsInvalidSkillDir, { recursive: true });
    await fs.mkdir(path.join(repoSkillDir, repoTopSkillDir), { recursive: true });
    await fs.mkdir(wsBinarySkillDir, { recursive: true });
    await fs.mkdir(repoSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(builtinSkillDir, "SKILL.md"),
      "---\nname: Builtin Skill V1\n---\n\nbody",
      "utf8"
    );
    insertRepo(fixture.db, {
      id: repoId,
      url: `https://example.test/${repoId}.git`,
      credentialId: null,
      defaultBranch: "main",
      mirrorPath: path.join(fixture.dataDir, "repos", repoId, "mirror.git"),
      syncStatus: "idle",
      syncError: null,
      lastSyncAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    insertWorkspaceRepo(fixture.db, {
      workspaceId: fixture.workspaceId,
      repoId,
      dirName: repoDirName,
      path: repoPath,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    await fs.writeFile(path.join(builtinSkillDir, "child", "SKILL.md"), "---\nname: Child\ndescription: hidden\n---\n", "utf8");
    await fs.writeFile(
      path.join(wsSkillDir, "SKILL.md"),
      "---\nname: Workspace Skill V1\ndescription: ws-desc-v1\n---\n\nbody",
      "utf8"
    );
    await fs.writeFile(path.join(wsInvalidSkillDir, "SKILL.md"), "---\nname: Invalid workspace skill\n---\nbody", "utf8");
    await fs.writeFile(path.join(wsBinarySkillDir, "SKILL.md"), Buffer.from([0x2d, 0x2d, 0x2d, 0x00, 0x61]));
    await fs.writeFile(
      path.join(repoSkillDir, repoTopSkillDir, "SKILL.md"),
      "---\nname: Repo Skill V1\ndescription: repo-desc-v1\n---\n\nbody",
      "utf8"
    );
    setSettingJson(fixture.db, "workspace_external_skill_roots_v1", {
      workspaces: {
        [fixture.workspaceId]: {
          enabledRoots: [
            { sourceType: "workspace", rootDir: "deploy-skill", enabledAt: Date.now() },
            { sourceType: "repo", repoId, rootDir: repoSkillsRootDir, enabledAt: Date.now() }
          ],
          updatedAt: Date.now()
        }
      }
    }, Date.now());
    setSettingJson(fixture.db, "workspace_agents_instructions_v1", {
      workspaces: {
        [fixture.workspaceId]: {
          enabledSources: [{ sourceType: "workspace", enabledAt: Date.now() }],
          updatedAt: Date.now()
        }
      }
    }, Date.now());
    await fs.writeFile(path.join(fixture.workspacePath, "AGENTS.md"), "RULE_V1", "utf8");

    createRunRecord(fixture.db, {
      runId,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      uiLocale: "en-US",
      modelId: "gpt-5.2",
      status: "running",
      createdAt: Date.now()
    });

    const first = await getPromptContextInternal({
      app: fixture.app,
      internalToken: fixture.internalToken,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId
    });
    assert.ok(first.system.includes("[skills]"), "skills section should be present");
    assert.ok(first.system.includes(`skillId: builtin/${path.basename(builtinSkillDir)}`), "builtin skill identifier should be injected");
    assert.ok(first.system.includes("name: Builtin Skill V1"));
    assert.ok(first.system.includes(`skillId: builtin/${path.basename(builtinSkillDir)}; name: Builtin Skill V1\n`), "empty description must not leave a trailing separator");
    assert.equal(first.system.includes(`skillId: builtin/${path.basename(builtinSkillDir)}; name: Builtin Skill V1; description:`), false, "empty description must be omitted");
    assert.ok(first.system.includes("skillId: workspace/deploy-skill/deploy"), "workspace skill identifier should be injected");
    assert.ok(first.system.includes("description: ws-desc-v1"));
    assert.ok(first.system.includes(`skillId: repo/${repoId}/${repoSkillsRootDir}/${repoTopSkillDir}`), "repo skill identifier should be injected");
    assert.ok(first.system.includes("description: repo-desc-v1"));
    assert.equal(first.system.includes(fixture.workspacePath), false, "system prompt should not expose workspace real path");
    assert.equal(first.system.includes(repoPath), false, "system prompt should not expose repo real path");
    assert.equal(first.system.includes(`builtin/${path.basename(builtinSkillDir)}/child`), false, "only top-level skills should be injected");
    assert.equal(first.system.includes("skillId: workspace/deploy-skill/nontext"), false, "non-text top-level skill should not be injected");
    assert.equal(first.system.includes("skillId: workspace/deploy-skill/ invalid"), false, "non-callable physical skill must be omitted from prompt summaries");
    assert.equal(first.tools.some((tool) => tool.name === "skill"), true, "skill tool should be available");
    assert.ok(first.system.includes("First read the root:"), "skills prompt should require a root read first");
    assert.ok(first.system.includes("flat (not tree-shaped) Skill files list"), "skills prompt should describe the flat list");
    assert.ok(first.system.includes("copy one complete path line verbatim into filePath"), "skills prompt should explain direct path reuse");
    assert.equal(first.system.includes("skill_id:"), false, "skills prompt must not expose snake_case parameter labels");
    assert.equal(first.system.includes("file_path"), false, "skills prompt must not expose snake_case parameter labels");

    await fs.writeFile(path.join(wsSkillDir, "SKILL.md"), "---\nname: Workspace Skill V2\ndescription: ws-desc-v2\n---\n", "utf8");
    await fs.writeFile(path.join(repoSkillDir, repoTopSkillDir, "SKILL.md"), "---\nname: Repo Skill V2\ndescription: repo-desc-v2\n---\n", "utf8");
    await fs.writeFile(path.join(fixture.workspacePath, "AGENTS.md"), "RULE_V2", "utf8");
    await sleep(1100);

    const second = await getPromptContextInternal({
      app: fixture.app,
      internalToken: fixture.internalToken,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId
    });
    assert.ok(second.system.includes("RULE_V1"), "same run should keep cached workspace AGENTS content");
    assert.equal(second.system.includes("RULE_V2"), false, "same run should not see updated workspace AGENTS");
    assert.ok(second.system.includes("ws-desc-v1"), "same run should keep cached skill summary");
    assert.equal(second.system.includes("ws-desc-v2"), false, "same run should not see updated skill summary");
    assert.ok(second.system.includes("repo-desc-v1"), "same run should keep cached repo skill summary");
    assert.equal(second.system.includes("repo-desc-v2"), false, "same run should not see updated repo skill summary");

    const runId2 = newSortableId("run");
    createRunRecord(fixture.db, {
      runId: runId2,
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      triggerItemId: 1,
      agentId: "default",
      providerId: "ppchat",
      uiLocale: "en-US",
      modelId: "gpt-5.2",
      status: "running",
      createdAt: Date.now()
    });
    const third = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId: runId2 });
    assert.ok(third.system.includes("RULE_V2"), "new run should observe updated workspace AGENTS");
    assert.ok(third.system.includes("ws-desc-v2"), "new run should observe updated skill summary");
    assert.ok(third.system.includes("repo-desc-v2"), "new run should observe updated repo skill summary");
  } finally {
    await fs.rm(builtinSkillDir, { recursive: true, force: true });
  }
});

test("agent prompt-context 对 repo 根 symlink/路径失配安全跳过", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const ts = Date.now();

  const repoId = newSortableId("repo");
  const repoDirName = "repo-safe";
  const repoPath = path.join(fixture.workspacePath, repoDirName);
  await fs.mkdir(path.join(repoPath, "ai-skill", "ops"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "ai-skill", "ops", "SKILL.md"), "---\nname: Safe\ndescription: safe-desc\n---\n", "utf8");

  insertRepo(fixture.db, {
    id: repoId,
    url: `https://example.test/${repoId}.git`,
    credentialId: null,
    defaultBranch: "main",
    mirrorPath: path.join(fixture.dataDir, "repos", repoId, "mirror.git"),
    syncStatus: "idle",
    syncError: null,
    lastSyncAt: ts,
    createdAt: ts,
    updatedAt: ts
  });
  insertWorkspaceRepo(fixture.db, {
    workspaceId: fixture.workspaceId,
    repoId,
    dirName: repoDirName,
    path: repoPath,
    createdAt: ts,
    updatedAt: ts
  });

  setSettingJson(fixture.db, "workspace_external_skill_roots_v1", {
    workspaces: {
      [fixture.workspaceId]: {
        enabledRoots: [{ sourceType: "repo", repoId, rootDir: "ai-skill", enabledAt: ts }],
        updatedAt: ts
      }
    }
  }, ts);

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "en-US",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: ts
  });

  const first = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  assert.ok(first.system.includes("safe-desc"), "valid repo root should be injected");

  const symlinkPath = path.join(fixture.workspacePath, "repo-symlink");
  await fs.rename(repoPath, path.join(fixture.workspacePath, "repo-safe-target"));
  await fs.symlink(path.join(fixture.workspacePath, "repo-safe-target"), symlinkPath, "dir");
  fixture.db.prepare("update workspace_repos set path = ? where workspace_id = ? and repo_id = ?").run(symlinkPath, fixture.workspaceId, repoId);

  const runId2 = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: runId2,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: "en-US",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });
  const second = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId: runId2 });
  assert.equal(second.system.includes("safe-desc"), false, "repo symlink/mismatch should be skipped");
  assert.equal(second.externalSkillRoots.length, 0, "external skill roots mapping should also skip invalid repo root");
});
