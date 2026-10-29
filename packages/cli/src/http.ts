import { requestCookieHeader, type SessionCookie } from "./cookie.js";
import { CliError, isRecord, responseError } from "./errors.js";

export interface HttpResult { status: number; body: string; setCookies: string[]; }
export interface HttpRequest {
  method?: "GET" | "POST";
  body?: unknown;
  formData?: FormData;
  cookie?: SessionCookie | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface HttpStreamResult { status: number; headers: Headers; setCookies: string[]; body: ReadableStream<Uint8Array> | null; signal: AbortSignal; }
export interface HttpTransport {
  request(apiOrigin: string, path: string, request?: HttpRequest): Promise<HttpResult>;
  /** The consumer must finish reading/writing before returning; its whole lifetime is timed. */
  stream?<T>(apiOrigin: string, path: string, request: HttpRequest, consume: (result: HttpStreamResult) => Promise<T>): Promise<T>;
}

/** Validate exact pathname, not merely origin: WHATWG URL normalizes encoded dot segments. */
export function apiUrl(apiOrigin: string, path: string): URL {
  try {
    const url = new URL(path, apiOrigin);
    const expectedPath = path.split("?", 1)[0];
    if (!path.startsWith("/api/") || /[\u0000-\u0020\u007f\\#]/.test(path)
      || url.origin !== apiOrigin || url.hash !== "" || url.pathname !== expectedPath) throw new Error("Invalid route");
    return url;
  } catch {
    throw new CliError(6, "请求地址的 origin 或路径结构无效，未发送请求。", { effect: "not_sent" });
  }
}

export class HttpClient implements HttpTransport {
  constructor(private readonly fetchRequest: typeof fetch = fetch, private readonly timeoutMs = 30_000) {}
  async request(apiOrigin: string, path: string, request: HttpRequest = {}): Promise<HttpResult> {
    return this.perform(apiOrigin, path, request, async (response) => ({
      status: response.status, body: await response.text(), setCookies: response.headers.getSetCookie()
    }));
  }
  async stream<T>(apiOrigin: string, path: string, request: HttpRequest, consume: (result: HttpStreamResult) => Promise<T>): Promise<T> {
    return this.perform(apiOrigin, path, request, async (response, signal) => {
      try { return await consume({ status: response.status, headers: response.headers, setCookies: response.headers.getSetCookie(), body: response.body, signal }); }
      finally { await response.body?.cancel().catch(() => {}); }
    });
  }
  private async perform<T>(apiOrigin: string, path: string, request: HttpRequest, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    const url = apiUrl(apiOrigin, path);
    if (request.formData !== undefined && request.body !== undefined) throw new CliError(2, "JSON 与 multipart 请求体不能同时提供。", { effect: "not_sent" });
    const headers: Record<string, string> = { Accept: "application/json" };
    const cookie = requestCookieHeader(apiOrigin, request.cookie ?? null);
    if (cookie) headers.Cookie = cookie;
    let body: string | FormData | undefined;
    try {
      body = request.formData ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
    } catch { throw new CliError(2, "无法构建请求体，未发送请求。", { effect: "not_sent" }); }
    if (request.body !== undefined) headers["Content-Type"] = "application/json";
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 86_400_000) throw new CliError(2, "请求时限无效。", { effect: "not_sent" });
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (request.signal?.aborted) throw new CliError(5, "请求已在发送前中止。", { effect: "not_sent" });
    request.signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await this.fetchRequest(url, { method: request.method ?? "GET", headers, body, redirect: "manual", signal: controller.signal });
      const value = await consume(response, controller.signal);
      if (controller.signal.aborted) throw new Error("Request aborted during body consumption");
      return value;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(5, timedOut ? "单次请求时限已耗尽，未能确认完整响应。" : "网络请求失败或响应传输中断，未能确认完整响应。", {
        code: timedOut ? "REQUEST_TIMEOUT" : "TRANSPORT_FAILED", effect: request.method === "POST" ? "unknown" : "not_applicable"
      });
    } finally { clearTimeout(timer); request.signal?.removeEventListener("abort", abort); }
  }
}

export function parseJson(result: HttpResult): unknown {
  try { return JSON.parse(result.body); } catch { throw responseError("服务未返回有效 JSON 响应。"); }
}
const safeErrorCodes = new Set([
  "AGENT_SESSION_QUERY_INVALID", "AGENT_SESSION_QUERY_STATE_INVALID", "WORKSPACE_NOT_FOUND",
  "AGENT_COMPACTION_EMPTY", "AGENT_WORKER_UNAVAILABLE", "AGENT_SUBTASK_READONLY", "SESSION_RUNNING"
]);
export function httpStatusError(result: HttpResult): CliError | null {
  if (result.status >= 200 && result.status < 300) return null;
  let serviceCode: string | undefined;
  try { const body: unknown = JSON.parse(result.body); if (isRecord(body) && typeof body.code === "string" && safeErrorCodes.has(body.code)) serviceCode = body.code; } catch { /* Status remains authoritative. */ }
  const suffix = serviceCode ? `（${serviceCode}）` : "";
  const details = { code: result.status === 401 ? "AUTH_REQUIRED" : "HTTP_REJECTED", ...(serviceCode ? { serviceCode } : {}) };
  if (result.status === 401) return new CliError(4, `HTTP 401${suffix}：认证失败，请重新执行 awb login。`, details);
  if (result.status >= 300 && result.status < 400) return new CliError(6, `HTTP ${result.status}：不跟随重定向，请检查服务 origin。`, details);
  return new CliError(6, `HTTP ${result.status}${suffix}：API 请求失败。`, details);
}
