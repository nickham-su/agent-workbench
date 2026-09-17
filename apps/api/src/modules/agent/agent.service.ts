import type { AgentServiceCapabilities } from "./agent.composition.js";

/**
 * Stable compatibility facade for routes and runtimes. Construction belongs to
 * createAgentComposition; this class only forwards application capabilities.
 */
export class AgentService {
  constructor(private readonly capabilities: AgentServiceCapabilities) {}

  cleanupSubtaskOrphansOnStartup(...args: Parameters<AgentServiceCapabilities["session"]["cleanupSubtaskOrphansOnStartup"]>): ReturnType<AgentServiceCapabilities["session"]["cleanupSubtaskOrphansOnStartup"]> {
    return this.capabilities.session.cleanupSubtaskOrphansOnStartup(...args);
  }

  listSessions(...args: Parameters<AgentServiceCapabilities["session"]["listSessions"]>): ReturnType<AgentServiceCapabilities["session"]["listSessions"]> {
    return this.capabilities.session.listSessions(...args);
  }

  listRecentSessions(...args: Parameters<AgentServiceCapabilities["query"]["listRecentSessions"]>): ReturnType<AgentServiceCapabilities["query"]["listRecentSessions"]> {
    return this.capabilities.query.listRecentSessions(...args);
  }

  getSession(...args: Parameters<AgentServiceCapabilities["session"]["getSession"]>): ReturnType<AgentServiceCapabilities["session"]["getSession"]> {
    return this.capabilities.session.getSession(...args);
  }

  listAvailableAgents(...args: Parameters<AgentServiceCapabilities["query"]["listAvailableAgents"]>): ReturnType<AgentServiceCapabilities["query"]["listAvailableAgents"]> {
    return this.capabilities.query.listAvailableAgents(...args);
  }

  listRecentWorkspaces(...args: Parameters<AgentServiceCapabilities["query"]["listRecentWorkspaces"]>): ReturnType<AgentServiceCapabilities["query"]["listRecentWorkspaces"]> {
    return this.capabilities.query.listRecentWorkspaces(...args);
  }

  getWorkspace(...args: Parameters<AgentServiceCapabilities["session"]["getWorkspace"]>): ReturnType<AgentServiceCapabilities["session"]["getWorkspace"]> {
    return this.capabilities.session.getWorkspace(...args);
  }

  createPrimarySession(...args: Parameters<AgentServiceCapabilities["session"]["createPrimarySession"]>): ReturnType<AgentServiceCapabilities["session"]["createPrimarySession"]> {
    return this.capabilities.session.createPrimarySession(...args);
  }

  forkPrimarySession(...args: Parameters<AgentServiceCapabilities["session"]["forkPrimarySession"]>): ReturnType<AgentServiceCapabilities["session"]["forkPrimarySession"]> {
    return this.capabilities.session.forkPrimarySession(...args);
  }

  updateSessionTitle(...args: Parameters<AgentServiceCapabilities["session"]["updateSessionTitle"]>): ReturnType<AgentServiceCapabilities["session"]["updateSessionTitle"]> {
    return this.capabilities.session.updateSessionTitle(...args);
  }

  listSessionModelOverrides(...args: Parameters<AgentServiceCapabilities["session"]["listSessionModelOverrides"]>): ReturnType<AgentServiceCapabilities["session"]["listSessionModelOverrides"]> {
    return this.capabilities.session.listSessionModelOverrides(...args);
  }

  setSessionModelOverride(...args: Parameters<AgentServiceCapabilities["session"]["setSessionModelOverride"]>): ReturnType<AgentServiceCapabilities["session"]["setSessionModelOverride"]> {
    return this.capabilities.session.setSessionModelOverride(...args);
  }

  resetSessionModelOverride(...args: Parameters<AgentServiceCapabilities["session"]["resetSessionModelOverride"]>): ReturnType<AgentServiceCapabilities["session"]["resetSessionModelOverride"]> {
    return this.capabilities.session.resetSessionModelOverride(...args);
  }

  sendMessage(...args: Parameters<AgentServiceCapabilities["session"]["sendMessage"]>): ReturnType<AgentServiceCapabilities["session"]["sendMessage"]> {
    return this.capabilities.session.sendMessage(...args);
  }

  getMessageTimeline(...args: Parameters<AgentServiceCapabilities["query"]["getMessageTimeline"]>): ReturnType<AgentServiceCapabilities["query"]["getMessageTimeline"]> {
    return this.capabilities.query.getMessageTimeline(...args);
  }

  compactSession(...args: Parameters<AgentServiceCapabilities["session"]["compactSession"]>): ReturnType<AgentServiceCapabilities["session"]["compactSession"]> {
    return this.capabilities.session.compactSession(...args);
  }

  getMessageDetail(...args: Parameters<AgentServiceCapabilities["query"]["getMessageDetail"]>): ReturnType<AgentServiceCapabilities["query"]["getMessageDetail"]> {
    return this.capabilities.query.getMessageDetail(...args);
  }

  getToolExecutionDetail(...args: Parameters<AgentServiceCapabilities["query"]["getToolExecutionDetail"]>): ReturnType<AgentServiceCapabilities["query"]["getToolExecutionDetail"]> {
    return this.capabilities.query.getToolExecutionDetail(...args);
  }

  getLastAssistantText(...args: Parameters<AgentServiceCapabilities["query"]["getLastAssistantText"]>): ReturnType<AgentServiceCapabilities["query"]["getLastAssistantText"]> {
    return this.capabilities.query.getLastAssistantText(...args);
  }

  getLatestTodolistToolExecution(...args: Parameters<AgentServiceCapabilities["query"]["getLatestTodolistToolExecution"]>): ReturnType<AgentServiceCapabilities["query"]["getLatestTodolistToolExecution"]> {
    return this.capabilities.query.getLatestTodolistToolExecution(...args);
  }

  getMessageTimelineSnapshot(...args: Parameters<AgentServiceCapabilities["query"]["getMessageTimelineSnapshot"]>): ReturnType<AgentServiceCapabilities["query"]["getMessageTimelineSnapshot"]> {
    return this.capabilities.query.getMessageTimelineSnapshot(...args);
  }

  getMessageRunState(...args: Parameters<AgentServiceCapabilities["query"]["getMessageRunState"]>): ReturnType<AgentServiceCapabilities["query"]["getMessageRunState"]> {
    return this.capabilities.query.getMessageRunState(...args);
  }

  getApplyPatchUiArtifact(...args: Parameters<AgentServiceCapabilities["query"]["getApplyPatchUiArtifact"]>): ReturnType<AgentServiceCapabilities["query"]["getApplyPatchUiArtifact"]> {
    return this.capabilities.query.getApplyPatchUiArtifact(...args);
  }

  getWriteUiArtifact(...args: Parameters<AgentServiceCapabilities["query"]["getWriteUiArtifact"]>): ReturnType<AgentServiceCapabilities["query"]["getWriteUiArtifact"]> {
    return this.capabilities.query.getWriteUiArtifact(...args);
  }

  getAttachmentContent(...args: Parameters<AgentServiceCapabilities["query"]["getAttachmentContent"]>): ReturnType<AgentServiceCapabilities["query"]["getAttachmentContent"]> {
    return this.capabilities.query.getAttachmentContent(...args);
  }

  revertSession(...args: Parameters<AgentServiceCapabilities["session"]["revertSession"]>): ReturnType<AgentServiceCapabilities["session"]["revertSession"]> {
    return this.capabilities.session.revertSession(...args);
  }

  cancelSessionWithRuntime(...args: Parameters<AgentServiceCapabilities["lifecycle"]["cancelSessionWithRuntime"]>): ReturnType<AgentServiceCapabilities["lifecycle"]["cancelSessionWithRuntime"]> {
    return this.capabilities.lifecycle.cancelSessionWithRuntime(...args);
  }

  recoverRunsOnStartup(...args: Parameters<AgentServiceCapabilities["lifecycle"]["recoverRunsOnStartup"]>): ReturnType<AgentServiceCapabilities["lifecycle"]["recoverRunsOnStartup"]> {
    return this.capabilities.lifecycle.recoverRunsOnStartup(...args);
  }

  createStreamingAssistantFromWorker(...args: Parameters<AgentServiceCapabilities["lifecycle"]["createStreamingAssistantFromWorker"]>): ReturnType<AgentServiceCapabilities["lifecycle"]["createStreamingAssistantFromWorker"]> {
    return this.capabilities.lifecycle.createStreamingAssistantFromWorker(...args);
  }

  flushAssistantPartsFromWorker(...args: Parameters<AgentServiceCapabilities["lifecycle"]["flushAssistantPartsFromWorker"]>): ReturnType<AgentServiceCapabilities["lifecycle"]["flushAssistantPartsFromWorker"]> {
    return this.capabilities.lifecycle.flushAssistantPartsFromWorker(...args);
  }

  resumeStreamingAssistantFromWorker(...args: Parameters<AgentServiceCapabilities["lifecycle"]["resumeStreamingAssistantFromWorker"]>): ReturnType<AgentServiceCapabilities["lifecycle"]["resumeStreamingAssistantFromWorker"]> {
    return this.capabilities.lifecycle.resumeStreamingAssistantFromWorker(...args);
  }

  replaceStreamingAssistantFromWorker(...args: Parameters<AgentServiceCapabilities["lifecycle"]["replaceStreamingAssistantFromWorker"]>): ReturnType<AgentServiceCapabilities["lifecycle"]["replaceStreamingAssistantFromWorker"]> {
    return this.capabilities.lifecycle.replaceStreamingAssistantFromWorker(...args);
  }

  completeAssistantFromWorker(...args: Parameters<AgentServiceCapabilities["lifecycle"]["completeAssistantFromWorker"]>): ReturnType<AgentServiceCapabilities["lifecycle"]["completeAssistantFromWorker"]> {
    return this.capabilities.lifecycle.completeAssistantFromWorker(...args);
  }

  archiveReadFromWorker(...args: Parameters<AgentServiceCapabilities["worker"]["archiveReadFromWorker"]>): ReturnType<AgentServiceCapabilities["worker"]["archiveReadFromWorker"]> {
    return this.capabilities.worker.archiveReadFromWorker(...args);
  }

  archiveSearchFromWorker(...args: Parameters<AgentServiceCapabilities["worker"]["archiveSearchFromWorker"]>): ReturnType<AgentServiceCapabilities["worker"]["archiveSearchFromWorker"]> {
    return this.capabilities.worker.archiveSearchFromWorker(...args);
  }

  updateToolExecutionFromWorker(...args: Parameters<AgentServiceCapabilities["lifecycle"]["updateToolExecutionFromWorker"]>): ReturnType<AgentServiceCapabilities["lifecycle"]["updateToolExecutionFromWorker"]> {
    return this.capabilities.lifecycle.updateToolExecutionFromWorker(...args);
  }

  updateRunNoticeFromWorker(...args: Parameters<AgentServiceCapabilities["lifecycle"]["updateRunNoticeFromWorker"]>): ReturnType<AgentServiceCapabilities["lifecycle"]["updateRunNoticeFromWorker"]> {
    return this.capabilities.lifecycle.updateRunNoticeFromWorker(...args);
  }

  completeRunFromWorker(...args: Parameters<AgentServiceCapabilities["lifecycle"]["completeRunFromWorker"]>): ReturnType<AgentServiceCapabilities["lifecycle"]["completeRunFromWorker"]> {
    return this.capabilities.lifecycle.completeRunFromWorker(...args);
  }

  getSubtaskPreforkPlanFromWorker(...args: Parameters<AgentServiceCapabilities["worker"]["getSubtaskPreforkPlanFromWorker"]>): ReturnType<AgentServiceCapabilities["worker"]["getSubtaskPreforkPlanFromWorker"]> {
    return this.capabilities.worker.getSubtaskPreforkPlanFromWorker(...args);
  }

  startSubtaskRunFromWorker(...args: Parameters<AgentServiceCapabilities["worker"]["startSubtaskRunFromWorker"]>): ReturnType<AgentServiceCapabilities["worker"]["startSubtaskRunFromWorker"]> {
    return this.capabilities.worker.startSubtaskRunFromWorker(...args);
  }

  getSubtaskRunResultFromWorker(...args: Parameters<AgentServiceCapabilities["worker"]["getSubtaskRunResultFromWorker"]>): ReturnType<AgentServiceCapabilities["worker"]["getSubtaskRunResultFromWorker"]> {
    return this.capabilities.worker.getSubtaskRunResultFromWorker(...args);
  }

  getSubtaskRunStatusFromWorker(...args: Parameters<AgentServiceCapabilities["worker"]["getSubtaskRunStatusFromWorker"]>): ReturnType<AgentServiceCapabilities["worker"]["getSubtaskRunStatusFromWorker"]> {
    return this.capabilities.worker.getSubtaskRunStatusFromWorker(...args);
  }

  getRunFinalText(...args: Parameters<AgentServiceCapabilities["query"]["getRunFinalText"]>): ReturnType<AgentServiceCapabilities["query"]["getRunFinalText"]> {
    return this.capabilities.query.getRunFinalText(...args);
  }

  getExecutionProfileForRun(...args: Parameters<AgentServiceCapabilities["worker"]["getExecutionProfileForRun"]>): ReturnType<AgentServiceCapabilities["worker"]["getExecutionProfileForRun"]> {
    return this.capabilities.worker.getExecutionProfileForRun(...args);
  }

  getSingleCallModelProfileForRun(...args: Parameters<AgentServiceCapabilities["worker"]["getSingleCallModelProfileForRun"]>): ReturnType<AgentServiceCapabilities["worker"]["getSingleCallModelProfileForRun"]> {
    return this.capabilities.worker.getSingleCallModelProfileForRun(...args);
  }

  getAgentMcpSettingsFromWorker(...args: Parameters<AgentServiceCapabilities["worker"]["getAgentMcpSettingsFromWorker"]>): ReturnType<AgentServiceCapabilities["worker"]["getAgentMcpSettingsFromWorker"]> {
    return this.capabilities.worker.getAgentMcpSettingsFromWorker(...args);
  }

  getPluginRuntimeSnapshotsFromWorker(...args: Parameters<AgentServiceCapabilities["worker"]["getPluginRuntimeSnapshotsFromWorker"]>): ReturnType<AgentServiceCapabilities["worker"]["getPluginRuntimeSnapshotsFromWorker"]> {
    return this.capabilities.worker.getPluginRuntimeSnapshotsFromWorker(...args);
  }

  commitCompactionFromWorker(...args: Parameters<AgentServiceCapabilities["worker"]["commitCompactionFromWorker"]>): ReturnType<AgentServiceCapabilities["worker"]["commitCompactionFromWorker"]> {
    return this.capabilities.worker.commitCompactionFromWorker(...args);
  }

  getMessagesContext(...args: Parameters<AgentServiceCapabilities["worker"]["getMessagesContext"]>): ReturnType<AgentServiceCapabilities["worker"]["getMessagesContext"]> {
    return this.capabilities.worker.getMessagesContext(...args);
  }

  getPromptContextForRun(...args: Parameters<AgentServiceCapabilities["worker"]["getPromptContextForRun"]>): ReturnType<AgentServiceCapabilities["worker"]["getPromptContextForRun"]> {
    return this.capabilities.worker.getPromptContextForRun(...args);
  }

  checkChannelSenderAllowlist(...args: Parameters<AgentServiceCapabilities["worker"]["checkChannelSenderAllowlist"]>): ReturnType<AgentServiceCapabilities["worker"]["checkChannelSenderAllowlist"]> {
    return this.capabilities.worker.checkChannelSenderAllowlist(...args);
  }

}
