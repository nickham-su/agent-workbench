import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const CredentialKindSchema = Type.Union([Type.Literal("https"), Type.Literal("ssh")]);
export type CredentialKind = Static<typeof CredentialKindSchema>;

export const CredentialRecordSchema = Type.Object({
  id: Type.String(),
  host: Type.String(),
  kind: CredentialKindSchema,
  label: Type.Union([Type.String(), Type.Null()]),
  username: Type.Union([Type.String(), Type.Null()]),
  isDefault: Type.Boolean(),
  createdAt: Type.Number(),
  updatedAt: Type.Number()
});
export type CredentialRecord = Static<typeof CredentialRecordSchema>;

export const CreateCredentialRequestSchema = Type.Object({
  host: Type.String({ minLength: 1 }),
  kind: CredentialKindSchema,
  label: Type.Optional(Type.String()),
  username: Type.Optional(Type.String()),
  secret: Type.String({ minLength: 1 }),
  isDefault: Type.Optional(Type.Boolean())
});
export type CreateCredentialRequest = Static<typeof CreateCredentialRequestSchema>;

export const UpdateCredentialRequestSchema = Type.Object({
  label: Type.Optional(Type.String()),
  username: Type.Optional(Type.String()),
  secret: Type.Optional(Type.String({ minLength: 1 })),
  isDefault: Type.Optional(Type.Boolean())
});
export type UpdateCredentialRequest = Static<typeof UpdateCredentialRequestSchema>;

