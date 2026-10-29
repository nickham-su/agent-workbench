import type {
  AgentSessionQueryItem,
  AgentSessionQueryKind,
  AgentSessionQueryRequest,
  AgentSessionQueryResponse,
  AgentSessionQueryStatus
} from "@agent-workbench/shared/contracts/agent-session-query";
import { CliError, isRecord, responseError } from "./errors.js";
import { isId, parseDuration, validateId } from "./validation.js";

export interface SessionListOptions {
  workspace: string;
  updatedWithin: string;
  kind?: string;
  status?: string;
}

export interface SessionListQuery extends Required<AgentSessionQueryRequest> {
  duration: string;
}

const maximumSeconds = 90 * 24 * 60 * 60;
const maximumTimestamp = 8_640_000_000_000_000;

function isStatus(value: unknown): value is AgentSessionQueryStatus {
  return value === "idle" || value === "running" || value === "all";
}

export function parseSessionListOptions(options: SessionListOptions): SessionListQuery {
  validateId(options.workspace);
  const seconds = parseDuration(options.updatedWithin, maximumSeconds, "更新时间窗口");
  const kind = options.kind === undefined ? "primary" : options.kind;
  const status = options.status === undefined ? "all" : options.status;
  if (kind !== "primary") throw new CliError(2, "会话列表现仅支持 primary；subtask/all 已移除，请用已知 ID 查询 show/messages/status。", { effect: "not_sent" });
  if (!isStatus(status)) throw new CliError(2, "Session 状态参数无效，请查看 session list --help。");
  return { workspaceId: options.workspace, updatedWithinSeconds: seconds, kind, status, duration: options.updatedWithin };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= maximumTimestamp;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const responseKeys = ["workspaceId", "updatedWithinSeconds", "updatedFrom", "updatedTo", "kind", "status", "total", "items"];
const itemKeys = ["id", "title", "kind", "status", "createdAt", "updatedAt", "userMessageCount", "completedAssistantMessageCount"];

/** Validate both the closed DTO structure and its relationship to this request. */
export function validateSessionQueryResponse(value: unknown, query: SessionListQuery): AgentSessionQueryResponse {
  if (!isRecord(value) || !hasExactKeys(value, responseKeys)
    || value.workspaceId !== query.workspaceId || value.updatedWithinSeconds !== query.updatedWithinSeconds
    || value.kind !== query.kind || value.status !== query.status
    || !isTimestamp(value.updatedFrom) || !isTimestamp(value.updatedTo)
    || value.updatedTo - value.updatedFrom !== query.updatedWithinSeconds * 1000
    || !isCount(value.total) || !Array.isArray(value.items) || value.total !== value.items.length) {
    throw responseError("Session 查询响应结构、筛选回显、时间窗口或总数无效。");
  }
  const ids = new Set<string>();
  const from = value.updatedFrom;
  const to = value.updatedTo;
  const items: AgentSessionQueryItem[] = value.items.map((item: unknown) => {
    if (!isRecord(item) || !hasExactKeys(item, itemKeys)
      || !isId(item.id) || ids.has(item.id)
      || typeof item.title !== "string"
      || (item.kind !== "primary" && item.kind !== "subtask")
      || (item.status !== "idle" && item.status !== "running")
      || (query.kind !== "all" && item.kind !== query.kind)
      || (query.status !== "all" && item.status !== query.status)
      || !isTimestamp(item.createdAt) || !isTimestamp(item.updatedAt) || item.updatedAt < from || item.updatedAt > to
      || !isCount(item.userMessageCount) || !isCount(item.completedAssistantMessageCount)) {
      throw responseError("Session 查询条目字段、筛选、时间或累计计数无效，未输出部分列表。");
    }
    ids.add(item.id);
    return {
      id: item.id, title: item.title, kind: item.kind, status: item.status,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
      userMessageCount: item.userMessageCount, completedAssistantMessageCount: item.completedAssistantMessageCount
    };
  });
  return {
    workspaceId: query.workspaceId, updatedWithinSeconds: query.updatedWithinSeconds,
    updatedFrom: from, updatedTo: to, kind: query.kind, status: query.status, total: value.total, items
  };
}
