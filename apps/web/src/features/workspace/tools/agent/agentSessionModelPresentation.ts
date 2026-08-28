import type { AgentSessionAgentModelState } from "@agent-workbench/shared";

export type SessionModelPresentation = {
  kind: "ready" | "override_unavailable" | "default_unavailable" | "loading" | "unavailable";
  source: AgentSessionAgentModelState["source"] | null;
  modelLabel: string | null;
};

/**
 * Converts the server-authoritative state into a display decision. In
 * particular, an invalid/missing model never falls back to another layer.
 */
export function resolveSessionModelPresentation(
  state: AgentSessionAgentModelState | null | undefined,
  loading: boolean,
  fallbackDefaultModelLabel?: string | null
): SessionModelPresentation {
  if (state?.status === "ready" && state.effectiveModel) {
    return {
      kind: "ready",
      source: state.source,
      modelLabel: `${state.effectiveModel.providerName} / ${state.effectiveModel.modelName}`
    };
  }
  if (state?.source === "session_override") {
    return { kind: "override_unavailable", source: "session_override", modelLabel: null };
  }
  if (state?.source === "agent_default") {
    return { kind: "default_unavailable", source: "agent_default", modelLabel: null };
  }
  // A draft has no server session ID and therefore cannot have an override.
  // Its available-agent resolved model is a safe, informational default until
  // the draft becomes a real session and authoritative state is loaded.
  if (!loading && fallbackDefaultModelLabel) {
    return { kind: "ready", source: "agent_default", modelLabel: fallbackDefaultModelLabel };
  }
  return { kind: loading ? "loading" : "unavailable", source: null, modelLabel: null };
}

export function canRequestSessionModelOpen(params: {
  hasAvailableAgents: boolean;
  isSubtaskSession: boolean;
  mutationPending: boolean;
  agentId: string;
}) {
  return params.hasAvailableAgents && !params.isSubtaskSession && !params.mutationPending && !!params.agentId.trim();
}

export function isSessionModelSendBlocked(params: { mutationPending: boolean }) {
  return params.mutationPending;
}
