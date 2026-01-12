import type { HealthResponse } from "./health.model.js";
import type { AppContext } from "../../app/context.js";

export function getHealth(ctx: AppContext): HealthResponse {
  return { ok: true, name: "agent-workbench", version: ctx.version };
}
