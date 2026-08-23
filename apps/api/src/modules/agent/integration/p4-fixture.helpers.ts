import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createApp } from "../../../app/createApp.js";
import { setSettingJson } from "../../settings/settings.store.js";
import {
  createAgentIntegrationFixture,
  type AgentIntegrationFixture
} from "../testkit/agent-integration-testkit.js";
import { createAgentTestFixture, createTestWorkspace } from "../testkit/agent-testkit.js";

export type CreateP4FixtureOptions = {
  agentWorkerConcurrency?: number;
  agentTestFaults?: {
    archiveWrite?: { failAfterChunks?: number } | null;
  };
  agentGlobalPromptsStored?: unknown;
  agentGlobalPromptsUpdatedAt?: number;
};

/**
 * P4 fixture owner. The exceptional pre-app settings are limited to P4's
 * archive-fault and global-prompt startup paths; ordinary callers reuse the
 * stable integration fixture directly.
 */
export async function createP4Fixture(t: TestContext, options: CreateP4FixtureOptions = {}) {
  const fixture = needsPreAppSetup(options)
    ? await createP4FixtureWithPreAppSetup(options)
    : await createAgentIntegrationFixture({ agentWorkerConcurrency: options.agentWorkerConcurrency });
  t.after(async () => {
    await fixture.dispose();
  });
  return fixture;
}

function needsPreAppSetup(options: CreateP4FixtureOptions) {
  return options.agentTestFaults !== undefined || options.agentGlobalPromptsStored !== undefined;
}

async function createP4FixtureWithPreAppSetup(options: CreateP4FixtureOptions): Promise<AgentIntegrationFixture> {
  const base = await createAgentTestFixture({ agentWorkerConcurrency: options.agentWorkerConcurrency });
  let app: AgentIntegrationFixture["app"] | null = null;
  let disposed = false;
  try {
    if (options.agentGlobalPromptsStored !== undefined) {
      setSettingJson(
        base.db,
        "agent_global_prompts_v1",
        options.agentGlobalPromptsStored,
        options.agentGlobalPromptsUpdatedAt ?? Date.now()
      );
    }
    if (options.agentTestFaults !== undefined) {
      base.ctx.agentTestFaults = options.agentTestFaults;
    }
    app = await createApp(base.ctx);
    await app.ready();
    const workspace = await createTestWorkspace(base, { title: "it-workspace" });
    await configureDefaultAgentSettings(app);
    setSettingJson(base.db, "agent_channel_sender_allowlist_v1", {
      items: [{ channel: "feishu", senderId: "u_allowed", remark: "default test allowlist" }]
    }, Date.now());

    return {
      ...base,
      app,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      async dispose() {
        if (disposed) return;
        disposed = true;
        const failures: unknown[] = [];
        try {
          await app?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await base.dispose();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, `Failed to dispose P4 fixture at ${base.dataDir}`);
        }
      }
    };
  } catch (error) {
    try {
      await app?.close();
    } finally {
      await base.dispose();
    }
    throw error;
  }
}

async function configureDefaultAgentSettings(app: AgentIntegrationFixture["app"]) {
  const providersRes = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "ppchat", modelId: "gpt-5.2" },
      providers: [{
        id: "ppchat",
        name: "ppchat",
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://code.ppchat.vip/v1", apiKey: "sk-test" },
        models: [{ id: "gpt-5.2", name: "gpt-5.2", contextWindowTokens: 128000 }]
      }]
    }
  });
  assert.equal(providersRes.statusCode, 200, `configure providers failed: ${providersRes.body}`);

  const agentsRes = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [{
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
      }]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);
}
