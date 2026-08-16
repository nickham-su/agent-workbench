import type {
  AgentContextItemOutput,
  AgentContextItemRecord,
  AgentUiLocale,
  AgentContextItemStatus,
  AgentRunStatus,
  AgentSessionRecord,
  AgentRecentSessionItem
} from "@agent-workbench/shared";
import type { Db } from "../../infra/db/db.js";

const TERMINAL_ITEM_STATUS = new Set<AgentContextItemStatus>(["completed", "failed", "cancelled"]);

export class AgentConflictError extends Error {
  readonly currentHeadItemId: number | null;

  constructor(currentHeadItemId: number | null) {
    super("agent context conflict");
    this.currentHeadItemId = currentHeadItemId;
  }
}

type AgentSessionRow = {
  id: string;
  workspaceId: string;
  title: string;
  kind: "primary" | "subtask";
  forkedFromSessionId: string | null;
  forkedFromItemId: number | null;
  createdAt: number;
  updatedAt: number;
  headItemId: number | null;
};

type AgentContextItemRow = {
  id: number;
  workspaceId: string;
  sessionId: string;
  runId: string | null;
  turnId: string | null;
  step: number | null;
  prevId: number | null;
  kind: AgentContextItemRecord["kind"];
  status: AgentContextItemStatus;
  outputText: string;
  assistantReasoningText: string | null;
  outputTextTruncated: number;
  outputTextArtifactPath: string | null;
  toolName: string | null;
  toolCallId: string | null;
  toolCallJson: string | null;
  toolResultJson: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  boundaryReason: string | null;
  archiveAt: number | null;
  outputJson: string;
  createdAt: number;
  updatedAt: number;
};

type StoredToolCall = {
  toolName?: unknown;
  toolCallId?: unknown;
  args?: unknown;
};

type StoredToolResult = {
  status?: unknown;
  error?: unknown;
  meta?: {
    resultFormat?: unknown;
    result?: unknown;
  } | unknown;
};

type SubtaskToolRefRow = {
  toolResultJson: string | null;
  outputText: string;
};

function parseJson(raw: string | null) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseLegacyOutput(raw: string): AgentContextItemOutput | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const type = String((parsed as { type?: unknown }).type || "").trim();
  if (type !== "user_text" && type !== "assistant_text" && type !== "tool" && type !== "system_text") {
    return null;
  }
  return parsed as AgentContextItemOutput;
}

function toResultText(raw: unknown) {
  if (typeof raw === "undefined") return "";
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function parseSubtaskSessionIdFromToolText(text: unknown) {
  if (typeof text !== "string") return "";
  const match = text.match(/(?:^|\n)subtask_session_id:\s*([^\s]+)/);
  return match ? String(match[1] || "").trim() : "";
}

function normalizeTextOutput(kind: AgentContextItemRecord["kind"], output: AgentContextItemOutput) {
  if (kind === "user" && output.type === "user_text") return output.text;
  if (kind === "assistant" && output.type === "assistant_text") return output.text;
  if (kind === "system" && output.type === "system_text") return output.text;
  if (kind === "tool" && output.type === "tool") {
    if (typeof output.text === "string") return output.text;
    return toResultText(output.result);
  }
  if ((output as { text?: unknown }).text && typeof (output as { text?: unknown }).text === "string") {
    return String((output as { text?: unknown }).text);
  }
  return "";
}

function normalizeAssistantReasoningOutput(kind: AgentContextItemRecord["kind"], output: AgentContextItemOutput) {
  if (kind !== "assistant" || output.type !== "assistant_text") return null;
  const text = typeof output.reasoning?.text === "string" ? output.reasoning.text : "";
  if (!text) return null;
  return text;
}

function normalizeErrorOutput(kind: AgentContextItemRecord["kind"], output: AgentContextItemOutput) {
  if (kind === "assistant" && output.type === "assistant_text") {
    const text = typeof output.error === "string" ? output.error.trim() : "";
    return text || null;
  }
  if (kind === "tool" && output.type === "tool") {
    const text = typeof output.error === "string" ? output.error.trim() : "";
    return text || null;
  }
  return null;
}

function inferErrorCode(params: {
  kind: AgentContextItemRecord["kind"];
  status: AgentContextItemStatus;
  errorMessage: string | null;
}) {
  const message = String(params.errorMessage || "").trim().toLowerCase();
  if (!message) return null;
  if (params.status === "cancelled") return "ITEM_CANCELLED";
  if (params.kind === "tool") return "TOOL_FAILED";
  if (params.kind === "assistant") {
    if (message.includes("idle timeout")) return "MODEL_IDLE_TIMEOUT";
    if (message.includes("total timeout")) return "MODEL_TOTAL_TIMEOUT";
    if (message.includes("stream")) return "MODEL_STREAM_FAILED";
    return "MODEL_REQUEST_FAILED";
  }
  return null;
}

function encodeStoredColumns(params: {
  kind: AgentContextItemRecord["kind"];
  status: AgentContextItemStatus;
  output: AgentContextItemOutput;
}) {
  const outputText = normalizeTextOutput(params.kind, params.output);
  const errorMessage = normalizeErrorOutput(params.kind, params.output);
  const base = {
    assistantReasoningText: normalizeAssistantReasoningOutput(params.kind, params.output),
    outputText,
    outputTextTruncated: 0,
    outputTextArtifactPath: null as string | null,
    toolName: null as string | null,
    toolCallId: null as string | null,
    toolCallJson: null as string | null,
    toolResultJson: null as string | null,
    errorMessage,
    errorCode: inferErrorCode({ kind: params.kind, status: params.status, errorMessage }),
    // 兼容历史列: 避免重复存储完整 output
    outputJson: "{}"
  };

  if (params.kind !== "tool" || params.output.type !== "tool") {
    return base;
  }

  const toolName = String(params.output.toolName || "").trim();
  const toolCallId = typeof params.output.toolCallId === "string" && params.output.toolCallId.trim()
    ? params.output.toolCallId.trim()
    : null;
  const toolCallPayload: StoredToolCall = {
    toolName,
    ...(toolCallId ? { toolCallId } : {}),
    ...(typeof params.output.args !== "undefined" ? { args: params.output.args } : {})
  };
  const shouldPersistStructuredResult =
    toolName === "apply_patch" || toolName === "todolist" || toolName === "subtask" || toolName === "write" || toolName === "scratchpad";
  const toolResultPayload: StoredToolResult = {
    status: params.status,
    ...(shouldPersistStructuredResult && Object.prototype.hasOwnProperty.call(params.output, "result")
      ? {
          meta: {
            resultFormat: typeof params.output.result === "string" ? "text" : "json",
            result: params.output.result
          }
        }
      : {})
  };

  return {
    ...base,
    outputText,
    outputTextTruncated: params.output.textTruncated === true ? 1 : 0,
    outputTextArtifactPath:
      typeof params.output.textArtifactPath === "string" && params.output.textArtifactPath.trim()
        ? params.output.textArtifactPath.trim()
        : null,
    toolName: toolName || null,
    toolCallId,
    toolCallJson: JSON.stringify(toolCallPayload),
    toolResultJson: JSON.stringify(toolResultPayload)
  };
}

function mapFromStoredColumns(row: AgentContextItemRow): AgentContextItemOutput {
  const legacy = parseLegacyOutput(row.outputJson);
  const legacyTool = legacy && legacy.type === "tool" ? legacy : null;
  const hasSplitPayload =
    row.outputText.length > 0 ||
    row.outputTextTruncated !== 0 ||
    row.assistantReasoningText != null ||
    row.outputTextArtifactPath != null ||
    row.toolName != null ||
    row.toolCallId != null ||
    row.toolCallJson != null || 
    row.errorMessage != null ||
    row.errorCode != null ||
    row.toolResultJson != null;

  if (!hasSplitPayload && legacy) {
    return legacy;
  }

  if (row.kind === "user") {
    return {
      type: "user_text",
      text: row.outputText
    };
  }
  if (row.kind === "assistant") {
    return {
      type: "assistant_text",
      text: row.outputText,
      ...(row.assistantReasoningText ? { reasoning: { text: row.assistantReasoningText } } : {}),
      ...(row.errorMessage ? { error: row.errorMessage } : {})
    };
  }
  if (row.kind === "system") {
    return {
      type: "system_text",
      text: row.outputText
    };
  }

  const call = parseJson(row.toolCallJson) as StoredToolCall | null;
  const result = parseJson(row.toolResultJson) as StoredToolResult | null;
  const toolName = String(row.toolName || call?.toolName || legacyTool?.toolName || "").trim();
  if (!toolName && legacyTool) {
    return legacyTool;
  }

  const toolCallId = String(row.toolCallId || call?.toolCallId || legacyTool?.toolCallId || "").trim();
  const args =
    call && Object.prototype.hasOwnProperty.call(call, "args")
      ? call.args
      : legacyTool && Object.prototype.hasOwnProperty.call(legacyTool, "args")
        ? legacyTool.args
        : undefined;

  const resultMeta = typeof result?.meta === "object" && result.meta && !Array.isArray(result.meta)
    ? (result.meta as Record<string, unknown>)
    : null;
  const resultFormat = resultMeta
    ? String((resultMeta.resultFormat as string) || "").trim()
    : "";

  let parsedResult: unknown = undefined;
  if (resultMeta && Object.prototype.hasOwnProperty.call(resultMeta, "result")) {
    parsedResult = resultMeta.result;
  } else if (row.outputText.trim()) {
    if (resultFormat === "json") {
      try {
        parsedResult = JSON.parse(row.outputText);
      } catch {
        parsedResult = row.outputText;
      }
    } else if (!resultFormat && (toolName === "apply_patch" || toolName === "todolist" || toolName === "subtask" || toolName === "write")) {
      // 兼容早期拆分数据: 这些工具历史上通常为结构化结果。
      try {
        parsedResult = JSON.parse(row.outputText);
      } catch {
        parsedResult = row.outputText;
      }
    } else {
      // 默认保持文本语义，避免将 JSON-like 字符串误解为结构化对象。
      parsedResult = row.outputText;
    }
  } else if (legacyTool && Object.prototype.hasOwnProperty.call(legacyTool, "result")) {
    parsedResult = legacyTool.result;
  }

  const error =
    typeof row.errorMessage === "string" && row.errorMessage.trim()
      ? row.errorMessage
      : typeof result?.error === "string" && result.error.trim()
        ? result.error
      : legacyTool && typeof legacyTool.error === "string" && legacyTool.error.trim()
          ? legacyTool.error
        : undefined;

  return {
    type: "tool",
    toolName: toolName as any,
    ...(toolCallId ? { toolCallId } : {}),
    ...(typeof args !== "undefined" ? { args } : {}),
    text: row.outputText,
    ...(row.outputTextTruncated !== 0 ? { textTruncated: true } : {}),
    ...(row.outputTextArtifactPath ? { textArtifactPath: row.outputTextArtifactPath } : {}),
    ...(typeof parsedResult !== "undefined" ? { result: parsedResult } : {}),
    ...(error ? { error } : {})
  } as AgentContextItemOutput;
}

export type AgentRunStateRow = {
  sessionId: string;
  status: AgentRunStatus;
  activeRunId: string | null;
  activeAssistantItemId: number | null;
  lastResponseTotalTokens: number | null;
  runNoticeText: string;
  updatedAt: number;
  appliedItemId: number;
};

export type AgentRunRecord = {
  runId: string;
  workspaceId: string;
  sessionId: string;
  triggerItemId: number;
  agentId: string;
  providerId: string;
  modelId: string;
  uiLocale: AgentUiLocale | null;
  subtaskDepth: number | null;
  parentRunId: string | null;
  parentToolItemId: number | null;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
};

function normalizeContextItemStatus(raw: unknown): AgentContextItemStatus {
  if (raw === "streaming" || raw === "queued" || raw === "running" || raw === "completed" || raw === "failed" || raw === "cancelled") {
    return raw;
  }
  return "failed";
}

function normalizeRunStatus(raw: unknown): AgentRunStatus {
  if (raw === "running") return "running";
  return "idle";
}

function normalizeRunRecordStatus(raw: unknown): AgentRunRecord["status"] {
  if (raw === "running") return "running";
  if (raw === "completed" || raw === "failed" || raw === "cancelled") return raw;
  return "failed";
}

type AgentRunRow = {
  runId: unknown;
  workspaceId: unknown;
  sessionId: unknown;
  triggerItemId: unknown;
  agentId: unknown;
  providerId: unknown;
  modelId: unknown;
  uiLocale?: unknown;
  subtaskDepth: unknown;
  parentRunId: unknown;
  parentToolItemId: unknown;
  status: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

function toNonNegativeSafeInteger(raw: unknown) {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

function toPositiveSafeInteger(raw: unknown) {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 ? raw : null;
}

function toNonEmptyString(raw: unknown) {
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function mapRunRecord(row: AgentRunRow): AgentRunRecord {
  return {
    runId: toNonEmptyString(row.runId) ?? "",
    workspaceId: toNonEmptyString(row.workspaceId) ?? "",
    sessionId: toNonEmptyString(row.sessionId) ?? "",
    triggerItemId: toPositiveSafeInteger(row.triggerItemId) ?? 0,
    agentId: toNonEmptyString(row.agentId) ?? "",
    providerId: toNonEmptyString(row.providerId) ?? "",
    modelId: toNonEmptyString(row.modelId) ?? "",
    uiLocale: normalizeRunUiLocale(row.uiLocale),
    subtaskDepth: toNonNegativeSafeInteger(row.subtaskDepth),
    parentRunId: toNonEmptyString(row.parentRunId),
    parentToolItemId: toPositiveSafeInteger(row.parentToolItemId),
    status: normalizeRunRecordStatus(row.status),
    createdAt: typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : 0,
    updatedAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : 0
  };
}

function toHeadItemId(row: { headItemId: number | null } | undefined) {
  if (!row) return null;
  if (typeof row.headItemId !== "number") return null;
  if (!Number.isFinite(row.headItemId) || row.headItemId <= 0) return null;
  return row.headItemId;
}

function mapSession(row: AgentSessionRow): AgentSessionRecord {
  const forkedFromSessionId = typeof row.forkedFromSessionId === "string" && row.forkedFromSessionId.trim()
    ? row.forkedFromSessionId
    : null;
  const forkedFromItemId = typeof row.forkedFromItemId === "number" && Number.isFinite(row.forkedFromItemId) && row.forkedFromItemId >= 1
    ? row.forkedFromItemId
    : null;
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    title: String(row.title),
    kind: row.kind === "subtask" ? "subtask" : "primary",
    forkedFromSessionId,
    forkedFromItemId,
    headItemId: toHeadItemId(row),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt)
  };
}

function mapContextItem(row: AgentContextItemRow): AgentContextItemRecord {
  const runId = typeof row.runId === "string" && row.runId.trim() ? row.runId : null;
  const turnId = typeof row.turnId === "string" && row.turnId.trim() ? row.turnId : null;
  const step = typeof row.step === "number" && Number.isFinite(row.step) && row.step >= 1 ? row.step : null;
  const prevId = typeof row.prevId === "number" && Number.isFinite(row.prevId) && row.prevId >= 1 ? row.prevId : null;
  const archiveAt = typeof row.archiveAt === "number" && Number.isFinite(row.archiveAt) && row.archiveAt >= 1 ? row.archiveAt : null;
  const boundaryReason = typeof row.boundaryReason === "string" && row.boundaryReason.trim()
    ? row.boundaryReason.trim()
    : null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    runId,
    turnId,
    step,
    prevId,
    kind: row.kind,
    status: normalizeContextItemStatus(row.status),
    archiveAt,
    boundaryReason,
    output: mapFromStoredColumns(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function getHead(db: Db, workspaceId: string, sessionId: string) {
  const row = db
    .prepare(
      `
        select
          head_item_id as headItemId
        from agent_session_head
        where workspace_id = ? and session_id = ?
      `
    )
    .get(workspaceId, sessionId) as { headItemId: number | null } | undefined;
  return toHeadItemId(row);
}

function setHead(db: Db, params: { workspaceId: string; sessionId: string; headItemId: number | null; updatedAt: number }) {
  db.prepare(
    `
      insert into agent_session_head (workspace_id, session_id, head_item_id, updated_at)
      values (@workspaceId, @sessionId, @headItemId, @updatedAt)
      on conflict(workspace_id, session_id) do update set
        head_item_id = excluded.head_item_id,
        updated_at = excluded.updated_at
    `
  ).run({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    headItemId: params.headItemId,
    updatedAt: params.updatedAt
  });
}

function touchSession(db: Db, sessionId: string, updatedAt: number) {
  db.prepare(`update agent_session set updated_at = @updatedAt where id = @sessionId`).run({ sessionId, updatedAt });
}

export function updateAgentSessionTitle(db: Db, params: { sessionId: string; title: string; updatedAt: number }) {
  db.prepare(
    `
      update agent_session
      set title = @title,
          updated_at = @updatedAt
      where id = @sessionId
    `
  ).run(params);
}

function isReachable(db: Db, params: { sessionId: string; fromHead: number | null; target: number }) {
  let cursor = params.fromHead;
  const seen = new Set<number>();
  while (cursor) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    if (cursor === params.target) return true;
    const row = db
      .prepare(`select prev_id as prevId, session_id as sessionId from agent_context_item where id = ?`)
      .get(cursor) as { prevId: number | null; sessionId: string } | undefined;
    if (!row || row.sessionId !== params.sessionId) return false;
    cursor = row.prevId;
  }
  return false;
}

function readContextItemRowById(db: Db, itemId: number) {
  return db
    .prepare(
      `
        select
          id,
          workspace_id as workspaceId,
          session_id as sessionId,
          run_id as runId,
          turn_id as turnId,
          step,
          prev_id as prevId,
          kind,
          status,
          output_text as outputText,
          assistant_reasoning_text as assistantReasoningText,
          output_text_truncated as outputTextTruncated,
          output_text_artifact_path as outputTextArtifactPath,
          tool_name as toolName,
          tool_call_id as toolCallId,
          tool_call_json as toolCallJson,
          tool_result_json as toolResultJson,
          error_message as errorMessage,
          error_code as errorCode,
          boundary_reason as boundaryReason,
          archive_at as archiveAt,
          output_json as outputJson,
          created_at as createdAt,
          updated_at as updatedAt
        from agent_context_item
        where id = ?
      `
    )
    .get(itemId) as AgentContextItemRow | undefined;
}

function upsertRunState(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  status: AgentRunStatus;
  activeRunId: string | null;
  activeAssistantItemId: number | null;
  lastResponseTotalTokens?: number | null;
  setLastResponseTotalTokens?: boolean;
  runNoticeText?: string;
  setRunNoticeText?: boolean;
  updatedAt: number;
  appliedItemId: number;
}) {
  db.prepare(
    `
      insert into agent_session_run_state (
        workspace_id,
        session_id,
        status,
        active_run_id,
        active_assistant_item_id,
        last_response_total_tokens,
        run_notice_text,
        updated_at,
        applied_item_id
      ) values (
        @workspaceId,
        @sessionId,
        @status,
        @activeRunId,
        @activeAssistantItemId,
        @lastResponseTotalTokens,
        @runNoticeText,
        @updatedAt,
        @appliedItemId
      )
      on conflict(workspace_id, session_id) do update set
        status = excluded.status,
        active_run_id = excluded.active_run_id,
        active_assistant_item_id = excluded.active_assistant_item_id,
        last_response_total_tokens = case
          when @setLastResponseTotalTokens = 1 then @lastResponseTotalTokens
          else agent_session_run_state.last_response_total_tokens
        end,
        run_notice_text = case
          when @setRunNoticeText = 1 then @runNoticeText
          else agent_session_run_state.run_notice_text
        end,
        updated_at = excluded.updated_at,
        applied_item_id = excluded.applied_item_id
    `
  ).run({
    ...params,
    lastResponseTotalTokens: params.lastResponseTotalTokens ?? null,
    setLastResponseTotalTokens: params.setLastResponseTotalTokens ? 1 : 0,
    runNoticeText: params.runNoticeText ?? "",
    setRunNoticeText: params.setRunNoticeText ? 1 : 0
  });
}

export function listAgentSessions(db: Db, workspaceId: string): AgentSessionRecord[] {
  const rows = db
    .prepare(
      `
        select
          s.id,
          s.workspace_id as workspaceId,
          s.title,
          s.kind,
          s.forked_from_session_id as forkedFromSessionId,
          s.forked_from_item_id as forkedFromItemId,
          s.created_at as createdAt,
          s.updated_at as updatedAt,
          h.head_item_id as headItemId
        from agent_session s
        left join agent_session_head h
          on h.workspace_id = s.workspace_id and h.session_id = s.id
        where s.workspace_id = ?
        order by s.updated_at desc
      `
    )
    .all(workspaceId) as AgentSessionRow[];
  return rows.map(mapSession);
}

export function getAgentSession(db: Db, sessionId: string): AgentSessionRecord | null {
  const row = db
    .prepare(
      `
        select
          s.id,
          s.workspace_id as workspaceId,
          s.title,
          s.kind,
          s.forked_from_session_id as forkedFromSessionId,
          s.forked_from_item_id as forkedFromItemId,
          s.created_at as createdAt,
          s.updated_at as updatedAt,
          h.head_item_id as headItemId
        from agent_session s
        left join agent_session_head h
          on h.workspace_id = s.workspace_id and h.session_id = s.id
        where s.id = ?
      `
    )
    .get(sessionId) as AgentSessionRow | undefined;
  return row ? mapSession(row) : null;
}

export function listRecentSessionsAcrossWorkspaces(db: Db, limit: number, kind: "primary" | "subtask" | "all" = "all"): AgentRecentSessionItem[] {
  const rows = db
    .prepare(
      `
        select
          s.id as sessionId,
          s.title as sessionTitle,
          s.updated_at as sessionUpdatedAt,
          s.workspace_id as workspaceId,
          w.title as workspaceTitle,
          w.dir_name as workspaceDirName
        from agent_session s
        join workspaces w
          on w.id = s.workspace_id
        ${kind === "all" ? "" : "where s.kind = ?"}
        order by s.updated_at desc
        limit ?
      `
    )
    .all(...(kind === "all" ? [limit] : [kind, limit])) as any[];
  return rows.map((row) => ({
    sessionId: String(row.sessionId),
    sessionTitle: String(row.sessionTitle || ""),
    sessionUpdatedAt: Number(row.sessionUpdatedAt || 0),
    workspaceId: String(row.workspaceId),
    workspaceTitle: String(row.workspaceTitle || "") || String(row.workspaceDirName || ""),
    workspaceDirName: String(row.workspaceDirName || "")
  }));
}

export function createAgentSession(db: Db, params: {
  id: string;
  workspaceId: string;
  title: string;
  kind: "primary" | "subtask";
  createdAt: number;
  forkedFromSessionId?: string | null;
  forkedFromItemId?: number | null;
}) {
  const tx = db.transaction(() => {
    db.prepare(
      `
        insert into agent_session (
          id,
          workspace_id,
          title,
          kind,
          created_at,
          updated_at,
          forked_from_session_id,
          forked_from_item_id
        ) values (
          @id,
          @workspaceId,
          @title,
          @kind,
          @createdAt,
          @updatedAt,
          @forkedFromSessionId,
          @forkedFromItemId
        )
      `
    ).run({
      ...params,
      updatedAt: params.createdAt,
      forkedFromSessionId: params.forkedFromSessionId ?? null,
      forkedFromItemId: params.forkedFromItemId ?? null
    });

    setHead(db, {
      workspaceId: params.workspaceId,
      sessionId: params.id,
      headItemId: null,
      updatedAt: params.createdAt
    });

    upsertRunState(db, {
      workspaceId: params.workspaceId,
      sessionId: params.id,
      status: "idle",
      activeRunId: null,
      activeAssistantItemId: null,
      updatedAt: params.createdAt,
      runNoticeText: "",
      setRunNoticeText: true,
      appliedItemId: 0
    });
  });
  tx();
}

export function getSessionHead(db: Db, workspaceId: string, sessionId: string) {
  return getHead(db, workspaceId, sessionId);
}

export function appendContextItem(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  runId: string | null;
  turnId: string | null;
  step: number | null;
  prevId: number | null;
  kind: AgentContextItemRecord["kind"];
  status: AgentContextItemStatus;
  boundaryReason?: string | null;
  output: AgentContextItemOutput;
  createdAt: number;
}) {
  const stored = encodeStoredColumns({
    kind: params.kind,
    status: params.status,
    output: params.output
  });

  const tx = db.transaction(() => {
    const currentHead = getHead(db, params.workspaceId, params.sessionId);
    if (currentHead !== params.prevId) {
      throw new AgentConflictError(currentHead);
    }

    const result = db
      .prepare(
        `
          insert into agent_context_item (
            workspace_id,
            session_id,
            run_id,
            turn_id,
            step,
            prev_id,
            kind,
            status,
            output_text,
            assistant_reasoning_text,
            output_text_truncated,
            output_text_artifact_path,
            tool_name,
            tool_call_id,
            tool_call_json,
            tool_result_json,
            error_message,
            error_code,
            boundary_reason,
            output_json,
            created_at,
            updated_at
          ) values (
            @workspaceId,
            @sessionId,
            @runId,
            @turnId,
            @step,
            @prevId,
            @kind,
            @status,
            @outputText,
            @assistantReasoningText,
            @outputTextTruncated,
            @outputTextArtifactPath,
            @toolName,
            @toolCallId,
            @toolCallJson,
            @toolResultJson,
            @errorMessage,
            @errorCode,
            @boundaryReason,
            @outputJson,
            @createdAt,
            @updatedAt
          )
        `
      )
      .run({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        runId: params.runId,
        turnId: params.turnId,
        step: params.step,
        prevId: params.prevId,
        kind: params.kind,
        status: params.status,
        outputText: stored.outputText,
        assistantReasoningText: stored.assistantReasoningText,
        outputTextTruncated: stored.outputTextTruncated,
        outputTextArtifactPath: stored.outputTextArtifactPath,
        toolName: stored.toolName,
        toolCallId: stored.toolCallId,
        toolCallJson: stored.toolCallJson,
        toolResultJson: stored.toolResultJson,
        errorMessage: stored.errorMessage,
        errorCode: stored.errorCode,
        boundaryReason:
          params.kind === "system" && typeof params.boundaryReason === "string" && params.boundaryReason.trim()
            ? params.boundaryReason.trim()
            : null,
        outputJson: stored.outputJson,
        createdAt: params.createdAt,
        updatedAt: params.createdAt
      });

    const itemId = Number(result.lastInsertRowid);
    setHead(db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      headItemId: itemId,
      updatedAt: params.createdAt
    });
    touchSession(db, params.sessionId, params.createdAt);
    return itemId;
  });

  const itemId = tx();
  const row = readContextItemRowById(db, itemId);
  if (!row) {
    throw new Error("failed to append context item");
  }
  return mapContextItem(row);
}

export function updateContextItem(db: Db, params: {
  itemId: number;
  status?: AgentContextItemStatus;
  output?: AgentContextItemOutput;
  updatedAt: number;
}) {
  const row = readContextItemRowById(db, params.itemId);
  if (!row) return null;
  if (TERMINAL_ITEM_STATUS.has(row.status)) {
    return mapContextItem(row);
  }

  const nextStatus = params.status ?? row.status;
  const nextOutput = params.output ?? mapFromStoredColumns(row);
  const stored = encodeStoredColumns({
    kind: row.kind,
    status: nextStatus,
    output: nextOutput
  });
  db.prepare(
    `
      update agent_context_item
      set status = @status,
          output_text = @outputText,
          assistant_reasoning_text = @assistantReasoningText,
          output_text_truncated = @outputTextTruncated,
          output_text_artifact_path = @outputTextArtifactPath,
          tool_name = @toolName,
          tool_call_id = @toolCallId,
          tool_call_json = @toolCallJson,
          tool_result_json = @toolResultJson,
          error_message = @errorMessage,
          error_code = @errorCode,
          output_json = @outputJson,
          updated_at = @updatedAt
      where id = @itemId
    `
  ).run({
    itemId: params.itemId,
    status: nextStatus,
    outputText: stored.outputText,
    assistantReasoningText: stored.assistantReasoningText,
    outputTextTruncated: stored.outputTextTruncated,
    outputTextArtifactPath: stored.outputTextArtifactPath,
    toolName: stored.toolName,
    toolCallId: stored.toolCallId,
    toolCallJson: stored.toolCallJson,
    toolResultJson: stored.toolResultJson,
    errorMessage: stored.errorMessage,
    errorCode: stored.errorCode,
    outputJson: stored.outputJson,
    updatedAt: params.updatedAt
  });

  const next = readContextItemRowById(db, params.itemId);
  return next ? mapContextItem(next) : null;
}

export function getContextItemById(db: Db, itemId: number) {
  const row = readContextItemRowById(db, itemId);
  return row ? mapContextItem(row) : null;
}

export function getLatestTerminalAssistantTextByRunId(
  db: Db,
  params: {
    runId: string;
  }
): { text: string; itemId: number | null } {
  const runId = String(params.runId || "").trim();
  if (!runId) return { text: "", itemId: null };

  // NOTE: Use output_text column which is normalized for assistant_text.
  // We only look at terminal assistant items. This is final-only.
  const rows = db
    .prepare(
      `
        select
          id,
          output_text as outputText,
          status
        from agent_context_item
        where run_id = ?
          and kind = 'assistant'
          and status in ('completed', 'failed', 'cancelled')
        order by id desc
        limit 20
      `
    )
    .all(runId) as Array<{ id: number; outputText: string; status: string }>;

  for (const row of rows) {
    const text = typeof row.outputText === "string" ? row.outputText : "";
    if (text.trim()) {
      return { text, itemId: row.id };
    }
  }

  return { text: "", itemId: rows.length > 0 ? rows[0]!.id : null };
}

export function getLatestCompletedAssistantTextByRunId(
  db: Db,
  params: {
    runId: string;
  }
): { text: string; itemId: number | null } {
  const runId = String(params.runId || "").trim();
  if (!runId) return { text: "", itemId: null };

  const rows = db
    .prepare(
      `
        select
          id,
          output_text as outputText
        from agent_context_item
        where run_id = ?
          and kind = 'assistant'
          and status = 'completed'
        order by id desc
        limit 20
      `
    )
    .all(runId) as Array<{ id: number; outputText: string }>;

  for (const row of rows) {
    const text = typeof row.outputText === "string" ? row.outputText : "";
    if (text.trim()) {
      return { text, itemId: row.id };
    }
  }

  return { text: "", itemId: rows.length > 0 ? rows[0]!.id : null };
}

function listSessionItems(
  db: Db,
  workspaceId: string,
  sessionId: string,
  params: { includeArchived: boolean }
): AgentContextItemRecord[] {
  const headItemId = getHead(db, workspaceId, sessionId);
  if (!headItemId) return [];

  const rows: AgentContextItemRecord[] = [];
  const seen = new Set<number>();
  let cursor: number | null = headItemId;
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const row = readContextItemRowById(db, cursor);
    if (!row) break;
    if (row.workspaceId !== workspaceId || row.sessionId !== sessionId) break;
    if (params.includeArchived || row.archiveAt == null) {
      rows.push(mapContextItem(row));
    }
    cursor = row.prevId;
  }
  return rows.reverse();
}

export function getSessionVisibleItems(db: Db, workspaceId: string, sessionId: string): AgentContextItemRecord[] {
  return listSessionItems(db, workspaceId, sessionId, { includeArchived: false });
}

export function getSessionTranscriptItems(db: Db, workspaceId: string, sessionId: string): AgentContextItemRecord[] {
  return listSessionItems(db, workspaceId, sessionId, { includeArchived: true });
}

function normalizeListLimit(raw: unknown, fallback: number) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(n)));
}

function readContextItemRowByIdStmt(db: Db) {
  return db.prepare(
    `
      select
        id,
        workspace_id as workspaceId,
        session_id as sessionId,
        run_id as runId,
        turn_id as turnId,
        step,
        prev_id as prevId,
        kind,
        status,
        output_text as outputText,
        assistant_reasoning_text as assistantReasoningText,
        output_text_truncated as outputTextTruncated,
        output_text_artifact_path as outputTextArtifactPath,
        tool_name as toolName,
        tool_call_id as toolCallId,
        tool_call_json as toolCallJson,
        tool_result_json as toolResultJson,
        error_message as errorMessage,
        error_code as errorCode,
        boundary_reason as boundaryReason,
        archive_at as archiveAt,
        output_json as outputJson,
        created_at as createdAt,
        updated_at as updatedAt
      from agent_context_item
      where id = ?
    `
  );
}

function listTranscriptWindowFromCursor(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  startId: number | null;
  limit: number;
}) {
  const stmt = readContextItemRowByIdStmt(db);
  const rows: AgentContextItemRecord[] = [];
  const seen = new Set<number>();
  let cursor: number | null = params.startId;
  while (cursor && rows.length < params.limit) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const row = stmt.get(cursor) as AgentContextItemRow | undefined;
    if (!row) break;
    if (row.workspaceId !== params.workspaceId || row.sessionId !== params.sessionId) break;
    rows.push(mapContextItem(row));
    cursor = row.prevId;
  }
  return {
    // 返回按时间从旧到新排序,与前端既有处理一致.
    items: rows.reverse(),
    hasMoreBefore: cursor != null
  };
}

export function getSessionTranscriptTailWindow(db: Db, workspaceId: string, sessionId: string, tailLimit: number) {
  const headItemId = getHead(db, workspaceId, sessionId);
  if (!headItemId) {
    return { items: [] as AgentContextItemRecord[], hasMoreBefore: false };
  }
  const limit = normalizeListLimit(tailLimit, 100);
  return listTranscriptWindowFromCursor(db, { workspaceId, sessionId, startId: headItemId, limit });
}

export function getSessionTranscriptBeforeWindow(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  beforeId: number;
  limit: number;
}) {
  const stmt = readContextItemRowByIdStmt(db);
  const beforeRow = stmt.get(params.beforeId) as AgentContextItemRow | undefined;
  if (!beforeRow) return { items: [] as AgentContextItemRecord[], hasMoreBefore: false };
  if (beforeRow.workspaceId !== params.workspaceId || beforeRow.sessionId !== params.sessionId) {
    return { items: [] as AgentContextItemRecord[], hasMoreBefore: false };
  }
  const limit = normalizeListLimit(params.limit, 100);
  return listTranscriptWindowFromCursor(db, {
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    startId: beforeRow.prevId,
    limit
  });
}

export function getSessionTranscriptItemsAfterIdWindow(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  afterId: number;
}) {
  const headItemId = getHead(db, params.workspaceId, params.sessionId);
  if (!headItemId) return [] as AgentContextItemRecord[];

  const stmt = readContextItemRowByIdStmt(db);
  const rows: AgentContextItemRecord[] = [];
  const seen = new Set<number>();
  let cursor: number | null = headItemId;
  const stopId = Math.max(0, Math.floor(params.afterId));
  while (cursor && cursor > stopId) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const row = stmt.get(cursor) as AgentContextItemRow | undefined;
    if (!row) break;
    if (row.workspaceId !== params.workspaceId || row.sessionId !== params.sessionId) break;
    rows.push(mapContextItem(row));
    cursor = row.prevId;
  }
  return rows.reverse();
}

export function setContextItemsArchiveAt(
  db: Db,
  params: {
    workspaceId: string;
    sessionId: string;
    itemIds: number[];
    archiveAt: number;
    updatedAt: number;
  }
) {
  if (params.itemIds.length === 0) return 0;
  const tx = db.transaction(() => {
    let changed = 0;
    const stmt = db.prepare(
      `
        update agent_context_item
        set archive_at = @archiveAt,
            updated_at = @updatedAt
        where id = @id
          and workspace_id = @workspaceId
          and session_id = @sessionId
          and archive_at is null
      `
    );
    for (const itemId of params.itemIds) {
      const result = stmt.run({
        id: itemId,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        archiveAt: params.archiveAt,
        updatedAt: params.updatedAt
      });
      changed += result.changes;
    }
    return changed;
  });
  return tx();
}

export function appendSystemSummaryAndArchiveItems(
  db: Db,
  params: {
    workspaceId: string;
    sessionId: string;
    runId: string | null;
    expectedHeadItemId: number | null;
    summaryText: string;
    boundaryReason: string;
    summaryCreatedAt: number;
    archiveItemIds: number[];
    archiveAt: number;
  }
) {
  const stored = encodeStoredColumns({
    kind: "system",
    status: "completed",
    output: {
      type: "system_text",
      text: params.summaryText
    }
  });

  const tx = db.transaction(() => {
    const currentHead = getHead(db, params.workspaceId, params.sessionId);
    if (currentHead !== params.expectedHeadItemId) {
      throw new AgentConflictError(currentHead);
    }

    const result = db
      .prepare(
        `
          insert into agent_context_item (
            workspace_id,
            session_id,
            run_id,
            turn_id,
            step,
            prev_id,
            kind,
            status,
            output_text,
            output_text_truncated,
            output_text_artifact_path,
            tool_name,
            tool_call_id,
            tool_call_json,
            tool_result_json,
            error_message,
            error_code,
            boundary_reason,
            output_json,
            created_at,
            updated_at
          ) values (
            @workspaceId,
            @sessionId,
            @runId,
            null,
            null,
            @prevId,
            'system',
            'completed',
            @outputText,
            @outputTextTruncated,
            @outputTextArtifactPath,
            @toolName,
            @toolCallId,
            @toolCallJson,
            @toolResultJson,
            @errorMessage,
            @errorCode,
            @boundaryReason,
            @outputJson,
            @createdAt,
            @updatedAt
          )
        `
      )
      .run({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        runId: params.runId,
        prevId: params.expectedHeadItemId,
        outputText: stored.outputText,
        outputTextTruncated: stored.outputTextTruncated,
        outputTextArtifactPath: stored.outputTextArtifactPath,
        toolName: stored.toolName,
        toolCallId: stored.toolCallId,
        toolCallJson: stored.toolCallJson,
        toolResultJson: stored.toolResultJson,
        errorMessage: stored.errorMessage,
        errorCode: stored.errorCode,
        boundaryReason: params.boundaryReason,
        outputJson: stored.outputJson,
        createdAt: params.summaryCreatedAt,
        updatedAt: params.summaryCreatedAt
      });
    const summaryItemId = Number(result.lastInsertRowid);

    let archivedCount = 0;
    if (params.archiveItemIds.length > 0) {
      const archiveStmt = db.prepare(
        `
          update agent_context_item
          set archive_at = @archiveAt,
              updated_at = @archiveAt
          where id = @id
            and workspace_id = @workspaceId
            and session_id = @sessionId
            and archive_at is null
        `
      );
      for (const itemId of params.archiveItemIds) {
        const archiveResult = archiveStmt.run({
          id: itemId,
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          archiveAt: params.archiveAt
        });
        archivedCount += archiveResult.changes;
      }
    }

    setHead(db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      headItemId: summaryItemId,
      updatedAt: params.summaryCreatedAt
    });
    touchSession(db, params.sessionId, params.summaryCreatedAt);

    return {
      summaryItemId,
      archivedCount
    };
  });

  return tx();
}

export function getSessionVisibleItemsAfter(db: Db, workspaceId: string, sessionId: string, afterId: number) {
  return getSessionVisibleItems(db, workspaceId, sessionId).filter((item) => item.id > afterId);
}

export function getSessionTranscriptItemsAfter(db: Db, workspaceId: string, sessionId: string, afterId: number) {
  return getSessionTranscriptItems(db, workspaceId, sessionId).filter((item) => item.id > afterId);
}

export function getVisibleItemById(db: Db, workspaceId: string, sessionId: string, itemId: number) {
  const visible = getSessionVisibleItems(db, workspaceId, sessionId);
  return visible.find((item) => item.id === itemId) ?? null;
}

export function getTranscriptItemById(db: Db, workspaceId: string, sessionId: string, itemId: number) {
  const visible = getSessionTranscriptItems(db, workspaceId, sessionId);
  return visible.find((item) => item.id === itemId) ?? null;
}

export function moveSessionHead(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  expectedHeadItemId: number | null;
  nextHeadItemId: number | null;
  updatedAt: number;
}) {
  const tx = db.transaction(() => {
    const currentHead = getHead(db, params.workspaceId, params.sessionId);
    if (currentHead !== params.expectedHeadItemId) {
      throw new AgentConflictError(currentHead);
    }

    if (params.nextHeadItemId != null) {
      const target = readContextItemRowById(db, params.nextHeadItemId);
      if (!target || target.workspaceId !== params.workspaceId || target.sessionId !== params.sessionId) {
        throw new Error("invalid target head item");
      }
      if (!isReachable(db, { sessionId: params.sessionId, fromHead: currentHead, target: params.nextHeadItemId })) {
        throw new Error("invalid target head item");
      }
    }

    setHead(db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      headItemId: params.nextHeadItemId,
      updatedAt: params.updatedAt
    });
    touchSession(db, params.sessionId, params.updatedAt);
  });

  tx();
}

export function getRunState(db: Db, workspaceId: string, sessionId: string): AgentRunStateRow {
  const row = db
    .prepare(
      `
        select
          session_id as sessionId,
          status,
          active_run_id as activeRunId,
          active_assistant_item_id as activeAssistantItemId,
          last_response_total_tokens as lastResponseTotalTokens,
          run_notice_text as runNoticeText,
          updated_at as updatedAt,
          applied_item_id as appliedItemId
        from agent_session_run_state
        where workspace_id = ? and session_id = ?
      `
    )
    .get(workspaceId, sessionId) as AgentRunStateRow | undefined;
  if (row) return { ...row, status: normalizeRunStatus(row.status) };
  return {
    sessionId,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    lastResponseTotalTokens: null,
    runNoticeText: "",
    updatedAt: 0,
    appliedItemId: 0
  };
}

export function updateRunState(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  status: AgentRunStatus;
  activeRunId: string | null;
  activeAssistantItemId: number | null;
  lastResponseTotalTokens?: number | null;
  runNoticeText?: string;
  updatedAt: number;
  appliedItemId: number;
}) {
  upsertRunState(db, {
    ...params,
    setLastResponseTotalTokens: Object.prototype.hasOwnProperty.call(params, "lastResponseTotalTokens"),
    setRunNoticeText: Object.prototype.hasOwnProperty.call(params, "runNoticeText")
  });
}

export function setRunStateIdle(db: Db, params: { workspaceId: string; sessionId: string; updatedAt: number; appliedItemId: number }) {
  upsertRunState(db, {
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    setLastResponseTotalTokens: false,
    runNoticeText: "",
    setRunNoticeText: true,
    updatedAt: params.updatedAt,
    appliedItemId: params.appliedItemId
  });
}

export function findClientRequestDedup(db: Db, params: { workspaceId: string; sessionId: string; clientRequestId: string }) {
  const row = db
    .prepare(
      `
        select message_item_id as messageItemId, run_id as runId
        from agent_client_request
        where workspace_id = ? and session_id = ? and client_request_id = ?
      `
    )
    .get(params.workspaceId, params.sessionId, params.clientRequestId) as { messageItemId: number; runId: string } | undefined;
  if (!row) return null;
  const itemId = Number(row.messageItemId);
  if (!Number.isFinite(itemId) || itemId <= 0) return null;
  return { messageItemId: itemId, runId: row.runId };
}

export function insertClientRequestDedup(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  clientRequestId: string;
  messageItemId: number;
  runId: string;
  createdAt: number;
}) {
  db.prepare(
    `
      insert into agent_client_request (
        workspace_id,
        session_id,
        client_request_id,
        message_item_id,
        run_id,
        created_at
      ) values (
        @workspaceId,
        @sessionId,
        @clientRequestId,
        @messageItemId,
        @runId,
        @createdAt
      )
    `
  ).run({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    clientRequestId: params.clientRequestId,
    messageItemId: params.messageItemId,
    runId: params.runId,
    createdAt: params.createdAt
  });
}

export function getLatestSessionItemId(db: Db, workspaceId: string, sessionId: string) {
  const row = db
    .prepare(
      `
        select max(id) as itemId
        from agent_context_item
        where workspace_id = ? and session_id = ?
      `
    )
    .get(workspaceId, sessionId) as { itemId: number | null };
  return row.itemId ?? 0;
}

export function listNonTerminalVisibleItemIds(db: Db, workspaceId: string, sessionId: string) {
  return getSessionVisibleItems(db, workspaceId, sessionId)
    .filter((item) => !TERMINAL_ITEM_STATUS.has(item.status))
    .map((item) => item.id);
}

export function listNonTerminalSessionItemIds(db: Db, workspaceId: string, sessionId: string) {
  const rows = db
    .prepare(
      `
        select id
        from agent_context_item
        where workspace_id = ?
          and session_id = ?
          and status not in ('completed', 'failed', 'cancelled')
        order by id asc
      `
    )
    .all(workspaceId, sessionId) as Array<{ id: number }>;

  return rows
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

export function listNonTerminalSessionItemIdsByRunId(
  db: Db,
  params: { workspaceId: string; sessionId: string; runId: string }
) {
  const rows = db
    .prepare(
      `
        select id
        from agent_context_item
        where workspace_id = @workspaceId
          and session_id = @sessionId
          and run_id = @runId
          and status not in ('completed', 'failed', 'cancelled')
        order by id asc
      `
    )
    .all(params) as Array<{ id: number }>;

  return rows
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

export function hasNonTerminalSessionItems(db: Db, workspaceId: string, sessionId: string) {
  return listNonTerminalSessionItemIds(db, workspaceId, sessionId).length > 0;
}

export function createRunRecord(db: Db, params: {
  runId: string;
  workspaceId: string;
  sessionId: string;
  triggerItemId: number;
  agentId: string;
  providerId: string;
  modelId: string;
  uiLocale?: AgentUiLocale | null;
  subtaskDepth?: number | null;
  parentRunId?: string | null;
  parentToolItemId?: number | null;
  status: AgentRunRecord["status"];
  createdAt: number;
}) {
  db.prepare(
    `
      insert into agent_run (
        run_id,
        workspace_id,
        session_id,
        trigger_item_id,
        agent_id,
        provider_id,
        ui_locale,
        model_id,
        subtask_depth,
        parent_run_id,
        parent_tool_item_id,
        status,
        created_at,
        updated_at
      ) values (
        @runId,
        @workspaceId,
        @sessionId,
        @triggerItemId,
        @agentId,
        @providerId,
        @uiLocale,
        @modelId,
        @subtaskDepth,
        @parentRunId,
        @parentToolItemId,
        @status,
        @createdAt,
        @updatedAt
      )
    `
  ).run({
    runId: params.runId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    triggerItemId: params.triggerItemId,
    agentId: params.agentId,
    providerId: params.providerId,
    uiLocale: params.uiLocale ?? null,
    modelId: params.modelId,
    subtaskDepth: params.subtaskDepth ?? null,
    parentRunId: params.parentRunId ?? null,
    parentToolItemId: params.parentToolItemId ?? null,
    status: params.status,
    createdAt: params.createdAt,
    updatedAt: params.createdAt
  });
}

function normalizeRunUiLocale(raw: unknown): AgentUiLocale | null {
  const value = String(raw || "").trim();
  if (value === "zh-CN" || value === "en-US") return value;
  return null;
}

export function getRunRecord(db: Db, runId: string) {
  const row = db
    .prepare(
      `
        select
          run_id as runId,
          workspace_id as workspaceId,
          session_id as sessionId,
          trigger_item_id as triggerItemId,
          agent_id as agentId,
          provider_id as providerId,
          ui_locale as uiLocale,
          model_id as modelId,
          subtask_depth as subtaskDepth,
          parent_run_id as parentRunId,
          parent_tool_item_id as parentToolItemId,
          status,
          created_at as createdAt,
          updated_at as updatedAt
        from agent_run
        where run_id = ?
      `
    )
    .get(runId) as AgentRunRow | undefined;
  return row ? mapRunRecord(row) : null;
}

export function findSubtaskRunByParentTool(
  db: Db,
  params: { parentRunId: string; parentToolItemId: number }
) {
  const row = db
    .prepare(
      `
        select
          run_id as runId,
          workspace_id as workspaceId,
          session_id as sessionId,
          trigger_item_id as triggerItemId,
          agent_id as agentId,
          provider_id as providerId,
          ui_locale as uiLocale,
          model_id as modelId,
          subtask_depth as subtaskDepth,
          parent_run_id as parentRunId,
          parent_tool_item_id as parentToolItemId,
          status,
          created_at as createdAt,
          updated_at as updatedAt
        from agent_run
        where parent_run_id = @parentRunId
          and parent_tool_item_id = @parentToolItemId
        limit 1
      `
    )
    .get(params) as AgentRunRow | undefined;
  return row ? mapRunRecord(row) : null;
}

export function getLatestRunUiLocaleBySession(db: Db, params: { workspaceId: string; sessionId: string }): AgentUiLocale | null {
  const row = db
    .prepare(
      `
        select ui_locale as uiLocale
        from agent_run
        where workspace_id = ?
          and session_id = ?
          and ui_locale in ('zh-CN', 'en-US')
        order by updated_at desc, created_at desc
        limit 1
      `
    )
    .get(params.workspaceId, params.sessionId) as { uiLocale: unknown } | undefined;
  if (!row) return null;
  return normalizeRunUiLocale(row.uiLocale);
}

export function getLatestRunUiLocaleGlobal(db: Db): AgentUiLocale | null {
  const row = db
    .prepare(
      `
        select ui_locale as uiLocale
        from agent_run
        where ui_locale in ('zh-CN', 'en-US')
        order by updated_at desc, created_at desc
        limit 1
      `
    )
    .get() as { uiLocale: unknown } | undefined;
  if (!row) return null;
  return normalizeRunUiLocale(row.uiLocale);
}

export function getLatestTerminalRunRecord(db: Db, params: { workspaceId: string; sessionId: string }): (AgentRunRecord & {
  status: "completed" | "failed" | "cancelled";
}) | null {

  const row = db
    .prepare(
      `
        select
          run_id as runId,
          workspace_id as workspaceId,
          session_id as sessionId,
          trigger_item_id as triggerItemId,
          agent_id as agentId,
          provider_id as providerId,
          ui_locale as uiLocale,
          model_id as modelId,
          subtask_depth as subtaskDepth,
          parent_run_id as parentRunId,
          parent_tool_item_id as parentToolItemId,
          status,
          created_at as createdAt,
          updated_at as updatedAt
        from agent_run
        where workspace_id = ? and session_id = ?
          and status in ('completed', 'failed', 'cancelled')
        order by created_at desc, run_id desc
        limit 1
      `
    )
    .get(params.workspaceId, params.sessionId) as AgentRunRow | undefined;
  const mapped = row ? mapRunRecord(row) : null;
  if (!mapped || mapped.status === "running") return null;
  return mapped as AgentRunRecord & { status: "completed" | "failed" | "cancelled" };
}

export function getLatestRunRecordBySession(db: Db, params: { workspaceId: string; sessionId: string }): AgentRunRecord | null {
  const row = db
    .prepare(
      `
        select
          run_id as runId,
          workspace_id as workspaceId,
          session_id as sessionId,
          trigger_item_id as triggerItemId,
          agent_id as agentId,
          provider_id as providerId,
          ui_locale as uiLocale,
          model_id as modelId,
          subtask_depth as subtaskDepth,
          parent_run_id as parentRunId,
          parent_tool_item_id as parentToolItemId,
          status,
          created_at as createdAt,
          updated_at as updatedAt
        from agent_run
        where workspace_id = ? and session_id = ?
        order by created_at desc, run_id desc
        limit 1
      `
    )
    .get(params.workspaceId, params.sessionId) as AgentRunRow | undefined;
  return row ? mapRunRecord(row) : null;
}

export function listNonTerminalRunIdsBySession(db: Db, params: { workspaceId: string; sessionId: string }) {
  const rows = db
    .prepare(
      `
        select run_id as runId
        from agent_run
        where workspace_id = ?
          and session_id = ?
          and status = 'running'
        order by created_at asc, run_id asc
      `
    )
    .all(params.workspaceId, params.sessionId) as Array<{ runId: string }>;

  return rows
    .map((row) => String(row.runId || "").trim())
    .filter((runId) => runId.length > 0);
}

export function listNonTerminalRunIdsByItemIds(db: Db, params: { workspaceId: string; sessionId: string; itemIds: number[] }) {
  if (params.itemIds.length === 0) return [] as string[];
  const placeholders = params.itemIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        select distinct i.run_id as runId
        from agent_context_item i
        inner join agent_run r on r.run_id = i.run_id
        where i.workspace_id = ? and i.session_id = ? and i.id in (${placeholders}) and i.run_id is not null
          and r.status = 'running'
      `
    )
    .all(params.workspaceId, params.sessionId, ...params.itemIds) as Array<{ runId: string | null }>;

  return rows.map((row) => String(row.runId || "").trim()).filter((runId) => runId.length > 0);
}

export function listSubtaskChildSessionIdsByRunId(
  db: Db,
  params: { workspaceId: string; sessionId: string; runId: string }
) {
  const rows = db
    .prepare(
      `
        select
          tool_result_json as toolResultJson,
          output_text as outputText
        from agent_context_item
        where workspace_id = @workspaceId
          and session_id = @sessionId
          and run_id = @runId
          and kind = 'tool'
          and status in ('queued', 'running', 'streaming')
          and tool_name = 'subtask'
        order by id asc
      `
    )
    .all(params) as SubtaskToolRefRow[];

  const seen = new Set<string>();
  const childSessionIds: string[] = [];
  for (const row of rows) {
    const result = parseJson(row.toolResultJson) as StoredToolResult | null;
    const resultMeta = typeof result?.meta === "object" && result.meta && !Array.isArray(result.meta)
      ? (result.meta as Record<string, unknown>)
      : null;
    const rawResult = resultMeta && Object.prototype.hasOwnProperty.call(resultMeta, "result") ? resultMeta.result : undefined;
    const resultObj = rawResult && typeof rawResult === "object" && !Array.isArray(rawResult) ? (rawResult as Record<string, unknown>) : null;
    const fromResult = typeof resultObj?.subtaskSessionId === "string" ? resultObj.subtaskSessionId.trim() : "";
    const childSessionId = fromResult || parseSubtaskSessionIdFromToolText(row.outputText);
    if (!childSessionId || seen.has(childSessionId)) continue;
    seen.add(childSessionId);
    childSessionIds.push(childSessionId);
  }
  return childSessionIds;
}

export function updateRunRecordStatus(db: Db, params: { runId: string; status: AgentRunRecord["status"]; updatedAt: number }) {
  db.prepare(
    `
      update agent_run
      set status = @status,
          updated_at = @updatedAt
      where run_id = @runId
    `
  ).run(params);
}

export function failRunRecordIfInFlight(db: Db, params: { runId: string; updatedAt: number }) {
  return db
    .prepare(
      `
        update agent_run
        set status = 'failed',
            updated_at = @updatedAt
        where run_id = @runId
          and status = 'running'
      `
    )
    .run(params).changes;
}

export function failNonTerminalContextItemsByRunId(db: Db, params: { runId: string; updatedAt: number }) {
  return db
    .prepare(
      `
        update agent_context_item
        set status = 'failed',
            updated_at = @updatedAt
        where run_id = @runId
          and status in ('streaming', 'queued', 'running')
      `
    )
    .run(params).changes;
}

export function setRunStateIdleIfActiveRunMatches(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  runId: string;
  updatedAt: number;
  appliedItemId: number;
}) {
  return db
    .prepare(
      `
        update agent_session_run_state
        set status = 'idle',
            active_run_id = null,
            active_assistant_item_id = null,
            run_notice_text = '',
            updated_at = @updatedAt,
            applied_item_id = @appliedItemId
        where workspace_id = @workspaceId
          and session_id = @sessionId
          and active_run_id = @runId
          and status = 'running'
      `
    )
    .run(params).changes;
}

export function listInFlightSessionsWithoutActiveRunId(db: Db) {
  return db
    .prepare(
      `
        select
          workspace_id as workspaceId,
          session_id as sessionId
        from agent_session_run_state
        where status = 'running'
          and active_run_id is null
      `
    )
    .all() as Array<{ workspaceId: string; sessionId: string }>;
}

export function setRunStateIdleIfNoActiveRun(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  updatedAt: number;
  appliedItemId: number;
}) {
  return db
    .prepare(
      `
        update agent_session_run_state
        set status = 'idle',
            active_run_id = null,
            active_assistant_item_id = null,
            run_notice_text = '',
            updated_at = @updatedAt,
            applied_item_id = @appliedItemId
        where workspace_id = @workspaceId
          and session_id = @sessionId
          and active_run_id is null
          and status = 'running'
      `
    )
    .run(params).changes;
}

export function listRunningSessions(db: Db): Array<{ workspaceId: string; sessionId: string; activeRunId: string | null }> {
  const rows = db
    .prepare(
      `
        select workspace_id as workspaceId, session_id as sessionId, active_run_id as activeRunId
        from agent_session_run_state
        where status = 'running'
      `
    )
    .all() as Array<{ workspaceId: string; sessionId: string; activeRunId: string | null }>;
  return rows;
}

export function listRecoverableRuns(db: Db) {
  return db
    .prepare(
      `
        select
          rs.workspace_id as workspaceId,
          rs.session_id as sessionId,
          rs.active_run_id as runId,
          rs.status as runStateStatus,
          r.trigger_item_id as triggerItemId
        from agent_session_run_state rs
        left join agent_run r on r.run_id = rs.active_run_id
        where rs.status = 'running' and rs.active_run_id is not null
      `
    )
    .all() as Array<{
      workspaceId: string;
      sessionId: string;
      runId: string;
      runStateStatus: AgentRunStatus;
      triggerItemId: number | null;
    }>;
}
