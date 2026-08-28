import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearSessionModelStates,
  replaceSessionModelStates,
  sessionAgentModelState,
  setSessionAgentModelState,
  type SessionModelStateCache
} from "./agentSessionModelState";

const ready = (sessionId: string, agentId: string, modelId: string) => ({
  sessionId,
  agentId,
  agentName: agentId,
  editable: true,
  agentDefaultModel: { providerId: "provider", modelId: "default" },
  override: modelId === "default" ? null : { providerId: "provider", modelId, updatedAt: 1 },
  effectiveModel: { providerId: "provider", modelId, providerName: "Provider", modelName: modelId, contextWindowTokens: 1000 },
  source: modelId === "default" ? "agent_default" as const : "session_override" as const,
  status: "ready" as const,
  reasonCode: null,
  message: null
});

test("Session model cache isolates agents and replaces stale states on refresh", () => {
  const cache: SessionModelStateCache = {};
  replaceSessionModelStates(cache, {
    workspaceId: "workspace",
    sessionId: "session-a",
    items: [ready("session-a", "agent-a", "override"), ready("session-a", "agent-b", "default")]
  });
  replaceSessionModelStates(cache, {
    workspaceId: "workspace",
    sessionId: "session-b",
    items: [ready("session-b", "agent-a", "other")]
  });
  assert.equal(sessionAgentModelState(cache, "session-a", "agent-a")?.effectiveModel?.modelId, "override");
  assert.equal(sessionAgentModelState(cache, "session-b", "agent-a")?.effectiveModel?.modelId, "other");

  replaceSessionModelStates(cache, { workspaceId: "workspace", sessionId: "session-a", items: [ready("session-a", "agent-a", "default")] });
  assert.equal(sessionAgentModelState(cache, "session-a", "agent-b"), null);
});

test("Session model cache updates one mutation result and clears deleted sessions", () => {
  const cache: SessionModelStateCache = {};
  setSessionAgentModelState(cache, ready("session", "agent", "override"));
  setSessionAgentModelState(cache, ready("session", "agent", "default"));
  assert.equal(sessionAgentModelState(cache, "session", "agent")?.source, "agent_default");
  clearSessionModelStates(cache, "session");
  assert.equal(sessionAgentModelState(cache, "session", "agent"), null);
});
