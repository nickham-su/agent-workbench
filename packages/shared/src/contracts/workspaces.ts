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

export const WorkspaceRepoSkillsRootSchema = Type.Object({
  repoId: Type.String({ minLength: 1 }),
  repoDirName: Type.String({ minLength: 1 }),
  relativePath: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  enabled: Type.Boolean()
});
export type WorkspaceRepoSkillsRoot = Static<typeof WorkspaceRepoSkillsRootSchema>;

export const WorkspaceRepoSkillsRootsDetectResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  items: Type.Array(WorkspaceRepoSkillsRootSchema),
  updatedAt: Type.Number()
});
export type WorkspaceRepoSkillsRootsDetectResponse = Static<typeof WorkspaceRepoSkillsRootsDetectResponseSchema>;

export const WorkspaceRepoSkillsRootInputSchema = Type.Object({
  repoId: Type.String({ minLength: 1 }),
  relativePath: Type.String({ minLength: 1 })
});
export type WorkspaceRepoSkillsRootInput = Static<typeof WorkspaceRepoSkillsRootInputSchema>;

export const WorkspaceRepoSkillsRootsSettingsItemSchema = Type.Object({
  repoId: Type.String({ minLength: 1 }),
  relativePath: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  enabledAt: Type.Number()
});
export type WorkspaceRepoSkillsRootsSettingsItem = Static<typeof WorkspaceRepoSkillsRootsSettingsItemSchema>;

export const WorkspaceRepoSkillsRootsSettingsResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  enabledRoots: Type.Array(WorkspaceRepoSkillsRootsSettingsItemSchema),
  updatedAt: Type.Number()
});
export type WorkspaceRepoSkillsRootsSettingsResponse = Static<typeof WorkspaceRepoSkillsRootsSettingsResponseSchema>;

export const UpdateWorkspaceRepoSkillsRootsSettingsRequestSchema = Type.Object({
  enabledRoots: Type.Array(WorkspaceRepoSkillsRootInputSchema)
});
export type UpdateWorkspaceRepoSkillsRootsSettingsRequest = Static<typeof UpdateWorkspaceRepoSkillsRootsSettingsRequestSchema>;
