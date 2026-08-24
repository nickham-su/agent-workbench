export type PromptStaticSkillSummary = {
  skill: string;
  name: string;
  description?: string;
};

export type PromptExternalSkillRoot = {
  sourceType: "workspace" | "repo";
  repoId?: string;
  rootDir: string;
  rootPath: string;
};

export type RunPromptStatic = {
  systemStatic: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  externalSkillRoots: PromptExternalSkillRoot[];
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
  listAgentsInstructionSources: (workspaceId: string) => Promise<Array<{ filePath: string; displayPath: string }>>;
  readAgentsInstruction: (source: { filePath: string; displayPath: string }) => Promise<{ filePath: string; displayPath: string; content: string } | null>;
  scanBuiltinSkills: () => Promise<PromptStaticSkillSummary[]>;
  listExternalSkillRoots: (workspaceId: string) => Promise<PromptExternalSkillRoot[]>;
  scanExternalSkills: (root: PromptExternalSkillRoot) => Promise<PromptStaticSkillSummary[]>;
  warnExternalSkillScanFailure: (input: { err: unknown; workspaceId: string; root: PromptExternalSkillRoot }) => void;
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
    const [globalPrompts, enabledAgentsSources, builtinSkills, enabledExternalRoots] = await Promise.all([
      Promise.resolve(this.dependencies.getGlobalPrompts()),
      this.dependencies.listAgentsInstructionSources(input.workspaceId),
      this.dependencies.scanBuiltinSkills(),
      this.dependencies.listExternalSkillRoots(input.workspaceId)
    ]);
    const agentsInstructions = (await Promise.all(enabledAgentsSources.map((source) => this.dependencies.readAgentsInstruction(source))))
      .filter((item): item is NonNullable<typeof item> => item !== null);
    const externalSkills: PromptStaticSkillSummary[] = [];
    for (const root of enabledExternalRoots) {
      const scanned = await this.dependencies.scanExternalSkills(root).catch((err) => {
        this.dependencies.warnExternalSkillScanFailure({ err, workspaceId: input.workspaceId, root });
        return [] as PromptStaticSkillSummary[];
      });
      externalSkills.push(...scanned);
    }
    externalSkills.sort((a, b) => a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0);

    const baselineToolNames = ["read", "archive_search", "archive_read", "skill"];
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
      externalSkillRoots: enabledExternalRoots
    };
  }
}
