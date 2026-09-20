import type {
  AgentImageMediaType,
  AgentMessage,
  AgentMessagePart,
  AgentMessageRow,
  AgentRunExecutionPhase,
  AgentRunKind,
  AgentToolExecution,
  AgentToolExecutionStatus,
} from "@agent-workbench/shared";
import {
  AgentMessageSchema,
  canStartPrimaryRetainedTail,
  type PrimaryProjectionProfile,
  type PrimaryReplayProjectionDescriptor,
} from "@agent-workbench/shared";
import {
  parseAgentProviderReplay,
  type AgentProviderReplayEnvelope,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import type { AgentUiLocale } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import { Value } from "@sinclair/typebox/value";
import type { Db } from "../../../infra/db/db.js";
import type { RuntimeTranscriptExecution } from "./runtime-transcript-projector.js";

/**
 * 模型上下文的物理来源坐标。它刻意不暴露 Provider wire message，避免调用方
 * 将某一模型的请求对象当作跨 Provider 的持久状态。
 */
export type ResolvedContextBlock = {
  sourceMessageId: string;
  physical: {
    previousMessageId: string | null;
    depth: number;
    originSessionId: string | null;
    originRunId: string | null;
    updatedRevision: number;
  };
  message: AgentMessage;
  toolExecutions: AgentToolExecution[];
  attachments: Array<{
    partId: string;
    attachmentId: string;
    mediaType: AgentImageMediaType;
    filename: string;
  }>;
  providerReplay: Array<{ partId: string; envelope: AgentProviderReplayEnvelope }>;
};

export type ResolvedPendingTool = {
  toolExecutionId: string;
  callPartId: string;
  assistantMessageId: string;
  status: "queued" | "running";
  toolName: string;
  toolCallId?: string;
  args: Record<string, unknown>;
};

export type ResolvedRunSnapshot = {
  runId: string;
  triggerMessageId: string | null;
  agentId: string;
  providerId: string;
  modelId: string;
  runKind: AgentRunKind;
  subtaskDepth: number | null;
  executionPhase: AgentRunExecutionPhase;
  uiLocale: AgentUiLocale | null;
};

export type ResolvedModelContext = {
  workspaceId: string;
  sessionId: string;
  headMessageId: string | null;
  contextRootMessageId: string | null;
  sessionRevision: number;
  blocks: ResolvedContextBlock[];
  /** 供现有 provider-neutral transcript projector 使用的同一快照投影。 */
  messages: AgentMessage[];
  executions: RuntimeTranscriptExecution[];
  providerReplayByPartId: Map<string, AgentProviderReplayEnvelope>;
  /** runId 存在时全部来自同一个 deferred read transaction。 */
  run: ResolvedRunSnapshot | null;
  pendingTools: ResolvedPendingTool[];
  pendingAssistantMessageIds: ReadonlySet<string>;
  lastResponseTotalTokens: number | null;
};

type SessionRow = {
  workspaceId: string;
  sessionId: string;
  headMessageId: string | null;
  contextRootMessageId: string | null;
  revision: number;
};

type MessageRow = AgentMessageRow;
type PartRow = {
  id: string;
  messageId: string;
  position: number;
  type: AgentMessagePart["type"];
  text: string | null;
  attachmentId: string | null;
  mediaType: AgentImageMediaType | null;
  filename: string | null;
  toolName: string | null;
  toolInputJson: string | null;
  providerToolCallId: string | null;
  providerReplayJson: string | null;
  updatedRevision: number;
  createdAt: number;
  updatedAt: number;
};
type ExecutionRow = {
  id: string;
  callPartId: string;
  originSessionId: string | null;
  originRunId: string | null;
  status: AgentToolExecutionStatus;
  resultPreview: string | null;
  resultTruncated: number;
  resultArtifactPath: string | null;
  structuredResultJson: string | null;
  error: string | null;
  updatedRevision: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
};

type RunRow = {
  runId: string;
  workspaceId: string;
  sessionId: string;
  triggerMessageId: string | null;
  agentId: string;
  providerId: string;
  modelId: string;
  runKind: AgentRunKind;
  subtaskDepth: number | null;
  status: string;
  executionPhase: AgentRunExecutionPhase;
  uiLocale: AgentUiLocale | null;
};

type RunStateRow = {
  status: string;
  activeRunId: string | null;
  lastResponseTotalTokens: number | null;
};

const SQLITE_IN_BATCH_SIZE = 400;
const TERMINAL_TOOL_EXECUTION_STATUSES = new Set<AgentToolExecutionStatus>([
  "completed", "failed", "cancelled", "unknown",
]);

function inBatches<T>(items: readonly T[], size = SQLITE_IN_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Stored tool input is a database invariant. Treat a corrupt row as unsafe rather than
    // allowing it to silently become an empty tool invocation.
  }
  throw new ModelContextInvariantError("stored tool input is invalid");
}

function parseStructuredResult(value: string | null): unknown | null {
  if (value == null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ModelContextInvariantError("stored tool result is invalid");
  }
}

function toPart(row: PartRow): AgentMessagePart {
  const base = {
    id: row.id,
    messageId: row.messageId,
    position: Number(row.position),
    updatedRevision: Number(row.updatedRevision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
  switch (row.type) {
    case "text":
      if (row.text == null) throw new ModelContextInvariantError("stored text part is invalid");
      return { ...base, type: "text", text: row.text };
    case "reasoning":
      if (row.text == null) throw new ModelContextInvariantError("stored reasoning part is invalid");
      return { ...base, type: "reasoning", text: row.text };
    case "image":
      if (!row.attachmentId || !row.mediaType || !row.filename) throw new ModelContextInvariantError("stored image part is invalid");
      return { ...base, type: "image", attachmentId: row.attachmentId, mediaType: row.mediaType, filename: row.filename };
    case "tool_call":
      if (!row.toolName || row.toolInputJson == null) throw new ModelContextInvariantError("stored tool call part is invalid");
      return {
        ...base,
        type: "tool_call",
        toolName: row.toolName,
        input: parseObject(row.toolInputJson),
        providerToolCallId: row.providerToolCallId,
      };
  }
}

function toExecution(row: ExecutionRow): AgentToolExecution {
  return {
    id: row.id,
    callPartId: row.callPartId,
    originSessionId: row.originSessionId,
    originRunId: row.originRunId,
    status: row.status,
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

function toRuntimeExecution(execution: AgentToolExecution): RuntimeTranscriptExecution {
  return {
    callPartId: execution.callPartId,
    status: execution.status,
    resultPreview: execution.resultPreview,
    error: execution.error,
  };
}

function strictMessage(row: MessageRow, parts: AgentMessagePart[]): AgentMessage {
  const candidate = {
    ...row,
    depth: Number(row.depth),
    updatedRevision: Number(row.updatedRevision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    parts,
  };
  const normalized = row.type === "compaction"
    ? candidate
    : (() => {
      const { retainedFromMessageId: _retainedFromMessageId, ...ordinary } = candidate;
      return ordinary;
    })();
  if (!Value.Check(AgentMessageSchema, normalized)) {
    throw new ModelContextInvariantError(`stored message ${row.id} violates the strict shared contract`);
  }
  return normalized;
}

/** A corrupt graph/context is never converted into a partial model prompt. */
export class ModelContextInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelContextInvariantError";
  }
}

/** 可预期的 retained anchor 拒绝；不用于表示损坏的持久化上下文。 */
export class RetainedAnchorValidationError extends ModelContextInvariantError {
  constructor(message: string) {
    super(message);
    this.name = "RetainedAnchorValidationError";
  }
}

function toPrimaryReplayProjectionDescriptor(
  envelope: AgentProviderReplayEnvelope,
): PrimaryReplayProjectionDescriptor {
  return {
    adapter: "openai_responses",
    providerId: envelope.provider.providerId,
    modelId: envelope.provider.model,
    itemType: envelope.item.type,
  };
}

export function projectModelContextToPrompt(input: {
  workspaceId: string;
  triggerMessageId: string | null;
  resolved: ResolvedModelContext;
  projector: { projectDetailed(input: {
    workspaceId: string;
    triggerMessageId: string | null;
    messages: AgentMessage[];
    executions: RuntimeTranscriptExecution[];
    stopBeforeAssistantMessageIds?: ReadonlySet<string>;
    includeEmptyAssistantMessageIds?: ReadonlySet<string>;
  }): { messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: unknown }>; assistantMessageIndexes: Map<string, number> } };
  /** Pending calls form a transcript boundary and are executed before model invocation. */
  stopBeforeAssistantMessageIds?: ReadonlySet<string>;
  /** Only protected PromptContext may preserve an empty Assistant for replay ordinals. */
  includeReplayOnlyAssistants?: boolean;
}) {
  const replayOnlyAssistantMessageIds = new Set(input.resolved.blocks.flatMap((block) => {
    const message = block.message;
    if (message.type !== "assistant" || message.status !== "completed") return [];
    const hasVisiblePart = message.parts.some((part) =>
      part.type === "tool_call" || (part.type === "text" && part.text.length > 0));
    const hasReasoningReplay = message.parts.some((part) =>
      part.type === "reasoning" && input.resolved.providerReplayByPartId.get(part.id)?.item.type === "reasoning");
    return !hasVisiblePart && hasReasoningReplay ? [message.id] : [];
  }));
  const projected = input.projector.projectDetailed({
    workspaceId: input.workspaceId,
    triggerMessageId: input.triggerMessageId,
    messages: input.resolved.messages,
    executions: input.resolved.executions,
    stopBeforeAssistantMessageIds: input.stopBeforeAssistantMessageIds,
    ...(input.includeReplayOnlyAssistants
      ? { includeEmptyAssistantMessageIds: replayOnlyAssistantMessageIds }
      : {}),
  });
  const providerReplay = input.resolved.messages.flatMap((message) => {
    const assistantOrdinal = projected.assistantMessageIndexes.get(message.id);
    if (assistantOrdinal == null || message.type !== "assistant" || message.status !== "completed") return [];
    let visibleIndex = 0;
    const parts: Array<
      | { visibleIndex: number; type: "reasoning"; text: string; providerReplay: AgentProviderReplayEnvelope }
      | { visibleIndex: number; type: "text"; providerReplay: AgentProviderReplayEnvelope }
      | { visibleIndex: number; type: "tool_call"; providerReplay: AgentProviderReplayEnvelope }
    > = [];
    for (const part of [...message.parts].sort((left, right) => left.position - right.position)) {
      if (part.type !== "text" && part.type !== "tool_call" && part.type !== "reasoning") continue;
      const replay = input.resolved.providerReplayByPartId.get(part.id);
      const currentVisibleIndex = visibleIndex;
      // Match RuntimeTranscriptProjector exactly: empty Text is omitted, non-empty Text and
      // ToolCall are visible, while reasoning remains replay-only and consumes no slot.
      if (part.type === "tool_call" || (part.type === "text" && part.text.length > 0)) {
        visibleIndex += 1;
      }
      if (!replay) continue;
      if (part.type === "reasoning" && replay.item.type === "reasoning") {
        parts.push({ visibleIndex: currentVisibleIndex, type: "reasoning", text: part.text, providerReplay: replay });
      }
      if (part.type === "text" && part.text.length > 0 && replay.item.type === "text") {
        parts.push({ visibleIndex: currentVisibleIndex, type: "text", providerReplay: replay });
      }
      if (part.type === "tool_call" && replay.item.type === "function_call") {
        parts.push({ visibleIndex: currentVisibleIndex, type: "tool_call", providerReplay: replay });
      }
    }
    return parts.length > 0 ? [{ assistantOrdinal, parts }] : [];
  });
  return { ...projected, providerReplay };
}

export type RetainedAnchorCandidate = Pick<MessageRow, "id" | "workspaceId" | "type" | "status">;

/** The canonical definition of a message eligible to begin a retained original tail. */
export function isLegalRetainedOriginalAnchor(candidate: RetainedAnchorCandidate | undefined, workspaceId: string) {
  return candidate?.workspaceId === workspaceId
    && candidate.type !== "compaction"
    && candidate.type !== "runtime"
    && candidate.status === "completed";
}

/**
 * Shared submission-side anchor validation. It deliberately checks only immutable graph
 * facts; retained-tail block selection stays in the Resolver/Planner and is not duplicated
 * in write-side code.
 */
export function assertRetainedAnchorOnPreviousChain(db: Db, input: {
  workspaceId: string;
  previousMessageId: string;
  retainedFromMessageId: string | null;
}) {
  if (input.retainedFromMessageId == null) return;
  const rows = db.prepare(`
    with recursive legal_source_sequence(id, previous_message_id, workspace_id, type, status) as (
      select id, previous_message_id, workspace_id, type, status
      from agent_message where id = @previousMessageId and workspace_id = @workspaceId
      union all
       select message.id, message.previous_message_id, message.workspace_id, message.type, message.status
       from agent_message message join legal_source_sequence on legal_source_sequence.previous_message_id = message.id
       where message.workspace_id = @workspaceId
    )
    select id, workspace_id as workspaceId, type, status
    from legal_source_sequence where id = @retainedFromMessageId limit 1
  `).get(input) as RetainedAnchorCandidate | undefined;
  if (!isLegalRetainedOriginalAnchor(rows, input.workspaceId)) {
    throw new ModelContextInvariantError("retained anchor is not a completed non-compaction ancestor");
  }
}

/**
 * The only authority for dynamic model context. Timeline queries intentionally do not use
 * this class: display ancestry, mutation range, and model visibility have different rules.
 */
export class ModelContextResolver {
  constructor(private readonly db: Db) {}

  /**
   * Transaction-aware shared core for retained-tail writes. Callers already owning a write
   * transaction use this directly, so expected coordinates and effective-source selection
   * are checked against one SQLite snapshot without a second ancestry algorithm.
   */
  assertRetainedAnchorInEffectiveOriginalBlocks(input: {
    workspaceId: string;
    sessionId: string;
    expectedHeadMessageId: string | null;
    expectedRevision: number;
    retainedFromMessageId: string | null;
    primaryProfile?: PrimaryProjectionProfile;
  }) {
    if (input.retainedFromMessageId == null) return;
    const session = this.db.prepare(`
      select workspace_id as workspaceId, id as sessionId, head_message_id as headMessageId,
             context_root_message_id as contextRootMessageId, revision
      from agent_session where workspace_id = @workspaceId and id = @sessionId
    `).get(input) as SessionRow | undefined;
    if (!session
      || session.headMessageId !== input.expectedHeadMessageId
      || Number(session.revision) !== input.expectedRevision) {
      throw new RetainedAnchorValidationError("session coordinates changed before retained anchor validation");
    }
    const chain = this.loadPhysicalChain(session, input.workspaceId);
    const hydrated = this.hydrate(
      input.workspaceId,
      session,
      this.selectLogicalMessages(session, chain),
    );
    const effectiveOriginalBlocks = hydrated.blocks
      .filter((block) => isLegalRetainedOriginalAnchor(block.message, input.workspaceId));
    const anchorIndex = effectiveOriginalBlocks.findIndex(
      (block) => block.sourceMessageId === input.retainedFromMessageId,
    );
    if (anchorIndex < 0) {
      throw new RetainedAnchorValidationError("retained anchor is not an effective original block");
    }
    const anchor = effectiveOriginalBlocks[anchorIndex]!;
    if (!canStartPrimaryRetainedTail({
      message: anchor.message,
      profile: input.primaryProfile!,
      replayProjectionByPartId: new Map(
        [...hydrated.providerReplayByPartId].map(([partId, envelope]) => [
          partId,
          toPrimaryReplayProjectionDescriptor(envelope),
        ]),
      ),
    })) {
      throw new RetainedAnchorValidationError("retained anchor has no visible primary projection for the current profile");
    }
    // A retained anchor names a whole resolved message block, never a Part. Every block in
    // the suffix must therefore remain legal, and an Assistant ToolCall block is retained
    // only with its one-to-one, terminal ToolExecution set.
    for (const block of effectiveOriginalBlocks.slice(anchorIndex)) {
      if (!isLegalRetainedOriginalAnchor(block.message, input.workspaceId)) {
        throw new RetainedAnchorValidationError("retained anchor does not start a continuous effective suffix");
      }
      const calls = block.message.type === "assistant"
        ? block.message.parts.filter((part) => part.type === "tool_call")
        : [];
      if (calls.length === 0) continue;
      if (block.toolExecutions.length !== calls.length
        || new Set(block.toolExecutions.map((execution) => execution.callPartId)).size !== calls.length
        || block.toolExecutions.some((execution) => !calls.some((call) => call.id === execution.callPartId))) {
        throw new RetainedAnchorValidationError("assistant tool-call block does not have exactly one execution per call");
      }
      if (block.toolExecutions.some((execution) => !TERMINAL_TOOL_EXECUTION_STATUSES.has(execution.status))) {
        throw new RetainedAnchorValidationError("assistant tool-call block has a non-terminal execution");
      }
    }
  }

  resolve(input: { workspaceId: string; sessionId: string; runId?: string }): ResolvedModelContext {
    return this.db.transaction(() => this.resolveCurrent(input))();
  }

  /** 仅供子类在不改变读取语义的前提下观测已建立的 deferred read snapshot。 */
  protected onReadSnapshotEstablished(): void {
    // no-op
  }

  private resolveCurrent(input: { workspaceId: string; sessionId: string; runId?: string }): ResolvedModelContext {
    const session = this.db.prepare(`
      select workspace_id as workspaceId, id as sessionId, head_message_id as headMessageId,
             context_root_message_id as contextRootMessageId, revision
      from agent_session where workspace_id = @workspaceId and id = @sessionId
    `).get(input) as SessionRow | undefined;
    if (!session) throw new ModelContextInvariantError("session not found");

    const runState = this.db.prepare(`
      select status, active_run_id as activeRunId,
             last_response_total_tokens as lastResponseTotalTokens
      from session_run_state
      where workspace_id = @workspaceId and session_id = @sessionId
    `).get(input) as RunStateRow | undefined;
    if (!runState) throw new ModelContextInvariantError("session run state not found");
    this.onReadSnapshotEstablished();

    let run: ResolvedRunSnapshot | null = null;
    let pendingTools: ResolvedPendingTool[] = [];
    if (input.runId != null) {
      const row = this.db.prepare(`
        select run_id as runId, workspace_id as workspaceId, session_id as sessionId,
               trigger_message_id as triggerMessageId, agent_id as agentId,
               provider_id as providerId, model_id as modelId, run_kind as runKind,
               subtask_depth as subtaskDepth, status, execution_phase as executionPhase,
               ui_locale as uiLocale
        from agent_run where run_id = @runId
      `).get({ runId: input.runId }) as RunRow | undefined;
      if (!row || row.workspaceId !== input.workspaceId || row.sessionId !== input.sessionId) {
        throw new ModelContextInvariantError("run does not belong to model context session");
      }
      if (row.status !== "running"
        || (row.executionPhase !== "work_pending" && row.executionPhase !== "work_in_progress")
        || runState.status !== "running"
        || runState.activeRunId !== input.runId) {
        throw new ModelContextInvariantError("run is not the active model context run");
      }
      run = {
        runId: row.runId,
        triggerMessageId: row.triggerMessageId,
        agentId: row.agentId,
        providerId: row.providerId,
        modelId: row.modelId,
        runKind: row.runKind,
        subtaskDepth: row.subtaskDepth == null ? null : Number(row.subtaskDepth),
        executionPhase: row.executionPhase,
        uiLocale: row.uiLocale,
      };
      pendingTools = this.loadPendingTools({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        runId: input.runId,
      });
    }

    const chain = this.loadPhysicalChain(session, input.workspaceId);
    const selected = this.selectLogicalMessages(session, chain);
    const hydrated = this.hydrate(input.workspaceId, session, selected);
    return {
      ...hydrated,
      run,
      pendingTools,
      pendingAssistantMessageIds: new Set(pendingTools.map((tool) => tool.assistantMessageId)),
      lastResponseTotalTokens: runState.lastResponseTotalTokens == null
        ? null
        : Number(runState.lastResponseTotalTokens),
    };
  }

  private loadPendingTools(input: { workspaceId: string; sessionId: string; runId: string }): ResolvedPendingTool[] {
    const rows = this.db.prepare(`
      select execution.id as toolExecutionId, execution.call_part_id as callPartId,
             part.message_id as assistantMessageId, execution.status,
             part.tool_name as toolName, part.provider_tool_call_id as toolCallId,
             part.tool_input_json as toolInputJson
      from agent_tool_execution execution
      join agent_message_part part on part.id = execution.call_part_id
      where execution.origin_session_id = @sessionId
        and execution.origin_run_id = @runId
        and execution.status in ('queued', 'running')
      order by execution.created_at asc, execution.id asc
    `).all(input) as Array<{
      toolExecutionId: string;
      callPartId: string;
      assistantMessageId: string;
      status: "queued" | "running";
      toolName: string | null;
      toolCallId: string | null;
      toolInputJson: string | null;
    }>;
    return rows.map((row) => {
      if (!row.toolName) throw new ModelContextInvariantError("pending tool has an invalid call part");
      return {
        toolExecutionId: row.toolExecutionId,
        callPartId: row.callPartId,
        assistantMessageId: row.assistantMessageId,
        status: row.status,
        toolName: row.toolName,
        ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
        args: parseObject(row.toolInputJson),
      };
    });
  }

  private loadPhysicalChain(session: SessionRow, workspaceId: string): MessageRow[] {
    if (!session.headMessageId) return [];
    const rows = this.db.prepare(`
      with recursive chain(id, workspace_id, previous_message_id, replaces_message_id, retained_from_message_id, depth, type, status,
                           origin_session_id, origin_run_id, updated_revision, created_at, updated_at) as (
        select id, workspace_id, previous_message_id, replaces_message_id, retained_from_message_id, depth, type, status,
               origin_session_id, origin_run_id, updated_revision, created_at, updated_at
        from agent_message where id = @headMessageId and workspace_id = @workspaceId
        union all
        select message.id, message.workspace_id, message.previous_message_id, message.replaces_message_id, message.retained_from_message_id,
               message.depth, message.type, message.status, message.origin_session_id, message.origin_run_id,
               message.updated_revision, message.created_at, message.updated_at
        from agent_message message join chain on chain.previous_message_id = message.id
        where message.workspace_id = @workspaceId
      )
      select id, workspace_id as workspaceId, previous_message_id as previousMessageId,
             replaces_message_id as replacesMessageId, retained_from_message_id as retainedFromMessageId,
             depth, type, status, origin_session_id as originSessionId, origin_run_id as originRunId,
             updated_revision as updatedRevision, created_at as createdAt, updated_at as updatedAt
      from chain order by depth asc
    `).all({ headMessageId: session.headMessageId, workspaceId }) as MessageRow[];
    if (!rows.some((row) => row.id === session.headMessageId)) {
      throw new ModelContextInvariantError("session head is not reachable in workspace");
    }
    return rows;
  }

  private selectLogicalMessages(session: SessionRow, chain: MessageRow[]): MessageRow[] {
    if (chain.length === 0) {
      if (session.contextRootMessageId != null) throw new ModelContextInvariantError("empty session has a context root");
      return [];
    }
    if (!session.contextRootMessageId) return this.normalized(chain);
    const rootIndex = chain.findIndex((message) => message.id === session.contextRootMessageId);
    if (rootIndex < 0) throw new ModelContextInvariantError("context root is not on the current ancestry branch");
    const root = chain[rootIndex]!;
    if (root.type !== "compaction") return this.normalized(chain.slice(rootIndex));

    const retained = this.retainedRange(chain, rootIndex, root);
    // S, B, and the messages after S have intentionally different physical ordering.
    const normalizedTail = this.normalized(retained);
    const normalizedAfterSummary = this.normalized(chain.slice(rootIndex + 1));
    return [root, ...normalizedTail, ...normalizedAfterSummary];
  }

  private retainedRange(chain: MessageRow[], rootIndex: number, root: MessageRow): MessageRow[] {
    if (root.retainedFromMessageId == null) return [];
    if (!root.previousMessageId) throw new ModelContextInvariantError("compaction root has no previous message");
    const endIndex = rootIndex - 1;
    if (endIndex < 0 || chain[endIndex]?.id !== root.previousMessageId) {
      throw new ModelContextInvariantError("compaction previous message is not on the current branch");
    }
    const startIndex = chain.findIndex((message) => message.id === root.retainedFromMessageId);
    if (startIndex < 0 || startIndex > endIndex) {
      throw new ModelContextInvariantError("retained anchor is not reachable from compaction predecessor");
    }
    return chain.slice(startIndex, endIndex + 1);
  }

  private normalized(messages: MessageRow[]): MessageRow[] {
    const seen = new Set<string>();
    return messages.filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      // A retained old summary would recursively represent history. It is display/archive
      // data only, never a second model summary. The current summary is inserted directly
      // by selectLogicalMessages and never passes through this normalizer.
      return isLegalRetainedOriginalAnchor(message, message.workspaceId);
    });
  }

  private hydrate(workspaceId: string, session: SessionRow, selected: MessageRow[]): ResolvedModelContext {
    if (selected.length === 0) {
      return {
        workspaceId,
        sessionId: session.sessionId,
        headMessageId: session.headMessageId,
        contextRootMessageId: session.contextRootMessageId,
        sessionRevision: Number(session.revision),
        blocks: [], messages: [], executions: [], providerReplayByPartId: new Map(),
        run: null,
        pendingTools: [],
        pendingAssistantMessageIds: new Set(),
        lastResponseTotalTokens: null,
      };
    }
    const ids = selected.map((message) => message.id);
    const parts = inBatches(ids).flatMap((batch) => this.db.prepare(`
        select id, message_id as messageId, position, type, text, attachment_id as attachmentId,
               media_type as mediaType, filename, tool_name as toolName, tool_input_json as toolInputJson,
               provider_tool_call_id as providerToolCallId, provider_replay_json as providerReplayJson,
                updated_revision as updatedRevision, created_at as createdAt, updated_at as updatedAt
         from agent_message_part where message_id in (${batch.map(() => "?").join(",")})
         order by message_id asc, position asc
      `).all(...batch) as PartRow[]);
    const partsByMessage = new Map<string, AgentMessagePart[]>();
    const replayByPartId = new Map<string, AgentProviderReplayEnvelope>();
    for (const row of parts) {
      const part = toPart(row);
      const list = partsByMessage.get(row.messageId) ?? [];
      list.push(part);
      partsByMessage.set(row.messageId, list);
      if (row.providerReplayJson != null) {
        const replay = parseAgentProviderReplay(row.providerReplayJson);
        if (!replay) throw new ModelContextInvariantError(`stored provider replay for part ${row.id} is invalid`);
        replayByPartId.set(row.id, replay);
      }
    }
    const callPartIds = parts.filter((part) => part.type === "tool_call").map((part) => part.id);
    const executionRows = inBatches(callPartIds).flatMap((batch) => this.db.prepare(`
        select id, call_part_id as callPartId, origin_session_id as originSessionId, origin_run_id as originRunId,
               status, result_preview as resultPreview, result_truncated as resultTruncated,
               result_artifact_path as resultArtifactPath, structured_result_json as structuredResultJson,
                error, updated_revision as updatedRevision, created_at as createdAt, updated_at as updatedAt,
                started_at as startedAt, completed_at as completedAt
         from agent_tool_execution where call_part_id in (${batch.map(() => "?").join(",")})
      `).all(...batch) as ExecutionRow[]);
    const executionsByCall = new Map<string, AgentToolExecution[]>();
    for (const row of executionRows) {
      const executions = executionsByCall.get(row.callPartId) ?? [];
      executions.push(toExecution(row));
      executionsByCall.set(row.callPartId, executions);
    }

    const blocks = selected.map((row) => {
      const message = strictMessage(row, partsByMessage.get(row.id) ?? []);
      const toolExecutions = message.parts
        .filter((part) => part.type === "tool_call")
        .map((part) => {
          const executions = executionsByCall.get(part.id) ?? [];
          if (executions.length !== 1) {
            throw new ModelContextInvariantError(`assistant tool call ${part.id} must have exactly one execution`);
          }
          // Queued/running executions are valid live state. PromptContext supplies their
          // owning Assistant as a stop boundary, so RuntimeTranscriptProjector never emits
          // an incomplete tool-call turn. Keeping the execution in the source preserves a
          // single snapshot for pending-work handling and future compaction planning.
          return executions[0]!;
        });
      const attachments = message.parts.flatMap((part) => part.type === "image" ? [{
        partId: part.id, attachmentId: part.attachmentId, mediaType: part.mediaType, filename: part.filename,
      }] : []);
      const providerReplay = message.parts.flatMap((part) => {
        const envelope = replayByPartId.get(part.id);
        return envelope ? [{ partId: part.id, envelope }] : [];
      });
      return {
        sourceMessageId: message.id,
        physical: {
          previousMessageId: message.previousMessageId,
          depth: message.depth,
          originSessionId: message.originSessionId,
          originRunId: message.originRunId,
          updatedRevision: message.updatedRevision,
        },
        message,
        toolExecutions,
        attachments,
        providerReplay,
      } satisfies ResolvedContextBlock;
    });
    const messages = blocks.map((block) => block.message);
    const executions = blocks.flatMap((block) => block.toolExecutions.map(toRuntimeExecution));
    return {
      workspaceId,
      sessionId: session.sessionId,
      headMessageId: session.headMessageId,
      contextRootMessageId: session.contextRootMessageId,
      sessionRevision: Number(session.revision),
      blocks,
      messages,
      executions,
      providerReplayByPartId: replayByPartId,
      run: null,
      pendingTools: [],
      pendingAssistantMessageIds: new Set(),
      lastResponseTotalTokens: null,
    };
  }
}
