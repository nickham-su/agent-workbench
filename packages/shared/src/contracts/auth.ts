import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const AuthLoginRequestSchema = Type.Object({
  token: Type.String({ minLength: 1 }),
  remember: Type.Optional(Type.Boolean())
});
export type AuthLoginRequest = Static<typeof AuthLoginRequestSchema>;

export const AuthLoginResponseSchema = Type.Object({
  ok: Type.Literal(true)
});
export type AuthLoginResponse = Static<typeof AuthLoginResponseSchema>;

