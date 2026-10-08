import type { ConfigStore } from "./config.js";
import { readResponseCookie } from "./cookie.js";
import { isRecord, responseError } from "./errors.js";
import { httpStatusError, parseJson, type HttpTransport } from "./http.js";
import { normalizeOrigin } from "./origin.js";
import { readLoginToken, type CliIO } from "./token-input.js";

export interface LoginOptions {
  url: string;
  tokenStdin?: boolean;
}

export interface LoginDependencies {
  config: ConfigStore;
  http: HttpTransport;
  io: CliIO;
}

function healthAuthEnabled(value: unknown): boolean {
  if (!isRecord(value) || value.ok !== true || value.name !== "agent-workbench"
    || typeof value.version !== "string" || typeof value.authEnabled !== "boolean"
    || typeof value.authed !== "boolean" || typeof value.previewEnabled !== "boolean") {
    throw responseError("服务健康响应结构无效。");
  }
  return value.authEnabled;
}

export async function login(options: LoginOptions, dependencies: LoginDependencies): Promise<void> {
  const apiOrigin = normalizeOrigin(options.url);
  const { config, http, io } = dependencies;
  // Initialization never reads an old connection or sends its Cookie. Check
  // health before deciding whether TTY or stdin input is needed.
  const health = await http.request(apiOrigin, "/api/health");
  const healthError = httpStatusError(health);
  if (healthError) throw healthError;
  if (!healthAuthEnabled(parseJson(health))) {
    await config.save({ version: 1, apiOrigin, cookie: null });
    io.stdout.write("连接初始化成功（服务未开启认证）。\n");
    return;
  }
  const token = await readLoginToken(io, Boolean(options.tokenStdin));
  const result = await http.request(apiOrigin, "/api/auth/login", {
    method: "POST",
    body: { token, remember: true }
  });
  const error = httpStatusError(result);
  if (error) throw error;
  const response = parseJson(result);
  if (!isRecord(response) || response.ok !== true) throw responseError("服务登录响应结构无效。");
  const cookie = readResponseCookie(result.setCookies, apiOrigin);
  if (!cookie) throw responseError("登录响应缺少会话 Cookie，未保存配置。");
  await config.save({ version: 1, apiOrigin, cookie });
  io.stdout.write("登录成功，已保存连接与会话凭证。\n");
}
