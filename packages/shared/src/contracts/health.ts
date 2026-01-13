import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const HealthResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    name: Type.Literal("agent-workbench"),
    version: Type.String(),
    authEnabled: Type.Boolean(),
    authed: Type.Boolean()
  },
  { $id: "HealthResponse" }
);
export type HealthResponse = Static<typeof HealthResponseSchema>;

