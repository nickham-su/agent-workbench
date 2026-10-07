import { isRecord, responseError } from "./errors.js";

export const SESSION_COOKIE_NAME = "awb_session";

export interface SessionCookie {
  name: typeof SESSION_COOKIE_NAME;
  value: string;
  secure: boolean;
}

export function isSessionCookie(value: unknown): value is SessionCookie {
  return isRecord(value)
    && Object.keys(value).length === 3
    && value.name === SESSION_COOKIE_NAME
    && typeof value.value === "string"
    && /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.value)
    && typeof value.secure === "boolean";
}

/** Only this service's host-only, Path=/ cookie is supported; not a cookie jar. */
export function readResponseCookie(headers: readonly string[], apiOrigin: string): SessionCookie | null {
  let result: SessionCookie | null = null;
  const knownAttributes = new Set(["domain", "path", "max-age", "expires", "secure", "httponly", "samesite"]);
  for (const header of headers) {
    const parts = header.split(";");
    const rawPair = parts.shift()!;
    const pair = rawPair.trim();
    const equals = pair.indexOf("=");
    const name = (equals < 0 ? pair : pair.slice(0, equals)).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    if (/[\x00-\x1f\x7f]/.test(rawPair)) {
      throw responseError("服务会话 Cookie 值包含非法控制字符。");
    }
    if (result || equals < 0) throw responseError("服务返回了无效或重复的会话 Cookie。");
    const value = pair.slice(equals + 1);
    const attributes = new Map<string, string | null>();
    for (const part of parts) {
      const text = part.trim();
      if (!text) continue;
      const separator = text.indexOf("=");
      const attribute = (separator < 0 ? text : text.slice(0, separator)).trim().toLowerCase();
      if (!knownAttributes.has(attribute)) continue;
      if (attributes.has(attribute)) throw responseError("服务返回了重复的会话 Cookie 属性。");
      attributes.set(attribute, separator < 0 ? null : text.slice(separator + 1).trim());
    }
    if (attributes.has("domain") || attributes.has("expires") || attributes.get("path") !== "/") {
      throw responseError("服务会话 Cookie 必须是无 Domain、无 Expires 且显式 Path=/ 的固定形式。");
    }
    if (attributes.has("max-age") && attributes.get("max-age") !== "2592000") {
      throw responseError("服务会话 Cookie 的 Max-Age 不符合固定有效期。");
    }
    // Secure is a flag, not a value; accepting Secure=false would lose its meaning.
    if (attributes.has("secure") && attributes.get("secure") !== null) {
      throw responseError("服务会话 Cookie 的 Secure 属性无效。");
    }
    const cookie = { name: SESSION_COOKIE_NAME, value, secure: attributes.has("secure") };
    if (!isSessionCookie(cookie)) throw responseError("服务返回了无效的会话 Cookie。");
    if (cookie.secure && new URL(apiOrigin).protocol !== "https:") {
      throw responseError("服务返回 Secure 会话 Cookie，请使用 HTTPS origin 登录。");
    }
    result = cookie;
  }
  return result;
}

export function requestCookieHeader(apiOrigin: string, cookie: SessionCookie | null): string | undefined {
  if (!cookie || (cookie.secure && new URL(apiOrigin).protocol !== "https:")) return undefined;
  if (!isSessionCookie(cookie)) throw responseError("会话 Cookie 结构无效。");
  return `${SESSION_COOKIE_NAME}=${cookie.value}`;
}
