import { HttpError } from "../../../app/errors.js";
import type { AgentCompactSessionResponse } from "@agent-workbench/shared";
import type { ManualCompactionApplicationDependencies, ScheduleManualCompactionCommand } from "./manual-compaction-ports.js";

/** Owns manual-compaction validation; Lifecycle owns all activated-Run handoff outcomes. */
export class ManualCompactionApplication {
  constructor(private readonly dependencies: ManualCompactionApplicationDependencies) {}

  async schedule(command: ScheduleManualCompactionCommand): Promise<AgentCompactSessionResponse> {
    const workspaceId = command.body.workspaceId;
    const session = this.dependencies.sessions.get(command.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.kind === "subtask") throw new HttpError(400, "subtask session is read-only", "AGENT_SUBTASK_READONLY");
    if (session.workspaceId !== workspaceId) throw new HttpError(400, "workspaceId mismatch");
    if (!this.dependencies.isWorkerEnabled()) throw new HttpError(503, "agent worker unavailable", "AGENT_WORKER_UNAVAILABLE");

    const clientRequestId = String(command.body.clientRequestId || "").trim();
    if (!clientRequestId) throw new HttpError(400, "clientRequestId is required");
    const dedup = this.dependencies.findDedup({ workspaceId, sessionId: session.id, clientRequestId });
    if (dedup) {
      return { ok: true, session, runState: this.dependencies.getControlRunState(session.id), runId: dedup.runId, scheduled: false, skippedReason: "deduplicated" };
    }
    if (this.dependencies.getRunState(workspaceId, session.id).status !== "idle") throw new HttpError(409, "session is running");
    const triggerMessageId = session.headMessageId;
    if (triggerMessageId == null) throw new HttpError(400, "no context to compact", "AGENT_COMPACTION_EMPTY");

    const profile = this.dependencies.resolveProfile({ workspaceId, sessionId: session.id, requestedAgentId: command.body.agentId });
    const createdAt = this.dependencies.clock.nowMs();
    const runId = this.dependencies.ids.newRunId();
    const uiLocale = command.body.uiLocale === "zh-CN" || command.body.uiLocale === "en-US" ? command.body.uiLocale : null;
    const runContext = this.dependencies.getWorkspaceRunContext(workspaceId);
    if (!runContext) throw new HttpError(404, "workspace not found");

    this.dependencies.activate({ workspaceId, sessionId: session.id, triggerMessageId, clientRequestId, runId, profile, uiLocale, createdAt });
    await this.dependencies.enqueueActivatedRunOrReconcile({
      runtime: command.runtime,
      run: { workspaceId, sessionId: session.id, runId, runKind: "manual_compaction", ...runContext },
    });
    return { ok: true, session, runState: this.dependencies.getControlRunState(session.id), runId, scheduled: true };
  }
}
