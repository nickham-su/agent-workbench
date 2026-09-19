import type { AgentUiLocale } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import type { AgentApiPromptContextResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { PromptStaticProfile, RunPromptStatic } from "../prompt/prompt-static-assembler.js";
import { RunPromptStaticCache } from "../prompt/run-prompt-static-cache.js";

export type PromptContextProjectorDependencies<Message> = {
  getRunState: (input: { workspaceId: string; sessionId: string }) => { activeRunId: string | null; lastResponseTotalTokens: number | null };
  resolveUiLocale: (input: { workspaceId: string; sessionId: string; activeRunId: string | null }) => AgentUiLocale | null;
  resolveProfile: (input: {
    surface: "user" | "subtask";
    workspaceId: string;
    agentId: string;
    providerId: string;
    modelId: string;
  }) => PromptStaticProfile;
  assembleStatic: (input: {
    workspaceId: string;
    run: { subtaskDepth: number | null };
    profile: PromptStaticProfile;
    uiLocale: AgentUiLocale | null;
  }) => Promise<RunPromptStatic>;
  buildRuntimeInstruction: (input: { uiLocale: AgentUiLocale | null }) => string;
  appendRuntimeConstraints: (systemStatic: string, runtimeInstruction: string) => string;
  listPendingTools: (input: { workspaceId: string; sessionId: string; runId: string }) => Array<{
    toolExecutionId: string;
    callPartId: string;
    assistantMessageId: string;
    status: "queued" | "running";
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
  }>;
  buildMessages: (input: {
    workspaceId: string;
    sessionId: string;
    triggerMessageId: string | null;
    compactionSnippetUiLocale: AgentUiLocale | null;
    pendingAssistantMessageIds: ReadonlySet<string>;
  }) => Promise<{
    messages: Message[];
    providerReplay?: AgentApiPromptContextResponse["providerReplay"];
  }>;
};

/** Composes cached static prompt data with the run/session dynamic read-side data. */
export class PromptContextProjector<Message> {
  constructor(
    private readonly cache: RunPromptStaticCache<RunPromptStatic>,
    private readonly dependencies: PromptContextProjectorDependencies<Message>
  ) {}

  async getPromptContextForRun(input: {
    workspaceId: string;
    sessionId: string;
    session: { kind: "primary" | "subtask"; headMessageId: string | null; revision: number };
    run: { runId: string; subtaskDepth: number | null; agentId: string; providerId: string; modelId: string; triggerMessageId: string | null };
  }) {
    // Preserve the legacy order: profile validation precedes dynamic run-state reads,
    // including when an already-built static prompt is reused from cache.
    const profile = this.dependencies.resolveProfile({
      surface: input.session.kind === "subtask" ? "subtask" : "user",
      workspaceId: input.workspaceId,
      agentId: input.run.agentId,
      providerId: input.run.providerId,
      modelId: input.run.modelId
    });
    const runState = this.dependencies.getRunState({ workspaceId: input.workspaceId, sessionId: input.sessionId });
    const uiLocale = this.dependencies.resolveUiLocale({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      activeRunId: runState.activeRunId
    });
    const staticPrompt = await this.cache.getOrCreate(input.run.runId, Date.now(), () => this.dependencies.assembleStatic({
      workspaceId: input.workspaceId,
      run: input.run,
      profile,
      uiLocale
    }));
    const system = this.dependencies.appendRuntimeConstraints(
      staticPrompt.systemStatic,
      this.dependencies.buildRuntimeInstruction({ uiLocale })
    );
    // Pending work is read before transcript construction. The Worker will execute it
    // and continue; it must never send an incomplete tool-call turn to a model.
    const pendingTools = this.dependencies.listPendingTools({ workspaceId: input.workspaceId, sessionId: input.sessionId, runId: input.run.runId });
    const { messages, providerReplay } = await this.dependencies.buildMessages({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      triggerMessageId: input.run.triggerMessageId,
      compactionSnippetUiLocale: uiLocale,
      pendingAssistantMessageIds: new Set(pendingTools.map((tool) => tool.assistantMessageId))
    });
    return {
      headMessageId: input.session.headMessageId,
      sessionRevision: input.session.revision,
      system,
      messages,
      ...(providerReplay == null ? {} : { providerReplay }),
      tools: staticPrompt.tools,
      pendingTools,
      lastResponseTotalTokens: runState.lastResponseTotalTokens,
      uiLocale,
      externalSkillRoots: staticPrompt.externalSkillRoots
    };
  }
}
