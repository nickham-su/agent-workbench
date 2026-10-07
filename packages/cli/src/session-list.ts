import type { ConfigStore } from "./config.js";
import { readResponseCookie } from "./cookie.js";
import { CliError, errorDiagnostic } from "./errors.js";
import { httpStatusError, parseJson, type HttpTransport } from "./http.js";
import { renderSessionList } from "./session-list-output.js";
import { validateSessionQueryResponse, type SessionListQuery } from "./session-query.js";
import type { CliIO } from "./token-input.js";

export interface SessionListDependencies {
  config: ConfigStore;
  http: HttpTransport;
  io: CliIO;
}

export async function listSessions(query: SessionListQuery, dependencies: SessionListDependencies): Promise<void> {
  const { config, http, io } = dependencies;
  const connection = await config.load();
  const parameters = new URLSearchParams({
    workspaceId: query.workspaceId,
    updatedWithinSeconds: String(query.updatedWithinSeconds),
    kind: query.kind,
    status: query.status
  });
  const result = await http.request(connection.apiOrigin, `/api/agent/sessions/query?${parameters}`, { cookie: connection.cookie });
  const mainError = httpStatusError(result);
  // A redirect is never a renewal source, even if it includes a target Cookie.
  if (mainError && result.status >= 300 && result.status < 400) throw mainError;

  // HttpTransport only returns after the complete body. Keep Cookie validation
  // and persistence before any successful response JSON/DTO parsing.
  try {
    const cookie = readResponseCookie(result.setCookies, connection.apiOrigin);
    if (cookie) {
      try {
        await config.save({ ...connection, cookie });
      } catch {
        throw new CliError(7, "无法保存续签凭证，旧配置保持不变；请检查用户目录权限后重试。");
      }
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    if (mainError) {
      // Retain the HTTP business category and code, then add only locally
      // authored renewal diagnostics. Never print response or exception text.
      throw new CliError(mainError.exitCode, `${mainError.message}\n${errorDiagnostic(error).trimEnd()}`);
    }
    throw error;
  }
  if (mainError) throw mainError;
  const response = validateSessionQueryResponse(parseJson(result), query);
  io.stdout.write(renderSessionList(response, query.duration));
}
