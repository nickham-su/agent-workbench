import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const WorkspaceRecordSchema = Type.Object(
  {
    id: Type.String(),
    repoId: Type.String(),
    branch: Type.String(),
    path: Type.String(),
    createdAt: Type.Number(),
    updatedAt: Type.Number()
  }
);
export type WorkspaceRecord = Static<typeof WorkspaceRecordSchema>;

export const WorkspaceDetailSchema = Type.Object(
  {
    id: Type.String(),
    repo: Type.Object({ id: Type.String(), url: Type.String() }),
    checkout: Type.Object({ branch: Type.String() }),
    terminalCount: Type.Number(),
    createdAt: Type.Number(),
    updatedAt: Type.Number()
  }
);
export type WorkspaceDetail = Static<typeof WorkspaceDetailSchema>;

export const CreateWorkspaceRequestSchema = Type.Object(
  {
    repoId: Type.String({ minLength: 1 }),
    branch: Type.String({ minLength: 1 })
  }
);
export type CreateWorkspaceRequest = Static<typeof CreateWorkspaceRequestSchema>;

export const SwitchWorkspaceBranchRequestSchema = Type.Object(
  { branch: Type.String({ minLength: 1 }) }
);
export type SwitchWorkspaceBranchRequest = Static<typeof SwitchWorkspaceBranchRequestSchema>;
