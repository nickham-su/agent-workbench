import type { AgentSessionAgentModelState, AgentSessionModelOverridesResponse } from "@agent-workbench/shared";

export type SessionModelStateByAgent = Record<string, AgentSessionAgentModelState>;
export type SessionModelStateCache = Record<string, SessionModelStateByAgent>;

/**
 * Applies server-authoritative Session model states without retaining stale
 * Agent entries. The caller owns Vue reactivity; this helper stays framework-
 * independent so its isolation semantics can be unit tested.
 */
export function replaceSessionModelStates(
  cache: SessionModelStateCache,
  response: AgentSessionModelOverridesResponse
) {
  const byAgent: SessionModelStateByAgent = {};
  for (const state of response.items) byAgent[state.agentId] = state;
  cache[response.sessionId] = byAgent;
}

/** Atomically replaces one `(sessionId, agentId)` entry with a PUT/DELETE response. */
export function setSessionAgentModelState(cache: SessionModelStateCache, state: AgentSessionAgentModelState) {
  cache[state.sessionId] = { ...(cache[state.sessionId] ?? {}), [state.agentId]: state };
}

export function clearSessionModelStates(cache: SessionModelStateCache, sessionId: string) {
  delete cache[sessionId];
}

export function sessionAgentModelState(
  cache: SessionModelStateCache,
  sessionId: string,
  agentId: string | null | undefined
) {
  const id = String(agentId || "").trim();
  return id ? cache[sessionId]?.[id] ?? null : null;
}
