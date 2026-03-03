import type {
  AgentContextItemOutput,
  AgentContextItemRecord,
  AgentContextItemStatus,
  AgentRunStatus,
  AgentSessionRecord
} from "@agent-workbench/shared";
import type { Db } from "../../infra/db/db.js";

const TERMINAL_ITEM_STATUS = new Set<AgentContextItemStatus>(["completed", "failed", "denied", "cancelled"]);

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
  outputTextTruncated: number;
  outputTextArtifactPath: string | null;
  toolName: string | null;
  toolCallId: string | null;
  toolCallJson: string | null;
  toolResultJson: string | null;
  archiveAt: number | null;
  outputJson: string;
  createdAt: number;
  updatedAt: number;
};

type StoredToolCall = {
  toolName?: unknown;
  toolCallId?: unknown;
  args?: unknown;
  approval?: {
    approved?: unknown;
  };
};

type StoredToolResult = {
  status?: unknown;
  error?: unknown;
  meta?: unknown;
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

function normalizeTextOutput(kind: AgentContextItemRecord["kind"], output: AgentContextItemOutput) {
  if (kind === "user" && output.type === "user_text") return output.text;
  if (kind === "assistant" && output.type === "assistant_text") return output.text;
  if (kind === "system" && output.type === "system_text") return output.text;
  if (kind === "tool" && output.type === "tool") return toResultText(output.result);
  if ((output as { text?: unknown }).text && typeof (output as { text?: unknown }).text === "string") {
    return String((output as { text?: unknown }).text);
  }
  return "";
}

function encodeStoredColumns(params: {
  kind: AgentContextItemRecord["kind"];
  status: AgentContextItemStatus;
  output: AgentContextItemOutput;
}) {
  const outputText = normalizeTextOutput(params.kind, params.output);
  const base = {
    outputText,
    outputTextTruncated: 0,
    outputTextArtifactPath: null as string | null,
    toolName: null as string | null,
    toolCallId: null as string | null,
    toolCallJson: null as string | null,
    toolResultJson: null as string | null,
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
    ...(typeof params.output.args !== "undefined" ? { args: params.output.args } : {}),
    ...(params.output.approved === true ? { approval: { approved: true } } : {})
  };
  const toolResultPayload: StoredToolResult = {
    status: params.status,
    ...(Object.prototype.hasOwnProperty.call(params.output, "result")
      ? {
          meta: {
            resultFormat: typeof params.output.result === "string" ? "text" : "json"
          }
        }
      : {}),
    ...(typeof params.output.error === "string" && params.output.error.trim()
      ? { error: params.output.error }
      : {})
  };

  return {
    ...base,
    outputText,
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
    row.outputTextArtifactPath != null ||
    row.toolName != null ||
    row.toolCallId != null ||
    row.toolCallJson != null ||
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
      text: row.outputText
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
  const approved = call?.approval?.approved === true || legacyTool?.approved === true;

  const resultFormat = typeof result?.meta === "object" && result.meta && !Array.isArray(result.meta)
    ? String(((result.meta as Record<string, unknown>).resultFormat as string) || "").trim()
    : "";

  let parsedResult: unknown = undefined;
  if (row.outputText.trim()) {
    if (resultFormat === "json") {
      try {
        parsedResult = JSON.parse(row.outputText);
      } catch {
        parsedResult = row.outputText;
      }
    } else if (!resultFormat && (toolName === "apply_patch" || toolName === "todolist" || toolName === "subtask")) {
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
    typeof result?.error === "string" && result.error.trim()
      ? result.error
      : legacyTool && typeof legacyTool.error === "string" && legacyTool.error.trim()
        ? legacyTool.error
        : undefined;

  return {
    type: "tool",
    toolName: toolName as any,
    ...(toolCallId ? { toolCallId } : {}),
    ...(typeof args !== "undefined" ? { args } : {}),
    ...(approved ? { approved: true } : {}),
    ...(typeof parsedResult !== "undefined" ? { result: parsedResult } : {}),
    ...(error ? { error } : {})
  } as AgentContextItemOutput;
}

export type AgentRunStateRow = {
  sessionId: string;
  status: AgentRunStatus;
  activeRunId: string | null;
  activeAssistantItemId: number | null;
  waitingToolItemId: number | null;
  lastResponseTotalTokens: number | null;
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
  status: "running" | "waiting_permission" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
};

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
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    runId,
    turnId,
    step,
    prevId,
    kind: row.kind,
    status: row.status,
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
          output_text_truncated as outputTextTruncated,
          output_text_artifact_path as outputTextArtifactPath,
          tool_name as toolName,
          tool_call_id as toolCallId,
          tool_call_json as toolCallJson,
          tool_result_json as toolResultJson,
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
  waitingToolItemId: number | null;
  lastResponseTotalTokens?: number | null;
  setLastResponseTotalTokens?: boolean;
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
        waiting_tool_item_id,
        last_response_total_tokens,
        updated_at,
        applied_item_id
      ) values (
        @workspaceId,
        @sessionId,
        @status,
        @activeRunId,
        @activeAssistantItemId,
        @waitingToolItemId,
        @lastResponseTotalTokens,
        @updatedAt,
        @appliedItemId
      )
      on conflict(workspace_id, session_id) do update set
        status = excluded.status,
        active_run_id = excluded.active_run_id,
        active_assistant_item_id = excluded.active_assistant_item_id,
        waiting_tool_item_id = excluded.waiting_tool_item_id,
        last_response_total_tokens = case
          when @setLastResponseTotalTokens = 1 then @lastResponseTotalTokens
          else agent_session_run_state.last_response_total_tokens
        end,
        updated_at = excluded.updated_at,
        applied_item_id = excluded.applied_item_id
    `
  ).run({
    ...params,
    lastResponseTotalTokens: params.lastResponseTotalTokens ?? null,
    setLastResponseTotalTokens: params.setLastResponseTotalTokens ? 1 : 0
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
      waitingToolItemId: null,
      updatedAt: params.createdAt,
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
            output_text_truncated,
            output_text_artifact_path,
            tool_name,
            tool_call_id,
            tool_call_json,
            tool_result_json,
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
            @outputTextTruncated,
            @outputTextArtifactPath,
            @toolName,
            @toolCallId,
            @toolCallJson,
            @toolResultJson,
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
        outputTextTruncated: stored.outputTextTruncated,
        outputTextArtifactPath: stored.outputTextArtifactPath,
        toolName: stored.toolName,
        toolCallId: stored.toolCallId,
        toolCallJson: stored.toolCallJson,
        toolResultJson: stored.toolResultJson,
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
          output_text_truncated = @outputTextTruncated,
          output_text_artifact_path = @outputTextArtifactPath,
          tool_name = @toolName,
          tool_call_id = @toolCallId,
          tool_call_json = @toolCallJson,
          tool_result_json = @toolResultJson,
          output_json = @outputJson,
          updated_at = @updatedAt
      where id = @itemId
    `
  ).run({
    itemId: params.itemId,
    status: nextStatus,
    outputText: stored.outputText,
    outputTextTruncated: stored.outputTextTruncated,
    outputTextArtifactPath: stored.outputTextArtifactPath,
    toolName: stored.toolName,
    toolCallId: stored.toolCallId,
    toolCallJson: stored.toolCallJson,
    toolResultJson: stored.toolResultJson,
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

export function getSessionVisibleItems(db: Db, workspaceId: string, sessionId: string): AgentContextItemRecord[] {
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
    if (row.archiveAt == null) {
      rows.push(mapContextItem(row));
    }
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

export function getVisibleItemById(db: Db, workspaceId: string, sessionId: string, itemId: number) {
  const visible = getSessionVisibleItems(db, workspaceId, sessionId);
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
          waiting_tool_item_id as waitingToolItemId,
          last_response_total_tokens as lastResponseTotalTokens,
          updated_at as updatedAt,
          applied_item_id as appliedItemId
        from agent_session_run_state
        where workspace_id = ? and session_id = ?
      `
    )
    .get(workspaceId, sessionId) as AgentRunStateRow | undefined;
  if (row) return row;
  return {
    sessionId,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    waitingToolItemId: null,
    lastResponseTotalTokens: null,
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
  waitingToolItemId: number | null;
  lastResponseTotalTokens?: number | null;
  updatedAt: number;
  appliedItemId: number;
}) {
  upsertRunState(db, {
    ...params,
    setLastResponseTotalTokens: Object.prototype.hasOwnProperty.call(params, "lastResponseTotalTokens")
  });
}

export function setRunStateIdle(db: Db, params: { workspaceId: string; sessionId: string; updatedAt: number; appliedItemId: number }) {
  upsertRunState(db, {
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    waitingToolItemId: null,
    setLastResponseTotalTokens: false,
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

export function createRunRecord(db: Db, params: {
  runId: string;
  workspaceId: string;
  sessionId: string;
  triggerItemId: number;
  agentId: string;
  providerId: string;
  modelId: string;
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
        model_id,
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
        @modelId,
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
    modelId: params.modelId,
    status: params.status,
    createdAt: params.createdAt,
    updatedAt: params.createdAt
  });
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
          model_id as modelId,
          status,
          created_at as createdAt,
          updated_at as updatedAt
        from agent_run
        where run_id = ?
      `
    )
    .get(runId) as AgentRunRecord | undefined;
  return row ?? null;
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

export function listRunningSessions(db: Db): Array<{ workspaceId: string; sessionId: string; activeRunId: string | null }> {
  const rows = db
    .prepare(
      `
        select workspace_id as workspaceId, session_id as sessionId, active_run_id as activeRunId
        from agent_session_run_state
        where status in ('running', 'waiting_permission')
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
        where rs.status in ('running', 'waiting_permission') and rs.active_run_id is not null
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
