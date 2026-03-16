import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

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

export const WorkspaceExternalSkillRootSourceSchema = Type.Union([
  Type.Literal("workspace"),
  Type.Literal("repo")
]);
export type WorkspaceExternalSkillRootSource = Static<typeof WorkspaceExternalSkillRootSourceSchema>;

export const WorkspaceExternalSkillRootSchema = Type.Object({
  sourceType: WorkspaceExternalSkillRootSourceSchema,
  repoId: Type.Optional(Type.String({ minLength: 1 })),
  repoDirName: Type.Optional(Type.String({ minLength: 1 })),
  rootDir: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  topLevelSkillCount: Type.Number({ minimum: 0 }),
  enabled: Type.Boolean()
});
export type WorkspaceExternalSkillRoot = Static<typeof WorkspaceExternalSkillRootSchema>;

export const WorkspaceExternalSkillRootsDetectResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  items: Type.Array(WorkspaceExternalSkillRootSchema),
  updatedAt: Type.Number()
});
export type WorkspaceExternalSkillRootsDetectResponse = Static<typeof WorkspaceExternalSkillRootsDetectResponseSchema>;

export const WorkspaceExternalSkillRootInputSchema = Type.Object({
  sourceType: WorkspaceExternalSkillRootSourceSchema,
  repoId: Type.Optional(Type.String({ minLength: 1 })),
  rootDir: Type.String({ minLength: 1 })
});
export type WorkspaceExternalSkillRootInput = Static<typeof WorkspaceExternalSkillRootInputSchema>;

export const WorkspaceExternalSkillRootsSettingsItemSchema = Type.Object({
  sourceType: WorkspaceExternalSkillRootSourceSchema,
  repoId: Type.Optional(Type.String({ minLength: 1 })),
  rootDir: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  enabledAt: Type.Number()
});
export type WorkspaceExternalSkillRootsSettingsItem = Static<typeof WorkspaceExternalSkillRootsSettingsItemSchema>;

export const WorkspaceExternalSkillRootsSettingsResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  enabledRoots: Type.Array(WorkspaceExternalSkillRootsSettingsItemSchema),
  updatedAt: Type.Number()
});
export type WorkspaceExternalSkillRootsSettingsResponse = Static<typeof WorkspaceExternalSkillRootsSettingsResponseSchema>;

export const UpdateWorkspaceExternalSkillRootsSettingsRequestSchema = Type.Object({
  enabledRoots: Type.Array(WorkspaceExternalSkillRootInputSchema)
});
export type UpdateWorkspaceExternalSkillRootsSettingsRequest = Static<typeof UpdateWorkspaceExternalSkillRootsSettingsRequestSchema>;

export const AgentPromptContextExternalSkillRootSchema = Type.Object({
  sourceType: WorkspaceExternalSkillRootSourceSchema,
  repoId: Type.Optional(Type.String({ minLength: 1 })),
  rootDir: Type.String({ minLength: 1 }),
  rootPath: Type.String({ minLength: 1 })
});
export type AgentPromptContextExternalSkillRoot = Static<typeof AgentPromptContextExternalSkillRootSchema>;
