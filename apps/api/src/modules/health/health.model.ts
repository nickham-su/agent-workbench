import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const HealthResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    name: Type.Literal("agent-workbench"),
    version: Type.String()
  },
  { $id: "HealthResponse" }
);
export type HealthResponse = Static<typeof HealthResponseSchema>;
