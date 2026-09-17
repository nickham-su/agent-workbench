import type {
  AgentMessage,
  AgentMessagePart,
  AgentMessageSessionRunState,
  AgentMessageStatus,
  AgentMessageType,
  AgentSessionMessageState,
  AgentSessionLatestTodolistExecution,
  AgentTimelineDeltaResponse,
  AgentTimelineToolExecution,
  AgentToolExecution,
  AgentToolExecutionStatus
} from "@agent-workbench/shared";
import type { Db } from "../../../infra/db/db.js";
import { HttpError } from "../../../app/errors.js";
import type { RuntimeTranscriptExecution } from "./runtime-transcript-projector.js";

type SessionRow = AgentSessionMessageState;
type RunStateRow = {
  workspaceId: string;
  sessionId: string;
  status: "idle" | "running";
  activeRunId: string | null;
  runNoticeText: string;
  retryCount: number;
  nextRetryAt: number | null;
  activeAssistantMessageId: string | null;
  nonTerminalMessageIdsJson: string;
  nonTerminalToolExecutionIdsJson: string;
  updatedAt: number;
};
type MessageRow = Omit<AgentMessage, "parts">;
type PartRow = {
  id: string;
  messageId: string;
  position: number;
  type: AgentMessagePart["type"];
  text: string | null;
  attachmentId: string | null;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | null;
  filename: string | null;
  toolName: string | null;
  toolInputJson: string | null;
  providerToolCallId: string | null;
  updatedRevision: number;
  createdAt: number;
  updatedAt: number;
};
type TimelineExecutionRow = Omit<AgentTimelineToolExecution, "resultTruncated"> & { resultTruncated: number };
type DetailExecutionRow = Omit<AgentToolExecution, "resultTruncated" | "structuredResult"> & {
  resultTruncated: number;
  structuredResultJson: string | null;
};
type LatestTodolistExecutionRow = {
  resultPreview: string | null;
  structuredResultJson: string | null;
};

function parseIdArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function parseToolInput(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStructuredResult(value: string | null): unknown | null {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toPart(row: PartRow): AgentMessagePart {
  const common = {
    id: row.id,
    messageId: row.messageId,
    position: Number(row.position),
    updatedRevision: Number(row.updatedRevision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt)
  };
  if (row.type === "text" || row.type === "reasoning") return { ...common, type: row.type, text: row.text ?? "" };
  if (row.type === "image") {
    return {
      ...common,
      type: "image",
      attachmentId: row.attachmentId ?? "",
      mediaType: row.mediaType ?? "image/png",
      filename: row.filename ?? "attachment"
    };
  }
  return {
    ...common,
    type: "tool_call",
    toolName: row.toolName ?? "bash",
    input: parseToolInput(row.toolInputJson),
    providerToolCallId: row.providerToolCallId
  };
}

function toSession(row: SessionRow): AgentSessionMessageState {
  return {
    ...row,
    revision: Number(row.revision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt)
  };
}

function toRunState(row: RunStateRow): AgentMessageSessionRunState {
  return {
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    status: row.status,
    activeRunId: row.activeRunId,
    runNoticeText: row.runNoticeText,
    retryCount: Number(row.retryCount),
    nextRetryAt: row.nextRetryAt,
    activeAssistantMessageId: row.activeAssistantMessageId,
    nonTerminalMessageIds: parseIdArray(row.nonTerminalMessageIdsJson),
    nonTerminalToolExecutionIds: parseIdArray(row.nonTerminalToolExecutionIdsJson),
    updatedAt: Number(row.updatedAt)
  };
}

/**
 * Read-only Message graph query. It deliberately starts from the Session head,
 * so shared historical Messages from another fork are never exposed unless they
 * are on the requesting Session's current context chain.
 */
export class SqliteMessageQuery {
  constructor(private readonly db: Db) {}

  getTimeline(input: {
    workspaceId: string;
    sessionId: string;
    mode?: "snapshot" | "delta" | "before";
    sinceRevision?: number;
    knownHeadMessageId?: string;
    knownContextRootMessageId?: string;
    beforeMessageId?: string;
    limit?: number;
  }): AgentTimelineDeltaResponse & { hasMore: boolean; nextBeforeMessageId: string | null } {
    const session = this.requireSession(input.workspaceId, input.sessionId);
    const chain = this.listChain(session);
    const mode = input.mode ?? (input.sinceRevision === undefined ? "snapshot" : "delta");
    const limit = Math.max(1, Math.min(500, input.limit ?? 100));
    const chainIds = chain.map((message) => message.id);
    const knownHeadStillVisible = !input.knownHeadMessageId || chainIds.includes(input.knownHeadMessageId);
    const rootUnchanged = input.knownContextRootMessageId === undefined || input.knownContextRootMessageId === session.contextRootMessageId;
    const lacksLegacySafeAnchor = input.knownHeadMessageId === undefined && session.contextRootMessageId !== null;
    const timelineReset = mode === "delta" && (
      input.sinceRevision === undefined || input.sinceRevision > session.revision || lacksLegacySafeAnchor || !knownHeadStillVisible || !rootUnchanged
    );

    let page: MessageRow[];
    let hasMore = false;
    if (mode === "before") {
      const beforeIndex = chain.findIndex((message) => message.id === input.beforeMessageId);
      if (beforeIndex < 0) throw new HttpError(404, "timeline cursor is not in current session chain", "TIMELINE_CURSOR_NOT_FOUND");
      const start = Math.max(0, beforeIndex - limit);
      page = chain.slice(start, beforeIndex);
      hasMore = start > 0;
    } else if (mode === "delta" && !timelineReset) {
      page = chain.filter((message) => Number(message.updatedRevision) > input.sinceRevision!);
    } else {
      const start = Math.max(0, chain.length - limit);
      page = chain.slice(start);
      hasMore = start > 0;
    }
    const messages = this.attachParts(page);
    const pageCallPartIds = messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "tool_call")
      .map((part) => part.id);
    const toolExecutions = mode === "delta" && !timelineReset
      ? this.listTimelineExecutions(chainIds, input.sinceRevision)
      : this.listTimelineExecutionsForCallParts(pageCallPartIds);
    return { session, timelineReset, messages, toolExecutions, hasMore, nextBeforeMessageId: page[0]?.id ?? null };
  }

  getMessage(input: { workspaceId: string; sessionId: string; messageId: string }): AgentMessage {
    const session = this.requireSession(input.workspaceId, input.sessionId);
    const message = this.listChain(session).find((candidate) => candidate.id === input.messageId);
    if (!message) throw new HttpError(404, "message not found in session timeline", "MESSAGE_NOT_FOUND");
    return this.attachParts([message])[0]!;
  }

  /** timeline 保持轻量，详情只允许读取当前 Session 可见链上的 execution。 */
  getToolExecutionDetail(input: { workspaceId: string; sessionId: string; toolExecutionId: string }): AgentToolExecution {
    const session = this.requireSession(input.workspaceId, input.sessionId);
    const chainIds = this.listChain(session).map((message) => message.id);
    if (chainIds.length === 0) {
      throw new HttpError(404, "tool execution not found in session timeline", "TOOL_EXECUTION_NOT_FOUND");
    }
    const placeholders = chainIds.map(() => "?").join(",");
    const row = this.db.prepare(`
      select execution.id, execution.call_part_id as callPartId,
             execution.origin_session_id as originSessionId, execution.origin_run_id as originRunId,
             execution.status, execution.result_preview as resultPreview,
             execution.result_truncated as resultTruncated,
             execution.result_artifact_path as resultArtifactPath,
             execution.structured_result_json as structuredResultJson,
             execution.error, execution.updated_revision as updatedRevision,
             execution.created_at as createdAt, execution.updated_at as updatedAt,
             execution.started_at as startedAt, execution.completed_at as completedAt
      from agent_tool_execution execution
      join agent_message_part part on part.id = execution.call_part_id
      where execution.id = ? and part.message_id in (${placeholders})
    `).get(input.toolExecutionId, ...chainIds) as DetailExecutionRow | undefined;
    if (!row) {
      throw new HttpError(404, "tool execution not found in session timeline", "TOOL_EXECUTION_NOT_FOUND");
    }
    return this.toDetailExecution(row);
  }

  /** 当前可见链上最后一个完成 Assistant 的完整文本，仅供窄化渠道读取。 */
  getLastAssistantText(input: { workspaceId: string; sessionId: string }): { found: boolean; text: string } {
    const session = this.requireSession(input.workspaceId, input.sessionId);
    const message = [...this.listChain(session)].reverse().find((candidate) => candidate.type === "assistant" && candidate.status === "completed");
    if (!message) return { found: false, text: "" };
    const text = this.attachParts([message])[0]!.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    return { found: text.length > 0, text };
  }

  /** 当前可见链上最新 todolist ToolCall 的权威 ToolExecution 详情。 */
  getLatestTodolistToolExecution(input: { workspaceId: string; sessionId: string }): AgentSessionLatestTodolistExecution | null {
    const session = this.requireSession(input.workspaceId, input.sessionId);
    const messages = this.attachParts(this.listChain(session));
    const callPart = [...messages].reverse().flatMap((message) => [...message.parts].reverse())
    .find((part) => part.type === "tool_call" && part.toolName === "todolist");
    if (!callPart) return null;
    const row = this.db.prepare(`
      select execution.result_preview as resultPreview,
             execution.structured_result_json as structuredResultJson
      from agent_tool_execution execution where execution.call_part_id = ?
    `).get(callPart.id) as LatestTodolistExecutionRow | undefined;
    if (!row) return null;
    return {
      resultPreview: row.resultPreview,
      structuredResult: parseStructuredResult(row.structuredResultJson)
    };
  }

  getSnapshot(input: { workspaceId: string; sessionId: string; sinceRevision?: number }) {
    const timeline = this.getTimeline(input);
    const row = this.runStateRow(input.workspaceId, input.sessionId);
    if (!row) throw new HttpError(404, "session run state not found", "SESSION_NOT_FOUND");
    return { ...timeline, runState: toRunState(row) };
  }

  /** Returns only the current contextRoot..head previous-message lineage. */
  getRuntimeTranscriptSource(input: { workspaceId: string; sessionId: string }) {
    const session = this.requireSession(input.workspaceId, input.sessionId);
    const messages = this.attachParts(this.listChain(session));
    const callPartIds = messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "tool_call")
      .map((part) => part.id);
    const executions = callPartIds.length === 0
      ? []
      : this.db.prepare(`
          select call_part_id as callPartId, status, result_preview as resultPreview, error
          from agent_tool_execution
          where call_part_id in (${callPartIds.map(() => "?").join(",")})
        `).all(...callPartIds) as RuntimeTranscriptExecution[];
    return { messages, executions };
  }

  getRunState(input: { workspaceId: string; sessionId: string }): AgentMessageSessionRunState {
    this.requireSession(input.workspaceId, input.sessionId);
    const row = this.runStateRow(input.workspaceId, input.sessionId);
    if (!row) throw new HttpError(404, "session run state not found", "SESSION_NOT_FOUND");
    return toRunState(row);
  }

  getArtifactToolExecution(input: {
    workspaceId: string;
    sessionId: string;
    toolExecutionId: string;
    toolName: "apply_patch" | "write";
  }): { workspaceId: string; toolExecutionId: string } {
    const session = this.requireSession(input.workspaceId, input.sessionId);
    const chainIds = this.listChain(session).map((message) => message.id);
    if (chainIds.length === 0) throw new HttpError(404, `${input.toolName} artifact not found`, "ARTIFACT_NOT_FOUND");
    const execution = this.db.prepare(`
      select execution.id
      from agent_tool_execution execution
      join agent_message_part part on part.id = execution.call_part_id
      where execution.id = ? and part.message_id in (${chainIds.map(() => "?").join(",")})
        and part.type = 'tool_call' and part.tool_name = ?
    `).get(input.toolExecutionId, ...chainIds, input.toolName) as { id: string } | undefined;
    if (!execution) throw new HttpError(404, `${input.toolName} artifact not found`, "ARTIFACT_NOT_FOUND");
    return { workspaceId: input.workspaceId, toolExecutionId: execution.id };
  }

  getRunFinalText(runId: string) {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return { found: false, text: "" };
    const row = this.db.prepare("select run_id from agent_run where run_id = ?").get(normalizedRunId) as { run_id: string } | undefined;
    if (!row) return { found: false, text: "" };
    const parts = this.db.prepare(`
      with latest_assistant as (
        select id
        from agent_message
        where origin_run_id = @runId
          and type = 'assistant'
          and status in ('completed', 'failed', 'cancelled', 'superseded')
        order by created_at desc, id desc
        limit 1
      )
      select part.text as text
      from agent_message_part part
      join latest_assistant on latest_assistant.id = part.message_id
      where part.type = 'text'
      order by part.position asc
    `).all({ runId: normalizedRunId }) as Array<{ text: string }>;
    return { found: parts.length > 0, text: parts.map((part) => part.text).join("") };
  }

  private toDetailExecution(row: DetailExecutionRow): AgentToolExecution {
    return {
      id: row.id,
      callPartId: row.callPartId,
      originSessionId: row.originSessionId,
      originRunId: row.originRunId,
      status: row.status as AgentToolExecutionStatus,
      resultPreview: row.resultPreview,
      resultTruncated: Number(row.resultTruncated) === 1,
      resultArtifactPath: row.resultArtifactPath,
      structuredResult: parseStructuredResult(row.structuredResultJson),
      error: row.error,
      updatedRevision: Number(row.updatedRevision),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    };
  }

  private requireSession(workspaceId: string, sessionId: string): AgentSessionMessageState {
    const row = this.db.prepare(`
      select id, workspace_id as workspaceId, title, kind,
             head_message_id as headMessageId, context_root_message_id as contextRootMessageId,
             revision, forked_from_session_id as forkedFromSessionId,
             forked_from_message_id as forkedFromMessageId, created_at as createdAt, updated_at as updatedAt
      from agent_session where id = ? and workspace_id = ?
    `).get(sessionId, workspaceId) as SessionRow | undefined;
    if (!row) throw new HttpError(404, "session not found", "SESSION_NOT_FOUND");
    return toSession(row);
  }

  private runStateRow(workspaceId: string, sessionId: string): RunStateRow | undefined {
    return this.db.prepare(`
      select workspace_id as workspaceId, session_id as sessionId, status,
             active_run_id as activeRunId, run_notice_text as runNoticeText,
             retry_count as retryCount, next_retry_at as nextRetryAt,
             active_assistant_message_id as activeAssistantMessageId,
             non_terminal_message_ids_json as nonTerminalMessageIdsJson,
             non_terminal_tool_execution_ids_json as nonTerminalToolExecutionIdsJson,
             updated_at as updatedAt
      from session_run_state where workspace_id = ? and session_id = ?
    `).get(workspaceId, sessionId) as RunStateRow | undefined;
  }

  private listChain(session: AgentSessionMessageState): MessageRow[] {
    if (!session.headMessageId) return [];
    return this.db.prepare(`
      with recursive chain(id, workspace_id, previous_message_id, replaces_message_id, depth, type, status,
                           origin_session_id, origin_run_id, updated_revision, created_at, updated_at) as (
        select id, workspace_id, previous_message_id, replaces_message_id, depth, type, status,
               origin_session_id, origin_run_id, updated_revision, created_at, updated_at
        from agent_message where id = @headMessageId
        union all
        select message.id, message.workspace_id, message.previous_message_id, message.replaces_message_id,
               message.depth, message.type, message.status, message.origin_session_id, message.origin_run_id,
               message.updated_revision, message.created_at, message.updated_at
        from agent_message message join chain on chain.previous_message_id = message.id
        where @contextRootMessageId is null or chain.id != @contextRootMessageId
      )
      select id, workspace_id as workspaceId, previous_message_id as previousMessageId,
             replaces_message_id as replacesMessageId, depth, type, status,
             origin_session_id as originSessionId, origin_run_id as originRunId,
             updated_revision as updatedRevision, created_at as createdAt, updated_at as updatedAt
      from chain order by depth asc
    `).all({
      headMessageId: session.headMessageId,
      contextRootMessageId: session.contextRootMessageId
    }) as MessageRow[];
  }

  private attachParts(rows: MessageRow[]): AgentMessage[] {
    if (rows.length === 0) return [];
    const partsByMessageId = new Map<string, AgentMessagePart[]>();
    const placeholders = rows.map(() => "?").join(",");
    const parts = this.db.prepare(`
      select id, message_id as messageId, position, type, text,
             attachment_id as attachmentId, media_type as mediaType, filename,
             tool_name as toolName, tool_input_json as toolInputJson,
             provider_tool_call_id as providerToolCallId, updated_revision as updatedRevision,
             created_at as createdAt, updated_at as updatedAt
      from agent_message_part where message_id in (${placeholders})
      order by message_id asc, position asc
    `).all(...rows.map((row) => row.id)) as PartRow[];
    for (const part of parts) {
      const current = partsByMessageId.get(part.messageId) ?? [];
      current.push(toPart(part));
      partsByMessageId.set(part.messageId, current);
    }
    return rows.map((row) => ({
      ...row,
      depth: Number(row.depth),
      type: row.type as AgentMessageType,
      status: row.status as AgentMessageStatus,
      updatedRevision: Number(row.updatedRevision),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      parts: partsByMessageId.get(row.id) ?? []
    }));
  }

  private listTimelineExecutions(chainIds: string[], sinceRevision: number | undefined): AgentTimelineToolExecution[] {
    if (chainIds.length === 0) return [];
    const placeholders = chainIds.map(() => "?").join(",");
    const revisionClause = sinceRevision === undefined ? "" : "and execution.updated_revision > ?";
    const values: Array<string | number> = [...chainIds];
    if (sinceRevision !== undefined) values.push(sinceRevision);
    const rows = this.db.prepare(`
      select execution.id, execution.call_part_id as callPartId,
             execution.status, execution.result_preview as resultPreview,
             execution.result_truncated as resultTruncated, execution.error,
             execution.updated_revision as updatedRevision, execution.started_at as startedAt,
             execution.completed_at as completedAt
      from agent_tool_execution execution
      join agent_message_part part on part.id = execution.call_part_id
      where part.message_id in (${placeholders}) ${revisionClause}
      order by execution.created_at asc, execution.id asc
    `).all(...values) as TimelineExecutionRow[];
    return rows.map((row) => ({
      id: row.id,
      callPartId: row.callPartId,
      status: row.status as AgentToolExecutionStatus,
      resultPreview: row.resultPreview,
      resultTruncated: Number(row.resultTruncated) === 1,
      error: row.error,
      updatedRevision: Number(row.updatedRevision),
      startedAt: row.startedAt,
      completedAt: row.completedAt
    }));
  }

  private listTimelineExecutionsForCallParts(callPartIds: string[]): AgentTimelineToolExecution[] {
    if (callPartIds.length === 0) return [];
    const rows = this.db.prepare(`
      select id, call_part_id as callPartId, status, result_preview as resultPreview,
             result_truncated as resultTruncated, error, updated_revision as updatedRevision,
             started_at as startedAt, completed_at as completedAt
      from agent_tool_execution where call_part_id in (${callPartIds.map(() => "?").join(",")})
      order by created_at asc, id asc
    `).all(...callPartIds) as TimelineExecutionRow[];
    return rows.map((row) => ({
      id: row.id,
      callPartId: row.callPartId,
      status: row.status as AgentToolExecutionStatus,
      resultPreview: row.resultPreview,
      resultTruncated: Number(row.resultTruncated) === 1,
      error: row.error,
      updatedRevision: Number(row.updatedRevision),
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    }));
  }
}
