import type {
  AgentCompactionMessage,
  AgentMessage,
  AgentMessageRow,
  AgentOrdinaryMessage,
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
import { AGENT_TIMELINE_TEXT_MAX_LENGTH, AgentMessageSchema } from "@agent-workbench/shared";
import { Value } from "@sinclair/typebox/value";
import type { Db } from "../../../infra/db/db.js";
import { HttpError } from "../../../app/errors.js";

const MESSAGE_PART_QUERY_CHUNK_SIZE = 500;

type HydratedMessage = AgentMessageRow & { inCurrentOperationRange?: boolean; parts: AgentMessagePart[] };

function asStrictMessage(message: HydratedMessage): AgentCompactionMessage | AgentOrdinaryMessage {
  const normalized = message.type === "compaction"
    ? message
    : (() => {
      const { retainedFromMessageId: _retainedFromMessageId, ...ordinaryMessage } = message;
      return ordinaryMessage;
    })();
  if (!Value.Check(AgentMessageSchema, normalized)) {
    throw new Error(`stored message ${message.id} violates the strict shared contract`);
  }
  return normalized;
}

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
  lastResponseTotalTokens: number | null;
  activeRunStartedAt: number | null;
  lastRunDurationMs: number | null;
  updatedAt: number;
};
type MessageRow = AgentMessageRow;
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

function timelineText(value: string | null) {
  return value !== null && value.length > AGENT_TIMELINE_TEXT_MAX_LENGTH
    ? value.slice(0, AGENT_TIMELINE_TEXT_MAX_LENGTH)
    : value;
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
    lastResponseTotalTokens: row.lastResponseTotalTokens == null ? null : Number(row.lastResponseTotalTokens),
    activeRunStartedAt: row.activeRunStartedAt == null ? null : Number(row.activeRunStartedAt),
    lastRunDurationMs: row.lastRunDurationMs == null ? null : Number(row.lastRunDurationMs),
    nextRetryAt: row.nextRetryAt,
    activeAssistantMessageId: row.activeAssistantMessageId,
    nonTerminalMessageIds: parseIdArray(row.nonTerminalMessageIdsJson),
    nonTerminalToolExecutionIds: parseIdArray(row.nonTerminalToolExecutionIdsJson),
    updatedAt: Number(row.updatedAt)
  };
}

/**
 * Read-only Message graph query. It deliberately starts from the Session head,
 * so Messages are exposed only when they are ancestors of the requesting
 * Session's current head. The display chain may cross contextRoot to preserve
 * browsable compacted history; runtime-only readers explicitly retain the
 * contextRoot boundary.
 */
export class SqliteMessageQuery {
  constructor(private readonly db: Db) {}

  getTimeline(input: {
    workspaceId: string;
    sessionId: string;
    mode?: "snapshot" | "delta" | "before";
    sinceRevision?: number;
    knownHeadMessageId?: string;
    knownContextRootMessageId?: string | null;
    beforeMessageId?: string;
    limit?: number;
  }): AgentTimelineDeltaResponse & { hasMore: boolean; nextBeforeMessageId: string | null } {
    const session = this.requireSession(input.workspaceId, input.sessionId);
    const mode = input.mode ?? (input.sinceRevision === undefined ? "snapshot" : "delta");
    const limit = Math.max(1, Math.min(500, input.limit ?? 100));
    const rootUnchanged = input.knownContextRootMessageId === undefined || input.knownContextRootMessageId === session.contextRootMessageId;
    // Compaction changes context root. A delta from the old root must reset, so
    // avoid the otherwise-unbounded old-head ancestry check on this hot path.
    const rootChanged = mode === "delta" && !rootUnchanged;
    const knownHeadStillVisible = rootChanged || !input.knownHeadMessageId || this.isDisplayChainMessage(session, input.knownHeadMessageId);
    const lacksLegacySafeAnchor = input.knownHeadMessageId === undefined && session.contextRootMessageId !== null;
    const timelineReset = mode === "delta" && (
      input.sinceRevision === undefined || input.sinceRevision > session.revision || lacksLegacySafeAnchor || !knownHeadStillVisible || rootChanged
    );

    let page: MessageRow[];
    let hasMore = false;
    if (mode === "before") {
      if (!input.beforeMessageId || !this.isDisplayChainMessage(session, input.beforeMessageId)) {
        throw new HttpError(404, "timeline cursor is not in current session chain", "TIMELINE_CURSOR_NOT_FOUND");
      }
      ({ page, hasMore } = this.listDisplayPageBefore(session, input.beforeMessageId, limit));
    } else if (mode === "delta" && !timelineReset) {
      page = this.listDisplayChainUpdates(session, input.sinceRevision!);
    } else {
      ({ page, hasMore } = this.listDisplayTailPage(session, limit));
    }
    const messages = this.attachParts(page, this.contextRootDepth(session)).map(asStrictMessage);
    const toolExecutions = mode === "delta" && !timelineReset
      ? this.listTimelineExecutions(session, input.sinceRevision)
      : this.listTimelineExecutionsForMessages(page.map((message) => message.id));
    return { session, timelineReset, messages, toolExecutions, hasMore, nextBeforeMessageId: page[0]?.id ?? null };
  }

  getMessage(input: { workspaceId: string; sessionId: string; messageId: string }): AgentCompactionMessage | AgentOrdinaryMessage {
    const session = this.requireSession(input.workspaceId, input.sessionId);
    const message = this.getDisplayChainMessage(session, input.messageId);
    if (!message) throw new HttpError(404, "message not found in session timeline", "MESSAGE_NOT_FOUND");
    return asStrictMessage(this.attachParts([message], this.contextRootDepth(session))[0]!);
  }

  /** timeline 保持轻量，详情只允许读取当前 Session 展示链上的 execution。 */
  getToolExecutionDetail(input: { workspaceId: string; sessionId: string; toolExecutionId: string }): AgentToolExecution {
    const session = this.requireSession(input.workspaceId, input.sessionId);
    const row = this.db.prepare(`
      ${this.displayChainCte()}
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
      join display_chain chain on chain.id = part.message_id
      where execution.id = @toolExecutionId
    `).get({ ...this.displayChainParams(session), toolExecutionId: input.toolExecutionId }) as DetailExecutionRow | undefined;
    if (!row) {
      throw new HttpError(404, "tool execution not found in session timeline", "TOOL_EXECUTION_NOT_FOUND");
    }
    return this.toDetailExecution(row);
  }

  /** 当前可见链上最后一个完成 Assistant 的完整文本，仅供窄化渠道读取。 */
  getLastAssistantText(input: { workspaceId: string; sessionId: string }): { found: boolean; text: string } {
    const session = this.requireSession(input.workspaceId, input.sessionId);
    const message = [...this.listActiveContextChain(session)].reverse().find((candidate) => candidate.type === "assistant" && candidate.status === "completed");
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
    const messages = this.attachParts(this.listActiveContextChain(session)).map(asStrictMessage);
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
    const execution = this.db.prepare(`
      ${this.displayChainCte()}
      select execution.id
      from agent_tool_execution execution
      join agent_message_part part on part.id = execution.call_part_id
      join display_chain chain on chain.id = part.message_id
      where execution.id = @toolExecutionId
        and execution.status in ('completed', 'failed', 'cancelled')
        and part.type = 'tool_call'
        and part.tool_name = @toolName
    `).get({ ...this.displayChainParams(session), toolExecutionId: input.toolExecutionId, toolName: input.toolName }) as { id: string } | undefined;
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
      select state.workspace_id as workspaceId, state.session_id as sessionId, state.status,
             state.active_run_id as activeRunId, state.run_notice_text as runNoticeText,
             state.retry_count as retryCount, state.next_retry_at as nextRetryAt,
             state.active_assistant_message_id as activeAssistantMessageId,
             state.non_terminal_message_ids_json as nonTerminalMessageIdsJson,
             state.non_terminal_tool_execution_ids_json as nonTerminalToolExecutionIdsJson,
             state.last_response_total_tokens as lastResponseTotalTokens,
             active.created_at as activeRunStartedAt,
             case when latest.run_id is null then null
               else max(0, latest.updated_at - latest.created_at) end as lastRunDurationMs,
             state.updated_at as updatedAt
      from session_run_state state
      left join agent_run active on active.run_id = state.active_run_id
      left join agent_run latest on latest.run_id = (
        select run.run_id from agent_run run
        where run.workspace_id = state.workspace_id and run.session_id = state.session_id
          and run.status in ('completed','failed','cancelled')
        order by run.updated_at desc, run.run_id desc limit 1
      )
      where state.workspace_id = ? and state.session_id = ?
    `).get(workspaceId, sessionId) as RunStateRow | undefined;
  }

  private displayChainCte() {
    return `
      with recursive display_chain(id, workspace_id, previous_message_id, replaces_message_id, retained_from_message_id, depth, type, status,
                                   origin_session_id, origin_run_id, updated_revision, created_at, updated_at) as (
        select id, workspace_id, previous_message_id, replaces_message_id, retained_from_message_id, depth, type, status,
               origin_session_id, origin_run_id, updated_revision, created_at, updated_at
        from agent_message
        where id = @headMessageId and workspace_id = @workspaceId
        union all
        select message.id, message.workspace_id, message.previous_message_id, message.replaces_message_id, message.retained_from_message_id,
               message.depth, message.type, message.status, message.origin_session_id, message.origin_run_id,
               message.updated_revision, message.created_at, message.updated_at
        from agent_message message
        join display_chain chain on chain.previous_message_id = message.id
        where message.workspace_id = @workspaceId
      )
    `;
  }

  private displayChainParams(session: AgentSessionMessageState) {
    return { workspaceId: session.workspaceId, headMessageId: session.headMessageId };
  }

  private isDisplayChainMessage(session: AgentSessionMessageState, messageId: string) {
    if (!session.headMessageId) return false;
    const row = this.db.prepare(`
      with recursive ancestors(id, previous_message_id) as (
        select id, previous_message_id from agent_message where id = @headMessageId and workspace_id = @workspaceId
        union all
        select message.id, message.previous_message_id
        from agent_message message join ancestors on ancestors.previous_message_id = message.id
        where message.workspace_id = @workspaceId and ancestors.id <> @messageId
      )
      select 1 as found from ancestors where id = @messageId limit 1
    `).get({ ...this.displayChainParams(session), messageId }) as { found: number } | undefined;
    return Boolean(row);
  }

  private getDisplayChainMessage(session: AgentSessionMessageState, messageId: string): MessageRow | undefined {
    if (!session.headMessageId) return undefined;
    return this.db.prepare(`
      ${this.displayChainCte()}
      select id, workspace_id as workspaceId, previous_message_id as previousMessageId,
             replaces_message_id as replacesMessageId, retained_from_message_id as retainedFromMessageId, depth, type, status,
             origin_session_id as originSessionId, origin_run_id as originRunId,
             updated_revision as updatedRevision, created_at as createdAt, updated_at as updatedAt
      from display_chain where id = @messageId limit 1
    `).get({ ...this.displayChainParams(session), messageId }) as MessageRow | undefined;
  }

  private listDisplayTailPage(session: AgentSessionMessageState, limit: number) {
    if (!session.headMessageId) return { page: [] as MessageRow[], hasMore: false };
    const rows = this.db.prepare(`
      with recursive page_chain(id, workspace_id, previous_message_id, replaces_message_id, retained_from_message_id, depth, type, status,
                                origin_session_id, origin_run_id, updated_revision, created_at, updated_at, steps) as (
        select id, workspace_id, previous_message_id, replaces_message_id, retained_from_message_id, depth, type, status,
               origin_session_id, origin_run_id, updated_revision, created_at, updated_at, 1
        from agent_message where id = @headMessageId and workspace_id = @workspaceId
        union all
        select message.id, message.workspace_id, message.previous_message_id, message.replaces_message_id, message.retained_from_message_id,
               message.depth, message.type, message.status, message.origin_session_id, message.origin_run_id,
               message.updated_revision, message.created_at, message.updated_at, chain.steps + 1
        from agent_message message join page_chain chain on chain.previous_message_id = message.id
        where message.workspace_id = @workspaceId and chain.steps < @take
      )
      select id, workspace_id as workspaceId, previous_message_id as previousMessageId,
             replaces_message_id as replacesMessageId, retained_from_message_id as retainedFromMessageId, depth, type, status,
             origin_session_id as originSessionId, origin_run_id as originRunId,
             updated_revision as updatedRevision, created_at as createdAt, updated_at as updatedAt
      from page_chain order by depth asc
    `).all({ ...this.displayChainParams(session), take: limit + 1 }) as MessageRow[];
    return this.trimDisplayPage(rows, limit);
  }

  private listDisplayPageBefore(session: AgentSessionMessageState, beforeMessageId: string, limit: number) {
    const rows = this.db.prepare(`
      with recursive page_chain(id, workspace_id, previous_message_id, replaces_message_id, depth, type, status,
                                origin_session_id, origin_run_id, updated_revision, created_at, updated_at, steps) as (
        select message.id, message.workspace_id, message.previous_message_id, message.replaces_message_id,
               message.depth, message.type, message.status, message.origin_session_id, message.origin_run_id,
               message.updated_revision, message.created_at, message.updated_at, 1
        from agent_message message
        join agent_message cursor on cursor.previous_message_id = message.id
        where cursor.id = @beforeMessageId and cursor.workspace_id = @workspaceId and message.workspace_id = @workspaceId
        union all
        select message.id, message.workspace_id, message.previous_message_id, message.replaces_message_id,
               message.depth, message.type, message.status, message.origin_session_id, message.origin_run_id,
               message.updated_revision, message.created_at, message.updated_at, chain.steps + 1
        from agent_message message join page_chain chain on chain.previous_message_id = message.id
        where message.workspace_id = @workspaceId and chain.steps < @take
      )
      select id, workspace_id as workspaceId, previous_message_id as previousMessageId,
             replaces_message_id as replacesMessageId, depth, type, status,
             origin_session_id as originSessionId, origin_run_id as originRunId,
             updated_revision as updatedRevision, created_at as createdAt, updated_at as updatedAt
      from page_chain order by depth asc
    `).all({ workspaceId: session.workspaceId, beforeMessageId, take: limit + 1 }) as MessageRow[];
    return this.trimDisplayPage(rows, limit);
  }

  private trimDisplayPage(rows: MessageRow[], limit: number) {
    const hasMore = rows.length > limit;
    return { page: hasMore ? rows.slice(1) : rows, hasMore };
  }

  private listDisplayChainUpdates(session: AgentSessionMessageState, sinceRevision: number): MessageRow[] {
    if (!session.headMessageId) return [];
    return this.db.prepare(`
      ${this.displayChainCte()}
      select id, workspace_id as workspaceId, previous_message_id as previousMessageId,
             replaces_message_id as replacesMessageId, retained_from_message_id as retainedFromMessageId, depth, type, status,
             origin_session_id as originSessionId, origin_run_id as originRunId,
             updated_revision as updatedRevision, created_at as createdAt, updated_at as updatedAt
      from display_chain where updated_revision > @sinceRevision order by depth asc
    `).all({ ...this.displayChainParams(session), sinceRevision }) as MessageRow[];
  }

  private contextRootDepth(session: AgentSessionMessageState): number | null {
    if (!session.contextRootMessageId) return null;
    const row = this.db.prepare(`
      select depth from agent_message where id = ? and workspace_id = ?
    `).get(session.contextRootMessageId, session.workspaceId) as { depth: number } | undefined;
    return row ? Number(row.depth) : null;
  }

  /** 当前模型上下文链；从最近 compaction/context root 开始，供运行时专用。 */
  private listActiveContextChain(session: AgentSessionMessageState): MessageRow[] {
    return this.listChain(session, session.contextRootMessageId);
  }

  private listChain(session: AgentSessionMessageState, stopAtMessageId: string | null): MessageRow[] {
    if (!session.headMessageId) return [];
    return this.db.prepare(`
      with recursive chain(id, workspace_id, previous_message_id, replaces_message_id, retained_from_message_id, depth, type, status,
                           origin_session_id, origin_run_id, updated_revision, created_at, updated_at) as (
        select id, workspace_id, previous_message_id, replaces_message_id, retained_from_message_id, depth, type, status,
               origin_session_id, origin_run_id, updated_revision, created_at, updated_at
        from agent_message where id = @headMessageId
        union all
        select message.id, message.workspace_id, message.previous_message_id, message.replaces_message_id, message.retained_from_message_id,
                message.depth, message.type, message.status, message.origin_session_id, message.origin_run_id,
                message.updated_revision, message.created_at, message.updated_at
        from agent_message message join chain on chain.previous_message_id = message.id
        where @stopAtMessageId is null or chain.id != @stopAtMessageId
      )
      select id, workspace_id as workspaceId, previous_message_id as previousMessageId,
             replaces_message_id as replacesMessageId, retained_from_message_id as retainedFromMessageId, depth, type, status,
             origin_session_id as originSessionId, origin_run_id as originRunId,
             updated_revision as updatedRevision, created_at as createdAt, updated_at as updatedAt
      from chain order by depth asc
    `).all({
      headMessageId: session.headMessageId,
      stopAtMessageId
    }) as MessageRow[];
  }

  private attachParts(rows: MessageRow[], operationRangeStartDepth?: number | null): HydratedMessage[] {
    if (rows.length === 0) return [];
    const partsByMessageId = new Map<string, AgentMessagePart[]>();
    for (let offset = 0; offset < rows.length; offset += MESSAGE_PART_QUERY_CHUNK_SIZE) {
      const messageIds = rows.slice(offset, offset + MESSAGE_PART_QUERY_CHUNK_SIZE).map((row) => row.id);
      const parts = this.db.prepare(`
        select id, message_id as messageId, position, type, text,
               attachment_id as attachmentId, media_type as mediaType, filename,
               tool_name as toolName, tool_input_json as toolInputJson,
               provider_tool_call_id as providerToolCallId, updated_revision as updatedRevision,
               created_at as createdAt, updated_at as updatedAt
        from agent_message_part where message_id in (${messageIds.map(() => "?").join(",")})
        order by message_id asc, position asc
      `).all(...messageIds) as PartRow[];
      for (const part of parts) {
        const current = partsByMessageId.get(part.messageId) ?? [];
        current.push(toPart(part));
        partsByMessageId.set(part.messageId, current);
      }
    }
    return rows.map((row) => ({
      ...row,
      depth: Number(row.depth),
      type: row.type as AgentMessageType,
      status: row.status as AgentMessageStatus,
      updatedRevision: Number(row.updatedRevision),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      ...(operationRangeStartDepth !== undefined
        ? { inCurrentOperationRange: operationRangeStartDepth === null || Number(row.depth) >= operationRangeStartDepth }
        : {}),
      parts: partsByMessageId.get(row.id) ?? []
    }));
  }

  private listTimelineExecutions(session: AgentSessionMessageState, sinceRevision: number | undefined): AgentTimelineToolExecution[] {
    if (!session.headMessageId) return [];
    const revisionClause = sinceRevision === undefined ? "" : "and execution.updated_revision > @sinceRevision";
    const rows = this.db.prepare(`
      ${this.displayChainCte()}
      select execution.id, execution.call_part_id as callPartId,
             execution.status, execution.result_preview as resultPreview,
             execution.result_truncated as resultTruncated, execution.error,
             execution.updated_revision as updatedRevision, execution.started_at as startedAt,
             execution.completed_at as completedAt
      from agent_tool_execution execution
      join agent_message_part part on part.id = execution.call_part_id
      join display_chain chain on chain.id = part.message_id
      where 1 = 1 ${revisionClause}
      order by execution.created_at asc, execution.id asc
    `).all({ ...this.displayChainParams(session), sinceRevision }) as TimelineExecutionRow[];
    return rows.map((row) => ({
      id: row.id,
      callPartId: row.callPartId,
      status: row.status as AgentToolExecutionStatus,
      resultPreview: timelineText(row.resultPreview),
      resultTruncated: Number(row.resultTruncated) === 1 || (row.resultPreview?.length ?? 0) > AGENT_TIMELINE_TEXT_MAX_LENGTH,
      error: timelineText(row.error),
      updatedRevision: Number(row.updatedRevision),
      startedAt: row.startedAt,
      completedAt: row.completedAt
    }));
  }

  private listTimelineExecutionsForMessages(messageIds: string[]): AgentTimelineToolExecution[] {
    if (messageIds.length === 0) return [];
    const rows = this.db.prepare(`
      select execution.id, execution.call_part_id as callPartId, execution.status, execution.result_preview as resultPreview,
             execution.result_truncated as resultTruncated, execution.error, execution.updated_revision as updatedRevision,
             execution.started_at as startedAt, execution.completed_at as completedAt
      from agent_tool_execution execution
      join agent_message_part part on part.id = execution.call_part_id
      where part.message_id in (${messageIds.map(() => "?").join(",")})
      order by execution.created_at asc, execution.id asc
    `).all(...messageIds) as TimelineExecutionRow[];
    return rows.map((row) => ({
      id: row.id,
      callPartId: row.callPartId,
      status: row.status as AgentToolExecutionStatus,
      resultPreview: timelineText(row.resultPreview),
      resultTruncated: Number(row.resultTruncated) === 1 || (row.resultPreview?.length ?? 0) > AGENT_TIMELINE_TEXT_MAX_LENGTH,
      error: timelineText(row.error),
      updatedRevision: Number(row.updatedRevision),
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    }));
  }
}
