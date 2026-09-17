import type { Db } from "../../../infra/db/db.js";
import type { ActiveSubtaskChildQuery, SubtaskLineagePersistence, SubtaskRunRecord } from "./subtask-ports.js";

function mapRun(row: Record<string, unknown>): SubtaskRunRecord | null {
  const nonEmpty = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
  const status = row.status;
  if (status !== "running" && status !== "completed" && status !== "failed" && status !== "cancelled") return null;
  const runId = nonEmpty(row.runId);
  const workspaceId = nonEmpty(row.workspaceId);
  const sessionId = nonEmpty(row.sessionId);
  const agentId = nonEmpty(row.agentId);
  const providerId = nonEmpty(row.providerId);
  const modelId = nonEmpty(row.modelId);
  if (!runId || !workspaceId || !sessionId || !agentId || !providerId || !modelId) return null;
  return {
    runId, workspaceId, sessionId,
    triggerMessageId: nonEmpty(row.triggerMessageId),
    agentId, providerId, modelId,
    uiLocale: row.uiLocale === "zh-CN" || row.uiLocale === "en-US" ? row.uiLocale : null,
    subtaskDepth: typeof row.subtaskDepth === "number" && Number.isSafeInteger(row.subtaskDepth) && row.subtaskDepth >= 0 ? row.subtaskDepth : null,
    parentRunId: nonEmpty(row.parentRunId),
    parentToolExecutionId: nonEmpty(row.parentToolExecutionId),
    status,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0
  };
}

/** SQLite authority for durable Message-model subtask lineage. */
export class SqliteSubtaskLineagePersistence implements SubtaskLineagePersistence, ActiveSubtaskChildQuery {
  constructor(private readonly db: Db) {}

  findChildByParentToolExecution(input: { workspaceId: string; parentRunId: string; parentToolExecutionId: string }) {
    const row = this.db.prepare(`
      select run_id as runId, workspace_id as workspaceId, session_id as sessionId,
             trigger_message_id as triggerMessageId, agent_id as agentId, provider_id as providerId,
             model_id as modelId, subtask_depth as subtaskDepth, parent_run_id as parentRunId,
             parent_tool_execution_id as parentToolExecutionId, status,
             created_at as createdAt, updated_at as updatedAt
      from agent_run
      where workspace_id = @workspaceId
        and parent_run_id = @parentRunId
        and parent_tool_execution_id = @parentToolExecutionId
      order by created_at asc, run_id asc
      limit 1
    `).get(input) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  listByParentRun(input: { workspaceId: string; sessionId: string; runId: string }) {
    return (this.db.prepare(`
      select session_id as sessionId
      from agent_run
      where workspace_id = @workspaceId and parent_run_id = @runId and status = 'running'
      order by created_at asc, run_id asc
    `).all(input) as Array<{ sessionId: string }>).map((row) => row.sessionId);
  }
}
