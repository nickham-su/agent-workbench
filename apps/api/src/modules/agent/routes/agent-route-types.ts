import type { AgentRuntimePort } from "../agent.runtime-port.js";
import type { AgentPluginHostClient } from "../agent.plugin-host-client.js";
import type { AgentRunCompletedEventHub } from "../run-completed-events.js";
import type { AgentService } from "../agent.service.js";

type InternalRouteDependencies = { internalToken: string };

export type AgentPublicRouteDependencies = InternalRouteDependencies & {
  dataDir: string;
  service: Pick<AgentService,
    "listSessions" | "createPrimarySession" | "forkPrimarySession" | "updateSessionTitle" | "getMessageTimeline" | "getMessageDetail" |
    "getToolExecutionDetail" | "getApplyPatchUiArtifact" | "getWriteUiArtifact" | "getMessageRunState" | "getRunStatus" | "listSessionModelOverrides" |
    "setSessionModelOverride" | "resetSessionModelOverride" | "sendMessage" | "compactSession" | "revertSession" |
    "cancelSessionWithRuntime" | "getAttachmentContent">;
  runtime: AgentRuntimePort;
};

export type AgentWorkerRouteDependencies = InternalRouteDependencies & {
  service: Pick<AgentService,
    "getSubtaskPreforkPlanFromWorker" | "getSubtaskRunResultFromWorker" |
    "getSubtaskRunStatusFromWorker" | "startSubtaskRunFromWorker" | "createStreamingAssistantFromWorker" |
    "flushAssistantPartsFromWorker" | "resumeStreamingAssistantFromWorker" | "replaceStreamingAssistantFromWorker" |
    "discardStreamingAssistantFromWorker" | "completeAssistantFromWorker" | "completeTerminalAssistantFromWorker" | "updateToolExecutionFromWorker" |
    "updateRunNoticeFromWorker" | "markRunWorkInProgressFromWorker" |
    "persistRunTerminalIntentFromWorker" | "convergeRunTerminalFromWorker" | "commitCompactionWithTerminalIntentFromWorker" | "confirmCompactionCommitFromWorker" |
    "archiveReadFromWorker" | "archiveSearchFromWorker" |
    "getPromptContextForRun" | "getCompactionSourceFromWorker" |
    "getMessagesContext" | "getExecutionProfileForRun" | "getSingleCallModelProfileForRun">;
};

export type AgentPeripheralRouteDependencies = InternalRouteDependencies & {
  service: Pick<AgentService,
    "getAgentMcpSettingsFromWorker" | "getPluginRuntimeSnapshotsFromWorker" | "checkChannelSenderAllowlist" |
    "createPrimarySession" | "sendMessage" | "listRecentSessions" | "listRecentWorkspaces" |
    "getRunFinalText" | "listAvailableAgents" | "getLastAssistantText" |
    "getLatestTodolistToolExecution" | "getMessageRunState">;
  runtime: AgentRuntimePort;
  pluginHost?: AgentPluginHostClient | null;
};

export type AgentStatusSseRouteDependencies = InternalRouteDependencies & {
  service: Pick<AgentService, "getMessageTimelineSnapshot">;
  runCompletedEventHub: AgentRunCompletedEventHub;
};
