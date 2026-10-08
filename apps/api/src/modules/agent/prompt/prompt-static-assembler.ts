export type PromptStaticSkillSummary = {
  skill: string;
  name: string;
  description?: string;
};

export type PromptExternalSkill = { skillId: string; skillDirectoryPath: string };
export type PromptWorkspaceContext = {
  enabledAgentsInstructions: Array<{ filePath: string; displayPath: string; content: string }>;
  availableExternalSkills: Array<PromptExternalSkill & { name: string; description: string }>;
};

export type RunPromptStatic = {
  systemStatic: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  externalSkills: PromptExternalSkill[];
};

export type PromptStaticProfile = {
  agent: {
    name: string;
    prompt?: string;
    globalPromptIds?: string[];
    tools: string[];
  };
};

type PromptStaticAssemblerDependencies = {
  getGlobalPrompts: () => { items: Array<{ id: string; title: string; prompt: string }> };
  resolveWorkspaceContext: (workspaceId: string) => Promise<PromptWorkspaceContext>;
  scanBuiltinSkills: () => Promise<PromptStaticSkillSummary[]>;
  getMaxSubtaskDepth: () => number;
  listSubtaskAgents: () => Array<{ id: string; name: string; summary: string }>;
  buildSystem: (input: {
    agentName: string;
    agentPrompt: string;
    agentGlobalPromptIds: string[];
    globalPrompts: Array<{ id: string; title: string; prompt: string }>;
    outputFormatInstruction: string;
    agentsInstructions: Array<{ filePath: string; displayPath: string; content: string }>;
    skillsInstruction: string;
  }) => string;
  buildOutputFormatInstruction: (input: { uiLocale: "zh-CN" | "en-US" | null }) => string;
  buildSkillsInstruction: (input: { builtin: PromptStaticSkillSummary[]; external: PromptStaticSkillSummary[] }) => string;
  buildSubtaskDescription: (agents: Array<{ id: string; name: string; summary: string }>) => string;
  describeTool: (name: string, options: { subtaskDescription?: string }) => string;
  getToolInputSchema: (name: string) => Record<string, unknown>;
};

/**
 * Builds only the run-stable prompt data. All infrastructure access is supplied
 * as narrow readers; this component has no AppContext, AgentService, or runtime.
 */
export class PromptStaticAssembler {
  constructor(private readonly dependencies: PromptStaticAssemblerDependencies) {}

  async assemble(input: {
    workspaceId: string;
    run: { subtaskDepth: number | null };
    profile: PromptStaticProfile;
    uiLocale: "zh-CN" | "en-US" | null;
  }): Promise<RunPromptStatic> {
    const profile = input.profile;
    const [globalPrompts, workspaceContext, builtinSkills] = await Promise.all([
      Promise.resolve(this.dependencies.getGlobalPrompts()),
      this.dependencies.resolveWorkspaceContext(input.workspaceId),
      this.dependencies.scanBuiltinSkills()
    ]);
    const agentsInstructions = workspaceContext.enabledAgentsInstructions;
    const externalSkills: PromptStaticSkillSummary[] = workspaceContext.availableExternalSkills.map((item) => ({
      skill: item.skillId, name: item.name, ...(item.description ? { description: item.description } : {})
    }));

    const baselineToolNames = ["read", "skill"];
    const enabledToolNames: string[] = [];
    const enabledToolNameSet = new Set<string>();
    for (const name of [...baselineToolNames, ...profile.agent.tools]) {
      if (!name || enabledToolNameSet.has(name)) continue;
      enabledToolNameSet.add(name);
      enabledToolNames.push(name);
    }
    const canExposeSubtask = input.run.subtaskDepth != null && input.run.subtaskDepth < this.dependencies.getMaxSubtaskDepth();
    if (!canExposeSubtask) {
      const filtered = enabledToolNames.filter((name) => name !== "subtask");
      enabledToolNames.length = 0;
      enabledToolNames.push(...filtered);
    }
    const subtaskDescription = enabledToolNames.includes("subtask")
      ? this.dependencies.buildSubtaskDescription(this.dependencies.listSubtaskAgents())
      : undefined;

    return {
      systemStatic: this.dependencies.buildSystem({
        agentName: profile.agent.name,
        agentPrompt: profile.agent.prompt || "",
        agentGlobalPromptIds: Array.isArray(profile.agent.globalPromptIds) ? profile.agent.globalPromptIds : [],
        globalPrompts: globalPrompts.items,
        outputFormatInstruction: this.dependencies.buildOutputFormatInstruction({ uiLocale: input.uiLocale }),
        agentsInstructions,
        skillsInstruction: this.dependencies.buildSkillsInstruction({ builtin: builtinSkills, external: externalSkills })
      }),
      tools: enabledToolNames.map((name) => ({
        name,
        description: this.dependencies.describeTool(name, { subtaskDescription }),
        inputSchema: this.dependencies.getToolInputSchema(name)
      })),
      externalSkills: workspaceContext.availableExternalSkills.map(({ skillId, skillDirectoryPath }) => ({ skillId, skillDirectoryPath }))
    };
  }
}
