import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { setSettingJson } from "../../settings/settings.store.js";
import {
  createAgentTestFixture,
  createTestWorkspace,
  type AgentTestFixture,
  type CreateAgentTestFixtureOptions
} from "./agent-testkit.js";

export type AgentIntegrationFixture = AgentTestFixture & {
  app: FastifyInstance;
  workspaceId: string;
  workspacePath: string;
};

export type CreateAgentIntegrationFixtureOptions = Pick<
  CreateAgentTestFixtureOptions,
  "repoRoot" | "agentWorkerConcurrency"
>;

/**
 * Creates one fully initialized HTTP integration fixture. The caller owns the
 * returned fixture and must dispose it from the individual test teardown.
 */
export async function createAgentIntegrationFixture(
  options: CreateAgentIntegrationFixtureOptions = {}
): Promise<AgentIntegrationFixture> {
  const fixture = await createAgentTestFixture({
    repoRoot: options.repoRoot,
    dataDirPrefix: "agent-integration-",
    withApp: true,
    agentWorkerConcurrency: options.agentWorkerConcurrency
  });
  const app = fixture.app;
  if (!app) {
    await fixture.dispose();
    throw new Error("Agent integration fixture requires a ready Fastify app");
  }

  try {
    const workspace = await createTestWorkspace(fixture, { title: "it-workspace" });
    await configureDefaultAgentSettings(app);
    setSettingJson(fixture.db, "agent_channel_sender_allowlist_v1", {
      items: [{ channel: "feishu", senderId: "u_allowed", remark: "default test allowlist" }]
    }, Date.now());
    return {
      ...fixture,
      app,
      workspaceId: workspace.id,
      workspacePath: workspace.path
    };
  } catch (error) {
    try {
      await fixture.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [cleanupError],
        `Agent integration fixture initialization failed and cleanup also failed at ${fixture.dataDir}`,
        { cause: error }
      );
    }
    throw error;
  }
}

async function configureDefaultAgentSettings(app: FastifyInstance, contextWindowTokens = 128000) {
  const providersRes = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "ppchat", modelId: "gpt-5.2" },
      providers: [
        {
          id: "ppchat",
          name: "ppchat",
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://code.ppchat.vip/v1", apiKey: "sk-test" },
          models: [{ id: "gpt-5.2", name: "gpt-5.2", contextWindowTokens }]
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

/** Creates a primary session through the public HTTP route. */
export async function createPrimarySession(fixture: Pick<AgentIntegrationFixture, "app" | "workspaceId">) {
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions",
    payload: { workspaceId: fixture.workspaceId, title: "it-session" }
  });
  assert.equal(res.statusCode, 201, `create session failed: ${res.body}`);
  return res.json() as { id: string };
}

/** Sends one user message through the public HTTP route. */
export async function sendAgentMessage(
  fixture: Pick<AgentIntegrationFixture, "app" | "workspaceId">,
  params: { sessionId: string; text: string; clientRequestId: string }
) {
  const res = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${params.sessionId}/messages`,
    payload: {
      workspaceId: fixture.workspaceId,
      text: params.text,
      clientRequestId: params.clientRequestId
    }
  });
  assert.equal(res.statusCode, 201, `send message failed: ${res.body}`);
  return res.json() as { messageItemId: number; runId: string; deduplicated: boolean };
}
