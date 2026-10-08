import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { AgentItemViewSchema } from "./settings.js";

export const WorkspaceRecordSchema = Type.Object(
  {
    id: Type.String(),
    dirName: Type.String(),
    title: Type.String(),
    path: Type.String(),
    terminalCredentialId: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.Number(),
    updatedAt: Type.Number()
  }
);
export type WorkspaceRecord = Static<typeof WorkspaceRecordSchema>;

export const WorkspaceRepoSchema = Type.Object(
  {
    repo: Type.Object({ id: Type.String(), url: Type.String() }),
    dirName: Type.String()
  }
);
export type WorkspaceRepo = Static<typeof WorkspaceRepoSchema>;

export const WorkspaceDetailSchema = Type.Object(
  {
    id: Type.String(),
    dirName: Type.String(),
    title: Type.String(),
    repos: Type.Array(WorkspaceRepoSchema),
    useTerminalCredential: Type.Boolean(),
    terminalCount: Type.Number(),
    createdAt: Type.Number(),
    updatedAt: Type.Number()
  }
);
export type WorkspaceDetail = Static<typeof WorkspaceDetailSchema>;

export const WorkspaceAgentTabStateSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  closedSessionIds: Type.Array(Type.String({ minLength: 1 })),
  openedSubtaskSessionIds: Type.Array(Type.String({ minLength: 1 }))
});
export type WorkspaceAgentTabState = Static<typeof WorkspaceAgentTabStateSchema>;

export const UpdateWorkspaceAgentSessionTabVisibilityRequestSchema = Type.Object(
  {
    visible: Type.Boolean()
  },
  { additionalProperties: false }
);
export type UpdateWorkspaceAgentSessionTabVisibilityRequest = Static<
  typeof UpdateWorkspaceAgentSessionTabVisibilityRequestSchema
>;

export const WorkspaceAgentSessionTabStateParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 })
});
export type WorkspaceAgentSessionTabStateParams = Static<typeof WorkspaceAgentSessionTabStateParamsSchema>;

export const WorkspaceAgentSessionTabVisibilityMutationSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  visible: Type.Boolean()
});
export type WorkspaceAgentSessionTabVisibilityMutation = Static<
  typeof WorkspaceAgentSessionTabVisibilityMutationSchema
>;

export const CreateWorkspaceRequestSchema = Type.Object(
  {
    // 允许创建“空工作区”(不绑定 repo)
    repoIds: Type.Array(Type.String({ minLength: 1 })),
    title: Type.Optional(Type.String({ minLength: 1 })),
    useTerminalCredential: Type.Optional(Type.Boolean())
  }
);
export type CreateWorkspaceRequest = Static<typeof CreateWorkspaceRequestSchema>;

export const UpdateWorkspaceRequestSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1 })),
    useTerminalCredential: Type.Optional(Type.Boolean())
  },
  { minProperties: 1 }
);
export type UpdateWorkspaceRequest = Static<typeof UpdateWorkspaceRequestSchema>;

export const AttachWorkspaceRepoRequestSchema = Type.Object({
  repoId: Type.String({ minLength: 1 }),
  branch: Type.Optional(Type.String({ minLength: 1 }))
});
export type AttachWorkspaceRepoRequest = Static<typeof AttachWorkspaceRepoRequestSchema>;

export const WorkspaceContextSkillCandidateSchema = Type.Object({
  skillId: Type.String({ minLength: 1 }),
  skillFilePath: Type.String({ minLength: 1 }),
  enabled: Type.Boolean()
});
export type WorkspaceContextSkillCandidate = Static<typeof WorkspaceContextSkillCandidateSchema>;

export const WorkspaceContextAgentsInstructionCandidateSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  enabled: Type.Boolean()
});
export type WorkspaceContextAgentsInstructionCandidate = Static<typeof WorkspaceContextAgentsInstructionCandidateSchema>;

export const WorkspaceContextFilesDetectResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  skills: Type.Array(WorkspaceContextSkillCandidateSchema),
  agentsInstructions: Type.Array(WorkspaceContextAgentsInstructionCandidateSchema)
});
export type WorkspaceContextFilesDetectResponse = Static<typeof WorkspaceContextFilesDetectResponseSchema>;

export const UpdateWorkspaceContextFilesSettingsRequestSchema = Type.Object({
  enabledSkillIds: Type.Array(Type.String({ minLength: 1 })),
  enabledAgentsInstructionPaths: Type.Array(Type.String({ minLength: 1 }))
});
export type UpdateWorkspaceContextFilesSettingsRequest = Static<typeof UpdateWorkspaceContextFilesSettingsRequestSchema>;

export const WorkspaceContextFilesSettingsResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  enabledSkillIds: Type.Array(Type.String({ minLength: 1 })),
  enabledAgentsInstructionPaths: Type.Array(Type.String({ minLength: 1 }))
});
export type WorkspaceContextFilesSettingsResponse = Static<typeof WorkspaceContextFilesSettingsResponseSchema>;

export const WorkspaceTopLevelSkillSourceSchema = Type.Union([
  Type.Literal("builtin"),
  Type.Literal("workspace")
]);
export type WorkspaceTopLevelSkillSource = Static<typeof WorkspaceTopLevelSkillSourceSchema>;

export const WorkspaceTopLevelSkillItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String(),
  description: Type.String(),
  sourceType: WorkspaceTopLevelSkillSourceSchema
});
export type WorkspaceTopLevelSkillItem = Static<typeof WorkspaceTopLevelSkillItemSchema>;

export const WorkspaceTopLevelSkillsResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  items: Type.Array(WorkspaceTopLevelSkillItemSchema),
  updatedAt: Type.Number()
});
export type WorkspaceTopLevelSkillsResponse = Static<typeof WorkspaceTopLevelSkillsResponseSchema>;

export const WorkspaceAgentEnablementModeSchema = Type.Union([Type.Literal("all"), Type.Literal("subset")]);
export type WorkspaceAgentEnablementMode = Static<typeof WorkspaceAgentEnablementModeSchema>;

export const WorkspaceAgentEnablementItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  scope: Type.Union([Type.Literal("user"), Type.Literal("subtask"), Type.Literal("both")]),
  enabled: Type.Boolean()
});
export type WorkspaceAgentEnablementItem = Static<typeof WorkspaceAgentEnablementItemSchema>;

export const WorkspaceAgentEnablementDetectResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  items: Type.Array(WorkspaceAgentEnablementItemSchema),
  updatedAt: Type.Number()
});
export type WorkspaceAgentEnablementDetectResponse = Static<typeof WorkspaceAgentEnablementDetectResponseSchema>;

export const WorkspaceAgentEnablementSettingsResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  mode: WorkspaceAgentEnablementModeSchema,
  enabledAgentIds: Type.Array(Type.String({ minLength: 1 })),
  updatedAt: Type.Number()
});
export type WorkspaceAgentEnablementSettingsResponse = Static<typeof WorkspaceAgentEnablementSettingsResponseSchema>;

export const UpdateWorkspaceAgentEnablementSettingsRequestSchema = Type.Object({
  mode: WorkspaceAgentEnablementModeSchema,
  enabledAgentIds: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
});
export type UpdateWorkspaceAgentEnablementSettingsRequest = Static<typeof UpdateWorkspaceAgentEnablementSettingsRequestSchema>;

export const WorkspaceAvailableAgentsResponseSchema = Type.Object({
  agents: Type.Array(AgentItemViewSchema)
});
export type WorkspaceAvailableAgentsResponse = Static<typeof WorkspaceAvailableAgentsResponseSchema>;

export const AgentPromptContextExternalSkillSchema = Type.Object({
  skillId: Type.String({ minLength: 1 }),
  skillDirectoryPath: Type.String({ minLength: 1 })
});
export type AgentPromptContextExternalSkill = Static<typeof AgentPromptContextExternalSkillSchema>;
