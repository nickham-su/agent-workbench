import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "./context.js";
import { HttpError } from "./errors.js";
import {
  AUTH_COOKIE_NAME,
  buildSetCookieHeader,
  createSessionCookieValue,
  getSessionCookieRenewalWindow,
  parseCookieHeader,
  readSessionCookiePayload,
  verifySessionCookieValue
} from "../infra/auth/sessionCookie.js";
import { nowMs } from "../utils/time.js";

type AuthContext = Pick<AppContext, "authToken" | "authCookieSecure" | "agentInternalToken">;

export function isRequestAuthed(ctx: Pick<AuthContext, "authToken">, req: { headers: { cookie?: string | undefined } }) {
  if (!ctx.authToken) return true;
  const cookies = parseCookieHeader(req.headers.cookie);
  const v = cookies[AUTH_COOKIE_NAME];
  if (!v) return false;
  return verifySessionCookieValue({ authToken: ctx.authToken, value: v, nowMs: nowMs() });
}

function isInternalTokenRoute(path: string) {
  // Analytics producers use an internal endpoint outside the /api/internal/ prefix.
  // Match only that route, not the Dashboard or other Analytics endpoints.
  return path.startsWith("/api/internal/") || path === "/api/analytics/internal/signal";
}

export async function registerAuthGuards(
  app: FastifyInstance,
  ctx: AuthContext,
  options: { clock?: () => number } = {}
) {
  // Guard ALL internal endpoints with internal token.
  // Must be enabled regardless of whether web auth (cookie) is enabled.
  app.addHook("onRequest", async (req) => {
    const url = String(req.raw.url || "");
    const path = url.split("?")[0] || "";
    if (!url.startsWith("/api/")) return;
    if (!isInternalTokenRoute(path)) return;

    const token = String(req.headers["x-awb-agent-internal-token"] || "");
    if (token !== ctx.agentInternalToken) {
      throw new HttpError(401, "Unauthorized");
    }
  });

  // If web auth is disabled, no further guards are needed.
  if (!ctx.authToken) return;

  const authToken = ctx.authToken;
  const clock = options.clock ?? nowMs;
  // Each candidate belongs to exactly one authenticated request and cannot leak to another request.
  const renewalCandidates = new WeakMap<FastifyRequest, string>();

  app.addHook("onRequest", async (req) => {
    const url = String(req.raw.url || "");
    const path = url.split("?")[0] || "";
    if (!url.startsWith("/api/")) return;
    if (path === "/api/health") return;
    if (path === "/api/auth/login") return;
    if (isInternalTokenRoute(path)) return;

    // WebSocket 鉴权放在 handler 内，确保能返回自定义 close code（4401），避免浏览器表现为“连接失败/1006”。
    if (path.startsWith("/api/terminals/") && path.endsWith("/ws")) return;

    const currentTimeMs = clock();
    const cookie = parseCookieHeader(req.headers.cookie)[AUTH_COOKIE_NAME];
    const payload = cookie ? readSessionCookiePayload({ authToken, value: cookie, nowMs: currentTimeMs }) : null;
    if (!payload) throw new HttpError(401, "Unauthorized");

    // Upgrades authenticate normally unless their handler owns authentication, but never renew a Cookie.
    if (req.headers.upgrade?.toLowerCase() === "websocket") return;
    const window = getSessionCookieRenewalWindow(payload, currentTimeMs);
    if (!window) return;
    renewalCandidates.set(req, buildSetCookieHeader({
      name: AUTH_COOKIE_NAME,
      value: createSessionCookieValue({ authToken, nowMs: currentTimeMs, ttlMs: window.ttlMs }),
      httpOnly: true,
      sameSite: "Lax",
      secure: ctx.authCookieSecure,
      path: "/",
      maxAgeSeconds: window.maxAgeSeconds
    }));
  });

  // This covers normal replies (including authenticated business errors and non-hijacked streams).
  // A future public raw/hijacked stream must arrange its first response headers separately.
  app.addHook("onSend", async (req, reply, payload) => {
    const renewal = renewalCandidates.get(req);
    renewalCandidates.delete(req);
    if (!renewal || reply.statusCode === 101) return payload;

    const existing = reply.getHeader("set-cookie");
    const cookies = Array.isArray(existing) ? existing : existing === undefined ? [] : [String(existing)];
    if (cookies.some((header) => header.slice(0, header.indexOf("=")).trim() === AUTH_COOKIE_NAME)) return payload;
    // Replace the logical header once: Fastify otherwise appends existing values again.
    // This also preserves Cookies a handler placed on reply.raw rather than reply.header.
    reply.removeHeader("set-cookie").header("set-cookie", [...cookies, renewal]);
    return payload;
  });
}
