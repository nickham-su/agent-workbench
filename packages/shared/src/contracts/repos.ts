import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const RepoSyncStatusSchema = Type.Union(
  [Type.Literal("idle"), Type.Literal("syncing"), Type.Literal("failed")]
);
export type RepoSyncStatus = Static<typeof RepoSyncStatusSchema>;

export const RepoRecordSchema = Type.Object(
  {
    id: Type.String(),
    url: Type.String(),
    credentialId: Type.Union([Type.String(), Type.Null()]),
    defaultBranch: Type.Union([Type.String(), Type.Null()]),
    mirrorPath: Type.String(),
    syncStatus: RepoSyncStatusSchema,
    syncError: Type.Union([Type.String(), Type.Null()]),
    lastSyncAt: Type.Union([Type.Number(), Type.Null()]),
    createdAt: Type.Number(),
    updatedAt: Type.Number()
  }
);
export type RepoRecord = Static<typeof RepoRecordSchema>;

export const CreateRepoRequestSchema = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    credentialId: Type.Optional(Type.Union([Type.String(), Type.Null()]))
  }
);
export type CreateRepoRequest = Static<typeof CreateRepoRequestSchema>;

export const RepoBranchesResponseSchema = Type.Object(
  {
    defaultBranch: Type.Union([Type.String(), Type.Null()]),
    branches: Type.Array(
      Type.Object({
        name: Type.String(),
        sha: Type.String()
      })
    )
  }
);
export type RepoBranchesResponse = Static<typeof RepoBranchesResponseSchema>;

export const RepoSyncResponseSchema = Type.Object(
  {
    accepted: Type.Literal(true),
    started: Type.Boolean()
  }
);
export type RepoSyncResponse = Static<typeof RepoSyncResponseSchema>;

export const UpdateRepoRequestSchema = Type.Object(
  {
    credentialId: Type.Optional(Type.Union([Type.String(), Type.Null()]))
  }
);
export type UpdateRepoRequest = Static<typeof UpdateRepoRequestSchema>;
