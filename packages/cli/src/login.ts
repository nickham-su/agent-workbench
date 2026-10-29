import type { ConfigStore } from "./config.js";
import { readResponseCookie } from "./cookie.js";
import { CliError, isRecord, responseError, withErrorDetails } from "./errors.js";
import { httpStatusError, parseJson, type HttpTransport } from "./http.js";
import { normalizeOrigin } from "./origin.js";
import { writeSuccess } from "./output.js";
import { readLoginToken, type CliIO } from "./token-input.js";

export interface LoginOptions { url: string; tokenStdin?: boolean; }
export interface LoginDependencies { config: ConfigStore; http: HttpTransport; io: CliIO; json?: boolean; timeoutMs?: number; signal?: AbortSignal; }
function healthAuthEnabled(value: unknown): boolean {
  if (!isRecord(value) || value.ok !== true || value.name !== "agent-workbench" || typeof value.version !== "string"
    || typeof value.authEnabled !== "boolean" || typeof value.authed !== "boolean" || typeof value.previewEnabled !== "boolean") throw responseError("服务健康响应结构无效。");
  return value.authEnabled;
}
export async function login(options: LoginOptions, dependencies: LoginDependencies): Promise<void> {
  const apiOrigin = normalizeOrigin(options.url);
  const { config, http, io } = dependencies;
  const request = { ...(dependencies.timeoutMs ? { timeoutMs: dependencies.timeoutMs } : {}), ...(dependencies.signal ? { signal: dependencies.signal } : {}) };
  let phase: "status" | "input" | "send" | "config" = "status";
  let effect: "not_applicable" | "not_sent" | "unknown" | "rejected" | "accepted" = "not_applicable";
  try {
    // Initialization never loads an old connection or sends its Cookie.
    const health = await http.request(apiOrigin, "/api/health", request);
    const healthError = httpStatusError(health);
    if (healthError) throw healthError;
    const authEnabled = healthAuthEnabled(parseJson(health));
    if (!authEnabled) {
      phase = "config";
      await save({ version: 1, apiOrigin, cookie: null });
      await writeSuccess(io, Boolean(dependencies.json), "login", { authEnabled: false, authenticated: false }, "连接初始化成功（服务未开启认证）。\n");
      return;
    }
    phase = "input"; effect = "not_sent";
    const token = await readLoginToken(io, Boolean(options.tokenStdin));
    phase = "send"; effect = "unknown";
    const result = await http.request(apiOrigin, "/api/auth/login", { ...request, method: "POST", body: { token, remember: true } });
    if (result.status >= 400 && result.status < 500) effect = "rejected";
    const error = httpStatusError(result);
    if (error) throw error;
    const response = parseJson(result);
    if (!isRecord(response) || response.ok !== true) throw responseError("服务登录响应结构无效。");
    effect = "accepted";
    const cookie = readResponseCookie(result.setCookies, apiOrigin);
    if (!cookie) throw responseError("登录响应缺少会话 Cookie，未保存配置。");
    await save({ version: 1, apiOrigin, cookie });
    await writeSuccess(io, Boolean(dependencies.json), "login", { authEnabled: true, authenticated: true }, "登录成功，已保存连接与会话凭证。\n");
  } catch (error) { throw withErrorDetails(error, { phase, effect }); }
  async function save(value: Parameters<ConfigStore["save"]>[0]): Promise<void> {
    try { await config.save(value); }
    catch { throw new CliError(7, "无法保存连接与会话凭证，旧配置保持不变；请检查用户目录权限。", { code: "COOKIE_SAVE_FAILED" }); }
  }
}
