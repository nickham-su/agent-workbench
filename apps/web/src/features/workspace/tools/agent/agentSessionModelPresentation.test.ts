import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionAgentModelState } from "@agent-workbench/shared";
import {
  canRequestSessionModelOpen,
  isSessionModelSendBlocked,
  resolveSessionModelPresentation
} from "./agentSessionModelPresentation";

function defaultReadyState(): AgentSessionAgentModelState {
  return {
    sessionId: "session",
    agentId: "agent",
    agentName: "Agent",
    editable: true,
    agentDefaultModel: { providerId: "provider", modelId: "default" },
    override: null,
    effectiveModel: { providerId: "provider", modelId: "model", providerName: "Provider", modelName: "Model", contextWindowTokens: 1 },
    source: "agent_default",
    status: "ready",
    reasonCode: null,
    message: null
  };
}

function overrideReadyState(): AgentSessionAgentModelState {
  return {
    ...defaultReadyState(),
    override: { providerId: "provider", modelId: "override", updatedAt: 1 },
    effectiveModel: { providerId: "provider", modelId: "override", providerName: "Provider", modelName: "Override", contextWindowTokens: 1 },
    source: "session_override"
  };
}

function invalidOverrideState(): AgentSessionAgentModelState {
  return {
    ...defaultReadyState(),
    override: { providerId: "removed", modelId: "removed", updatedAt: 1 },
    effectiveModel: null,
    source: "session_override",
    status: "invalid",
    reasonCode: "AGENT_MODEL_NOT_FOUND",
    message: "Model unavailable"
  };
}

function missingDefaultState(): AgentSessionAgentModelState {
  return {
    ...defaultReadyState(),
    agentDefaultModel: null,
    effectiveModel: null,
    status: "missing",
    reasonCode: "AGENT_MODEL_NOT_CONFIGURED",
    message: "Model missing"
  };
}

test("model presentation uses the authoritative ready state and preserves its source", () => {
  assert.deepEqual(resolveSessionModelPresentation(overrideReadyState(), false), {
    kind: "ready",
    source: "session_override",
    modelLabel: "Provider / Override"
  });
});

test("invalid overrides and missing defaults never masquerade as another ready model", () => {
  assert.deepEqual(
    resolveSessionModelPresentation(invalidOverrideState(), false),
    { kind: "override_unavailable", source: "session_override", modelLabel: null }
  );
  assert.deepEqual(
    resolveSessionModelPresentation(missingDefaultState(), false),
    { kind: "default_unavailable", source: "agent_default", modelLabel: null }
  );
});

test("unknown state keeps its source unknown while loading or unavailable", () => {
  assert.deepEqual(resolveSessionModelPresentation(null, true), { kind: "loading", source: null, modelLabel: null });
  assert.deepEqual(resolveSessionModelPresentation(null, false), { kind: "unavailable", source: null, modelLabel: null });
});

test("draft can show its known global default before it has a server session", () => {
  assert.deepEqual(resolveSessionModelPresentation(null, false, "Provider / Default"), {
    kind: "ready",
    source: "agent_default",
    modelLabel: "Provider / Default"
  });
  assert.deepEqual(resolveSessionModelPresentation(null, true, "Provider / Default"), { kind: "loading", source: null, modelLabel: null });
});

test("model entry and sending are blocked for the required Session-local conditions", () => {
  assert.equal(canRequestSessionModelOpen({ hasAvailableAgents: true, isSubtaskSession: false, mutationPending: false, agentId: "agent" }), true);
  assert.equal(canRequestSessionModelOpen({ hasAvailableAgents: false, isSubtaskSession: false, mutationPending: false, agentId: "agent" }), false);
  assert.equal(canRequestSessionModelOpen({ hasAvailableAgents: true, isSubtaskSession: false, mutationPending: true, agentId: "agent" }), false);
  assert.equal(isSessionModelSendBlocked({ mutationPending: true }), true);
  assert.equal(isSessionModelSendBlocked({ mutationPending: false }), false);
});
