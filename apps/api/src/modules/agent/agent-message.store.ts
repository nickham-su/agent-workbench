import type {
  PrimaryProjectionProfile,
  AgentCompactionMessage,
  AgentOrdinaryMessage,
  AgentMessage,
  AgentMessageRow,
  AgentMessagePart,
  AgentMessageStatus,
  AgentRunKind,
  AgentMessageType,
  AgentSessionMessageState,
  AgentMessageSessionRunState,
  AgentToolExecution,
  AgentRunExecutionPhase,
  AgentTerminalResultCode,
  AgentTerminalRunStatus,
  AgentToolExecutionStatus
} from "@agent-workbench/shared";
import { AgentCompactionMessageSchema, AgentOrdinaryMessageSchema, isAgentTerminalCodeAllowed } from "@agent-workbench/shared";
import { Value } from "@sinclair/typebox/value";
import {
  assertAgentProviderReplayUpdateCompatible,
  parseAgentProviderReplay,
  serializeAgentProviderReplay,
  type AgentProviderReplayEnvelope,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import type { Db } from "../../infra/db/db.js";
import { assertRetainedAnchorOnPreviousChain, ModelContextResolver } from "./read-side/model-context-resolver.js";
import { indexEligibleCompletedTextParts } from "./archive/agent-archive-store.js";

const TERMINAL_MESSAGE_STATUSES = new Set<AgentMessageStatus>(["completed", "failed", "cancelled", "superseded"]);
const TERMINAL_EXECUTION_STATUSES = new Set<AgentToolExecutionStatus>(["completed", "failed", "cancelled", "unknown"]);

export type AgentMessageDomainErrorCode =
  | "SESSION_NOT_FOUND"
  | "MESSAGE_TARGET_INVALID"
  | "MESSAGE_TARGET_BEFORE_CONTEXT_ROOT"
  | "MESSAGE_TARGET_HAS_NON_TERMINAL_EXECUTIONS"
  | "FORK_TARGET_INVALID"
  | "FORK_TARGET_BEFORE_CONTEXT_ROOT"
  | "FORK_TARGET_HAS_NON_TERMINAL_EXECUTIONS"
  | "SESSION_NOT_IDLE";

export class AgentMessageDomainError extends Error {
  constructor(readonly code: AgentMessageDomainErrorCode) {
    super(code);
  }
}

export class AgentMessageConflictError extends Error {
  readonly code = "SESSION_HEAD_CONFLICT" as const;

  constructor(
    readonly currentHeadMessageId: string | null,
    readonly currentRevision: number
  ) {
    super("SESSION_HEAD_CONFLICT");
  }
}

/** 已终态 Run 的重放发现持久化状态彼此矛盾时 fail closed，绝不尝试修复。 */
export class AgentRunTerminalInvariantError extends Error {
  readonly code = "AGENT_RUN_TERMINAL_INVARIANT" as const;

  constructor(reason: string) {
    super(`terminal convergence invariant violated: ${reason}`);
    this.name = "AgentRunTerminalInvariantError";
  }
}

/** An existing streaming Assistant ID was replayed with different immutable input. */
export class AgentStreamingAssistantReplayMismatchError extends Error {
  readonly code = "AGENT_STREAMING_ASSISTANT_REPLAY_MISMATCH" as const;

  constructor() {
    super("streaming assistant replay does not match existing message");
  }
}

export type AgentMessagePartInput =
  | { id: string; position: number; type: "text" | "reasoning"; text: string; providerReplay?: AgentProviderReplayEnvelope }
  | { id: string; position: number; type: "image"; attachmentId: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; filename: string }
  | { id: string; position: number; type: "tool_call"; toolName: string; input: Record<string, unknown>; providerToolCallId?: string | null; providerReplay?: AgentProviderReplayEnvelope };

export type AgentToolExecutionInput = {
  id: string;
  callPartId: string;
  originSessionId: string | null;
  originRunId: string | null;
  status: AgentToolExecutionStatus;
  resultPreview?: string | null;
  resultTruncated?: boolean;
  resultArtifactPath?: string | null;
  structuredResult?: unknown | null;
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
};

export type AgentRunRecord = {
  runId: string;
  workspaceId: string;
  sessionId: string;
  triggerMessageId: string | null;
  agentId: string;
  providerId: string;
  uiLocale: "zh-CN" | "en-US" | null;
  modelId: string;
  subtaskDepth: number | null;
  parentRunId: string | null;
  parentToolExecutionId: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  runKind: AgentRunKind;
  executionPhase: AgentRunExecutionPhase;
  intendedTerminalStatus: AgentTerminalRunStatus | null;
  intendedTerminalCode: AgentTerminalResultCode | null;
  intendedTerminalDetail: string | null;
  terminalResultCode: AgentTerminalResultCode | null;
  terminalResultDetail: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SessionAgentModelOverrideRecord = {
  sessionId: string;
  agentId: string;
  providerId: string;
  modelId: string;
  updatedAt: number;
};

type SessionRow = {
  id: string; workspaceId: string; title: string; kind: "primary" | "subtask";
  headMessageId: string | null; contextRootMessageId: string | null; revision: number;
  forkedFromSessionId: string | null; forkedFromMessageId: string | null; createdAt: number; updatedAt: number;
};
type RunStateRow = {
  workspaceId: string; sessionId: string; status: "idle" | "running"; activeRunId: string | null;
  runNoticeText: string; retryCount: number; nextRetryAt: number | null; activeAssistantMessageId: string | null;
  nonTerminalMessageIdsJson: string; nonTerminalToolExecutionIdsJson: string; updatedAt: number;
  lastResponseTotalTokens: number | null; activeRunStartedAt: number | null;
  lastRunDurationMs: number | null;
};
type MessageRow = AgentMessageRow;
type HydratedMessage = MessageRow & { inCurrentOperationRange?: boolean; parts: AgentMessagePart[] };
type PartRow = {
  id: string; messageId: string; position: number; type: AgentMessagePart["type"]; text: string | null;
  attachmentId: string | null; mediaType: "image/png" | "image/jpeg" | "image/webp" | null; filename: string | null;
  toolName: string | null; toolInputJson: string | null; providerToolCallId: string | null;
  updatedRevision: number; createdAt: number; updatedAt: number;
};
type ExecutionRow = Omit<AgentToolExecution, "resultTruncated" | "structuredResult"> & { resultTruncated: number; structuredResultJson: string | null };

function jsonArray(raw: string): string[] {
  try { const value = JSON.parse(raw); return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : []; } catch { return []; }
}
function jsonValue(raw: string | null): unknown | null {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function toSession(row: SessionRow): AgentSessionMessageState {
  return { ...row, revision: Number(row.revision), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
}
function toRunState(row: RunStateRow): AgentMessageSessionRunState {
  return {
    workspaceId: row.workspaceId, sessionId: row.sessionId, status: row.status, activeRunId: row.activeRunId,
    runNoticeText: row.runNoticeText, retryCount: Number(row.retryCount), nextRetryAt: row.nextRetryAt,
    lastResponseTotalTokens: row.lastResponseTotalTokens == null ? null : Number(row.lastResponseTotalTokens),
    activeRunStartedAt: row.activeRunStartedAt == null ? null : Number(row.activeRunStartedAt),
    lastRunDurationMs: row.lastRunDurationMs == null ? null : Number(row.lastRunDurationMs),
    activeAssistantMessageId: row.activeAssistantMessageId,
    nonTerminalMessageIds: jsonArray(row.nonTerminalMessageIdsJson),
    nonTerminalToolExecutionIds: jsonArray(row.nonTerminalToolExecutionIdsJson), updatedAt: Number(row.updatedAt)
  };
}
function toPart(row: PartRow): AgentMessagePart {
  const common = { id: row.id, messageId: row.messageId, position: Number(row.position), updatedRevision: Number(row.updatedRevision), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  if (row.type === "text" || row.type === "reasoning") return { ...common, type: row.type, text: row.text ?? "" };
  if (row.type === "image") return { ...common, type: "image", attachmentId: row.attachmentId!, mediaType: row.mediaType!, filename: row.filename! };
  return { ...common, type: "tool_call", toolName: row.toolName!, input: (jsonValue(row.toolInputJson) ?? {}) as Record<string, unknown>, providerToolCallId: row.providerToolCallId };
}
function toMessage(row: MessageRow, parts: AgentMessagePart[]): AgentMessage {
  const stored = { ...row, depth: Number(row.depth), updatedRevision: Number(row.updatedRevision), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt), parts };
  if (stored.type === "compaction") return asCompactionMessage(stored);
  return asOrdinaryMessage(stored);
}
function toExecution(row: ExecutionRow): AgentToolExecution {
  return { ...row, resultTruncated: row.resultTruncated === 1, structuredResult: jsonValue(row.structuredResultJson), updatedRevision: Number(row.updatedRevision), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt), startedAt: row.startedAt, completedAt: row.completedAt };
}

function sessionRow(db: Db, workspaceId: string, sessionId: string): SessionRow | null {
  return db.prepare(`select id, workspace_id as workspaceId, title, kind, head_message_id as headMessageId, context_root_message_id as contextRootMessageId, revision, forked_from_session_id as forkedFromSessionId, forked_from_message_id as forkedFromMessageId, created_at as createdAt, updated_at as updatedAt from agent_session where id = ? and workspace_id = ?`).get(sessionId, workspaceId) as SessionRow | undefined ?? null;
}
function messageRow(db: Db, messageId: string): MessageRow | null {
  return db.prepare(`select id, workspace_id as workspaceId, previous_message_id as previousMessageId,
    replaces_message_id as replacesMessageId, retained_from_message_id as retainedFromMessageId,
    depth, type, status, origin_session_id as originSessionId, origin_run_id as originRunId,
    updated_revision as updatedRevision, created_at as createdAt, updated_at as updatedAt
    from agent_message where id = ?`).get(messageId) as MessageRow | undefined ?? null;
}
function messageParts(db: Db, messageId: string): AgentMessagePart[] {
  const rows = db.prepare(`select id, message_id as messageId, position, type, text, attachment_id as attachmentId, media_type as mediaType, filename, tool_name as toolName, tool_input_json as toolInputJson, provider_tool_call_id as providerToolCallId, updated_revision as updatedRevision, created_at as createdAt, updated_at as updatedAt from agent_message_part where message_id = ? order by position`).all(messageId) as PartRow[];
  return rows.map(toPart);
}
function assertCurrent(db: Db, params: { workspaceId: string; sessionId: string; expectedHeadMessageId: string | null; expectedRevision: number }) {
  const current = sessionRow(db, params.workspaceId, params.sessionId);
  if (!current) throw new AgentMessageDomainError("SESSION_NOT_FOUND");
  if (current.headMessageId !== params.expectedHeadMessageId || current.revision !== params.expectedRevision) throw new AgentMessageConflictError(current.headMessageId, current.revision);
  return current;
}
function assertFence(db: Db, params: { workspaceId: string; sessionId: string; runId: string }) {
  const run = db.prepare("select workspace_id as workspaceId, session_id as sessionId, status from agent_run where run_id = ?").get(params.runId) as { workspaceId: string; sessionId: string; status: string } | undefined;
  const state = db.prepare("select status, active_run_id as activeRunId from session_run_state where workspace_id = ? and session_id = ?").get(params.workspaceId, params.sessionId) as { status: string; activeRunId: string | null } | undefined;
  return !!run && run.workspaceId === params.workspaceId && run.sessionId === params.sessionId && run.status === "running" && state?.status === "running" && state.activeRunId === params.runId;
}
function normalizedResponseTotalTokens(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}
function stableJson(value: unknown) {
  return value == null ? null : JSON.stringify(value);
}
function normalizedExecution(input: AgentToolExecutionInput) {
  return {
    id: input.id,
    callPartId: input.callPartId,
    originSessionId: input.originSessionId,
    originRunId: input.originRunId,
    status: input.status,
    resultPreview: input.resultPreview ?? null,
    resultTruncated: input.resultTruncated ? 1 : 0,
    resultArtifactPath: input.resultArtifactPath ?? null,
    structuredResultJson: stableJson(input.structuredResult),
    error: input.error ?? null,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
  };
}
function executionReplayMatches(existing: AgentToolExecution, input: AgentToolExecutionInput, updatedAt: number) {
  const expected = normalizedExecution(input);
  return existing.id === expected.id && existing.callPartId === expected.callPartId
    && existing.originSessionId === expected.originSessionId && existing.originRunId === expected.originRunId
    && existing.status === expected.status && existing.resultPreview === expected.resultPreview
    && (existing.resultTruncated ? 1 : 0) === expected.resultTruncated
    && existing.resultArtifactPath === expected.resultArtifactPath
    && stableJson(existing.structuredResult) === expected.structuredResultJson
    && existing.error === expected.error && existing.startedAt === expected.startedAt
    && existing.completedAt === expected.completedAt && existing.updatedAt === updatedAt;
}
function completeAssistantReplayMatches(db: Db, message: MessageRow, input: { workspaceId: string; sessionId: string; runId: string; messageId: string; executions: AgentToolExecutionInput[]; updatedAt: number }) {
  if (message.workspaceId !== input.workspaceId || message.originSessionId !== input.sessionId || message.originRunId !== input.runId || message.status !== "completed" || message.updatedAt !== input.updatedAt) return false;
  const existing = db.prepare(`select id,call_part_id as callPartId,origin_session_id as originSessionId,origin_run_id as originRunId,status,result_preview as resultPreview,result_truncated as resultTruncated,result_artifact_path as resultArtifactPath,structured_result_json as structuredResultJson,error,updated_revision as updatedRevision,created_at as createdAt,updated_at as updatedAt,started_at as startedAt,completed_at as completedAt from agent_tool_execution where origin_session_id=? and origin_run_id=? and call_part_id in (select id from agent_message_part where message_id=?) order by id`).all(input.sessionId, input.runId, input.messageId) as ExecutionRow[];
  if (existing.length !== input.executions.length) return false;
  const requestedById = new Map(input.executions.map((execution) => [execution.id, execution]));
  return requestedById.size === input.executions.length && existing.every((row) => {
    const request = requestedById.get(row.id);
    return request != null && executionReplayMatches(toExecution(row), request, input.updatedAt);
  });
}
function terminalExecutionReplayMatches(execution: AgentToolExecution, input: { sessionId: string; runId: string; status: AgentToolExecutionStatus; resultPreview?: string | null; resultTruncated?: boolean; resultArtifactPath?: string | null; structuredResult?: unknown | null; error?: string | null; startedAt?: number | null; completedAt?: number | null; updatedAt: number }) {
  if (execution.originSessionId !== input.sessionId || execution.originRunId !== input.runId || !executionTerminal(execution.status)) return false;
  const request: AgentToolExecutionInput = {
    id: execution.id, callPartId: execution.callPartId, originSessionId: input.sessionId, originRunId: input.runId, status: input.status,
    resultPreview: Object.hasOwn(input, "resultPreview") ? input.resultPreview : execution.resultPreview,
    resultTruncated: Object.hasOwn(input, "resultTruncated") ? input.resultTruncated : execution.resultTruncated,
    resultArtifactPath: Object.hasOwn(input, "resultArtifactPath") ? input.resultArtifactPath : execution.resultArtifactPath,
    structuredResult: Object.hasOwn(input, "structuredResult") ? input.structuredResult : execution.structuredResult,
    error: Object.hasOwn(input, "error") ? input.error : execution.error,
    startedAt: Object.hasOwn(input, "startedAt") ? input.startedAt : execution.startedAt,
    completedAt: Object.hasOwn(input, "completedAt") ? input.completedAt : execution.completedAt,
  };
  return executionReplayMatches(execution, request, input.updatedAt);
}
function replacementReplayMatches(db: Db, oldMessage: MessageRow, input: { workspaceId: string; sessionId: string; runId: string; oldMessageId: string; newMessageId: string; runNoticeText: string; retryCount: number; nextRetryAt: number | null; createdAt: number }) {
  const replacement = messageRow(db, input.newMessageId);
  const session = sessionRow(db, input.workspaceId, input.sessionId);
  const state = getMessageRunState(db, input.workspaceId, input.sessionId);
  return oldMessage.workspaceId === input.workspaceId && oldMessage.originSessionId === input.sessionId && oldMessage.originRunId === input.runId && oldMessage.status === "superseded"
    && replacement?.workspaceId === input.workspaceId && replacement.previousMessageId === oldMessage.previousMessageId
    && replacement.replacesMessageId === input.oldMessageId && replacement.originSessionId === input.sessionId && replacement.originRunId === input.runId
    && replacement.status === "streaming" && replacement.createdAt === input.createdAt && replacement.updatedAt === input.createdAt
    && session?.headMessageId === input.newMessageId && state?.activeAssistantMessageId === input.newMessageId
    && state.nonTerminalMessageIds.length === 1 && state.nonTerminalMessageIds[0] === input.newMessageId
    && state.runNoticeText === input.runNoticeText && state.retryCount === input.retryCount && state.nextRetryAt === input.nextRetryAt && state.updatedAt === input.createdAt;
}

function discardReplayMatches(db: Db, message: MessageRow, input: {
  workspaceId: string; sessionId: string; runId: string; messageId: string; updatedAt: number;
}) {
  const session = sessionRow(db, input.workspaceId, input.sessionId);
  const state = getMessageRunState(db, input.workspaceId, input.sessionId);
  return assertFence(db, input)
    && message.id === input.messageId && message.workspaceId === input.workspaceId
    && message.originSessionId === input.sessionId && message.originRunId === input.runId
    && message.status === "superseded" && message.updatedAt === input.updatedAt
    && session?.headMessageId === message.previousMessageId
    && session.revision === message.updatedRevision && session.updatedAt === input.updatedAt
    && state?.activeAssistantMessageId === null
    && !state.nonTerminalMessageIds.includes(input.messageId)
    && state.updatedAt === input.updatedAt;
}

function assertPrevious(db: Db, workspaceId: string, previousMessageId: string | null) {
  if (previousMessageId == null) return -1;
  const previous = messageRow(db, previousMessageId);
  if (!previous || previous.workspaceId !== workspaceId) throw new Error("invalid previous message");
  return previous.depth;
}

function serializePartProviderReplay(part: AgentMessagePartInput): string | null {
  if (part.type === "image" || part.providerReplay == null) return null;
  const replayType = part.providerReplay.item.type;
  const matchesPart = (part.type === "reasoning" && replayType === "reasoning")
    || (part.type === "text" && replayType === "text")
    || (part.type === "tool_call" && replayType === "function_call");
  if (!matchesPart) throw new Error("provider replay item type does not match message part type");
  return serializeAgentProviderReplay(part.providerReplay);
}

function insertParts(db: Db, messageId: string, parts: AgentMessagePartInput[], revision: number, now: number) {
  const sorted = [...parts].sort((a, b) => a.position - b.position);
  if (new Set(sorted.map((part) => part.position)).size !== sorted.length) throw new Error("duplicate message part position");
  for (const part of sorted) {
    const base = { id: part.id, messageId, position: part.position, updatedRevision: revision, now };
    if (part.type === "text" || part.type === "reasoning") {
      db.prepare(`insert into agent_message_part (id,message_id,position,type,text,provider_replay_json,updated_revision,created_at,updated_at)
        values (@id,@messageId,@position,@type,@text,@providerReplayJson,@updatedRevision,@now,@now)`)
        .run({ ...base, type: part.type, text: part.text, providerReplayJson: serializePartProviderReplay(part) });
    } else if (part.type === "image") {
      db.prepare(`insert into agent_message_part (id,message_id,position,type,attachment_id,media_type,filename,updated_revision,created_at,updated_at) values (@id,@messageId,@position,'image',@attachmentId,@mediaType,@filename,@updatedRevision,@now,@now)`).run({ ...base, ...part });
    } else if (part.type === "tool_call") {
      db.prepare(`insert into agent_message_part (id,message_id,position,type,tool_name,tool_input_json,provider_tool_call_id,provider_replay_json,updated_revision,created_at,updated_at)
        values (@id,@messageId,@position,'tool_call',@toolName,@toolInputJson,@providerToolCallId,@providerReplayJson,@updatedRevision,@now,@now)`)
        .run({ ...base, toolName: part.toolName, toolInputJson: JSON.stringify(part.input), providerToolCallId: part.providerToolCallId ?? null, providerReplayJson: serializePartProviderReplay(part) });
    }
  }
}
function writeRunState(db: Db, input: {
  workspaceId: string; sessionId: string; updatedAt: number;
  activeAssistantMessageId?: string | null; nonTerminalMessageIds?: string[];
  nonTerminalToolExecutionIds?: string[]; runNoticeText?: string;
  retryCount?: number; nextRetryAt?: number | null;
}) {
  const current = getMessageRunState(db, input.workspaceId, input.sessionId);
  if (!current) throw new Error("agent session run state not found");
  db.prepare(`update session_run_state set active_assistant_message_id=@activeAssistantMessageId, non_terminal_message_ids_json=@messages, non_terminal_tool_execution_ids_json=@executions, run_notice_text=@notice, retry_count=@retryCount, next_retry_at=@nextRetryAt, updated_at=@updatedAt where workspace_id=@workspaceId and session_id=@sessionId`).run({
    ...input,
    activeAssistantMessageId: Object.hasOwn(input, "activeAssistantMessageId") ? input.activeAssistantMessageId ?? null : current.activeAssistantMessageId,
    messages: JSON.stringify(input.nonTerminalMessageIds ?? current.nonTerminalMessageIds),
    executions: JSON.stringify(input.nonTerminalToolExecutionIds ?? current.nonTerminalToolExecutionIds),
    notice: input.runNoticeText ?? current.runNoticeText,
    retryCount: input.retryCount ?? current.retryCount,
    nextRetryAt: Object.hasOwn(input, "nextRetryAt") ? input.nextRetryAt ?? null : current.nextRetryAt
  });
}
function updateSessionPointer(db: Db, params: { workspaceId: string; sessionId: string; headMessageId: string | null; contextRootMessageId: string | null; revision: number; now: number }) {
  db.prepare(`update agent_session set head_message_id = @headMessageId, context_root_message_id = @contextRootMessageId, revision = @revision, updated_at = @now where id = @sessionId and workspace_id = @workspaceId`).run(params);
}
function messageTerminal(status: AgentMessageStatus) { return TERMINAL_MESSAGE_STATUSES.has(status); }
function executionTerminal(status: AgentToolExecutionStatus) { return TERMINAL_EXECUTION_STATUSES.has(status); }

function assertPrimaryProfileMatchesRun(run: AgentRunRecord | null, profile: PrimaryProjectionProfile) {
  if (!run
    || profile.provider.id !== run.providerId
    || profile.model.id !== run.modelId) {
    throw new Error("primary profile does not match the retained compaction run");
  }
}

export function createMessageSession(db: Db, input: { id: string; workspaceId: string; title: string; kind: "primary" | "subtask"; createdAt: number; forkedFromSessionId?: string | null; forkedFromMessageId?: string | null; headMessageId?: string | null; contextRootMessageId?: string | null }) {
  db.transaction(() => {
    if (input.forkedFromMessageId) {
      const message = messageRow(db, input.forkedFromMessageId);
      if (!message || message.workspaceId !== input.workspaceId) throw new Error("invalid fork message");
    }
    db.prepare(`insert into agent_session (id,workspace_id,title,kind,head_message_id,context_root_message_id,revision,forked_from_session_id,forked_from_message_id,created_at,updated_at) values (@id,@workspaceId,@title,@kind,@headMessageId,@contextRootMessageId,0,@forkedFromSessionId,@forkedFromMessageId,@createdAt,@createdAt)`).run({ ...input, headMessageId: input.headMessageId ?? null, contextRootMessageId: input.contextRootMessageId ?? null, forkedFromSessionId: input.forkedFromSessionId ?? null, forkedFromMessageId: input.forkedFromMessageId ?? null });
    db.prepare(`insert into session_run_state (workspace_id,session_id,status,active_run_id,run_notice_text,retry_count,next_retry_at,active_assistant_message_id,non_terminal_message_ids_json,non_terminal_tool_execution_ids_json,updated_at) values (@workspaceId,@id,'idle',null,'',0,null,null,'[]','[]',@createdAt)`).run(input);
  })();
}

export function getMessageSession(db: Db, workspaceId: string, sessionId: string): AgentSessionMessageState | null { const row = sessionRow(db, workspaceId, sessionId); return row ? toSession(row) : null; }

export function getMessageSessionById(db: Db, sessionId: string): AgentSessionMessageState | null {
  const row = db.prepare(`select id,workspace_id as workspaceId,title,kind,head_message_id as headMessageId,context_root_message_id as contextRootMessageId,revision,forked_from_session_id as forkedFromSessionId,forked_from_message_id as forkedFromMessageId,created_at as createdAt,updated_at as updatedAt from agent_session where id=?`).get(sessionId) as SessionRow | undefined;
  return row ? toSession(row) : null;
}

export function listMessageSessions(db: Db, workspaceId: string): AgentSessionMessageState[] {
  return (db.prepare(`select id,workspace_id as workspaceId,title,kind,head_message_id as headMessageId,context_root_message_id as contextRootMessageId,revision,forked_from_session_id as forkedFromSessionId,forked_from_message_id as forkedFromMessageId,created_at as createdAt,updated_at as updatedAt from agent_session where workspace_id=? order by updated_at desc`).all(workspaceId) as SessionRow[]).map(toSession);
}
export function getMessageRunState(db: Db, workspaceId: string, sessionId: string): AgentMessageSessionRunState | null {
  const row = db.prepare(`
    select state.workspace_id as workspaceId, state.session_id as sessionId,
      state.status, state.active_run_id as activeRunId,
      state.run_notice_text as runNoticeText, state.retry_count as retryCount,
      state.next_retry_at as nextRetryAt,
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
    where state.workspace_id=? and state.session_id=?
  `).get(workspaceId, sessionId) as RunStateRow | undefined;
  return row ? toRunState(row) : null;
}

/** 创建 Run 后的唯一运行态写入入口。 */
export function startMessageRun(db: Db, input: { workspaceId: string; sessionId: string; runId: string; updatedAt: number; noticeText?: string }) {
  const result = db.prepare(`
    update session_run_state
    set status='running', active_run_id=@runId, active_assistant_message_id=null,
      non_terminal_message_ids_json='[]', non_terminal_tool_execution_ids_json='[]',
      retry_count=0, next_retry_at=null, run_notice_text=@noticeText, updated_at=@updatedAt
    where workspace_id=@workspaceId and session_id=@sessionId and status='idle'
  `).run({ ...input, noticeText: input.noticeText ?? "" });
  if (result.changes !== 1) throw new Error("session is not idle");
}

/** 仅当前 active Run 可以收敛运行态，晚到写回不会覆盖新 Run。 */
export function settleMessageRunIfCurrent(db: Db, input: { workspaceId: string; sessionId: string; runId: string; updatedAt: number; noticeText?: string }) {
  return db.prepare(`
    update session_run_state
    set status='idle', active_run_id=null, active_assistant_message_id=null,
      non_terminal_message_ids_json='[]', non_terminal_tool_execution_ids_json='[]',
      retry_count=0, next_retry_at=null, run_notice_text=@noticeText, updated_at=@updatedAt
    where workspace_id=@workspaceId and session_id=@sessionId and status='running' and active_run_id=@runId
  `).run({ ...input, noticeText: input.noticeText ?? "" }).changes === 1;
}

export function appendMessage(db: Db, input: { id: string; workspaceId: string; sessionId: string; expectedHeadMessageId: string | null; expectedRevision: number; type: AgentMessageType; status: AgentMessageStatus; originRunId?: string | null; replacesMessageId?: string | null; parts: AgentMessagePartInput[]; createdAt: number; contextRootMessageId?: string | null }): AgentMessage {
  return db.transaction(() => {
    const session = assertCurrent(db, input);
    const depth = assertPrevious(db, input.workspaceId, input.expectedHeadMessageId) + 1;
    if (input.replacesMessageId) {
      const replaced = messageRow(db, input.replacesMessageId);
      if (!replaced || replaced.workspaceId !== input.workspaceId || replaced.previousMessageId !== input.expectedHeadMessageId) throw new Error("invalid replacement message");
    }
    const revision = session.revision + 1;
    db.prepare(`insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at) values (@id,@workspaceId,@previousMessageId,@replacesMessageId,@depth,@type,@status,@sessionId,@originRunId,@revision,@createdAt,@createdAt)`).run({ ...input, previousMessageId: input.expectedHeadMessageId, replacesMessageId: input.replacesMessageId ?? null, originRunId: input.originRunId ?? null, depth, revision });
    insertParts(db, input.id, input.parts, revision, input.createdAt);
    if (input.status === "completed") indexEligibleCompletedTextParts(db, input.id, input.createdAt);
    updateSessionPointer(db, { workspaceId: input.workspaceId, sessionId: input.sessionId, headMessageId: input.id, contextRootMessageId: input.contextRootMessageId ?? session.contextRootMessageId ?? input.id, revision, now: input.createdAt });
    return getMessage(db, input.id)!;
  })();
}

export function getMessage(db: Db, messageId: string): AgentMessage | null { const row = messageRow(db, messageId); return row ? toMessage(row, messageParts(db, messageId)) : null; }
export function getToolExecution(db: Db, executionId: string): AgentToolExecution | null {
  const row = db.prepare(`select id,call_part_id as callPartId,origin_session_id as originSessionId,origin_run_id as originRunId,status,result_preview as resultPreview,result_truncated as resultTruncated,result_artifact_path as resultArtifactPath,structured_result_json as structuredResultJson,error,updated_revision as updatedRevision,created_at as createdAt,updated_at as updatedAt,started_at as startedAt,completed_at as completedAt from agent_tool_execution where id=?`).get(executionId) as ExecutionRow | undefined;
  return row ? toExecution(row) : null;
}

/**
 * Confirms only a fully persisted compaction artifact owned by this Run. The
 * check intentionally does not reveal other messages or permit cross-run IDs.
 */
export function hasCommittedCompactionArtifact(db: Db, input: {
  workspaceId: string; sessionId: string; runId: string; messageId: string;
}) {
  const message = getMessage(db, input.messageId);
  if (!message || message.workspaceId !== input.workspaceId || message.type !== "compaction"
    || message.status !== "completed" || message.originSessionId !== input.sessionId
    || message.originRunId !== input.runId) return false;
  const session = getMessageSession(db, input.workspaceId, input.sessionId);
  if (!session || session.headMessageId !== input.messageId || session.contextRootMessageId !== input.messageId) return false;
  const run = getRunRecord(db, input.runId);
  if (!run || run.workspaceId !== input.workspaceId || run.sessionId !== input.sessionId) return false;
  if (run.runKind !== "manual_compaction") return true;
  const intent = getPersistedRunTerminalIntent(db, input);
  return intent?.status === "completed" && intent.code === "compaction_completed" && intent.detail === null;
}

export function getMessageSessionHead(db: Db, input: { workspaceId: string; sessionId: string }): { headMessageId: string | null; revision: number } | null {
  const session = sessionRow(db, input.workspaceId, input.sessionId);
  if (!session) return null;
  return { headMessageId: session.headMessageId, revision: session.revision };
}

/** Returns the current context-root-to-head chain in chronological order. */
export function getVisibleMessageChain(db: Db, input: { workspaceId: string; sessionId: string }): AgentMessage[] {
  const session = sessionRow(db, input.workspaceId, input.sessionId);
  if (!session || !session.headMessageId) return [];
  const messages: AgentMessage[] = [];
  let cursor: string | null = session.headMessageId;
  while (cursor) {
    const message = getMessage(db, cursor);
    if (!message || message.workspaceId !== input.workspaceId) break;
    messages.push(message);
    if (cursor === session.contextRootMessageId) break;
    cursor = message.previousMessageId;
  }
  return messages.reverse();
}

export function hasNonTerminalVisibleMessageWork(db: Db, input: { workspaceId: string; sessionId: string }): boolean {
  const messages = getVisibleMessageChain(db, input);
  if (messages.some((message) => !messageTerminal(message.status))) return true;
  if (!messages.length) return false;
  const placeholders = messages.map(() => "?").join(",");
  return Boolean(db.prepare(`select 1 from agent_tool_execution execution join agent_message_part part on part.id=execution.call_part_id where part.message_id in (${placeholders}) and execution.status in ('queued','running') limit 1`).get(...messages.map((message) => message.id)));
}

export function appendStreamingAssistant(db: Db, input: Omit<Parameters<typeof appendMessage>[1], "type" | "status" | "parts"> & { runId: string }) {
  return db.transaction(() => {
    const existing = messageRow(db, input.id);
    if (existing) {
      const session = sessionRow(db, input.workspaceId, input.sessionId);
      const state = getMessageRunState(db, input.workspaceId, input.sessionId);
      const matches = existing.workspaceId === input.workspaceId
        && existing.previousMessageId === input.expectedHeadMessageId
        && existing.replacesMessageId === (input.replacesMessageId ?? null)
        && existing.type === "assistant"
        && existing.status === "streaming"
        && existing.originSessionId === input.sessionId
        && existing.originRunId === input.runId
        && existing.createdAt === input.createdAt
        && existing.updatedAt === input.createdAt
        && messageParts(db, input.id).length === 0
        && session?.headMessageId === input.id
        && state?.activeAssistantMessageId === input.id
        && state.nonTerminalMessageIds.includes(input.id);
      if (!matches) throw new AgentStreamingAssistantReplayMismatchError();
      return asOrdinaryMessage(getMessage(db, input.id)!);
    }
    if (!assertFence(db, input)) throw new Error("run fence rejected streaming assistant creation");
    const message = appendMessage(db, { ...input, type: "assistant", status: "streaming", originRunId: input.runId, parts: [] });
    const state = getMessageRunState(db, input.workspaceId, input.sessionId)!;
    writeRunState(db, {
      workspaceId: input.workspaceId, sessionId: input.sessionId, updatedAt: input.createdAt,
      activeAssistantMessageId: message.id,
      nonTerminalMessageIds: [...new Set([...state.nonTerminalMessageIds, message.id])]
    });
    return asOrdinaryMessage(message);
  })();
}

export type FencedWriteResult = "updated" | "ignored" | "missing";
export function flushStreamingParts(db: Db, input: { workspaceId: string; sessionId: string; runId: string; messageId: string; parts: AgentMessagePartInput[]; updatedAt: number }): FencedWriteResult {
  return db.transaction(() => {
    const message = messageRow(db, input.messageId);
    if (!message) return "missing";
    if (!assertFence(db, input)) return "ignored";
    if (message.workspaceId !== input.workspaceId || message.originSessionId !== input.sessionId || message.originRunId !== input.runId || message.status !== "streaming") return "ignored";
    const session = sessionRow(db, input.workspaceId, input.sessionId)!;
    const revision = session.revision + 1;
    let changed = false;
    for (const part of input.parts) {
      const incomingProviderReplayJson = serializePartProviderReplay(part);
      const existing = db.prepare(`select id,position,type,text,tool_name as toolName,tool_input_json as toolInputJson,
        provider_tool_call_id as providerToolCallId,provider_replay_json as providerReplayJson
        from agent_message_part where id = ? and message_id = ?`).get(part.id, input.messageId) as {
          id: string; position: number; type: string; text: string | null; toolName: string | null;
          toolInputJson: string | null; providerToolCallId: string | null; providerReplayJson: string | null;
        } | undefined;
      if (!existing) {
        insertParts(db, input.messageId, [part], revision, input.updatedAt);
        changed = true;
        continue;
      }
      let providerReplayChanged = false;
      if (incomingProviderReplayJson != null && incomingProviderReplayJson !== existing.providerReplayJson) {
        const incomingReplay = parseAgentProviderReplay(incomingProviderReplayJson)!;
        const existingReplay = parseAgentProviderReplay(existing.providerReplayJson);
        if (existing.providerReplayJson != null && !existingReplay) {
          throw new Error("stored streaming part provider replay is invalid");
        }
        if (existingReplay) assertAgentProviderReplayUpdateCompatible(existingReplay, incomingReplay);
        providerReplayChanged = true;
      }
      if (existing.type === "tool_call" && part.type === "tool_call") {
        const sameCall = existing.position === part.position
          && existing.toolName === part.toolName
          && existing.toolInputJson === JSON.stringify(part.input)
          && existing.providerToolCallId === (part.providerToolCallId ?? null);
        if (!sameCall) throw new Error("streaming ToolCall part replay does not match existing part");
        if (providerReplayChanged) {
          db.prepare("update agent_message_part set provider_replay_json=?,updated_revision=?,updated_at=? where id=? and message_id=?")
            .run(incomingProviderReplayJson, revision, input.updatedAt, part.id, input.messageId);
          changed = true;
        }
        continue;
      }
      if (existing.type !== part.type || (part.type !== "text" && part.type !== "reasoning")) {
        throw new Error("streaming part type is immutable");
      }
      if (existing.position !== part.position) {
        throw new Error("streaming text part replay position does not match existing part");
      }
      if (existing.text === part.text && !providerReplayChanged) continue;
      if (!part.text.startsWith(existing.text ?? "")) {
        throw new Error("streaming text part must extend the existing cumulative text");
      }
      db.prepare("update agent_message_part set text=?,provider_replay_json=coalesce(?,provider_replay_json),updated_revision=?,updated_at=? where id=? and message_id=?")
        .run(part.text, incomingProviderReplayJson, revision, input.updatedAt, part.id, input.messageId);
      changed = true;
    }
    if (!changed) return "updated";
    db.prepare("update agent_message set updated_revision=?,updated_at=? where id=?").run(revision, input.updatedAt, input.messageId);
    db.prepare("update agent_session set revision=?,updated_at=? where id=? and workspace_id=?").run(revision, input.updatedAt, input.sessionId, input.workspaceId);
    return "updated";
  })();
}

/** 仅当前 fenced Run 可认领恢复事务准备的 active streaming Assistant。 */
export function resumeStreamingAssistant(db: Db, input: {
  workspaceId: string; sessionId: string; runId: string; messageId: string;
}): FencedWriteResult {
  return db.transaction(() => {
    const message = messageRow(db, input.messageId);
    if (!message) return "missing";
    if (!assertFence(db, input)) return "ignored";
    const state = getMessageRunState(db, input.workspaceId, input.sessionId);
    if (message.workspaceId !== input.workspaceId || message.originSessionId !== input.sessionId || message.originRunId !== input.runId || message.status !== "streaming" || state?.activeAssistantMessageId !== input.messageId) return "ignored";
    return "updated";
  })();
}

export function completeAssistantWithExecutions(db: Db, input: { workspaceId: string; sessionId: string; runId: string; messageId: string; executions: AgentToolExecutionInput[]; responseTotalTokens?: number | null; updatedAt: number }): FencedWriteResult {
  return db.transaction(() => {
    const message = messageRow(db, input.messageId);
    if (!message) return "missing";
    if (message.status === "completed") return completeAssistantReplayMatches(db, message, input) ? "updated" : "ignored";
    if (!assertFence(db, input)) return "ignored";
    if (message.workspaceId !== input.workspaceId || message.originSessionId !== input.sessionId || message.originRunId !== input.runId || message.status !== "streaming") return "ignored";
    const session = sessionRow(db, input.workspaceId, input.sessionId)!;
    const revision = session.revision + 1;
    const callParts = db.prepare("select id from agent_message_part where message_id = ? and type = 'tool_call' order by position").all(input.messageId) as Array<{ id: string }>;
    const callPartIds = new Set(callParts.map((part) => part.id));
    if (input.executions.length !== callParts.length || new Set(input.executions.map((execution) => execution.callPartId)).size !== input.executions.length || input.executions.some((execution) => !callPartIds.has(execution.callPartId))) {
      throw new Error("tool executions must exactly match assistant ToolCallParts");
    }
    for (const execution of input.executions) {
      if (execution.originSessionId !== input.sessionId || execution.originRunId !== input.runId) {
        throw new Error("tool execution origin must match completed assistant run");
      }
      if (execution.status !== "queued") throw new Error("completed assistant can only create queued tool executions");
      db.prepare(`insert into agent_tool_execution (id,call_part_id,origin_session_id,origin_run_id,status,result_preview,result_truncated,result_artifact_path,structured_result_json,error,updated_revision,created_at,updated_at,started_at,completed_at) values (@id,@callPartId,@originSessionId,@originRunId,'queued',@resultPreview,@resultTruncated,@resultArtifactPath,@structuredResultJson,@error,@revision,@updatedAt,@updatedAt,@startedAt,@completedAt)`).run({ ...execution, resultPreview: execution.resultPreview ?? null, resultTruncated: execution.resultTruncated ? 1 : 0, resultArtifactPath: execution.resultArtifactPath ?? null, structuredResultJson: execution.structuredResult == null ? null : JSON.stringify(execution.structuredResult), error: execution.error ?? null, startedAt: execution.startedAt ?? null, completedAt: execution.completedAt ?? null, revision, updatedAt: input.updatedAt });
    }
    db.prepare("update agent_message set status='completed',updated_revision=?,updated_at=? where id=?").run(revision, input.updatedAt, input.messageId);
    indexEligibleCompletedTextParts(db, input.messageId, input.updatedAt);
    db.prepare("update agent_session set revision=?,updated_at=? where id=? and workspace_id=?").run(revision, input.updatedAt, input.sessionId, input.workspaceId);
    const state = getMessageRunState(db, input.workspaceId, input.sessionId)!;
    writeRunState(db, {
      workspaceId: input.workspaceId, sessionId: input.sessionId, updatedAt: input.updatedAt,
      activeAssistantMessageId: state.activeAssistantMessageId === input.messageId ? null : state.activeAssistantMessageId,
      nonTerminalMessageIds: state.nonTerminalMessageIds.filter((id) => id !== input.messageId),
      nonTerminalToolExecutionIds: [...new Set([...state.nonTerminalToolExecutionIds, ...input.executions.map((execution) => execution.id)])]
    });
    db.prepare("update session_run_state set last_response_total_tokens=? where workspace_id=? and session_id=?")
      .run(normalizedResponseTotalTokens(input.responseTotalTokens), input.workspaceId, input.sessionId);
    return "updated";
  })();
}

export function updateToolExecution(db: Db, input: { workspaceId: string; sessionId: string; runId: string; executionId: string; status: AgentToolExecutionStatus; resultPreview?: string | null; resultTruncated?: boolean; resultArtifactPath?: string | null; structuredResult?: unknown | null; error?: string | null; startedAt?: number | null; completedAt?: number | null; updatedAt: number }): FencedWriteResult {
  return db.transaction(() => {
    const execution = getToolExecution(db, input.executionId);
    if (!execution) return "missing";
    if (executionTerminal(execution.status)) return terminalExecutionReplayMatches(execution, input) ? "updated" : "ignored";
    if (!assertFence(db, input)) return "ignored";
    if (execution.originSessionId !== input.sessionId || execution.originRunId !== input.runId) return "ignored";
    if (execution.status === "queued" && !["queued", "running", "failed", "cancelled"].includes(input.status)) throw new Error("invalid tool execution transition");
    if (execution.status === "running" && !["running", "completed", "failed", "cancelled", "unknown"].includes(input.status)) {
      throw new Error("invalid tool execution transition");
    }
    const session = sessionRow(db, input.workspaceId, input.sessionId)!;
    const revision = session.revision + 1;
    db.prepare(`update agent_tool_execution set status=@status,result_preview=@resultPreview,result_truncated=@resultTruncated,result_artifact_path=@resultArtifactPath,structured_result_json=@structuredResultJson,error=@error,started_at=@startedAt,completed_at=@completedAt,updated_revision=@revision,updated_at=@updatedAt where id=@executionId`).run({ ...input, resultPreview: Object.hasOwn(input, "resultPreview") ? input.resultPreview ?? null : execution.resultPreview, resultTruncated: Object.hasOwn(input, "resultTruncated") ? (input.resultTruncated ? 1 : 0) : (execution.resultTruncated ? 1 : 0), resultArtifactPath: Object.hasOwn(input, "resultArtifactPath") ? input.resultArtifactPath ?? null : execution.resultArtifactPath, structuredResultJson: Object.hasOwn(input, "structuredResult") ? (input.structuredResult == null ? null : JSON.stringify(input.structuredResult)) : (execution.structuredResult == null ? null : JSON.stringify(execution.structuredResult)), error: Object.hasOwn(input, "error") ? input.error ?? null : execution.error, startedAt: Object.hasOwn(input, "startedAt") ? input.startedAt ?? null : execution.startedAt, completedAt: Object.hasOwn(input, "completedAt") ? input.completedAt ?? null : execution.completedAt, revision });
    db.prepare("update agent_session set revision=?,updated_at=? where id=? and workspace_id=?").run(revision, input.updatedAt, input.sessionId, input.workspaceId);
    if (executionTerminal(input.status)) {
      const state = getMessageRunState(db, input.workspaceId, input.sessionId)!;
      writeRunState(db, { workspaceId: input.workspaceId, sessionId: input.sessionId, updatedAt: input.updatedAt, nonTerminalToolExecutionIds: state.nonTerminalToolExecutionIds.filter((id) => id !== input.executionId) });
    }
    return "updated";
  })();
}

export function updateMessageRunNotice(db: Db, input: { workspaceId: string; sessionId: string; runId: string; runNoticeText: string; retryCount?: number; nextRetryAt?: number | null; updatedAt: number }): FencedWriteResult {
  return db.transaction(() => {
    if (!assertFence(db, input)) return "ignored";
    const notice = input.runNoticeText
      .replace(/\r\n/g, "\n")
      .replace(/\0/g, "")
      .trim()
      .slice(0, 1000);
    const current = getMessageRunState(db, input.workspaceId, input.sessionId);
    if (!current) return "missing";
    db.prepare(`update session_run_state set run_notice_text=?, retry_count=?, next_retry_at=?, updated_at=? where workspace_id=? and session_id=? and active_run_id=? and status='running'`).run(
      notice,
      input.retryCount ?? current.retryCount,
      Object.prototype.hasOwnProperty.call(input, "nextRetryAt") ? input.nextRetryAt ?? null : current.nextRetryAt,
      input.updatedAt,
      input.workspaceId,
      input.sessionId,
      input.runId
    );
    return "updated";
  })();
}

export function replaceStreamingAssistant(db: Db, input: { workspaceId: string; sessionId: string; runId: string; oldMessageId: string; newMessageId: string; expectedHeadMessageId: string | null; expectedRevision: number; runNoticeText: string; retryCount: number; nextRetryAt: number | null; createdAt: number }): { result: FencedWriteResult; message: AgentOrdinaryMessage | null } {
  return db.transaction((): { result: FencedWriteResult; message: AgentOrdinaryMessage | null } => {
    const old = messageRow(db, input.oldMessageId);
    if (!old) return { result: "missing", message: null };
    if (old.status === "superseded") {
      const replayed = replacementReplayMatches(db, old, input);
      return { result: replayed ? "updated" : "ignored", message: replayed ? asOrdinaryMessage(getMessage(db, input.newMessageId)!) : null };
    }
    if (!assertFence(db, input)) return { result: "ignored", message: null };
    const session = assertCurrent(db, input);
    if (input.expectedHeadMessageId !== input.oldMessageId || old.workspaceId !== input.workspaceId || old.status !== "streaming" || old.originSessionId !== input.sessionId || old.originRunId !== input.runId) {
      return { result: "ignored", message: null };
    }
    const revision = session.revision + 1;
    db.prepare("update agent_message set status='superseded',updated_revision=?,updated_at=? where id=?").run(revision, input.createdAt, input.oldMessageId);
    db.prepare(`insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at) values (?,?,?,?,?,'assistant','streaming',?,?,?, ?,?)`).run(input.newMessageId, input.workspaceId, old.previousMessageId, input.oldMessageId, old.depth, input.sessionId, input.runId, revision, input.createdAt, input.createdAt);
    const state = getMessageRunState(db, input.workspaceId, input.sessionId)!;
    writeRunState(db, {
      workspaceId: input.workspaceId, sessionId: input.sessionId, updatedAt: input.createdAt,
      activeAssistantMessageId: input.newMessageId,
      nonTerminalMessageIds: [...new Set([...state.nonTerminalMessageIds.filter((id) => id !== input.oldMessageId), input.newMessageId])],
      runNoticeText: input.runNoticeText,
      retryCount: input.retryCount,
      nextRetryAt: input.nextRetryAt
    });
    updateSessionPointer(db, { workspaceId: input.workspaceId, sessionId: input.sessionId, headMessageId: input.newMessageId, contextRootMessageId: session.contextRootMessageId, revision, now: input.createdAt });
    return { result: "updated", message: asOrdinaryMessage(getMessage(db, input.newMessageId)!) };
  })();
}

/** 作废当前模型尝试，并回退到尝试前的有效 head。私有 replay 留在 superseded 消息中但不会进入有效链。 */
export function discardStreamingAssistant(db: Db, input: {
  workspaceId: string; sessionId: string; runId: string; messageId: string; updatedAt: number;
}): FencedWriteResult {
  return db.transaction(() => {
    const message = messageRow(db, input.messageId);
    if (!message) return "missing";
    if (message.status === "superseded") {
      return discardReplayMatches(db, message, input) ? "updated" : "ignored";
    }
    if (!assertFence(db, input)) return "ignored";
    const session = sessionRow(db, input.workspaceId, input.sessionId)!;
    const state = getMessageRunState(db, input.workspaceId, input.sessionId)!;
    if (message.workspaceId !== input.workspaceId
      || message.originSessionId !== input.sessionId
      || message.originRunId !== input.runId
      || message.status !== "streaming"
      || session.headMessageId !== input.messageId
      || state.activeAssistantMessageId !== input.messageId) return "ignored";
    const revision = session.revision + 1;
    db.prepare("update agent_message set status='superseded',updated_revision=?,updated_at=? where id=?")
      .run(revision, input.updatedAt, input.messageId);
    writeRunState(db, {
      workspaceId: input.workspaceId, sessionId: input.sessionId, updatedAt: input.updatedAt,
      activeAssistantMessageId: null,
      nonTerminalMessageIds: state.nonTerminalMessageIds.filter((id) => id !== input.messageId),
    });
    updateSessionPointer(db, { workspaceId: input.workspaceId, sessionId: input.sessionId, headMessageId: message.previousMessageId, contextRootMessageId: session.contextRootMessageId, revision, now: input.updatedAt });
    return "updated";
  })();
}

export function moveMessageHead(db: Db, input: { workspaceId: string; sessionId: string; expectedHeadMessageId: string | null; expectedRevision: number; nextHeadMessageId: string; updatedAt: number }) {
  db.transaction(() => {
    const session = assertCurrent(db, input);
    if (!isAncestor(db, input.workspaceId, input.expectedHeadMessageId, input.nextHeadMessageId)) throw new AgentMessageDomainError("MESSAGE_TARGET_INVALID");
    if (session.contextRootMessageId && !isAncestor(db, input.workspaceId, input.nextHeadMessageId, session.contextRootMessageId)) throw new AgentMessageDomainError("MESSAGE_TARGET_BEFORE_CONTEXT_ROOT");
    const target = messageRow(db, input.nextHeadMessageId);
    if (!target || !messageTerminal(target.status) || (target.type !== "user" && target.type !== "assistant")) throw new AgentMessageDomainError("MESSAGE_TARGET_INVALID");
    if (target.type === "assistant") {
      const pending = db.prepare(`select 1 from agent_tool_execution execution join agent_message_part part on part.id = execution.call_part_id where part.message_id = ? and execution.status in ('queued','running') limit 1`).get(target.id);
      if (pending) throw new AgentMessageDomainError("MESSAGE_TARGET_HAS_NON_TERMINAL_EXECUTIONS");
    }
    updateSessionPointer(db, { workspaceId: input.workspaceId, sessionId: input.sessionId, headMessageId: target.id, contextRootMessageId: session.contextRootMessageId, revision: session.revision + 1, now: input.updatedAt });
  })();
}

export function revertBeforeUserMessage(db: Db, input: { workspaceId: string; sessionId: string; expectedHeadMessageId: string | null; expectedRevision: number; targetMessageId: string; updatedAt: number }) {
  db.transaction(() => {
    const session = assertCurrent(db, input);
    if (!isAncestor(db, input.workspaceId, input.expectedHeadMessageId, input.targetMessageId)) throw new AgentMessageDomainError("MESSAGE_TARGET_INVALID");
    if (session.contextRootMessageId && !isAncestor(db, input.workspaceId, input.targetMessageId, session.contextRootMessageId)) throw new AgentMessageDomainError("MESSAGE_TARGET_BEFORE_CONTEXT_ROOT");
    const target = messageRow(db, input.targetMessageId);
    if (!target || !messageTerminal(target.status) || target.type !== "user") throw new AgentMessageDomainError("MESSAGE_TARGET_INVALID");
    const removesContextRoot = target.id === session.contextRootMessageId;
    updateSessionPointer(db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      headMessageId: target.previousMessageId,
      contextRootMessageId: removesContextRoot ? null : session.contextRootMessageId,
      revision: session.revision + 1,
      now: input.updatedAt
    });
  })();
}

function asCompactionMessage(message: AgentMessage | HydratedMessage): AgentCompactionMessage {
  if (!Value.Check(AgentCompactionMessageSchema, message)) {
    throw new Error("stored compaction message violates the strict shared contract");
  }
  return message;
}

function asOrdinaryMessage(message: AgentMessage | HydratedMessage): AgentOrdinaryMessage {
  const ordinaryMessage = "retainedFromMessageId" in message
    ? (() => { const { retainedFromMessageId: _retainedFromMessageId, ...normalized } = message; return normalized; })()
    : message;
  if (!Value.Check(AgentOrdinaryMessageSchema, ordinaryMessage)) {
    throw new Error("stored ordinary message violates the strict shared contract");
  }
  return ordinaryMessage;
}

/**
 * Internal compaction write primitive. Production callers must use a Run-fenced
 * artifact-only entrypoint or the manual artifact-plus-intent atomic entrypoint.
 */
function commitCompactionMessageCurrent(db: Db, input: { id: string; workspaceId: string; sessionId: string; runId?: string | null; expectedHeadMessageId: string | null; expectedRevision: number; textPartId: string; text: string; retainedFromMessageId?: string | null; createdAt: number; effectiveRetainedAnchorAlreadyValidated?: boolean }): AgentCompactionMessage {
  const session = assertCurrent(db, input);
  if (!input.expectedHeadMessageId) throw new Error("cannot compact an empty session");
  if (!input.text.trim()) throw new Error("compaction summary must not be blank");
  if (!input.effectiveRetainedAnchorAlreadyValidated) {
    assertRetainedAnchorOnPreviousChain(db, {
      workspaceId: input.workspaceId,
      previousMessageId: input.expectedHeadMessageId,
      retainedFromMessageId: input.retainedFromMessageId ?? null,
    });
  }
  const depth = assertPrevious(db, input.workspaceId, input.expectedHeadMessageId) + 1;
  const revision = session.revision + 1;
  db.prepare(`insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,retained_from_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at) values (?,?,?,?,?,?,'compaction','completed',?,?,?,?,?)`).run(input.id, input.workspaceId, input.expectedHeadMessageId, null, input.retainedFromMessageId ?? null, depth, input.sessionId, input.runId ?? null, revision, input.createdAt, input.createdAt);
  insertParts(db, input.id, [{ id: input.textPartId, position: 0, type: "text", text: input.text }], revision, input.createdAt);
  indexEligibleCompletedTextParts(db, input.id, input.createdAt);
  updateSessionPointer(db, { workspaceId: input.workspaceId, sessionId: input.sessionId, headMessageId: input.id, contextRootMessageId: input.id, revision, now: input.createdAt });
  db.prepare("update session_run_state set last_response_total_tokens=null where workspace_id=? and session_id=?")
    .run(input.workspaceId, input.sessionId);
  return asCompactionMessage(getMessage(db, input.id)!);
}

/**
 * Test fixture helper for constructing historical compaction chains without a Run.
 * Production code must not use this unfenced write path.
 */
export function commitCompactionMessageForTest(db: Db, input: { id: string; workspaceId: string; sessionId: string; expectedHeadMessageId: string | null; expectedRevision: number; textPartId: string; text: string; retainedFromMessageId?: string | null; createdAt: number }): AgentCompactionMessage {
  return db.transaction(() => {
    return commitCompactionMessageCurrent(db, input);
  })();
}

/** Commits compaction only while this Run still owns the Session fence. */
export function commitCompactionMessageWithRunFence(db: Db, input: {
  id: string; workspaceId: string; sessionId: string; runId: string;
  expectedHeadMessageId: string | null; expectedRevision: number;
  textPartId: string; text: string; retainedFromMessageId?: string | null; createdAt: number; primaryProfile?: PrimaryProjectionProfile;
}): AgentCompactionMessage | null {
  return db.transaction(() => {
    const run = getRunRecord(db, input.runId);
    if (run?.workspaceId === input.workspaceId && run.sessionId === input.sessionId
      && run.runKind === "manual_compaction") {
      throw new Error("manual compaction requires an atomic terminal intent");
    }
    const existing = messageRow(db, input.id);
    if (existing) {
      const part = db.prepare(`select id, position, type, text, created_at as createdAt, updated_at as updatedAt from agent_message_part where id = ? and message_id = ?`).get(input.textPartId, input.id) as {
        id: string; position: number; type: string; text: string | null; createdAt: number; updatedAt: number;
      } | undefined;
      const partCount = (db.prepare(`select count(*) as count from agent_message_part where message_id = ?`).get(input.id) as {
        count: number;
      }).count;
      const session = sessionRow(db, input.workspaceId, input.sessionId);
      const exactReplay = existing.workspaceId === input.workspaceId
        && existing.type === "compaction"
        && existing.status === "completed"
        && existing.previousMessageId === input.expectedHeadMessageId
        && existing.replacesMessageId === null
        && (existing.retainedFromMessageId ?? null) === (input.retainedFromMessageId ?? null)
        && existing.originSessionId === input.sessionId
        && existing.originRunId === input.runId
        && existing.createdAt === input.createdAt
        && existing.updatedAt === input.createdAt
        && partCount === 1
        && part?.position === 0
        && part.type === "text"
        && part.text === input.text
        && part.createdAt === input.createdAt
        && part.updatedAt === input.createdAt
        && session?.headMessageId === input.id
        && session.contextRootMessageId === input.id
        && session.revision === input.expectedRevision + 1;
      return exactReplay ? asCompactionMessage(getMessage(db, input.id)!) : null;
    }
    if (!assertFence(db, input)) return null;
    if (input.retainedFromMessageId != null) {
      if (!input.primaryProfile) throw new Error("primary profile is required for a retained compaction anchor");
      assertPrimaryProfileMatchesRun(getRunRecord(db, input.runId), input.primaryProfile);
      new ModelContextResolver(db).assertRetainedAnchorInEffectiveOriginalBlocks({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        expectedHeadMessageId: input.expectedHeadMessageId,
        expectedRevision: input.expectedRevision,
        retainedFromMessageId: input.retainedFromMessageId,
        primaryProfile: input.primaryProfile,
      });
    }
    return commitCompactionMessageCurrent(db, input);
  })();
}

export function forkMessageSession(db: Db, input: {
  id: string; workspaceId: string; sourceSessionId: string; expectedHeadMessageId: string | null;
  expectedRevision: number; targetMessageId: string; title: string; kind: "primary" | "subtask"; createdAt: number;
  allowSourceWithActiveRun?: boolean;
}) {
  return db.transaction(() => {
    const source = assertCurrent(db, { workspaceId: input.workspaceId, sessionId: input.sourceSessionId, expectedHeadMessageId: input.expectedHeadMessageId, expectedRevision: input.expectedRevision });
    const state = getMessageRunState(db, input.workspaceId, input.sourceSessionId);
    const sourceHasActiveRun = state?.status === "running" && state.activeRunId != null;
    if (!state
      || (!input.allowSourceWithActiveRun && state.status !== "idle")
      || (input.allowSourceWithActiveRun && !sourceHasActiveRun)
      || state.nonTerminalMessageIds.length
      || (!input.allowSourceWithActiveRun && state.nonTerminalToolExecutionIds.length)
    ) {
      throw new AgentMessageDomainError("SESSION_NOT_IDLE");
    }
    if (!isAncestor(db, input.workspaceId, source.headMessageId, input.targetMessageId)) throw new AgentMessageDomainError("FORK_TARGET_INVALID");
    if (source.contextRootMessageId && !isAncestor(db, input.workspaceId, input.targetMessageId, source.contextRootMessageId)) throw new AgentMessageDomainError("FORK_TARGET_BEFORE_CONTEXT_ROOT");
    const target = messageRow(db, input.targetMessageId);
    if (!target || !messageTerminal(target.status) || (target.type !== "user" && target.type !== "assistant")) throw new AgentMessageDomainError("FORK_TARGET_INVALID");
    if (target.type === "assistant") {
      const pending = db.prepare(`select 1 from agent_tool_execution execution join agent_message_part part on part.id = execution.call_part_id where part.message_id = ? and execution.status in ('queued','running') limit 1`).get(target.id);
      if (pending) throw new AgentMessageDomainError("FORK_TARGET_HAS_NON_TERMINAL_EXECUTIONS");
    }
    db.prepare(`insert into agent_session (id,workspace_id,title,kind,head_message_id,context_root_message_id,revision,forked_from_session_id,forked_from_message_id,created_at,updated_at) values (@id,@workspaceId,@title,@kind,@targetMessageId,@contextRootMessageId,0,@sourceSessionId,@targetMessageId,@createdAt,@createdAt)`).run({ ...input, contextRootMessageId: source.contextRootMessageId ?? input.targetMessageId });
    db.prepare(`insert into session_run_state (workspace_id,session_id,status,active_run_id,run_notice_text,retry_count,next_retry_at,active_assistant_message_id,non_terminal_message_ids_json,non_terminal_tool_execution_ids_json,updated_at) values (@workspaceId,@id,'idle',null,'',0,null,null,'[]','[]',@createdAt)`).run(input);
    return getMessageSession(db, input.workspaceId, input.id)!;
  })();
}

export function isAncestor(db: Db, workspaceId: string, headMessageId: string | null, targetMessageId: string): boolean {
  let current = headMessageId;
  const seen = new Set<string>();
  while (current) {
    if (current === targetMessageId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const message = messageRow(db, current);
    if (!message || message.workspaceId !== workspaceId) return false;
    current = message.previousMessageId;
  }
  return false;
}

function toRunRecord(row: Record<string, unknown>): AgentRunRecord {
  const status = row.status;
  return {
    runId: String(row.runId ?? ""),
    workspaceId: String(row.workspaceId ?? ""),
    sessionId: String(row.sessionId ?? ""),
    triggerMessageId: typeof row.triggerMessageId === "string" ? row.triggerMessageId : null,
    agentId: String(row.agentId ?? ""),
    providerId: String(row.providerId ?? ""),
    uiLocale: row.uiLocale === "zh-CN" || row.uiLocale === "en-US" ? row.uiLocale : null,
    modelId: String(row.modelId ?? ""),
    subtaskDepth: typeof row.subtaskDepth === "number" ? row.subtaskDepth : null,
    parentRunId: typeof row.parentRunId === "string" ? row.parentRunId : null,
    parentToolExecutionId: typeof row.parentToolExecutionId === "string" ? row.parentToolExecutionId : null,
    status: status === "completed" || status === "failed" || status === "cancelled" ? status : "running",
    runKind: row.runKind === "manual_compaction" || row.runKind === "subtask" ? row.runKind : "user",
    executionPhase: row.executionPhase === "work_in_progress" || row.executionPhase === "terminal_intent_persisted" || row.executionPhase === "terminal"
      ? row.executionPhase : "work_pending",
    intendedTerminalStatus: row.intendedTerminalStatus === "completed" || row.intendedTerminalStatus === "failed" || row.intendedTerminalStatus === "cancelled"
      ? row.intendedTerminalStatus : null,
    intendedTerminalCode: typeof row.intendedTerminalCode === "string" ? row.intendedTerminalCode as AgentTerminalResultCode : null,
    intendedTerminalDetail: typeof row.intendedTerminalDetail === "string" ? row.intendedTerminalDetail : null,
    terminalResultCode: typeof row.terminalResultCode === "string" ? row.terminalResultCode as AgentTerminalResultCode : null,
    terminalResultDetail: typeof row.terminalResultDetail === "string" ? row.terminalResultDetail : null,
    createdAt: Number(row.createdAt ?? 0),
    updatedAt: Number(row.updatedAt ?? 0),
  };
}

function terminalResultCodeFor(runKind: AgentRunKind, status: AgentTerminalRunStatus): AgentTerminalResultCode {
  if (status === "cancelled") return "run_cancelled";
  if (status === "completed") {
    return runKind === "subtask" ? "subtask_completed" : runKind === "manual_compaction" ? "compaction_completed" : "run_completed";
  }
  return runKind === "subtask" ? "subtask_failed" : runKind === "manual_compaction" ? "compaction_failed" : "run_failed";
}

export type CreateMessageRunRecordInput = {
  runId: string; workspaceId: string; sessionId: string; triggerMessageId: string | null;
  agentId: string; providerId: string; modelId: string;
  uiLocale?: "zh-CN" | "en-US" | null;
  runKind?: AgentRunKind; subtaskDepth?: number | null;
  parentRunId?: string | null; parentToolExecutionId?: string | null;
  status: AgentRunRecord["status"]; createdAt: number;
};

export function createMessageRunRecord(db: Db, params: CreateMessageRunRecordInput) {
  db.prepare(`
    insert into agent_run (
      run_id, workspace_id, session_id, trigger_message_id, agent_id, provider_id,
      ui_locale, model_id, subtask_depth, parent_run_id, parent_tool_execution_id, status,
      created_at, updated_at, run_kind, execution_phase, terminal_result_code
    ) values (
      @runId, @workspaceId, @sessionId, @triggerMessageId, @agentId, @providerId,
      @uiLocale, @modelId, @subtaskDepth, @parentRunId, @parentToolExecutionId, @status,
      @createdAt, @createdAt, @runKind, @executionPhase, @terminalResultCode
    )
  `).run({
    ...params,
    uiLocale: params.uiLocale ?? null,
    subtaskDepth: params.subtaskDepth ?? null,
    parentRunId: params.parentRunId ?? null,
    parentToolExecutionId: params.parentToolExecutionId ?? null,
    runKind: params.runKind ?? "user",
    executionPhase: params.status === "running" ? "work_pending" : "terminal",
    terminalResultCode: params.status === "running"
      ? null
      : terminalResultCodeFor(params.runKind ?? "user", params.status),
  });
}

export function getRunRecord(db: Db, runId: string): AgentRunRecord | null {
  const row = db.prepare(`
    select run_id as runId, workspace_id as workspaceId, session_id as sessionId,
      trigger_message_id as triggerMessageId, agent_id as agentId, provider_id as providerId,
      ui_locale as uiLocale, model_id as modelId, subtask_depth as subtaskDepth, parent_run_id as parentRunId,
      parent_tool_execution_id as parentToolExecutionId, status, run_kind as runKind,
      execution_phase as executionPhase, intended_terminal_status as intendedTerminalStatus,
      intended_terminal_code as intendedTerminalCode, intended_terminal_detail as intendedTerminalDetail,
      terminal_result_code as terminalResultCode, terminal_result_detail as terminalResultDetail,
      created_at as createdAt, updated_at as updatedAt
    from agent_run where run_id = ?
  `).get(runId) as Record<string, unknown> | undefined;
  return row ? toRunRecord(row) : null;
}

export function getLatestMessageRunRecordBySession(db: Db, params: { workspaceId: string; sessionId: string }): AgentRunRecord | null {
  const row = db.prepare(`
    select run_id as runId, workspace_id as workspaceId, session_id as sessionId,
      trigger_message_id as triggerMessageId, agent_id as agentId, provider_id as providerId,
      ui_locale as uiLocale, model_id as modelId, subtask_depth as subtaskDepth, parent_run_id as parentRunId,
      parent_tool_execution_id as parentToolExecutionId, status, run_kind as runKind,
      execution_phase as executionPhase, intended_terminal_status as intendedTerminalStatus,
      intended_terminal_code as intendedTerminalCode, intended_terminal_detail as intendedTerminalDetail,
      terminal_result_code as terminalResultCode, terminal_result_detail as terminalResultDetail,
      created_at as createdAt, updated_at as updatedAt
    from agent_run where workspace_id = @workspaceId and session_id = @sessionId
    order by created_at desc, run_id desc limit 1
  `).get(params) as Record<string, unknown> | undefined;
  return row ? toRunRecord(row) : null;
}

export function getLatestTerminalMessageRunRecord(db: Db, params: { workspaceId: string; sessionId: string }): AgentRunRecord | null {
  const row = db.prepare(`
    select run_id as runId, workspace_id as workspaceId, session_id as sessionId,
      trigger_message_id as triggerMessageId, agent_id as agentId, provider_id as providerId,
      ui_locale as uiLocale, model_id as modelId, subtask_depth as subtaskDepth, parent_run_id as parentRunId,
      parent_tool_execution_id as parentToolExecutionId, status, run_kind as runKind,
      execution_phase as executionPhase, intended_terminal_status as intendedTerminalStatus,
      intended_terminal_code as intendedTerminalCode, intended_terminal_detail as intendedTerminalDetail,
      terminal_result_code as terminalResultCode, terminal_result_detail as terminalResultDetail,
      created_at as createdAt, updated_at as updatedAt
    from agent_run where workspace_id = @workspaceId and session_id = @sessionId
      and status in ('completed', 'failed', 'cancelled')
    order by updated_at desc, run_id desc limit 1
  `).get(params) as Record<string, unknown> | undefined;
  return row ? toRunRecord(row) : null;
}

export function findMessageSubtaskRunByParentToolExecution(db: Db, params: { workspaceId: string; parentRunId: string; parentToolExecutionId: string }): AgentRunRecord | null {
  const row = db.prepare(`
    select run_id as runId, workspace_id as workspaceId, session_id as sessionId,
      trigger_message_id as triggerMessageId, agent_id as agentId, provider_id as providerId,
      ui_locale as uiLocale, model_id as modelId, subtask_depth as subtaskDepth, parent_run_id as parentRunId,
      parent_tool_execution_id as parentToolExecutionId, status, run_kind as runKind,
      execution_phase as executionPhase, intended_terminal_status as intendedTerminalStatus,
      intended_terminal_code as intendedTerminalCode, intended_terminal_detail as intendedTerminalDetail,
      terminal_result_code as terminalResultCode, terminal_result_detail as terminalResultDetail,
      created_at as createdAt, updated_at as updatedAt
    from agent_run where workspace_id = @workspaceId and parent_run_id = @parentRunId
      and parent_tool_execution_id = @parentToolExecutionId limit 1
  `).get(params) as Record<string, unknown> | undefined;
  return row ? toRunRecord(row) : null;
}

export type TerminalIntentInput = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  status: AgentTerminalRunStatus;
  code: AgentTerminalResultCode;
  detail: string | null;
  updatedAt: number;
};

/** Worker 取得执行权的幂等基础写入。 */
export function markRunWorkInProgress(db: Db, input: {
  workspaceId: string; sessionId: string; runId: string; updatedAt: number;
}): "updated" | "already_in_progress" {
  const result = db.prepare(`
    update agent_run set execution_phase='work_in_progress', updated_at=@updatedAt
    where run_id=@runId and workspace_id=@workspaceId and session_id=@sessionId
      and status='running' and execution_phase='work_pending'
  `).run(input);
  if (result.changes === 1) return "updated";
  const current = getRunRecord(db, input.runId);
  if (current?.workspaceId === input.workspaceId && current.sessionId === input.sessionId
    && current.status === "running" && current.executionPhase === "work_in_progress") {
    return "already_in_progress";
  }
  throw new Error("run is not eligible to start work");
}

/**
 * 仅持久化 intent，不改变 Run 的公开终态、不处理 artifact。相同三元组重放幂等，
 * 不同三元组或非法 phase 均拒绝；公开终态由 convergeRunTerminal 统一收敛。
 */
export function persistRunTerminalIntent(db: Db, input: TerminalIntentInput): "updated" | "already_persisted" {
  const run = getRunRecord(db, input.runId);
  if (!run || run.workspaceId !== input.workspaceId || run.sessionId !== input.sessionId) {
    throw new Error("terminal intent run is not eligible");
  }
  assertTerminalTuple(run, input.status, input.code, input.detail);
  const result = db.prepare(`
    update agent_run
    set execution_phase='terminal_intent_persisted', intended_terminal_status=@status,
      intended_terminal_code=@code, intended_terminal_detail=@detail, updated_at=@updatedAt
    where run_id=@runId and workspace_id=@workspaceId and session_id=@sessionId
      and status='running' and execution_phase in ('work_pending','work_in_progress')
  `).run(input);
  if (result.changes === 1) return "updated";
  const current = getRunRecord(db, input.runId);
  if (current?.workspaceId === input.workspaceId && current.sessionId === input.sessionId
    && current.executionPhase === "terminal_intent_persisted"
    && current.intendedTerminalStatus === input.status
    && current.intendedTerminalCode === input.code
    && current.intendedTerminalDetail === input.detail) {
    return "already_persisted";
  }
  throw new Error("terminal intent conflicts with current run state");
}

/** 读取已持久化的 terminal intent，供幂等重放与终态收敛验证使用。 */
export function getPersistedRunTerminalIntent(db: Db, input: {
  workspaceId: string; sessionId: string; runId: string;
}): Pick<TerminalIntentInput, "status" | "code" | "detail"> | null {
  const run = getRunRecord(db, input.runId);
  if (!run || run.workspaceId !== input.workspaceId || run.sessionId !== input.sessionId
    || run.executionPhase !== "terminal_intent_persisted"
    || run.intendedTerminalStatus == null || run.intendedTerminalCode == null) return null;
  return { status: run.intendedTerminalStatus, code: run.intendedTerminalCode, detail: run.intendedTerminalDetail };
}

function assertTerminalTuple(run: AgentRunRecord, status: AgentTerminalRunStatus, code: AgentTerminalResultCode, detail: string | null) {
  if (detail !== null || !isAgentTerminalCodeAllowed(run.runKind, status, code)) {
    throw new Error("terminal tuple is not allowed for run kind");
  }
}

function assertAlreadyConvergedTerminalInvariant(db: Db, input: {
  workspaceId: string; sessionId: string; runId: string;
}, run: AgentRunRecord) {
  if (run.status === "running") throw new AgentRunTerminalInvariantError("terminal run has running status");
  if (run.terminalResultCode == null || run.terminalResultDetail !== null) {
    throw new AgentRunTerminalInvariantError("actual terminal tuple is incomplete");
  }
  if (!isAgentTerminalCodeAllowed(run.runKind, run.status, run.terminalResultCode)) {
    throw new AgentRunTerminalInvariantError("actual terminal tuple is not allowed for run kind");
  }
  if (run.intendedTerminalStatus !== null || run.intendedTerminalCode !== null || run.intendedTerminalDetail !== null) {
    throw new AgentRunTerminalInvariantError("terminal run retains terminal intent");
  }

  const session = sessionRow(db, input.workspaceId, input.sessionId);
  const state = getMessageRunState(db, input.workspaceId, input.sessionId);
  if (!session || !state) throw new AgentRunTerminalInvariantError("session or run state is missing");
  // 新 Run 可以已经占据 active fence；重放旧 Run 时绝不能动它。
  if (state.activeRunId === input.runId) {
    throw new AgentRunTerminalInvariantError("terminal run still occupies active fence");
  }

  const messages = db.prepare(`
    select id, status, updated_revision as updatedRevision, updated_at as updatedAt
    from agent_message
    where workspace_id=@workspaceId and origin_session_id=@sessionId and origin_run_id=@runId
  `).all(input) as Array<{ id: string; status: AgentMessageStatus; updatedRevision: number; updatedAt: number }>;
  const executions = db.prepare(`
    select id, status, updated_revision as updatedRevision, updated_at as updatedAt,
      completed_at as completedAt
    from agent_tool_execution
    where origin_session_id=@sessionId and origin_run_id=@runId
  `).all(input) as Array<{
    id: string; status: AgentToolExecutionStatus; updatedRevision: number; updatedAt: number; completedAt: number | null;
  }>;

  if (messages.some((message) => !TERMINAL_MESSAGE_STATUSES.has(message.status))) {
    throw new AgentRunTerminalInvariantError("terminal run has non-terminal message");
  }
  if (executions.some((execution) => !TERMINAL_EXECUTION_STATUSES.has(execution.status))) {
    throw new AgentRunTerminalInvariantError("terminal run has non-terminal tool execution");
  }
  if (messages.some((message) => message.updatedRevision > session.revision || message.updatedAt > session.updatedAt)) {
    throw new AgentRunTerminalInvariantError("message revision or timestamp exceeds session");
  }
  if (executions.some((execution) => execution.updatedRevision > session.revision || execution.updatedAt > session.updatedAt)) {
    throw new AgentRunTerminalInvariantError("tool execution revision or timestamp exceeds session");
  }
  if (run.updatedAt > session.updatedAt) {
    throw new AgentRunTerminalInvariantError("terminal run timestamp exceeds session");
  }
}

export type ConvergeRunTerminalResult = {
  kind: "transitioned" | "already_converged";
  finalStatus: AgentTerminalRunStatus;
};

/**
 * 唯一的 Run 终态物化入口。它只相信已持久化的 intent，不接受调用方传入的
 * 终态结果，避免 Worker、取消和启动恢复形成彼此不同的收敛规则。
 */
export function convergeRunTerminal(db: Db, input: {
  workspaceId: string; sessionId: string; runId: string; updatedAt: number;
}): ConvergeRunTerminalResult {
  return db.transaction(() => {
    const run = getRunRecord(db, input.runId);
    if (!run || run.workspaceId !== input.workspaceId || run.sessionId !== input.sessionId) {
      throw new Error("terminal convergence run is not eligible");
    }
    if (run.executionPhase === "terminal") {
      assertAlreadyConvergedTerminalInvariant(db, input, run);
      return {
        kind: "already_converged" as const,
        finalStatus: run.status as AgentTerminalRunStatus,
      };
    }
    if (
      run.executionPhase !== "terminal_intent_persisted" ||
      run.intendedTerminalStatus == null ||
      run.intendedTerminalCode == null
    ) {
      throw new Error("terminal intent is not persisted");
    }
    const intent = {
      status: run.intendedTerminalStatus,
      code: run.intendedTerminalCode,
      detail: run.intendedTerminalDetail,
    };
    assertTerminalTuple(run, intent.status, intent.code, intent.detail);
    if (!assertFence(db, input)) throw new Error("terminal convergence run fence is not current");

    const session = sessionRow(db, input.workspaceId, input.sessionId);
    const state = getMessageRunState(db, input.workspaceId, input.sessionId);
    if (!session || !state) throw new Error("terminal convergence session state is missing");
    const messages = db.prepare(`
      select id, status from agent_message
      where workspace_id=@workspaceId and origin_session_id=@sessionId and origin_run_id=@runId
    `).all(input) as Array<{ id: string; status: AgentMessageStatus }>;
    const executions = db.prepare(`
      select id, status from agent_tool_execution
      where origin_session_id=@sessionId and origin_run_id=@runId
    `).all(input) as Array<{ id: string; status: AgentToolExecutionStatus }>;

    if (intent.status === "completed") {
      if (messages.some((message) => message.status === "streaming")) {
        throw new Error("completed terminal intent has streaming message");
      }
      if (executions.some((execution) => !TERMINAL_EXECUTION_STATUSES.has(execution.status))) {
        throw new Error("completed terminal intent has non-terminal tool execution");
      }
    }

    const revision = session.revision + 1;
    if (intent.status !== "completed") {
      const messageStatus = intent.status === "cancelled" ? "cancelled" : "failed";
      db.prepare(`
        update agent_message set status=@messageStatus, updated_revision=@revision, updated_at=@updatedAt
        where workspace_id=@workspaceId and origin_session_id=@sessionId and origin_run_id=@runId
          and status='streaming'
      `).run({ ...input, messageStatus, revision });
      db.prepare(`
        update agent_tool_execution
        set status=case when status='running' then 'unknown' else 'cancelled' end,
            completed_at=@updatedAt, updated_revision=@revision, updated_at=@updatedAt
        where origin_session_id=@sessionId and origin_run_id=@runId and status in ('queued','running')
      `).run({ ...input, revision });
    }

    updateSessionPointer(db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      headMessageId: session.headMessageId,
      contextRootMessageId: session.contextRootMessageId,
      revision,
      now: input.updatedAt,
    });
    db.prepare(`
      update agent_run
      set status=@status, execution_phase='terminal',
          intended_terminal_status=null, intended_terminal_code=null, intended_terminal_detail=null,
          terminal_result_code=@code, terminal_result_detail=@detail, updated_at=@updatedAt
      where run_id=@runId and workspace_id=@workspaceId and session_id=@sessionId
        and status='running' and execution_phase='terminal_intent_persisted'
    `).run({ ...input, ...intent });
    const terminalRun = getRunRecord(db, input.runId);
    if (terminalRun?.status !== intent.status || terminalRun.executionPhase !== "terminal") {
      throw new Error("terminal convergence run transition failed");
    }
    if (!settleMessageRunIfCurrent(db, input)) {
      throw new Error("terminal convergence active run unexpectedly changed");
    }
    return { kind: "transitioned" as const, finalStatus: intent.status };
  })();
}

function terminalAssistantIntentFor(run: AgentRunRecord) {
  if (run.runKind === "user") return { status: "completed" as const, code: "run_completed" as const, detail: null };
  if (run.runKind === "subtask") return { status: "completed" as const, code: "subtask_completed" as const, detail: null };
  throw new Error("manual compaction run cannot complete a terminal assistant");
}

/** 终态 Assistant 仅允许 user/subtask 成功结果；产物和 intent 必须精确幂等重放。 */
export function completeTerminalAssistantWithIntent(db: Db, input: {
  workspaceId: string; sessionId: string; runId: string; messageId: string;
  responseTotalTokens?: number | null;
  status: "completed"; code: "run_completed" | "subtask_completed"; detail: null; updatedAt: number;
}): FencedWriteResult {
  return db.transaction(() => {
    const run = getRunRecord(db, input.runId);
    if (!run || run.workspaceId !== input.workspaceId || run.sessionId !== input.sessionId) throw new Error("terminal assistant run is not eligible");
    const expectedIntent = terminalAssistantIntentFor(run);
    if (input.status !== expectedIntent.status || input.code !== expectedIntent.code || input.detail !== expectedIntent.detail) {
      throw new Error("terminal assistant intent conflicts with run kind");
    }
    assertTerminalTuple(run, input.status, input.code, input.detail);
    const message = messageRow(db, input.messageId);
    if (!message || message.workspaceId !== input.workspaceId || message.originSessionId !== input.sessionId
      || message.originRunId !== input.runId || message.type !== "assistant") {
      throw new Error("terminal assistant is not eligible to complete");
    }
    if (message.status === "completed") {
      const replay = completeAssistantReplayMatches(db, message, { ...input, executions: [] });
      const state = getMessageRunState(db, input.workspaceId, input.sessionId);
      const responseTokensMatch = state?.lastResponseTotalTokens === normalizedResponseTotalTokens(input.responseTotalTokens);
      const persisted = getPersistedRunTerminalIntent(db, input);
      if (replay && responseTokensMatch && persisted?.status === input.status && persisted.code === input.code && persisted.detail === input.detail) return "updated";
      throw new Error("terminal assistant replay conflicts with persisted result");
    }
    if (message.status !== "streaming" || !assertFence(db, input)) throw new Error("terminal assistant is not eligible to complete");
    const toolCall = db.prepare("select 1 from agent_message_part where message_id = ? and type = 'tool_call' limit 1").get(input.messageId);
    const nonTerminalExecution = db.prepare(
      "select 1 from agent_tool_execution where origin_run_id = ? and status in ('queued', 'running') limit 1",
    ).get(input.runId);
    if (toolCall || nonTerminalExecution) throw new Error("terminal assistant cannot contain tool calls or non-terminal executions");
    const completed = completeAssistantWithExecutions(db, {
      workspaceId: input.workspaceId, sessionId: input.sessionId, runId: input.runId,
      messageId: input.messageId, executions: [], responseTotalTokens: input.responseTotalTokens,
      updatedAt: input.updatedAt,
    });
    if (completed !== "updated") return completed;
    persistRunTerminalIntent(db, {
      workspaceId: input.workspaceId, sessionId: input.sessionId, runId: input.runId,
      status: input.status, code: input.code, detail: input.detail, updatedAt: input.updatedAt,
    });
    return completed;
  })();
}

/**
 * Atomically persists a manual compaction artifact and its completed terminal
 * intent. Exact replay is accepted only when both artifact and intent match.
 */
export function commitCompactionWithTerminalIntent(db: Db, input: {
  id: string; workspaceId: string; sessionId: string; runId: string; text: string;
  expectedHeadMessageId: string | null; expectedRevision: number;
  textPartId: string; retainedFromMessageId: string | null; createdAt: number;
  primaryProfile?: PrimaryProjectionProfile;
}) {
  return db.transaction(() => {
    const run = getRunRecord(db, input.runId);
    if (!run || run.workspaceId !== input.workspaceId || run.sessionId !== input.sessionId
      || run.runKind !== "manual_compaction" || run.status !== "running") {
      throw new Error("run is not eligible to commit compaction");
    }
    const existing = messageRow(db, input.id);
    if (existing) {
      const existingMessage = getMessage(db, input.id);
      const compaction = existingMessage ? asCompactionMessage(existingMessage) : null;
      const part = compaction?.parts[0];
      const session = getMessageSession(db, input.workspaceId, input.sessionId);
      const replay = existing.workspaceId === input.workspaceId && existing.originSessionId === input.sessionId
        && existing.originRunId === input.runId && existing.type === "compaction" && existing.status === "completed"
        && existing.previousMessageId === input.expectedHeadMessageId && existing.replacesMessageId === null
        && existing.retainedFromMessageId === input.retainedFromMessageId && existing.createdAt === input.createdAt
        && existing.updatedAt === input.createdAt && existing.updatedRevision === input.expectedRevision + 1
        && session?.headMessageId === input.id && session.contextRootMessageId === input.id
        && session.revision === input.expectedRevision + 1
        && part?.id === input.textPartId && part.messageId === input.id && part.position === 0
        && part.text === input.text && part.createdAt === input.createdAt && part.updatedAt === input.createdAt
        && part.updatedRevision === input.expectedRevision + 1;
      const persisted = getPersistedRunTerminalIntent(db, input);
      if (replay && persisted?.status === "completed" && persisted.code === "compaction_completed" && persisted.detail === null) return compaction!;
      throw new Error("compaction replay conflicts with persisted result");
    }
    if (!(["work_pending", "work_in_progress"] as string[]).includes(run.executionPhase) || !assertFence(db, input)) {
      throw new Error("run is not eligible to commit compaction");
    }
    assertTerminalTuple(run, "completed", "compaction_completed", null);
    if (input.retainedFromMessageId != null && !input.primaryProfile) {
      throw new Error("primary profile is required for a retained compaction anchor");
    }
    if (input.retainedFromMessageId != null) assertPrimaryProfileMatchesRun(run, input.primaryProfile!);
    new ModelContextResolver(db).assertRetainedAnchorInEffectiveOriginalBlocks({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      expectedHeadMessageId: input.expectedHeadMessageId,
      expectedRevision: input.expectedRevision,
      retainedFromMessageId: input.retainedFromMessageId,
      primaryProfile: input.primaryProfile!,
    });
    const message = commitCompactionMessageCurrent(db, { ...input, effectiveRetainedAnchorAlreadyValidated: true });
    persistRunTerminalIntent(db, {
      workspaceId: input.workspaceId, sessionId: input.sessionId, runId: input.runId,
      status: "completed", code: "compaction_completed", detail: null, updatedAt: input.createdAt,
    });
    return message;
  })();
}

export function listRecentMessageSessionsAcrossWorkspaces(db: Db, limit: number, kind: "primary" | "subtask" | "all") {
  const kindClause = kind === "all" ? "" : "and session.kind = @kind";
  return db.prepare(`
    select session.id as sessionId, session.title as sessionTitle,
      session.updated_at as sessionUpdatedAt, workspace.id as workspaceId,
      workspace.title as workspaceTitle, workspace.dir_name as workspaceDirName
    from agent_session session join workspaces workspace on workspace.id = session.workspace_id
    where 1 = 1 ${kindClause}
    order by session.updated_at desc, session.id desc limit @limit
  `).all({ limit, kind }) as Array<{
    sessionId: string; sessionTitle: string; sessionUpdatedAt: number;
    workspaceId: string; workspaceTitle: string; workspaceDirName: string;
  }>;
}

export function getLatestTerminalAssistantTextForMessageRun(db: Db, params: { runId: string }) {
  const row = db.prepare(`
    select message.id as messageId, part.text as text
    from agent_message message join agent_message_part part on part.message_id = message.id
    where message.origin_run_id = @runId and message.type = 'assistant'
      and message.status = 'completed' and part.type = 'text'
    order by message.created_at desc, part.position desc limit 1
  `).get(params) as { messageId: string; text: string } | undefined;
  return { messageId: row?.messageId ?? null, text: row?.text ?? "" };
}

export function findMessageClientRequestDedup(db: Db, params: { workspaceId: string; sessionId: string; clientRequestId: string }) {
  return (db.prepare(`
    select message_id as messageId, run_id as runId
    from agent_client_request
    where workspace_id = ? and session_id = ? and client_request_id = ?
  `).get(params.workspaceId, params.sessionId, params.clientRequestId) as { messageId: string; runId: string } | undefined) ?? null;
}

export function insertMessageClientRequestDedup(db: Db, params: { workspaceId: string; sessionId: string; clientRequestId: string; messageId: string; runId: string; createdAt: number }) {
  db.prepare(`
    insert into agent_client_request (workspace_id, session_id, client_request_id, message_id, run_id, created_at)
    values (@workspaceId, @sessionId, @clientRequestId, @messageId, @runId, @createdAt)
  `).run(params);
}

export function updateAutoMessageSessionTitle(db: Db, params: { sessionId: string; title: string; updatedAt: number }) {
  return db.prepare(`
    update agent_session set title = @title, updated_at = @updatedAt
    where id = @sessionId and title_manually_set = 0
  `).run(params).changes > 0;
}

export function setManualMessageSessionTitle(db: Db, params: { sessionId: string; workspaceId: string; title: string }) {
  return db.prepare(`
    update agent_session set title = @title, title_manually_set = 1
    where id = @sessionId and workspace_id = @workspaceId
  `).run(params).changes > 0;
}

export function getSessionAgentModelOverride(db: Db, params: { sessionId: string; agentId: string }): SessionAgentModelOverrideRecord | null {
  return (db.prepare(`
    select session_id as sessionId, agent_id as agentId, provider_id as providerId,
      model_id as modelId, updated_at as updatedAt
    from agent_session_agent_model_override
    where session_id = @sessionId and agent_id = @agentId
  `).get(params) as SessionAgentModelOverrideRecord | undefined) ?? null;
}

export function listSessionAgentModelOverrides(db: Db, params: { sessionId: string }): SessionAgentModelOverrideRecord[] {
  return db.prepare(`
    select session_id as sessionId, agent_id as agentId, provider_id as providerId,
      model_id as modelId, updated_at as updatedAt
    from agent_session_agent_model_override where session_id = @sessionId order by agent_id
  `).all(params) as SessionAgentModelOverrideRecord[];
}

export function upsertSessionAgentModelOverride(db: Db, record: SessionAgentModelOverrideRecord) {
  db.prepare(`
    insert into agent_session_agent_model_override (session_id,agent_id,provider_id,model_id,updated_at)
    values (@sessionId,@agentId,@providerId,@modelId,@updatedAt)
    on conflict(session_id,agent_id) do update set
      provider_id = excluded.provider_id, model_id = excluded.model_id, updated_at = excluded.updated_at
  `).run(record);
}

export function deleteSessionAgentModelOverride(db: Db, params: { sessionId: string; agentId: string }) {
  return db.prepare(`delete from agent_session_agent_model_override where session_id = @sessionId and agent_id = @agentId`).run(params).changes > 0;
}
