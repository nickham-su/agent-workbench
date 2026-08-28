import type {
  AgentSessionAgentModelState,
  AgentSessionModelOverridesResponse,
  UpdateAgentSessionModelOverrideRequest
} from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import type { AgentSessionRecord } from "@agent-workbench/shared";
import type { AgentItem, AgentProvidersSettings } from "@agent-workbench/shared";
import type { WorkspaceAgentEnablementInput } from "../../settings/settings.service.js";
import type { SessionAgentModelOverrideRecord } from "../agent.store.js";

const NOT_EDITABLE_CODE = "AGENT_SESSION_MODEL_OVERRIDE_NOT_EDITABLE";

type ModelPair = { providerId: string; modelId: string };
type AgentProvider = AgentProvidersSettings["providers"][number];
type AgentProviderModel = AgentProvider["models"][number];

type ResolveModelResult =
  | { ready: true; provider: AgentProvider; model: AgentProviderModel }
  | { ready: false; status: "invalid" | "missing"; reasonCode: string; message: string };

export class SessionAgentModelApplication {
  constructor(private readonly dependencies: {
    sessions: { get(sessionId: string): AgentSessionRecord | null };
    overrides: {
      get(params: { sessionId: string; agentId: string }): SessionAgentModelOverrideRecord | null;
      list(params: { sessionId: string }): SessionAgentModelOverrideRecord[];
      upsert(record: SessionAgentModelOverrideRecord): void;
      delete(params: { sessionId: string; agentId: string }): boolean;
    };
    settings: {
      getAgents(): AgentItem[];
      getProviders(): AgentProvidersSettings;
      getWorkspaceEnablement(workspaceId: string): WorkspaceAgentEnablementInput;
    };
    clock: { nowMs(): number };
  }) {}

  list(params: { sessionId: string; workspaceId: string }): AgentSessionModelOverridesResponse {
    const session = this.getEditablePrimarySession(params);
    const enablement = this.dependencies.settings.getWorkspaceEnablement(session.workspaceId);
    const allAgents = this.dependencies.settings.getAgents();
    const agents = allAgents.filter((agent) => this.isUserScopeAllowed(agent));
    const byId = new Map(allAgents.map((agent) => [agent.id, agent]));
    const overrides = this.dependencies.overrides.list({ sessionId: session.id });
    const overrideByAgentId = new Map(overrides.map((record) => [record.agentId, record]));

    const visibleAgents = agents.filter((agent) => this.isEditableAgent(agent, enablement));
    const orphanAgentIds = overrides
      .map((record) => record.agentId)
      .filter((agentId) => !this.isEditableAgent(byId.get(agentId), enablement));
    const ids = [...visibleAgents.map((agent) => agent.id), ...orphanAgentIds.filter((id, index, all) => all.indexOf(id) === index)]
      .sort((left, right) => this.compareAgentOrder(byId.get(left), byId.get(right), left, right));

    return {
      workspaceId: session.workspaceId,
      sessionId: session.id,
      items: ids.map((agentId) => this.project({
        session,
        agentId,
        agent: byId.get(agentId) ?? null,
        override: overrideByAgentId.get(agentId) ?? null,
        enablement
      }))
    };
  }

  put(params: {
    sessionId: string;
    agentId: string;
    body: UpdateAgentSessionModelOverrideRequest;
  }): AgentSessionAgentModelState {
    const session = this.getEditablePrimarySession({ sessionId: params.sessionId, workspaceId: params.body.workspaceId });
    const enablement = this.dependencies.settings.getWorkspaceEnablement(session.workspaceId);
    const agent = this.requireEditableAgent(params.agentId, enablement);
    const requested: ModelPair = {
      providerId: params.body.providerId.trim(),
      modelId: params.body.modelId.trim()
    };
    this.requireReadyModel(requested);

    const updatedAt = this.dependencies.clock.nowMs();
    this.dependencies.overrides.upsert({
      sessionId: session.id,
      agentId: agent.id,
      providerId: requested.providerId,
      modelId: requested.modelId,
      updatedAt
    });

    return this.project({
      session,
      agentId: agent.id,
      agent,
      override: { sessionId: session.id, agentId: agent.id, ...requested, updatedAt },
      enablement
    });
  }

  /**
   * Resolves the complete primary-model pair for a new primary-session Run.
   * Existing Runs deliberately do not use this method: their model pair is
   * immutable in agent_run and is resolved by the Worker read-side path.
   */
  resolveForNewRun(params: {
    sessionId: string;
    workspaceId: string;
    agentId: string;
  }): { providerId: string; modelId: string; source: "session_override" | "agent_default" } {
    const session = this.getEditablePrimarySession(params);
    const enablement = this.dependencies.settings.getWorkspaceEnablement(session.workspaceId);
    const agent = this.requireEditableAgent(params.agentId, enablement);
    const override = this.dependencies.overrides.get({ sessionId: session.id, agentId: agent.id });
    const source = override ? "session_override" : "agent_default";
    const pair = override
      ? { providerId: override.providerId, modelId: override.modelId }
      : agent.defaultModel;
    if (!pair) throw new HttpError(400, "Agent model is not configured", "AGENT_MODEL_NOT_CONFIGURED");
    this.requireReadyModel(pair);
    return { ...pair, source };
  }

  delete(params: { sessionId: string; agentId: string; workspaceId: string }): AgentSessionAgentModelState {
    const session = this.getEditablePrimarySession(params);
    this.dependencies.overrides.delete({ sessionId: session.id, agentId: params.agentId });
    const enablement = this.dependencies.settings.getWorkspaceEnablement(session.workspaceId);
    const agent = this.dependencies.settings.getAgents().find((item) => item.id === params.agentId) ?? null;
    return this.project({
      session,
      agentId: params.agentId,
      agent,
      override: null,
      enablement
    });
  }

  private getEditablePrimarySession(params: { sessionId: string; workspaceId: string }) {
    const session = this.dependencies.sessions.get(params.sessionId);
    if (!session || session.workspaceId !== params.workspaceId) {
      throw new HttpError(404, "Session not found", "AGENT_SESSION_NOT_FOUND");
    }
    if (session.kind !== "primary") {
      throw new HttpError(409, "Session model override is only editable for primary sessions", NOT_EDITABLE_CODE);
    }
    return session;
  }

  private requireEditableAgent(agentId: string, enablement: WorkspaceAgentEnablementInput) {
    const agent = this.dependencies.settings.getAgents().find((item) => item.id === agentId);
    if (!agent) throw new HttpError(400, "Agent not found", "AGENT_NOT_FOUND");
    if (!this.isUserScopeAllowed(agent)) {
      throw new HttpError(400, "Agent is not allowed for user", "AGENT_SCOPE_NOT_ALLOWED");
    }
    if (!this.isEnabledForWorkspace(agent.id, enablement)) {
      throw new HttpError(400, "Agent is disabled in current workspace", "AGENT_DISABLED_IN_WORKSPACE");
    }
    return agent;
  }

  private project(params: {
    session: AgentSessionRecord;
    agentId: string;
    agent: AgentItem | null;
    override: SessionAgentModelOverrideRecord | null;
    enablement: WorkspaceAgentEnablementInput;
  }): AgentSessionAgentModelState {
    const source = params.override ? "session_override" : "agent_default";
    const agentDefaultModel = params.agent?.defaultModel ?? null;
    const editable = params.agent !== null && this.isEditableAgent(params.agent, params.enablement);
    const override = this.toOverrideView(params.override);
    const candidate = params.override
      ? { providerId: params.override.providerId, modelId: params.override.modelId }
      : agentDefaultModel;

    if (!params.agent) {
      return this.unavailableState({
        sessionId: params.session.id,
        agentId: params.agentId,
        agentName: params.agentId,
        editable: false,
        agentDefaultModel: null,
        override,
        source,
        status: "missing",
        reasonCode: "AGENT_NOT_FOUND",
        message: "Agent not found"
      });
    }

    if (!this.isUserScopeAllowed(params.agent)) {
      return this.unavailableState({
        sessionId: params.session.id,
        agentId: params.agent.id,
        agentName: params.agent.name,
        editable: false,
        agentDefaultModel,
        override,
        source,
        status: "invalid",
        reasonCode: "AGENT_SCOPE_NOT_ALLOWED",
        message: "Agent is not allowed for user"
      });
    }

    if (!this.isEnabledForWorkspace(params.agent.id, params.enablement)) {
      return this.unavailableState({
        sessionId: params.session.id,
        agentId: params.agent.id,
        agentName: params.agent.name,
        editable: false,
        agentDefaultModel,
        override,
        source,
        status: "invalid",
        reasonCode: "AGENT_DISABLED_IN_WORKSPACE",
        message: "Agent is disabled in current workspace"
      });
    }

    if (!candidate) {
      return this.unavailableState({
        sessionId: params.session.id,
        agentId: params.agent.id,
        agentName: params.agent.name,
        editable,
        agentDefaultModel,
        override,
        source,
        status: "missing",
        reasonCode: "AGENT_MODEL_NOT_CONFIGURED",
        message: "Agent model is not configured"
      });
    }

    const resolved = this.resolveModel(candidate);
    if (!resolved.ready) {
      return this.unavailableState({
        sessionId: params.session.id,
        agentId: params.agent.id,
        agentName: params.agent.name,
        editable,
        agentDefaultModel,
        override,
        source,
        status: resolved.status,
        reasonCode: resolved.reasonCode,
        message: resolved.message
      });
    }

    return {
      sessionId: params.session.id,
      agentId: params.agent.id,
      agentName: params.agent.name,
      editable,
      agentDefaultModel,
      override,
      effectiveModel: {
        providerId: resolved.provider.id,
        providerName: resolved.provider.name,
        modelId: resolved.model.id,
        modelName: resolved.model.name,
        contextWindowTokens: resolved.model.contextWindowTokens
      },
      source,
      status: "ready",
      reasonCode: null,
      message: null
    };
  }

  private unavailableState(input: Omit<AgentSessionAgentModelState, "effectiveModel"> & {
    effectiveModel?: never;
  }): AgentSessionAgentModelState {
    return { ...input, effectiveModel: null };
  }

  private toOverrideView(record: SessionAgentModelOverrideRecord | null) {
    if (!record) return null;
    return {
      providerId: record.providerId,
      modelId: record.modelId,
      updatedAt: record.updatedAt
    };
  }

  private requireReadyModel(pair: ModelPair) {
    const resolved = this.resolveModel(pair);
    if (resolved.ready) return resolved;
    throw new HttpError(400, resolved.message, resolved.reasonCode);
  }

  private resolveModel(pair: ModelPair): ResolveModelResult {
    const provider = this.dependencies.settings.getProviders().providers.find((item) => item.id === pair.providerId);
    if (!provider) return { ready: false, status: "invalid", reasonCode: "AGENT_PROVIDER_NOT_FOUND", message: "Provider not found" };
    const model = provider.models.find((item) => item.id === pair.modelId);
    if (!model) return { ready: false, status: "invalid", reasonCode: "AGENT_MODEL_NOT_FOUND", message: "Model not found" };
    if (!provider.options.apiKey) {
      return { ready: false, status: "invalid", reasonCode: "AGENT_PROVIDER_API_KEY_MISSING", message: `Provider '${provider.id}' apiKey is missing` };
    }
    return { ready: true, provider, model };
  }

  private isEditableAgent(agent: AgentItem | undefined | null, enablement: WorkspaceAgentEnablementInput) {
    return Boolean(agent && this.isUserScopeAllowed(agent) && this.isEnabledForWorkspace(agent.id, enablement));
  }

  private isUserScopeAllowed(agent: AgentItem) {
    return agent.scope === "both" || agent.scope === "user";
  }

  private isEnabledForWorkspace(agentId: string, enablement: WorkspaceAgentEnablementInput) {
    return enablement.mode !== "subset" || enablement.enabledAgentIds.includes(agentId);
  }

  private compareAgentOrder(left: AgentItem | undefined, right: AgentItem | undefined, leftId: string, rightId: string) {
    const order = (left?.order ?? Number.MAX_SAFE_INTEGER) - (right?.order ?? Number.MAX_SAFE_INTEGER);
    return order || leftId.localeCompare(rightId);
  }
}
