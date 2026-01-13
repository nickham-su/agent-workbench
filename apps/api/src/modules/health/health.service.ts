import type { HealthResponse } from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { isRequestAuthed } from "../../app/auth.js";

export function getHealth(ctx: AppContext, req: { headers: { cookie?: string | undefined } }): HealthResponse {
  const authEnabled = Boolean(ctx.authToken);
  const authed = authEnabled ? isRequestAuthed(ctx, req) : true;
  return { ok: true, name: "agent-workbench", version: ctx.version, authEnabled, authed };
}
