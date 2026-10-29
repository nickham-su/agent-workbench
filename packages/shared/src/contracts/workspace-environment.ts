import { Type, type Static } from "@sinclair/typebox";

const Fields = {
  name: Type.String(),
  value: Type.String(),
  remark: Type.String(),
  enabled: Type.Boolean()
};
const Id = Type.String({ minLength: 1 });
const Timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const WorkspaceEnvironmentVariableSchema = Type.Object({
  id: Id, workspaceId: Id, ...Fields, createdAt: Timestamp, updatedAt: Timestamp
}, { additionalProperties: false });
export type WorkspaceEnvironmentVariable = Static<typeof WorkspaceEnvironmentVariableSchema>;

export const CreateWorkspaceEnvironmentVariableRequestSchema = Type.Object({
  name: Fields.name, value: Fields.value,
  remark: Type.Optional(Fields.remark), enabled: Type.Optional(Fields.enabled)
}, { additionalProperties: false });
export type CreateWorkspaceEnvironmentVariableRequest = Static<typeof CreateWorkspaceEnvironmentVariableRequestSchema>;

export const UpdateWorkspaceEnvironmentVariableRequestSchema = Type.Partial(Type.Object(Fields), {
  additionalProperties: false, minProperties: 1
});
export type UpdateWorkspaceEnvironmentVariableRequest = Static<typeof UpdateWorkspaceEnvironmentVariableRequestSchema>;

export const SetWorkspaceEnvironmentVariableEnabledRequestSchema = Type.Object({ enabled: Fields.enabled }, { additionalProperties: false });
export type SetWorkspaceEnvironmentVariableEnabledRequest = Static<typeof SetWorkspaceEnvironmentVariableEnabledRequestSchema>;

export const WorkspaceEnvironmentParamsSchema = Type.Object({ workspaceId: Id }, { additionalProperties: false });
export const WorkspaceEnvironmentVariableParamsSchema = Type.Object({ workspaceId: Id, variableId: Id }, { additionalProperties: false });
export const WorkspaceEnvironmentVariablesSchema = Type.Array(WorkspaceEnvironmentVariableSchema);
