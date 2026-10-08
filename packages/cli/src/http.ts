import { requestCookieHeader, type SessionCookie } from "./cookie.js";
import { CliError, isRecord, responseError } from "./errors.js";

export interface HttpResult {
  status: number;
  body: string;
  setCookies: string[];
}

export interface HttpRequest {
  method?: "GET" | "POST";
  body?: unknown;
  cookie?: SessionCookie | null;
}

export interface HttpTransport {
  request(apiOrigin: string, path: string, request?: HttpRequest): Promise<HttpResult>;
}

export class HttpClient implements HttpTransport {
  constructor(private readonly fetchRequest: typeof fetch = fetch, private readonly timeoutMs = 30_000) {}

  async request(apiOrigin: string, path: string, request: HttpRequest = {}): Promise<HttpResult> {
    const url = new URL(path, apiOrigin);
    if (url.origin !== apiOrigin || !url.pathname.startsWith("/api/")) {
      throw responseError("请求地址不属于已配置的 API origin。");
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    const cookie = requestCookieHeader(apiOrigin, request.cookie ?? null);
    if (cookie) headers.Cookie = cookie;
    if (request.body !== undefined) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchRequest(url, {
        method: request.method ?? "GET",
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: "manual",
        signal: controller.signal
      });
      // Keep the timer active through the complete body. Never expose a partial
      // body or Cookie to callers after a timeout or transport interruption.
      const body = await response.text();
      return { status: response.status, body, setCookies: response.headers.getSetCookie() };
    } catch {
      throw new CliError(5, "网络请求失败、超时或响应传输中断；请检查连接后重试。");
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseJson(result: HttpResult): unknown {
  try {
    return JSON.parse(result.body);
  } catch {
    throw responseError("服务未返回有效 JSON 响应。");
  }
}

// Only documented service codes are echoed. Arbitrary response strings may
// contain credentials even when they happen to resemble an error code.
const safeErrorCodes = new Set([
  "AGENT_SESSION_QUERY_INVALID",
  "AGENT_SESSION_QUERY_STATE_INVALID",
  "WORKSPACE_NOT_FOUND"
]);

export function httpStatusError(result: HttpResult): CliError | null {
  if (result.status >= 200 && result.status < 300) return null;
  let code = "";
  try {
    const body: unknown = JSON.parse(result.body);
    if (isRecord(body) && typeof body.code === "string" && safeErrorCodes.has(body.code)) code = `（${body.code}）`;
  } catch {
    // Non-JSON error bodies still have an authoritative HTTP status.
  }
  if (result.status === 401) return new CliError(4, `HTTP 401${code}：认证失败，请重新执行 awb login。`);
  if (result.status >= 300 && result.status < 400) return responseError(`HTTP ${result.status}：不跟随重定向，请检查服务 origin。`);
  return responseError(`HTTP ${result.status}${code}：API 请求失败。`);
}
