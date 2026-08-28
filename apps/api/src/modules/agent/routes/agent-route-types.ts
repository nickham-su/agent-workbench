import type { AgentRuntimePort } from "../agent.runtime-port.js";
import type { AgentPluginHostClient } from "../agent.plugin-host-client.js";
import type { AgentRunCompletedEventHub } from "../run-completed-events.js";
import type { AgentService } from "../agent.service.js";

type InternalRouteDependencies = { internalToken: string };

export type AgentPublicRouteDependencies = InternalRouteDependencies & {
  dataDir: string;
  service: Pick<AgentService,
    "listSessions" | "createPrimarySession" | "forkPrimarySession" | "getContextItems" | "getContextItem" |
    "getApplyPatchUiArtifact" | "getWriteUiArtifact" | "getRunState" | "listSessionModelOverrides" |
    "setSessionModelOverride" | "resetSessionModelOverride" | "sendMessage" | "compactSession" |
    "clearSession" | "revertSession" | "cancelSessionWithRuntime" | "getAttachmentContent">;
  runtime: AgentRuntimePort;
};

export type AgentWorkerRouteDependencies = InternalRouteDependencies & {
  service: Pick<AgentService,
    "getSubtaskPreforkPlanFromWorker" | "getSubtaskRunResultFromWorker" |
    "getSubtaskRunStatusFromWorker" | "startSubtaskRunFromWorker" | "appendContextItemFromWorker" | "updateContextItemFromWorker" |
    "updateRunStateFromWorker" | "completeRunFromWorker" | "compactContextFromWorker" |
    "archiveSearchFromWorker" | "archiveReadFromWorker" | "getPromptContextForRun" |
    "getMessagesContext" | "getExecutionProfileForRun" | "getSingleCallModelProfileForRun">;
};

export type AgentPeripheralRouteDependencies = InternalRouteDependencies & {
  service: Pick<AgentService,
    "getAgentMcpSettingsFromWorker" | "getPluginRuntimeSnapshotsFromWorker" | "checkChannelSenderAllowlist" |
    "createPrimarySession" | "sendMessage" | "listRecentSessions" | "listRecentWorkspaces" |
    "getRunFinalText" | "listAvailableAgents">;
  runtime: AgentRuntimePort;
  pluginHost?: AgentPluginHostClient | null;
};

export type AgentStatusSseRouteDependencies = InternalRouteDependencies & {
  service: Pick<AgentService, "getSessionStatusSummary" | "getContextItems">;
  runCompletedEventHub: AgentRunCompletedEventHub;
};
