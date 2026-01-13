import crypto from "node:crypto";

const SESSION_VERSION = "v1";

export const AUTH_COOKIE_NAME = "awb_session";

export const AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const AUTH_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

type SessionPayloadV1 = {
  iat: number;
  exp: number;
};

function deriveSessionSecret(authToken: string) {
  return crypto.createHash("sha256").update(`awb-session:${authToken}`).digest();
}

function hmacSign(secret: Buffer, input: string) {
  return crypto.createHmac("sha256", secret).update(input).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function toB64UrlJson(obj: unknown) {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64url");
}

function fromB64UrlJson<T>(b64url: string): T | null {
  try {
    const raw = Buffer.from(b64url, "base64url").toString("utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function createSessionCookieValue(params: { authToken: string; nowMs: number; ttlMs: number }) {
  const secret = deriveSessionSecret(params.authToken);
  const payload: SessionPayloadV1 = {
    iat: Math.floor(params.nowMs),
    exp: Math.floor(params.nowMs + params.ttlMs)
  };
  const payloadB64 = toB64UrlJson(payload);
  const signingInput = `${SESSION_VERSION}.${payloadB64}`;
  const sigB64 = hmacSign(secret, signingInput);
  return `${SESSION_VERSION}.${payloadB64}.${sigB64}`;
}

export function verifySessionCookieValue(params: { authToken: string; value: string; nowMs: number }) {
  const raw = String(params.value || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  const [version, payloadB64, sigB64] = parts;
  if (version !== SESSION_VERSION) return false;
  if (!payloadB64 || !sigB64) return false;

  const secret = deriveSessionSecret(params.authToken);
  const signingInput = `${version}.${payloadB64}`;
  const expected = hmacSign(secret, signingInput);
  if (!safeEqual(expected, sigB64)) return false;

  const payload = fromB64UrlJson<SessionPayloadV1>(payloadB64);
  if (!payload) return false;
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return false;
  if (payload.exp <= params.nowMs) return false;
  // 允许少量时钟漂移
  if (payload.iat > params.nowMs + 5 * 60 * 1000) return false;
  return true;
}

export function parseCookieHeader(cookieHeader: string | undefined) {
  const out: Record<string, string> = {};
  const raw = String(cookieHeader || "");
  if (!raw) return out;
  const parts = raw.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name) continue;
    out[name] = value;
  }
  return out;
}

export function buildSetCookieHeader(params: {
  name: string;
  value: string;
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
  path?: string;
}) {
  const segments: string[] = [];
  segments.push(`${params.name}=${params.value}`);
  segments.push(`Path=${params.path || "/"}`);
  if (params.httpOnly) segments.push("HttpOnly");
  if (params.secure) segments.push("Secure");
  if (params.sameSite) segments.push(`SameSite=${params.sameSite}`);
  if (typeof params.maxAgeSeconds === "number") segments.push(`Max-Age=${Math.max(0, Math.floor(params.maxAgeSeconds))}`);
  return segments.join("; ");
}

