import crypto from "node:crypto";
import type { FastifyReply } from "fastify";
import type { AuthLoginRequest } from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import { nowMs } from "../../utils/time.js";
import type { AppContext } from "../../app/context.js";
import {
  AUTH_COOKIE_NAME,
  AUTH_REMEMBER_TTL_MS,
  AUTH_SESSION_TTL_MS,
  buildSetCookieHeader,
  createSessionCookieValue
} from "../../infra/auth/sessionCookie.js";

function safeEqualToken(input: string, expected: string) {
  const a = Buffer.from(String(input || ""), "utf-8");
  const b = Buffer.from(String(expected || ""), "utf-8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function login(ctx: AppContext, reply: FastifyReply, bodyRaw: unknown) {
  if (!ctx.authToken) {
    throw new HttpError(400, "Auth is not enabled");
  }
  const body = (bodyRaw ?? {}) as AuthLoginRequest;
  const token = String((body as any).token || "");
  const remember = Boolean((body as any).remember);
  if (!token) throw new HttpError(400, "Token is required");
  if (!safeEqualToken(token, ctx.authToken)) {
    throw new HttpError(401, "Unauthorized");
  }

  const ttlMs = remember ? AUTH_REMEMBER_TTL_MS : AUTH_SESSION_TTL_MS;
  const value = createSessionCookieValue({ authToken: ctx.authToken, nowMs: nowMs(), ttlMs });
  const header = buildSetCookieHeader({
    name: AUTH_COOKIE_NAME,
    value,
    httpOnly: true,
    sameSite: "Lax",
    secure: ctx.authCookieSecure,
    path: "/",
    maxAgeSeconds: remember ? Math.floor(AUTH_REMEMBER_TTL_MS / 1000) : undefined
  });
  reply.header("Set-Cookie", header);
  return { ok: true as const };
}

