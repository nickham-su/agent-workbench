import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const ErrorResponseSchema = Type.Object(
  {
    message: Type.String(),
    code: Type.Optional(Type.String())
  }
);
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

export const IdSchema = Type.String({ minLength: 1 });
