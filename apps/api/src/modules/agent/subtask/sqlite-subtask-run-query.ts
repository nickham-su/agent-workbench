import type { Db } from "../../../infra/db/db.js";
import type { SubtaskRunMessageText, SubtaskRunQuery, SubtaskRunRecord, SubtaskSession } from "./subtask-ports.js";

function mapRun(row: Record<string, unknown>): SubtaskRunRecord | null {
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
  const status = row.status;
  if (status !== "running" && status !== "completed" && status !== "failed" && status !== "cancelled") return null;
  const runId = text(row.runId); const workspaceId = text(row.workspaceId); const sessionId = text(row.sessionId);
  const agentId = text(row.agentId); const providerId = text(row.providerId); const modelId = text(row.modelId);
  if (!runId || !workspaceId || !sessionId || !agentId || !providerId || !modelId) return null;
  return {
    runId, workspaceId, sessionId, triggerMessageId: text(row.triggerMessageId), agentId, providerId, modelId,
    uiLocale: row.uiLocale === "zh-CN" || row.uiLocale === "en-US" ? row.uiLocale : null,
    subtaskDepth: typeof row.subtaskDepth === "number" && Number.isInteger(row.subtaskDepth) ? row.subtaskDepth : null,
    parentRunId: text(row.parentRunId), parentToolExecutionId: text(row.parentToolExecutionId), status,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0
  };
}

/** SQLite query adapter for ownership-fenced Message-model subtask reads. */
export class SqliteSubtaskRunQuery implements SubtaskRunQuery {
  constructor(private readonly db: Db) {}

  findSession(sessionId: string): SubtaskSession | null {
    const row = this.db.prepare(`
      select id, workspace_id as workspaceId, title, kind, head_message_id as headMessageId, revision
      from agent_session where id = ?
    `).get(sessionId) as SubtaskSession | undefined;
    return row ?? null;
  }

  findRunInSession(input: { workspaceId: string; sessionId: string; runId: string }) {
    const row = this.db.prepare(`
      select run_id as runId, workspace_id as workspaceId, session_id as sessionId,
             trigger_message_id as triggerMessageId, agent_id as agentId, provider_id as providerId,
             model_id as modelId, subtask_depth as subtaskDepth, parent_run_id as parentRunId,
             parent_tool_execution_id as parentToolExecutionId, status,
             created_at as createdAt, updated_at as updatedAt
      from agent_run where run_id = @runId and workspace_id = @workspaceId and session_id = @sessionId
    `).get(input) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  listMessageTextsByRun(input: { workspaceId: string; sessionId: string; runId: string }) {
    const assistantRows = this.db.prepare(`
      select part.text as text
      from agent_message message
      join agent_message_part part on part.message_id = message.id
      where message.workspace_id = @workspaceId
        and message.type = 'assistant'
        and message.status in ('completed', 'failed')
        and message.origin_session_id = @sessionId
        and message.origin_run_id = @runId
        and part.type = 'text'
      order by message.depth asc, part.position asc
    `).all(input) as Array<{ text: string | null }>;
    const systemRows = this.db.prepare(`
      with recursive chain(id) as (
        select trigger_message_id
        from agent_run
        where run_id = @runId
          and workspace_id = @workspaceId
          and session_id = @sessionId
        union all
        select message.previous_message_id
        from agent_message message
        join chain on chain.id = message.id
        where message.previous_message_id is not null
      )
      select part.text as text
      from agent_message message
      join agent_message_part part on part.message_id = message.id
      join chain on chain.id = message.id
      where message.workspace_id = @workspaceId
        and message.type = 'system'
        and message.status = 'completed'
        and message.origin_session_id = @sessionId
        and part.type = 'text'
      order by message.depth asc, part.position asc
    `).all(input) as Array<{ text: string | null }>;
    return [
      ...assistantRows.flatMap((row): SubtaskRunMessageText[] =>
        typeof row.text === "string" && row.text.trim() ? [{ type: "assistant", text: row.text }] : []
      ),
      ...systemRows.flatMap((row): SubtaskRunMessageText[] =>
        typeof row.text === "string" && row.text.trim() ? [{ type: "system", text: row.text }] : []
      )
    ];
  }
}
