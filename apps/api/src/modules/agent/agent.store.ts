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
  outputJson: string;
  createdAt: number;
  updatedAt: number;
};

export type AgentRunStateRow = {
  sessionId: string;
  status: AgentRunStatus;
  activeRunId: string | null;
  activeAssistantItemId: number | null;
  waitingToolItemId: number | null;
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
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    title: String(row.title),
    kind: row.kind === "subtask" ? "subtask" : "primary",
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
    output: JSON.parse(row.outputJson) as AgentContextItemOutput,
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
        updated_at,
        applied_item_id
      ) values (
        @workspaceId,
        @sessionId,
        @status,
        @activeRunId,
        @activeAssistantItemId,
        @waitingToolItemId,
        @updatedAt,
        @appliedItemId
      )
      on conflict(workspace_id, session_id) do update set
        status = excluded.status,
        active_run_id = excluded.active_run_id,
        active_assistant_item_id = excluded.active_assistant_item_id,
        waiting_tool_item_id = excluded.waiting_tool_item_id,
        updated_at = excluded.updated_at,
        applied_item_id = excluded.applied_item_id
    `
  ).run(params);
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
        outputJson: JSON.stringify(params.output),
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
  const nextOutput = params.output ?? (JSON.parse(row.outputJson) as AgentContextItemOutput);
  db.prepare(
    `
      update agent_context_item
      set status = @status,
          output_json = @outputJson,
          updated_at = @updatedAt
      where id = @itemId
    `
  ).run({
    itemId: params.itemId,
    status: nextStatus,
    outputJson: JSON.stringify(nextOutput),
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
    rows.push(mapContextItem(row));
    cursor = row.prevId;
  }
  return rows.reverse();
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
  updatedAt: number;
  appliedItemId: number;
}) {
  upsertRunState(db, params);
}

export function setRunStateIdle(db: Db, params: { workspaceId: string; sessionId: string; updatedAt: number; appliedItemId: number }) {
  upsertRunState(db, {
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    waitingToolItemId: null,
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
