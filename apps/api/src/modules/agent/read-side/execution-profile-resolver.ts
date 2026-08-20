export type ExecutionProfileRun = {
  runId: string;
  agentId: string;
  providerId: string;
  modelId: string;
};

export type ExecutionProfileSession = {
  kind: "primary" | "subtask";
};

export type ExecutionProfileResolverDependencies<Profile, Runtime> = {
  resolveProfile: (input: {
    surface: "user" | "subtask";
    workspaceId: string;
    agentId: string;
    providerId: string;
    modelId: string;
  }) => Profile;
  getRuntime: () => Runtime;
};

/**
 * Resolves the execution-profile payload after the application entry has
 * validated the workspace/session/run relationship. It has no HTTP, DB, or
 * runtime-enqueue dependency.
 */
export class ExecutionProfileResolver<
  Profile extends { agent: { id: string }; provider: { id: string }; model: { id: string }; vision: unknown; compaction: unknown },
  Runtime
> {
  constructor(private readonly dependencies: ExecutionProfileResolverDependencies<Profile, Runtime>) {}

  getExecutionProfileForRun(input: {
    workspaceId: string;
    sessionId: string;
    run: ExecutionProfileRun;
    session: ExecutionProfileSession;
  }) {
    const profile = this.dependencies.resolveProfile({
      surface: input.session.kind === "subtask" ? "subtask" : "user",
      workspaceId: input.workspaceId,
      agentId: input.run.agentId,
      providerId: input.run.providerId,
      modelId: input.run.modelId
    });
    return {
      resolved: {
        runId: input.run.runId,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        agentId: profile.agent.id,
        providerId: profile.provider.id,
        modelId: profile.model.id
      },
      agent: profile.agent,
      provider: profile.provider,
      model: profile.model,
      vision: profile.vision,
      compaction: profile.compaction,
      runtime: this.dependencies.getRuntime()
    };
  }
}
