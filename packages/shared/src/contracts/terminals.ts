import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const TerminalStatusSchema = Type.Union(
  [Type.Literal("active"), Type.Literal("closed"), Type.Literal("errored")]
);
export type TerminalStatus = Static<typeof TerminalStatusSchema>;

export const TerminalRecordSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    sessionName: Type.String(),
    status: TerminalStatusSchema,
    createdAt: Type.Number(),
    updatedAt: Type.Number()
  }
);
export type TerminalRecord = Static<typeof TerminalRecordSchema>;

export const CreateTerminalRequestSchema = Type.Object(
  {
    shell: Type.Optional(Type.String())
  }
);
export type CreateTerminalRequest = Static<typeof CreateTerminalRequestSchema>;
