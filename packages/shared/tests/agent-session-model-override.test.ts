import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  AgentSessionAgentModelStateSchema,
  AgentSessionModelOverridesResponseSchema,
  UpdateAgentSessionModelOverrideRequestSchema
} from "../src/contracts/agent.js";

const defaultReadyState = {
  sessionId: "session-a",
  agentId: "agent-a",
  agentName: "Agent A",
  editable: true,
  agentDefaultModel: { providerId: "provider-default", modelId: "model-default" },
  override: null,
  effectiveModel: {
    providerId: "provider-default",
    modelId: "model-default",
    providerName: "Default Provider",
    modelName: "Default Model",
    contextWindowTokens: 128000
  },
  source: "agent_default" as const,
  status: "ready" as const,
  reasonCode: null,
  message: null
};

test("session model state contracts accept ready default and override projections", () => {
  assert.equal(Value.Check(AgentSessionAgentModelStateSchema, defaultReadyState), true);
  assert.equal(
    Value.Check(AgentSessionAgentModelStateSchema, {
      ...defaultReadyState,
      override: { providerId: "provider-override", modelId: "model-override", updatedAt: 1 },
      effectiveModel: {
        providerId: "provider-override",
        modelId: "model-override",
        providerName: "Override Provider",
        modelName: "Override Model",
        contextWindowTokens: 1
      },
      source: "session_override"
    }),
    true
  );
});

test("session model state contracts retain unavailable states without a fake effective model", () => {
  assert.equal(
    Value.Check(AgentSessionAgentModelStateSchema, {
      ...defaultReadyState,
      override: { providerId: "removed-provider", modelId: "removed-model", updatedAt: 1 },
      effectiveModel: null,
      source: "session_override",
      status: "invalid",
      reasonCode: "AGENT_PROVIDER_NOT_FOUND",
      message: "Provider unavailable"
    }),
    true
  );
  assert.equal(
    Value.Check(AgentSessionAgentModelStateSchema, {
      ...defaultReadyState,
      agentDefaultModel: null,
      effectiveModel: null,
      source: "agent_default",
      status: "missing",
      reasonCode: "AGENT_DEFAULT_MODEL_MISSING",
      message: "Default unavailable"
    }),
    true
  );
});

test("session model state schema rejects unsupported values and sensitive or extra fields", () => {
  assert.equal(
    Value.Check(AgentSessionAgentModelStateSchema, {
      ...defaultReadyState,
      override: { providerId: "provider", modelId: "model", updatedAt: 1 },
      source: "agent_default"
    }),
    true,
    "source/override consistency is an application-level invariant"
  );
  assert.equal(Value.Check(AgentSessionAgentModelStateSchema, { ...defaultReadyState, source: "run_snapshot" }), false);
  assert.equal(Value.Check(AgentSessionAgentModelStateSchema, { ...defaultReadyState, effectiveModel: null }), true);
  assert.equal(Value.Check(AgentSessionAgentModelStateSchema, { ...defaultReadyState, apiKey: "secret" }), false);
  assert.equal(Value.Check(AgentSessionAgentModelStateSchema, { ...defaultReadyState, effectiveModel: { ...defaultReadyState.effectiveModel, contextWindowTokens: 0 } }), false);
});

test("session model API contracts require complete pairs and expose only state projections", () => {
  const body = { workspaceId: "workspace-a", providerId: "provider-a", modelId: "model-a" };
  assert.equal(Value.Check(UpdateAgentSessionModelOverrideRequestSchema, body), true);
  assert.equal(Value.Check(UpdateAgentSessionModelOverrideRequestSchema, { ...body, modelId: "" }), false);
  assert.equal(Value.Check(UpdateAgentSessionModelOverrideRequestSchema, { ...body, apiKey: "secret" }), false);

  assert.equal(
    Value.Check(AgentSessionModelOverridesResponseSchema, {
      workspaceId: "workspace-a",
      sessionId: "session-a",
      items: [defaultReadyState]
    }),
    true
  );
  assert.equal(Value.Check(AgentSessionModelOverridesResponseSchema, { workspaceId: "workspace-a", sessionId: "session-a", items: [] }), true);
});
