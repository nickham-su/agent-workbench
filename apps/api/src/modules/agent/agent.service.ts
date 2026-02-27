import type { FastifyBaseLogger } from "fastify";
import type {
  AgentCancelSessionRequest,
  AgentContextItemRecord,
  AgentContextItemStatus,
  AgentContextItemsResponse,
  AgentControlResult,
  AgentForkSessionRequest,
  AgentPermissionDecision,
  AgentRevertSessionRequest,
  AgentRunStatus,
  AgentSendMessageRequest,
  AgentSendMessageResponse,
  AgentSessionRunState,
  AgentContextToolName,
  AgentToolPermissionRequest
} from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import type { AppContext } from "../../app/context.js";
import { nowMs } from "../../utils/time.js";
import { newSortableId } from "../../utils/ids.js";
import { getWorkspace } from "../workspaces/workspace.store.js";
import {
  AgentConflictError,
  appendContextItem,
  createAgentSession,
  createRunRecord,
  findClientRequestDedup,
  getAgentSession,
  getContextItemById,
  getLatestSessionItemId,
  getRunRecord,
  getRunState,
  getSessionHead,
  getSessionVisibleItems,
  getSessionVisibleItemsAfter,
  getVisibleItemById,
  insertClientRequestDedup,
  listAgentSessions,
  listNonTerminalVisibleItemIds,
  moveSessionHead,
  setRunStateIdle,
  updateContextItem,
  updateRunRecordStatus,
  updateRunState
} from "./agent.store.js";
import { resolveExecutionProfile } from "../settings/settings.service.js";

export type AgentQueuedRun = {
  workspaceId: string;
  sessionId: string;
  runId: string;
};

function conflictToHttpError(err: AgentConflictError): HttpError {
  return new HttpError(409, "session head conflict", `conflict_head:${String(err.currentHeadItemId ?? "null")}`);
}

function toolArgsSchema(toolName: AgentContextToolName) {
  if (toolName === "bash") {
    return {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", minLength: 1 }
      }
    };
  }
  if (toolName === "read") {
    return {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string", minLength: 1 },
        offset: { type: "number", minimum: 1 },
        limit: { type: "number", minimum: 1 }
      }
    };
  }
  return {
    type: "object",
    required: ["filePath", "content"],
    properties: {
      filePath: { type: "string", minLength: 1 },
      content: { type: "string" }
    }
  };
}

function toolDescription(toolName: AgentContextToolName) {
  if (toolName === "bash") return "执行一个 bash 命令并返回 stdout/stderr。";
  if (toolName === "read") return "读取工作区内的文件内容。";
  return "写入工作区内的文件内容。";
}

function stringifyToolResult(raw: unknown) {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

const NON_TERMINAL_ITEM_STATUS = new Set<AgentContextItemStatus>([
  "streaming",
  "queued",
  "running",
  "awaiting_permission"
]);

const TERMINAL_TOOL_ITEM_STATUS = new Set<AgentContextItemStatus>([
  "completed",
  "failed",
  "denied",
  "cancelled"
]);

type PromptTextPart = { type: "text"; text: string };
type PromptToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: AgentContextToolName;
  input: Record<string, unknown>;
};
type PromptToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: AgentContextToolName;
  output:
    | { type: "json"; value: unknown }
    | { type: "error-text"; value: string };
};
type PromptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | PromptTextPart[] }
  | { role: "assistant"; content: string | Array<PromptTextPart | PromptToolCallPart> }
  | { role: "tool"; content: PromptToolResultPart[] };

export class AgentService {
  constructor(private readonly ctx: AppContext, private readonly logger: FastifyBaseLogger) {}

  getContext() {
    return this.ctx;
  }

  listSessions(workspaceId: string) {
    this.ensureWorkspace(workspaceId);
    return listAgentSessions(this.ctx.db, workspaceId);
  }

  getSession(sessionId: string) {
    return getAgentSession(this.ctx.db, sessionId);
  }

  getWorkspace(workspaceId: string) {
    return getWorkspace(this.ctx.db, workspaceId);
  }

  createSession(params: { workspaceId: string; title?: string; kind?: "primary" | "subtask" }) {
    this.ensureWorkspace(params.workspaceId);
    const createdAt = nowMs();
    const sessionId = newSortableId("sess");
    const title = (params.title || "新会话").trim() || "新会话";
    const kind = params.kind === "subtask" ? "subtask" : "primary";

    createAgentSession(this.ctx.db, {
      id: sessionId,
      workspaceId: params.workspaceId,
      title,
      kind,
      createdAt
    });

    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(500, "failed to create session");
    return session;
  }

  forkSession(params: AgentForkSessionRequest) {
    const fromSession = getAgentSession(this.ctx.db, params.fromSessionId);
    if (!fromSession) throw new HttpError(404, "source session not found");

    const visible = getSessionVisibleItems(this.ctx.db, fromSession.workspaceId, fromSession.id);
    const index = visible.findIndex((item) => item.id === params.fromItemId);
    if (index < 0) throw new HttpError(400, "invalid fromItemId");

    const createdAt = nowMs();
    const newSessionId = newSortableId("sess");
    const title = (params.title || `${fromSession.title} (fork)`).trim() || `${fromSession.title} (fork)`;
    const kind = params.kind === "subtask" ? "subtask" : "primary";

    const cloned = visible.slice(0, index + 1);
    const tx = this.ctx.db.transaction(() => {
      createAgentSession(this.ctx.db, {
        id: newSessionId,
        workspaceId: fromSession.workspaceId,
        title,
        kind,
        createdAt,
        forkedFromSessionId: fromSession.id,
        forkedFromItemId: params.fromItemId
      });

      let prevId: number | null = null;
      for (const item of cloned) {
        const safeStatus = item.status === "streaming" || item.status === "queued" || item.status === "running" || item.status === "awaiting_permission" ? "completed" : item.status;
        const next = appendContextItem(this.ctx.db, {
          workspaceId: fromSession.workspaceId,
          sessionId: newSessionId,
          runId: null,
          turnId: null,
          step: null,
          prevId,
          kind: item.kind,
          status: safeStatus,
          output: item.output,
          createdAt: Math.max(createdAt, item.createdAt)
        });
        prevId = next.id;
      }
    });
    tx();

    const session = getAgentSession(this.ctx.db, newSessionId);
    if (!session) throw new HttpError(500, "failed to create fork session");
    return session;
  }

  async sendMessage(params: { sessionId: string; body: AgentSendMessageRequest }): Promise<AgentSendMessageResponse> {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.body.workspaceId) {
      throw new HttpError(400, "workspaceId mismatch");
    }

    const text = params.body.text.trim();
    if (!text) throw new HttpError(400, "text is required");

    const dedup = findClientRequestDedup(this.ctx.db, {
      workspaceId: session.workspaceId,
      sessionId: session.id,
      clientRequestId: params.body.clientRequestId
    });
    if (dedup) {
      return {
        sessionId: session.id,
        messageItemId: dedup.messageItemId,
        runId: dedup.runId,
        deduplicated: true
      };
    }

    const runState = getRunState(this.ctx.db, session.workspaceId, session.id);
    if (runState.status !== "idle") {
      throw new HttpError(409, "session is running");
    }

    const profile = resolveExecutionProfile(this.ctx, {
      requestedAgentId: params.body.agentId
    });

    const createdAt = nowMs();
    const runId = newSortableId("run");
    let messageItemId = 0;

    try {
      const tx = this.ctx.db.transaction(() => {
        const head = getSessionHead(this.ctx.db, session.workspaceId, session.id);
        const item = appendContextItem(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          runId,
          turnId: null,
          step: null,
          prevId: head,
          kind: "user",
          status: "completed",
          output: {
            type: "user_text",
            text
          },
          createdAt
        });

        messageItemId = item.id;
        insertClientRequestDedup(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          clientRequestId: params.body.clientRequestId,
          messageItemId: item.id,
          runId,
          createdAt
        });

        createRunRecord(this.ctx.db, {
          runId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          triggerItemId: item.id,
          agentId: profile.agent.id,
          providerId: profile.provider.id,
          modelId: profile.model.id,
          status: "running",
          createdAt
        });

        updateRunState(this.ctx.db, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          status: "running",
          activeRunId: runId,
          activeAssistantItemId: null,
          waitingToolItemId: null,
          updatedAt: createdAt,
          appliedItemId: item.id
        });
      });
      tx();
    } catch (err) {
      if (err instanceof AgentConflictError) throw conflictToHttpError(err);
      throw err;
    }

    return {
      sessionId: session.id,
      messageItemId,
      runId,
      deduplicated: false
    };
  }

  getContextItems(sessionId: string, afterId?: number): AgentContextItemsResponse {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    const items = afterId && afterId > 0 ? getSessionVisibleItemsAfter(this.ctx.db, session.workspaceId, session.id, afterId) : getSessionVisibleItems(this.ctx.db, session.workspaceId, session.id);
    const runState = getRunState(this.ctx.db, session.workspaceId, session.id);
    return {
      sessionId: session.id,
      headItemId: session.headItemId,
      appliedItemId: runState.appliedItemId,
      items
    };
  }

  getContextItem(sessionId: string, itemId: number) {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    const item = getVisibleItemById(this.ctx.db, session.workspaceId, session.id, itemId);
    if (!item) throw new HttpError(404, "context item not found");
    return item;
  }

  getRunState(sessionId: string): AgentSessionRunState {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    const nonTerminalItemIds = listNonTerminalVisibleItemIds(this.ctx.db, session.workspaceId, session.id);
    return {
      sessionId: session.id,
      status: state.status,
      activeRunId: state.activeRunId,
      activeAssistantItemId: state.activeAssistantItemId,
      waitingToolItemId: state.waitingToolItemId,
      nonTerminalItemIds,
      updatedAt: state.updatedAt,
      appliedItemId: state.appliedItemId
    };
  }

  getContextItemById(itemId: number) {
    return getContextItemById(this.ctx.db, itemId);
  }

  revertSession(sessionId: string, body: AgentRevertSessionRequest): AgentControlResult {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== body.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const target = getVisibleItemById(this.ctx.db, session.workspaceId, session.id, body.toItemId);
    if (!target) throw new HttpError(400, "toItemId is invalid");

    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    const createdAt = nowMs();
    try {
      moveSessionHead(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        expectedHeadItemId: session.headItemId,
        nextHeadItemId: body.toItemId,
        updatedAt: createdAt
      });
      setRunStateIdle(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        updatedAt: createdAt,
        appliedItemId: getLatestSessionItemId(this.ctx.db, session.workspaceId, session.id)
      });
      if (state.activeRunId) {
        updateRunRecordStatus(this.ctx.db, {
          runId: state.activeRunId,
          status: "cancelled",
          updatedAt: createdAt
        });
      }
    } catch (err) {
      if (err instanceof AgentConflictError) throw conflictToHttpError(err);
      if (err instanceof Error && err.message === "invalid target head item") {
        throw new HttpError(400, "toItemId is invalid");
      }
      throw err;
    }

    const headItemId = getSessionHead(this.ctx.db, session.workspaceId, session.id);
    return { sessionId: session.id, headItemId };
  }

  cancelSession(sessionId: string, body: AgentCancelSessionRequest): AgentControlResult {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== body.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    const createdAt = nowMs();

    const tx = this.ctx.db.transaction(() => {
      const visible = getSessionVisibleItems(this.ctx.db, session.workspaceId, session.id);
      for (const item of visible) {
        if (!NON_TERMINAL_ITEM_STATUS.has(item.status)) continue;
        updateContextItem(this.ctx.db, {
          itemId: item.id,
          status: "cancelled",
          output: item.output,
          updatedAt: createdAt
        });
      }

      setRunStateIdle(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        updatedAt: createdAt,
        appliedItemId: getLatestSessionItemId(this.ctx.db, session.workspaceId, session.id)
      });
      if (state.activeRunId) {
        updateRunRecordStatus(this.ctx.db, {
          runId: state.activeRunId,
          status: "cancelled",
          updatedAt: createdAt
        });
      }
    });

    tx();

    const headItemId = getSessionHead(this.ctx.db, session.workspaceId, session.id);
    return { sessionId: session.id, headItemId };
  }

  applyToolPermission(sessionId: string, body: AgentToolPermissionRequest) {
    const session = getAgentSession(this.ctx.db, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== body.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const state = getRunState(this.ctx.db, session.workspaceId, session.id);
    if (!state.activeRunId) throw new HttpError(409, "no active run");
    if (state.waitingToolItemId !== body.toolItemId) throw new HttpError(409, "tool is not waiting for permission");

    const item = getContextItemById(this.ctx.db, body.toolItemId);
    if (!item || item.sessionId !== session.id || item.kind !== "tool") {
      throw new HttpError(404, "tool item not found");
    }
    if (item.status !== "awaiting_permission") {
      throw new HttpError(409, "tool is not waiting for permission");
    }

    if (item.output.type !== "tool") {
      throw new HttpError(400, "invalid tool item output");
    }
    const output = item.output;
    const updatedAt = nowMs();
    if (body.decision === "approve") {
      updateContextItem(this.ctx.db, {
        itemId: item.id,
        status: "queued",
        output: {
          ...output,
          approved: true
        },
        updatedAt
      });
      updateRunRecordStatus(this.ctx.db, {
        runId: state.activeRunId,
        status: "running",
        updatedAt
      });
      updateRunState(this.ctx.db, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        status: "running",
        activeRunId: state.activeRunId,
        activeAssistantItemId: state.activeAssistantItemId,
        waitingToolItemId: null,
        updatedAt,
        appliedItemId: getLatestSessionItemId(this.ctx.db, session.workspaceId, session.id)
      });
      return { runId: state.activeRunId, decision: body.decision };
    }

    updateContextItem(this.ctx.db, {
      itemId: item.id,
      status: "denied",
      output: {
        ...output,
        error: "permission denied"
      },
      updatedAt
    });
    updateRunRecordStatus(this.ctx.db, {
      runId: state.activeRunId,
      status: "running",
      updatedAt
    });
    updateRunState(this.ctx.db, {
      workspaceId: session.workspaceId,
      sessionId: session.id,
      status: "running",
      activeRunId: state.activeRunId,
      activeAssistantItemId: state.activeAssistantItemId,
      waitingToolItemId: null,
      updatedAt,
      appliedItemId: getLatestSessionItemId(this.ctx.db, session.workspaceId, session.id)
    });
    return { runId: state.activeRunId, decision: body.decision };
  }

  appendContextItemFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    runId: string | null;
    turnId: string | null;
    step: number | null;
    prevId: number | null;
    kind: AgentContextItemRecord["kind"];
    status: AgentContextItemStatus;
    output: AgentContextItemRecord["output"];
    createdAt?: number;
  }) {
    try {
      return appendContextItem(this.ctx.db, {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        runId: params.runId,
        turnId: params.turnId,
        step: params.step,
        prevId: params.prevId,
        kind: params.kind,
        status: params.status,
        output: params.output,
        createdAt: params.createdAt ?? nowMs()
      });
    } catch (err) {
      if (err instanceof AgentConflictError) {
        this.logger.warn(
          {
            sessionId: params.sessionId,
            kind: params.kind,
            currentHeadItemId: err.currentHeadItemId
          },
          "agent append context item conflict"
        );
        throw conflictToHttpError(err);
      }
      throw err;
    }
  }

  updateContextItemFromWorker(params: {
    itemId: number;
    status?: AgentContextItemStatus;
    output?: AgentContextItemRecord["output"];
    updatedAt?: number;
  }) {
    const item = updateContextItem(this.ctx.db, {
      itemId: params.itemId,
      status: params.status,
      output: params.output,
      updatedAt: params.updatedAt ?? nowMs()
    });
    if (!item) throw new HttpError(404, "context item not found");
    return item;
  }

  updateRunStateFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    status: AgentRunStatus;
    activeRunId: string | null;
    activeAssistantItemId: number | null;
    waitingToolItemId: number | null;
    updatedAt?: number;
  }) {
    const ts = params.updatedAt ?? nowMs();
    const appliedItemId = getLatestSessionItemId(this.ctx.db, params.workspaceId, params.sessionId);
    updateRunState(this.ctx.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      status: params.status,
      activeRunId: params.activeRunId,
      activeAssistantItemId: params.activeAssistantItemId,
      waitingToolItemId: params.waitingToolItemId,
      updatedAt: ts,
      appliedItemId
    });
    if (params.activeRunId) {
      updateRunRecordStatus(this.ctx.db, {
        runId: params.activeRunId,
        status: params.status === "waiting_permission" ? "waiting_permission" : "running",
        updatedAt: ts
      });
    }
  }

  completeRunFromWorker(params: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    status: "completed" | "failed" | "cancelled";
    updatedAt?: number;
  }) {
    const ts = params.updatedAt ?? nowMs();
    updateRunRecordStatus(this.ctx.db, {
      runId: params.runId,
      status: params.status,
      updatedAt: ts
    });
    const state = getRunState(this.ctx.db, params.workspaceId, params.sessionId);
    if (state.activeRunId !== params.runId) {
      return;
    }
    setRunStateIdle(this.ctx.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      updatedAt: ts,
      appliedItemId: getLatestSessionItemId(this.ctx.db, params.workspaceId, params.sessionId)
    });
  }

  getExecutionProfileForRun(params: { workspaceId: string; sessionId: string; runId: string }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const run = getRunRecord(this.ctx.db, params.runId);
    if (!run || run.sessionId !== params.sessionId || run.workspaceId !== params.workspaceId) {
      throw new HttpError(404, "run not found");
    }

    const profile = resolveExecutionProfile(this.ctx, {
      agentIdFromRun: run.agentId,
      providerIdFromRun: run.providerId,
      modelIdFromRun: run.modelId
    });

    return {
      resolved: {
        runId: params.runId,
        sessionId: params.sessionId,
        workspaceId: params.workspaceId,
        agentId: profile.agent.id,
        providerId: profile.provider.id,
        modelId: profile.model.id
      },
      agent: profile.agent,
      provider: profile.provider,
      model: profile.model
    };
  }

  getPromptContextForRun(params: { workspaceId: string; sessionId: string; runId: string }) {
    const session = getAgentSession(this.ctx.db, params.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch");

    const run = getRunRecord(this.ctx.db, params.runId);
    if (!run || run.sessionId !== params.sessionId || run.workspaceId !== params.workspaceId) {
      throw new HttpError(404, "run not found");
    }

    const profile = resolveExecutionProfile(this.ctx, {
      agentIdFromRun: run.agentId,
      providerIdFromRun: run.providerId,
      modelIdFromRun: run.modelId
    });

    const visible = getSessionVisibleItems(this.ctx.db, params.workspaceId, params.sessionId);
    const messages: PromptMessage[] = [];
    for (let i = 0; i < visible.length; i += 1) {
      const item = visible[i];
      if (!item) continue;

      if (item.kind === "user" && item.output.type === "user_text") {
        if (!item.output.text) continue;
        messages.push({ role: "user", content: item.output.text });
        continue;
      }

      if (item.kind !== "assistant" || item.output.type !== "assistant_text" || item.status !== "completed") {
        continue;
      }

      const assistantParts: Array<PromptTextPart | PromptToolCallPart> = [];
      if (item.output.text) {
        assistantParts.push({ type: "text", text: item.output.text });
      }

      const toolResultParts: PromptToolResultPart[] = [];
      let cursor = i + 1;
      while (cursor < visible.length) {
        const toolItem = visible[cursor];
        if (!toolItem || toolItem.kind !== "tool") break;
        if (toolItem.runId !== item.runId || toolItem.turnId !== item.turnId || toolItem.step !== item.step) break;
        if (toolItem.output.type !== "tool" || !TERMINAL_TOOL_ITEM_STATUS.has(toolItem.status)) {
          cursor += 1;
          continue;
        }

        const toolCallId = typeof toolItem.output.toolCallId === "string" ? toolItem.output.toolCallId.trim() : "";
        if (!toolCallId) {
          cursor += 1;
          continue;
        }
        const toolInput = toolItem.output.args && typeof toolItem.output.args === "object" && !Array.isArray(toolItem.output.args)
          ? (toolItem.output.args as Record<string, unknown>)
          : {};
        assistantParts.push({
          type: "tool-call",
          toolCallId,
          toolName: toolItem.output.toolName,
          input: toolInput
        });

        const toolOutput = toolItem.output.error
          ? { type: "error-text" as const, value: toolItem.output.error }
          : {
              type: "json" as const,
              value: toolItem.output.result !== undefined ? toolItem.output.result : { status: toolItem.status }
            };
        toolResultParts.push({
          type: "tool-result",
          toolCallId,
          toolName: toolItem.output.toolName,
          output: toolOutput
        });
        cursor += 1;
      }

      if (assistantParts.length === 1 && assistantParts[0].type === "text") {
        messages.push({ role: "assistant", content: assistantParts[0].text });
      } else if (assistantParts.length > 0) {
        messages.push({ role: "assistant", content: assistantParts });
      }

      if (toolResultParts.length > 0) {
        messages.push({ role: "tool", content: toolResultParts });
      }

      i = cursor - 1;
    }

    const tools = profile.agent.tools.map((name) => {
      const requiresApproval =
        (name === "read" && !profile.agent.permissions.allowRead) ||
        (name === "write" && !profile.agent.permissions.allowWrite) ||
        (name === "bash" && !profile.agent.permissions.allowBash);
      return {
        name,
        description: toolDescription(name),
        inputSchema: toolArgsSchema(name),
        requiresApproval
      };
    });

    const pendingTools = visible
      .filter((item) => item.runId === params.runId && item.kind === "tool")
      .filter((item) => item.status === "queued" || item.status === "running" || item.status === "awaiting_permission")
      .map((item) => {
        if (item.output.type !== "tool") return null;
        return {
          itemId: item.id,
          status: item.status,
          toolName: item.output.toolName,
          toolCallId: item.output.toolCallId,
          args: item.output.args ?? {},
          approved: item.output.approved === true
        };
      })
      .filter((item): item is {
        itemId: number;
        status: AgentContextItemStatus;
        toolName: AgentContextToolName;
        toolCallId: string | undefined;
        args: Record<string, unknown>;
        approved: boolean;
      } => item !== null);

    return {
      headItemId: session.headItemId,
      system: profile.agent.prompt || "",
      messages,
      tools,
      pendingTools
    };
  }

  private ensureWorkspace(workspaceId: string) {
    const workspace = getWorkspace(this.ctx.db, workspaceId);
    if (!workspace) throw new HttpError(404, "workspace not found");
    return workspace;
  }
}
