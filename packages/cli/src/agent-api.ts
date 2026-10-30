import type { AgentMessageSessionRunState, AgentSessionRecord } from "@agent-workbench/shared";
import type { CliConfigV1, ConfigStore } from "./config.js";
import { readResponseCookie } from "./cookie.js";
import { CliError, errorDiagnostic, isRecord, responseError, withErrorDetails, type ErrorContext, type ErrorPhase, type OperationEffect } from "./errors.js";
import { apiUrl, httpStatusError, parseJson, type HttpRequest, type HttpResult, type HttpStreamResult, type HttpTransport } from "./http.js";
import { compareCodePoints, encodeId, isCount, isId, isTimestamp } from "./validation.js";

export interface ApiDependencies { config: ConfigStore; http: HttpTransport; timeoutMs?: number; signal?: AbortSignal; }
export interface ApiCall<T> extends Omit<HttpRequest, "cookie"> {
  phase: ErrorPhase;
  context?: ErrorContext;
  validate: (value: unknown) => T;
  /** Only confirmed response identities belong here, for persistence-failure context. */
  identity?: (value: T) => ErrorContext;
}

/** One mutable connection per CLI command; sequential requests use the latest persisted Cookie. */
export class AgentApi {
  private constructor(private connection: CliConfigV1, private readonly dependencies: ApiDependencies) {}
  static async connect(dependencies: ApiDependencies): Promise<AgentApi> {
    try { return new AgentApi(await dependencies.config.load(), dependencies); }
    catch (error) { throw withErrorDetails(error instanceof CliError ? error : new CliError(3, "无法读取有效的本地连接配置，请重新执行 awb login。"), { phase: "config", effect: "not_sent" }); }
  }
  async json<T>(path: string, options: ApiCall<T>): Promise<T> {
    const { phase, context = {}, validate, identity, ...request } = options;
    const write = request.method === "POST";
    let effect: OperationEffect = write ? "not_sent" : "not_applicable";
    let known: ErrorContext = context;
    try {
      apiUrl(this.connection.apiOrigin, path); // Also protect injectable transports.
      effect = write ? "unknown" : "not_applicable";
      let result: HttpResult;
      try {
        result = await this.dependencies.http.request(this.connection.apiOrigin, path, {
          ...request, cookie: this.connection.cookie,
          ...(request.timeoutMs ?? this.dependencies.timeoutMs ? { timeoutMs: request.timeoutMs ?? this.dependencies.timeoutMs } : {}),
          ...(request.signal ?? this.dependencies.signal ? { signal: request.signal ?? this.dependencies.signal } : {})
        });
      } catch (error) {
        throw error instanceof CliError ? error : new CliError(5, "网络请求失败，未能确认完整响应。");
      }
      const mainError = httpStatusError(result);
      if (write && result.status >= 400 && result.status < 500) effect = "rejected";
      if (mainError && result.status >= 300 && result.status < 400) throw mainError;
      let value!: T;
      let validationError: unknown;
      if (!mainError) {
        try { value = validate(parseJson(result)); known = { ...context, ...identity?.(value) }; if (write) effect = "accepted"; }
        catch (error) { validationError = error; }
      }
      // Preserve historical renewal-before-response-error precedence. Successful
      // validation may collect identity, but no result is published before save.
      try { await this.renew(result); }
      catch (error) {
        if (mainError && error instanceof CliError) throw new CliError(mainError.exitCode, `${mainError.message}\n${errorDiagnostic(error).trimEnd()}`, mainError.details);
        throw error;
      }
      if (mainError) throw mainError;
      if (validationError) throw validationError;
      return value;
    } catch (error) { throw withErrorDetails(error, { phase, effect, context: known }); }
  }
  async stream<T>(path: string, options: { phase: ErrorPhase; context: ErrorContext; consume: (result: HttpStreamResult) => Promise<T> }): Promise<T> {
    try {
      apiUrl(this.connection.apiOrigin, path);
      if (!this.dependencies.http.stream) throw responseError("当前传输不支持流式下载。");
      return await this.dependencies.http.stream(this.connection.apiOrigin, path, {
        cookie: this.connection.cookie, timeoutMs: this.dependencies.timeoutMs, signal: this.dependencies.signal
      }, async (result) => {
        // Never buffer a successful binary body. Error diagnostics need at most a bounded JSON prefix.
        let body = "";
        if (result.status < 200 || result.status >= 300) {
          const reader = result.body?.getReader();
          try {
            if (reader) { const first = await reader.read(); body = new TextDecoder().decode(first.value?.subarray(0, 8192)); }
          } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
        }
        const mainError = httpStatusError({ status: result.status, body, setCookies: result.setCookies });
        if (mainError && result.status >= 300 && result.status < 400) throw mainError;
        try { await this.renew(result); }
        catch (error) { if (mainError && error instanceof CliError) throw new CliError(mainError.exitCode, `${mainError.message}\n${errorDiagnostic(error).trimEnd()}`, mainError.details); throw error; }
        if (mainError) throw mainError;
        return options.consume(result);
      });
    } catch (error) { throw withErrorDetails(error, { phase: options.phase, effect: "not_applicable", context: options.context }); }
  }
  private async renew(result: Pick<HttpResult, "setCookies">): Promise<void> {
    const cookie = readResponseCookie(result.setCookies, this.connection.apiOrigin);
    if (!cookie) return;
    const next = { ...this.connection, cookie };
    try { await this.dependencies.config.save(next); }
    catch { throw new CliError(7, "无法保存续签凭证，旧配置保持不变；请检查用户目录权限，不要重发已受理操作。", { code: "COOKIE_SAVE_FAILED" }); }
    this.connection = next;
  }
  workspaces(): Promise<WorkspaceView[]> {
    return this.json("/api/workspaces", { phase: "discover", validate: workspaceViews });
  }
  agents(workspaceId: string): Promise<AgentView[]> {
    return this.json(`/api/workspaces/${encodeId(workspaceId)}/agents/available?surface=user`, { phase: "discover", context: { workspaceId }, validate: agentViews });
  }
  session(workspaceId: string, sessionId: string): Promise<AgentSessionRecord> {
    const query = new URLSearchParams({ workspaceId });
    return this.json(`/api/agent/sessions/${encodeId(sessionId)}?${query}`, { phase: "status", context: { workspaceId, sessionId }, validate: (value) => sessionRecord(value, workspaceId, sessionId) });
  }
  runState(workspaceId: string, sessionId: string): Promise<AgentMessageSessionRunState> {
    const query = new URLSearchParams({ workspaceId });
    return this.json(`/api/agent/sessions/${encodeId(sessionId)}/run-state?${query}`, { phase: "status", context: { workspaceId, sessionId }, validate: (value) => runState(value, workspaceId, sessionId) });
  }
}

export interface WorkspaceView { id: string; name: string; }
export interface AgentView { id: string; name: string; summary: string; }
function uniqueIds<T extends { id: string }>(items: T[]): T[] {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw responseError("响应包含重复资源 ID。");
  return items;
}
export function workspaceViews(value: unknown): WorkspaceView[] {
  if (!Array.isArray(value)) throw responseError("工作区列表响应结构无效。");
  const items = value.map((item: unknown) => {
    if (!isRecord(item) || !isId(item.id) || typeof item.title !== "string") throw responseError("工作区列表条目结构无效。");
    return { id: item.id, name: item.title };
  });
  return uniqueIds(items).sort((a, b) => compareCodePoints(a.name, b.name) || compareCodePoints(a.id, b.id));
}
export function agentViews(value: unknown): AgentView[] {
  if (!isRecord(value) || !Array.isArray(value.agents)) throw responseError("Agent 列表响应结构无效。");
  return uniqueIds(value.agents.map((item: unknown) => {
    if (!isRecord(item) || !isId(item.id) || typeof item.name !== "string" || !item.name || typeof item.summary !== "string" || item.summary.length > 160) throw responseError("Agent 列表条目结构无效。");
    return { id: item.id, name: item.name, summary: item.summary };
  }));
}
export function selectAgent(items: AgentView[], explicitId?: string): AgentView {
  const item = explicitId === undefined ? items[0] : items.find((agent) => agent.id === explicitId);
  if (!item) throw new CliError(6, explicitId === undefined ? "没有可用的 user Agent。" : "指定 Agent 不在当前可用 user 列表中。", { code: explicitId === undefined ? "NO_AVAILABLE_AGENT" : "AGENT_UNAVAILABLE", phase: "discover", effect: "not_sent" });
  return item;
}
const nullableId = (value: unknown): value is string | null => value === null || isId(value);
export function sessionRecord(value: unknown, workspaceId: string, sessionId: string): AgentSessionRecord {
  if (!isRecord(value) || value.id !== sessionId || value.workspaceId !== workspaceId
    || typeof value.title !== "string" || (value.kind !== "primary" && value.kind !== "subtask")
    || !nullableId(value.forkedFromSessionId) || !nullableId(value.forkedFromMessageId)
    || !nullableId(value.headMessageId) || !nullableId(value.contextRootMessageId)
    || !isCount(value.revision) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) throw responseError("会话详情响应身份或结构无效。");
  return { id: sessionId, workspaceId, title: value.title, kind: value.kind,
    forkedFromSessionId: value.forkedFromSessionId, forkedFromMessageId: value.forkedFromMessageId,
    headMessageId: value.headMessageId, contextRootMessageId: value.contextRootMessageId,
    revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
export function runState(value: unknown, workspaceId: string, sessionId: string): AgentMessageSessionRunState {
  if (!isRecord(value) || value.workspaceId !== workspaceId || value.sessionId !== sessionId
    || (value.status !== "idle" && value.status !== "running") || !nullableId(value.activeRunId)
    || (value.status === "idle" ? value.activeRunId !== null : value.activeRunId === null)
    || typeof value.runNoticeText !== "string" || !isCount(value.retryCount)
    || !(value.nextRetryAt === null || isTimestamp(value.nextRetryAt)) || !nullableId(value.activeAssistantMessageId)
    || !Array.isArray(value.nonTerminalMessageIds) || !value.nonTerminalMessageIds.every(isId)
    || !Array.isArray(value.nonTerminalToolExecutionIds) || !value.nonTerminalToolExecutionIds.every(isId)
    || !isTimestamp(value.updatedAt)) throw responseError("会话状态响应身份或结构无效。");
  for (const key of ["lastResponseTotalTokens", "contextTokenRatio", "lastRunDurationMs"] as const) {
    const field = value[key];
    if (field !== undefined && field !== null && (typeof field !== "number" || !Number.isFinite(field) || field < 0)) throw responseError("会话状态统计字段无效。");
  }
  if (value.activeRunStartedAt !== undefined && value.activeRunStartedAt !== null && !isTimestamp(value.activeRunStartedAt)) throw responseError("会话状态时间字段无效。");
  // Preserve validated internal fields for follow; public status output is a separate narrow projection.
  return { workspaceId, sessionId, status: value.status, activeRunId: value.activeRunId,
    runNoticeText: value.runNoticeText, retryCount: value.retryCount, nextRetryAt: value.nextRetryAt,
    activeAssistantMessageId: value.activeAssistantMessageId, nonTerminalMessageIds: value.nonTerminalMessageIds,
    nonTerminalToolExecutionIds: value.nonTerminalToolExecutionIds, updatedAt: value.updatedAt };
}
