import type { AgentContextItemRecord, AgentContextItemStatus, AgentContextToolName, AgentUiLocale } from "@agent-workbench/shared";
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
  listVisibleItems: (input: { workspaceId: string; sessionId: string }) => AgentContextItemRecord[];
  buildMessages: (input: {
    workspaceId: string;
    sessionId: string;
    triggerItemId: number | null;
    compactionSnippetUiLocale: AgentUiLocale | null;
  }) => Promise<{ messages: Message[] }>;
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
    session: { kind: "primary" | "subtask"; headItemId: number | null };
    run: { runId: string; subtaskDepth: number | null; agentId: string; providerId: string; modelId: string; triggerItemId: number | null };
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
    const visible = this.dependencies.listVisibleItems({ workspaceId: input.workspaceId, sessionId: input.sessionId });
    const { messages } = await this.dependencies.buildMessages({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      triggerItemId: input.run.triggerItemId,
      compactionSnippetUiLocale: uiLocale
    });
    const pendingTools = visible
      .filter((item) => item.runId === input.run.runId && item.kind === "tool")
      .filter((item) => item.status === "queued" || item.status === "running")
      .map((item) => {
        if (item.output.type !== "tool") return null;
        return {
          itemId: item.id,
          status: item.status,
          toolName: item.output.toolName,
          toolCallId: item.output.toolCallId,
          args: item.output.args ?? {}
        };
      })
      .filter((item): item is {
        itemId: number;
        status: AgentContextItemStatus;
        toolName: AgentContextToolName;
        toolCallId: string | undefined;
        args: Record<string, unknown>;
      } => item !== null);
    return {
      headItemId: input.session.headItemId,
      system,
      messages,
      tools: staticPrompt.tools,
      pendingTools,
      lastResponseTotalTokens: runState.lastResponseTotalTokens,
      uiLocale,
      externalSkillRoots: staticPrompt.externalSkillRoots
    };
  }
}
