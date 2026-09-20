import type { AgentUiLocale } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import type { AgentApiPromptContextResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { PromptStaticProfile, RunPromptStatic } from "../prompt/prompt-static-assembler.js";
import { RunPromptStaticCache } from "../prompt/run-prompt-static-cache.js";
import type { ResolvedPendingTool, ResolvedRunSnapshot } from "./model-context-resolver.js";

export type PromptContextProjectorDependencies<Message> = {
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
  resolveDynamicContext: (input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }) => Promise<{
    headMessageId: string | null;
    sessionRevision: number;
    run: ResolvedRunSnapshot;
    pendingTools: ResolvedPendingTool[];
    lastResponseTotalTokens: number | null;
    uiLocale: AgentUiLocale | null;
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
    const cacheGeneration = this.cache.generation(input.run.runId);
    const dynamic = await this.dependencies.resolveDynamicContext({
      workspaceId: input.workspaceId, sessionId: input.sessionId, runId: input.run.runId,
    });
    const profile = this.dependencies.resolveProfile({
      surface: input.session.kind === "subtask" ? "subtask" : "user",
      workspaceId: input.workspaceId,
      agentId: dynamic.run.agentId,
      providerId: dynamic.run.providerId,
      modelId: dynamic.run.modelId
    });
    const staticPrompt = await this.cache.getOrCreate(dynamic.run.runId, Date.now(), () => this.dependencies.assembleStatic({
      workspaceId: input.workspaceId,
      run: dynamic.run,
      profile,
      uiLocale: dynamic.uiLocale
    }), cacheGeneration);
    if (!this.cache.isCurrent(dynamic.run.runId, cacheGeneration)) {
      throw new Error("prompt static cache was invalidated while assembling context");
    }
    const system = this.dependencies.appendRuntimeConstraints(
      staticPrompt.systemStatic,
      this.dependencies.buildRuntimeInstruction({ uiLocale: dynamic.uiLocale })
    );
    return {
      headMessageId: dynamic.headMessageId,
      sessionRevision: dynamic.sessionRevision,
      system,
      messages: dynamic.messages,
      ...(dynamic.providerReplay == null ? {} : { providerReplay: dynamic.providerReplay }),
      tools: staticPrompt.tools,
      pendingTools: dynamic.pendingTools,
      lastResponseTotalTokens: dynamic.lastResponseTotalTokens,
      uiLocale: dynamic.uiLocale,
      externalSkillRoots: staticPrompt.externalSkillRoots
    };
  }
}
