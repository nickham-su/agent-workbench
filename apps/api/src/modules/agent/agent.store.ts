import type { Db } from "../../infra/db/db.js";
import type { AgentEventLane, AgentEventRecord, AgentRunStatus, AgentSessionRecord } from "@agent-workbench/shared";

export class AgentConflictError extends Error {
  readonly currentHeadEventId: string | null;

  constructor(currentHeadEventId: string | null) {
    super("agent timeline conflict");
    this.currentHeadEventId = currentHeadEventId;
  }
}

export type AgentSessionRow = {
  id: string;
  workspaceId: string;
  title: string;
  kind: "primary" | "subtask";
  createdAt: number;
  updatedAt: number;
  headEventId: string | null;
};

type AgentEventRow = {
  eventId: number;
  id: string;
  workspaceId: string;
  sessionId: string;
  lane: AgentEventLane;
  prevId: string | null;
  type: string;
  schemaVersion: number;
  correlationId: string | null;
  causationId: string | null;
  createdAt: number;
  payloadJson: string;
};

export type AgentRunStateRow = {
  sessionId: string;
  status: AgentRunStatus;
  activeRunId: string | null;
  updatedAt: number;
  appliedEventId: number;
};

export type NewAgentEventInput = {
  id: string;
  workspaceId: string;
  sessionId: string;
  lane: AgentEventLane;
  prevId: string | null;
  type: string;
  schemaVersion: number;
  correlationId?: string | null;
  causationId?: string | null;
  createdAt: number;
  payload: unknown;
};

type RunState = {
  status: AgentRunStatus;
  activeRunId: string | null;
};

function mapSession(row: any): AgentSessionRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    title: String(row.title),
    kind: row.kind === "subtask" ? "subtask" : "primary",
    headEventId: row.headEventId ? String(row.headEventId) : null,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt)
  };
}

function mapEvent(row: AgentEventRow): AgentEventRecord {
  return {
    eventId: row.eventId,
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    lane: row.lane,
    prevId: row.prevId,
    type: row.type,
    schemaVersion: row.schemaVersion,
    correlationId: row.correlationId,
    causationId: row.causationId,
    createdAt: row.createdAt,
    payload: JSON.parse(row.payloadJson)
  };
}

function readRunState(db: Db, workspaceId: string, sessionId: string): RunState {
  const row = db
    .prepare(
      `
        select status, active_run_id as activeRunId
        from agent_session_run_state
        where workspace_id = ? and session_id = ?
      `
    )
    .get(workspaceId, sessionId) as { status: AgentRunStatus; activeRunId: string | null } | undefined;
  if (!row) return { status: "idle", activeRunId: null };
  return { status: row.status, activeRunId: row.activeRunId ?? null };
}

function reduceRunState(current: RunState, eventType: string, payload: any): RunState {
  if (eventType === "run.created") {
    return { status: "running", activeRunId: typeof payload?.runId === "string" ? payload.runId : current.activeRunId };
  }
  if (eventType === "run.started") {
    return { status: "running", activeRunId: typeof payload?.runId === "string" ? payload.runId : current.activeRunId };
  }
  if (eventType === "run.waiting_approval") {
    return {
      status: "waiting_approval",
      activeRunId: typeof payload?.runId === "string" ? payload.runId : current.activeRunId
    };
  }
  if (eventType === "run.completed" || eventType === "run.failed" || eventType === "run.cancelled") {
    const runId = typeof payload?.runId === "string" ? payload.runId : null;
    if (!runId || runId === current.activeRunId) {
      return { status: "idle", activeRunId: null };
    }
  }
  return current;
}

function upsertRunState(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  status: AgentRunStatus;
  activeRunId: string | null;
  updatedAt: number;
  appliedEventId: number;
}) {
  db.prepare(
    `
      insert into agent_session_run_state (
        workspace_id,
        session_id,
        status,
        active_run_id,
        updated_at,
        applied_event_id
      ) values (
        @workspaceId,
        @sessionId,
        @status,
        @activeRunId,
        @updatedAt,
        @appliedEventId
      )
      on conflict(workspace_id, session_id) do update set
        status = excluded.status,
        active_run_id = excluded.active_run_id,
        updated_at = excluded.updated_at,
        applied_event_id = excluded.applied_event_id
    `
  ).run(params);
}

function getHead(db: Db, workspaceId: string, sessionId: string) {
  const row = db
    .prepare(
      `
        select head_event_id as headEventId
        from agent_session_head
        where workspace_id = ? and session_id = ?
      `
    )
    .get(workspaceId, sessionId) as { headEventId: string | null } | undefined;
  return row ? row.headEventId ?? null : null;
}

function setHead(db: Db, params: { workspaceId: string; sessionId: string; headEventId: string | null; updatedAt: number }) {
  db.prepare(
    `
      insert into agent_session_head (workspace_id, session_id, head_event_id, updated_at)
      values (@workspaceId, @sessionId, @headEventId, @updatedAt)
      on conflict(workspace_id, session_id) do update set
        head_event_id = excluded.head_event_id,
        updated_at = excluded.updated_at
    `
  ).run(params);
}

function touchSession(db: Db, sessionId: string, updatedAt: number) {
  db.prepare(`update agent_session set updated_at = @updatedAt where id = @sessionId`).run({ sessionId, updatedAt });
}

function insertEvent(db: Db, event: NewAgentEventInput) {
  const result = db
    .prepare(
      `
        insert into agent_event (
          id,
          workspace_id,
          session_id,
          lane,
          prev_id,
          type,
          schema_version,
          correlation_id,
          causation_id,
          created_at,
          payload_json
        ) values (
          @id,
          @workspaceId,
          @sessionId,
          @lane,
          @prevId,
          @type,
          @schemaVersion,
          @correlationId,
          @causationId,
          @createdAt,
          @payloadJson
        )
      `
    )
    .run({
      id: event.id,
      workspaceId: event.workspaceId,
      sessionId: event.sessionId,
      lane: event.lane,
      prevId: event.prevId,
      type: event.type,
      schemaVersion: event.schemaVersion,
      correlationId: event.correlationId ?? null,
      causationId: event.causationId ?? null,
      createdAt: event.createdAt,
      payloadJson: JSON.stringify(event.payload)
    });
  return Number(result.lastInsertRowid);
}

function readEventByStableId(db: Db, eventId: string): AgentEventRecord | null {
  const row = db
    .prepare(
      `
        select
          event_id as eventId,
          id,
          workspace_id as workspaceId,
          session_id as sessionId,
          lane,
          prev_id as prevId,
          type,
          schema_version as schemaVersion,
          correlation_id as correlationId,
          causation_id as causationId,
          created_at as createdAt,
          payload_json as payloadJson
        from agent_event
        where id = ?
      `
    )
    .get(eventId) as AgentEventRow | undefined;
  return row ? mapEvent(row) : null;
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
          h.head_event_id as headEventId
        from agent_session s
        left join agent_session_head h
          on h.workspace_id = s.workspace_id and h.session_id = s.id
        where s.workspace_id = ?
        order by s.updated_at desc
      `
    )
    .all(workspaceId);
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
          h.head_event_id as headEventId
        from agent_session s
        left join agent_session_head h
          on h.workspace_id = s.workspace_id and h.session_id = s.id
        where s.id = ?
      `
    )
    .get(sessionId);
  return row ? mapSession(row) : null;
}

export function createAgentSession(db: Db, params: {
  id: string;
  workspaceId: string;
  title: string;
  kind: "primary" | "subtask";
  createdAt: number;
  forkedFromSessionId?: string | null;
  forkedFromEventId?: string | null;
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
          forked_from_event_id
        ) values (
          @id,
          @workspaceId,
          @title,
          @kind,
          @createdAt,
          @updatedAt,
          @forkedFromSessionId,
          @forkedFromEventId
        )
      `
    ).run({
      ...params,
      updatedAt: params.createdAt,
      forkedFromSessionId: params.forkedFromSessionId ?? null,
      forkedFromEventId: params.forkedFromEventId ?? null
    });

    setHead(db, {
      workspaceId: params.workspaceId,
      sessionId: params.id,
      headEventId: null,
      updatedAt: params.createdAt
    });

    upsertRunState(db, {
      workspaceId: params.workspaceId,
      sessionId: params.id,
      status: "idle",
      activeRunId: null,
      updatedAt: params.createdAt,
      appliedEventId: 0
    });
  });
  tx();
}

export function appendTimelineEvent(db: Db, input: NewAgentEventInput): AgentEventRecord {
  const tx = db.transaction(() => {
    const currentHead = getHead(db, input.workspaceId, input.sessionId);
    if (currentHead !== input.prevId) {
      throw new AgentConflictError(currentHead);
    }

    const eventId = insertEvent(db, input);
    setHead(db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      headEventId: input.id,
      updatedAt: input.createdAt
    });
    touchSession(db, input.sessionId, input.createdAt);

    const previousState = readRunState(db, input.workspaceId, input.sessionId);
    const nextState = reduceRunState(previousState, input.type, input.payload);
    upsertRunState(db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      status: nextState.status,
      activeRunId: nextState.activeRunId,
      updatedAt: input.createdAt,
      appliedEventId: eventId
    });

    return {
      eventId,
      ...input,
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null
    };
  });

  return tx();
}

export function appendControlEvent(db: Db, input: Omit<NewAgentEventInput, "prevId">): AgentEventRecord {
  const tx = db.transaction(() => {
    const eventId = insertEvent(db, { ...input, prevId: null });
    touchSession(db, input.sessionId, input.createdAt);
    return {
      eventId,
      ...input,
      prevId: null,
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null
    };
  });
  return tx();
}

export function moveSessionHead(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  expectedHeadEventId: string | null;
  nextHeadEventId: string | null;
  movedEvent: Omit<NewAgentEventInput, "lane" | "prevId" | "type">;
  reason: "revert" | "cancel" | "fork_init" | "admin";
}) {
  const tx = db.transaction(() => {
    const currentHead = getHead(db, params.workspaceId, params.sessionId);
    if (currentHead !== params.expectedHeadEventId) {
      throw new AgentConflictError(currentHead);
    }

    if (params.nextHeadEventId) {
      const target = readEventByStableId(db, params.nextHeadEventId);
      if (!target || target.sessionId !== params.sessionId || target.lane !== "timeline") {
        throw new Error("invalid target head event");
      }

      if (!currentHead) {
        throw new Error("invalid target head event");
      }

      let cursor: string | null = currentHead;
      const seen = new Set<string>();
      let reachable = false;
      while (cursor) {
        if (seen.has(cursor)) break;
        seen.add(cursor);
        if (cursor === params.nextHeadEventId) {
          reachable = true;
          break;
        }
        const event = readEventByStableId(db, cursor);
        if (!event || event.sessionId !== params.sessionId || event.lane !== "timeline") break;
        cursor = event.prevId;
      }
      if (!reachable) {
        throw new Error("invalid target head event");
      }
    }

    const eventId = insertEvent(db, {
      id: params.movedEvent.id,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      lane: "control",
      prevId: null,
      type: "session.head.moved",
      schemaVersion: params.movedEvent.schemaVersion,
      correlationId: params.movedEvent.correlationId,
      causationId: params.movedEvent.causationId,
      createdAt: params.movedEvent.createdAt,
      payload: {
        fromHeadEventId: currentHead,
        toHeadEventId: params.nextHeadEventId,
        reason: params.reason
      }
    });

    setHead(db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      headEventId: params.nextHeadEventId,
      updatedAt: params.movedEvent.createdAt
    });
    touchSession(db, params.sessionId, params.movedEvent.createdAt);

    return {
      eventId,
      id: params.movedEvent.id,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      lane: "control" as const,
      prevId: null,
      type: "session.head.moved",
      schemaVersion: params.movedEvent.schemaVersion,
      correlationId: params.movedEvent.correlationId ?? null,
      causationId: params.movedEvent.causationId ?? null,
      createdAt: params.movedEvent.createdAt,
      payload: {
        fromHeadEventId: currentHead,
        toHeadEventId: params.nextHeadEventId,
        reason: params.reason
      }
    };
  });

  return tx();
}

export function getRunState(db: Db, workspaceId: string, sessionId: string): AgentRunStateRow {
  const row = db
    .prepare(
      `
        select
          session_id as sessionId,
          status,
          active_run_id as activeRunId,
          updated_at as updatedAt,
          applied_event_id as appliedEventId
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
    updatedAt: 0,
    appliedEventId: 0
  };
}

export function getEventById(db: Db, eventId: string): AgentEventRecord | null {
  return readEventByStableId(db, eventId);
}

export function getSessionTimelineEvents(db: Db, workspaceId: string, sessionId: string): AgentEventRecord[] {
  const headEventId = getHead(db, workspaceId, sessionId);
  if (!headEventId) return [];

  const events: AgentEventRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | null = headEventId;

  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const event = readEventByStableId(db, cursor);
    if (!event) break;
    if (event.workspaceId !== workspaceId || event.sessionId !== sessionId) break;
    if (event.lane !== "timeline") break;
    events.push(event);
    cursor = event.prevId;
  }

  return events.reverse();
}

export function getSessionHead(db: Db, workspaceId: string, sessionId: string) {
  return getHead(db, workspaceId, sessionId);
}

export function findClientRequestDedup(db: Db, params: { workspaceId: string; sessionId: string; clientRequestId: string }) {
  const row = db
    .prepare(
      `
        select message_event_id as messageEventId, run_id as runId
        from agent_client_request
        where workspace_id = ? and session_id = ? and client_request_id = ?
      `
    )
    .get(params.workspaceId, params.sessionId, params.clientRequestId) as { messageEventId: string; runId: string } | undefined;
  return row ?? null;
}

export function insertClientRequestDedup(db: Db, params: {
  workspaceId: string;
  sessionId: string;
  clientRequestId: string;
  messageEventId: string;
  runId: string;
  createdAt: number;
}) {
  db.prepare(
    `
      insert into agent_client_request (
        workspace_id,
        session_id,
        client_request_id,
        message_event_id,
        run_id,
        created_at
      ) values (
        @workspaceId,
        @sessionId,
        @clientRequestId,
        @messageEventId,
        @runId,
        @createdAt
      )
    `
  ).run(params);
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

export function findRunCreatedEvent(db: Db, params: { workspaceId: string; sessionId: string; runId: string }) {
  // run.created 需要在全量 timeline 中查找，不能依赖当前 head 可见分支。
  const rows = db
    .prepare(
      `
        select
          event_id as eventId,
          id,
          workspace_id as workspaceId,
          session_id as sessionId,
          lane,
          prev_id as prevId,
          type,
          schema_version as schemaVersion,
          correlation_id as correlationId,
          causation_id as causationId,
          created_at as createdAt,
          payload_json as payloadJson
        from agent_event
        where workspace_id = ? and session_id = ? and lane = 'timeline' and type = 'run.created'
        order by event_id desc
      `
    )
    .all(params.workspaceId, params.sessionId) as AgentEventRow[];

  for (const row of rows) {
    const item = mapEvent(row);
    const payload = item.payload as any;
    if (payload?.runId === params.runId) return item;
  }
  return null;
}

export function setRunStateIdle(db: Db, params: { workspaceId: string; sessionId: string; updatedAt: number; appliedEventId: number }) {
  upsertRunState(db, {
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    status: "idle",
    activeRunId: null,
    updatedAt: params.updatedAt,
    appliedEventId: params.appliedEventId
  });
}

export function getLatestSessionEventId(db: Db, workspaceId: string, sessionId: string) {
  const row = db
    .prepare(
      `
        select max(event_id) as eventId
        from agent_event
        where workspace_id = ? and session_id = ?
      `
    )
    .get(workspaceId, sessionId) as { eventId: number | null };
  return row.eventId ?? 0;
}
