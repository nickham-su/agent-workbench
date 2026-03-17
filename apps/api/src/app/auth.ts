import type { FastifyInstance } from "fastify";
import type { AppContext } from "./context.js";
import { HttpError } from "./errors.js";
import { AUTH_COOKIE_NAME, parseCookieHeader, verifySessionCookieValue } from "../infra/auth/sessionCookie.js";
import { nowMs } from "../utils/time.js";

export function isRequestAuthed(ctx: AppContext, req: { headers: { cookie?: string | undefined } }) {
  if (!ctx.authToken) return true;
  const cookies = parseCookieHeader(req.headers.cookie);
  const v = cookies[AUTH_COOKIE_NAME];
  if (!v) return false;
  return verifySessionCookieValue({ authToken: ctx.authToken, value: v, nowMs: nowMs() });
}

export async function registerAuthGuards(app: FastifyInstance, ctx: AppContext) {
  // Guard ALL internal endpoints with internal token.
  // Must be enabled regardless of whether web auth (cookie) is enabled.
  app.addHook("onRequest", async (req) => {
    const url = String(req.raw.url || "");
    const path = url.split("?")[0] || "";
    if (!url.startsWith("/api/")) return;
    if (!path.startsWith("/api/internal/")) return;

    const token = String(req.headers["x-awb-agent-internal-token"] || "");
    if (token !== ctx.agentInternalToken) {
      throw new HttpError(401, "Unauthorized");
    }
  });

  // If web auth is disabled, no further guards are needed.
  if (!ctx.authToken) return;

  app.addHook("onRequest", async (req) => {
    const url = String(req.raw.url || "");
    const path = url.split("?")[0] || "";
    if (!url.startsWith("/api/")) return;
    if (path === "/api/health") return;
    if (path === "/api/auth/login") return;
    if (path.startsWith("/api/internal/")) return;

    // WebSocket 鉴权放在 handler 内，确保能返回自定义 close code（4401），避免浏览器表现为“连接失败/1006”。
    if (path.startsWith("/api/terminals/") && path.endsWith("/ws")) return;

    const ok = isRequestAuthed(ctx, req as any);
    if (!ok) throw new HttpError(401, "Unauthorized");
  });
}
