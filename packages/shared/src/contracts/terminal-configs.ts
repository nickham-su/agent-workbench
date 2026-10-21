import { Type, type Static } from "@sinclair/typebox";

export const TERMINAL_CONFIG_COMMAND_MAX_LENGTH = 65536;
export const TerminalConfigInputSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  cwd: Type.String({ maxLength: 4096 }),
  command: Type.String({ minLength: 1, maxLength: TERMINAL_CONFIG_COMMAND_MAX_LENGTH })
}, { additionalProperties: false });
export type TerminalConfigInput = Static<typeof TerminalConfigInputSchema>;
export const UpdateTerminalConfigRequestSchema = Type.Partial(TerminalConfigInputSchema);
export type UpdateTerminalConfigRequest = Static<typeof UpdateTerminalConfigRequestSchema>;
export const TerminalConfigRecordSchema = Type.Object({
  id: Type.String(), workspaceId: Type.String(),
  ...TerminalConfigInputSchema.properties,
  createdAt: Type.Number(), updatedAt: Type.Number()
});
export type TerminalConfigRecord = Static<typeof TerminalConfigRecordSchema>;
