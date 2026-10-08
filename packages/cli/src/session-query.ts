import type {
  AgentSessionQueryItem,
  AgentSessionQueryKind,
  AgentSessionQueryRequest,
  AgentSessionQueryResponse,
  AgentSessionQueryStatus
} from "@agent-workbench/shared/contracts/agent-session-query";
import { CliError, isRecord, responseError } from "./errors.js";

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
const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

function isKind(value: unknown): value is AgentSessionQueryKind {
  return value === "primary" || value === "subtask" || value === "all";
}

function isStatus(value: unknown): value is AgentSessionQueryStatus {
  return value === "idle" || value === "running" || value === "all";
}

export function parseSessionListOptions(options: SessionListOptions): SessionListQuery {
  if (typeof options.workspace !== "string" || !/\S/.test(options.workspace)) {
    throw new CliError(2, "Workspace ID 必须是非空且不全为空白的字符串。");
  }
  const match = typeof options.updatedWithin === "string" && /^([1-9][0-9]*)(s|m|h|d)$/.exec(options.updatedWithin);
  if (!match || match[0] !== options.updatedWithin) throw new CliError(2, "更新时间窗口必须是正整数 s/m/h/d 时长，例如 24h，且不超过 90d。");
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) {
    throw new CliError(2, "更新时间窗口必须在 1 秒至 90 天之间，不能溢出或超限。");
  }
  const seconds = amount * unitSeconds[match[2]];
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > maximumSeconds) {
    throw new CliError(2, "更新时间窗口必须在 1 秒至 90 天之间，不能溢出或超限。");
  }
  const kind = options.kind === undefined ? "all" : options.kind;
  const status = options.status === undefined ? "all" : options.status;
  if (!isKind(kind) || !isStatus(status)) throw new CliError(2, "Session 类型或状态参数无效，请查看 session list --help。");
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
      || typeof item.id !== "string" || item.id.length === 0 || ids.has(item.id)
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
