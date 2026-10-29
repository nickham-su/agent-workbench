import { Type, type Static } from "@sinclair/typebox";

export const WorkspaceEnvironmentResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  env: Type.Record(Type.String(), Type.String())
}, { additionalProperties: false });
export type WorkspaceEnvironmentResponse = Static<typeof WorkspaceEnvironmentResponseSchema>;
