import type { AgentSessionVisibility } from "@agent-workbench/shared";
import { AgentSubtaskErrorCode } from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../../app/errors.js";
import type { Db } from "../../../infra/db/db.js";

/** Execution identity is independent of the content/ancestry recorded on a Fork. */
export type SessionExecutionParent = {
  sessionId: string;
  runId: string;
  toolExecutionId: string;
};

export type SessionVisibilityInput = {
  visibility?: AgentSessionVisibility;
  executionParent?: SessionExecutionParent;
  contentSourceSessionId?: string;
};

/** Called inside the existing creation transaction, never from client metadata. */
export function resolveSessionVisibility(db: Db, workspaceId: string, input: SessionVisibilityInput): AgentSessionVisibility {
  let inherited: AgentSessionVisibility = "listed";
  if (input.executionParent) {
    const parent = input.executionParent;
    const row = db.prepare(`
      select session.visibility
      from agent_session session
      join agent_run run on run.session_id = session.id and run.workspace_id = session.workspace_id
      join agent_tool_execution execution
        on execution.id = @toolExecutionId and execution.origin_session_id = session.id
        and execution.origin_run_id = run.run_id
      join agent_message_part part on part.id = execution.call_part_id and part.tool_name = 'subtask'
      where session.id = @sessionId and session.workspace_id = @workspaceId and run.run_id = @runId
    `).get({ ...parent, workspaceId }) as { visibility: AgentSessionVisibility } | undefined;
    if (!row) throw new HttpError(400, "invalid subtask parent binding", AgentSubtaskErrorCode.AnchorRunMismatch);
    inherited = row.visibility;
  }
  if (input.contentSourceSessionId !== undefined) {
    const source = db.prepare("select visibility from agent_session where id = ? and workspace_id = ?")
      .get(input.contentSourceSessionId, workspaceId) as { visibility: AgentSessionVisibility } | undefined;
    if (!source) throw new HttpError(404, "source session not found");
    if (source.visibility === "unlisted") inherited = "unlisted";
  }
  return input.visibility === "unlisted" || inherited === "unlisted" ? "unlisted" : "listed";
}

/** Visibility is immutable: callers may reuse a hidden target, but never promote it. */
export function assertSubtaskSessionVisibility(parentVisibility: AgentSessionVisibility, targetVisibility: AgentSessionVisibility): void {
  if (parentVisibility === "unlisted" && targetVisibility !== "unlisted") {
    throw new HttpError(409, "unlisted parent cannot reuse a listed subtask session", AgentSubtaskErrorCode.SessionVisibilityMismatch);
  }
}
