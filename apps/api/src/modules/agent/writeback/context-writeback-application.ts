import type {
  AgentApiCreateContextItemRequest,
  AgentApiUpdateContextItemRequest,
  AgentApiCreateContextItemResponse
} from "@agent-workbench/shared/internal-contracts/agent-api";
import type { AgentContextItemOutput, AgentContextItemRecord, AgentContextItemKind, AgentContextItemStatus } from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import type { UiArtifactCapabilityPort } from "../artifact/ui-artifact-capability.js";
import { splitApplyPatchResult, splitWriteResult } from "./ui-artifact-result-split.js";

/**
 * P3 owns append orchestration. P4 replaces the remaining update delegate.
 * This application deliberately does not receive AgentService or AppContext.
 */
export type ContextWritebackApplicationDependencies = {
  appendWithRunFence: (params: Omit<AgentApiCreateContextItemRequest, "createdAt"> & { createdAt: number }) =>
    | { kind: "appended"; item: AgentContextItemRecord }
    | { kind: "ignored" }
    | { kind: "missing-session" }
    | { kind: "workspace-mismatch" }
    | { kind: "missing-run" }
    | { kind: "run-mismatch" };
  nowMs: () => number;
  formatTodolistTitle: (value: unknown) => string;
  updateSessionTitle: (params: { sessionId: string; title: string; updatedAt: number }) => void;
  isAppendConflict: (error: unknown) => error is { currentHeadItemId: number | null };
  warnAppendConflict: (params: { sessionId: string; kind: AgentContextItemKind; currentHeadItemId: number | null }) => void;
  inspectForWorkerUpdate: (itemId: number) =>
    | { kind: "updated"; item: AgentContextItemRecord }
    | { kind: "unchanged"; item: AgentContextItemRecord }
    | { kind: "missing" }
    | { kind: "ownership-mismatch" };
  uiArtifacts: UiArtifactCapabilityPort;
  logArtifactError: (params: { itemId: number; message: string; filePath?: string; err?: unknown }) => void;
  logArtifactWarning: (params: { itemId: number; message: string; hasToolCallId: boolean; hasWorkspaceId: boolean }) => void;
  updateWithRunFence: (params: {
    itemId: number;
    status?: AgentContextItemStatus;
    output?: AgentContextItemOutput;
    updatedAt: number;
  }) =>
    | { kind: "updated"; item: AgentContextItemRecord }
    | { kind: "unchanged"; item: AgentContextItemRecord }
    | { kind: "missing" }
    | { kind: "ownership-mismatch" };
};

/**
 * Create/append rules are authoritative here from P3; P4 makes update
 * orchestration authoritative here too. P5 keeps artifact timing here while
 * delegating only fixed apply_patch/write artifact I/O to a narrow capability.
 */
export class ContextWritebackApplication {
  constructor(private readonly dependencies: ContextWritebackApplicationDependencies) {}

  appendContextItemFromWorker(params: AgentApiCreateContextItemRequest): AgentApiCreateContextItemResponse {
    if (
      params.kind === "tool"
      && params.status === "completed"
      && params.output.type === "tool"
      && params.output.toolName === "apply_patch"
      && Object.prototype.hasOwnProperty.call(params.output, "result")
    ) {
      throw new HttpError(400, "apply_patch completed tool item must be updated, not appended");
    }

    const createdAt = params.createdAt ?? this.dependencies.nowMs();
    try {
      const append = this.dependencies.appendWithRunFence({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        runId: params.runId,
        turnId: params.turnId,
        step: params.step,
        prevId: params.prevId,
        kind: params.kind,
        status: params.status,
        output: params.output,
        createdAt
      });
      if (append.kind === "ignored") return { ok: true, item: null, ignored: true };
      if (append.kind === "missing-session" || append.kind === "missing-run") {
        throw new HttpError(404, append.kind === "missing-run" ? "run not found" : "session not found");
      }
      if (append.kind === "workspace-mismatch" || append.kind === "run-mismatch") {
        throw new HttpError(400, "workspaceId mismatch");
      }

      const item = append.item;
      if (item.kind === "tool" && item.status === "completed" && item.output.type === "tool" && item.output.toolName === "todolist") {
        const result = item.output.result && typeof item.output.result === "object"
          ? item.output.result as Record<string, unknown>
          : null;
        const title = this.dependencies.formatTodolistTitle(result?.goal);
        if (title) this.dependencies.updateSessionTitle({ sessionId: item.sessionId, title, updatedAt: createdAt });
      }
      return { ok: true, item };
    } catch (error) {
      const conflict = this.dependencies.isAppendConflict(error) ? error : null;
      if (conflict) {
        this.dependencies.warnAppendConflict({
          sessionId: params.sessionId,
          kind: params.kind,
          currentHeadItemId: conflict.currentHeadItemId
        });
        throw new HttpError(409, "session head conflict", `conflict_head:${String(conflict.currentHeadItemId ?? "null")}`);
      }
      throw error;
    }
  }

  async updateContextItemFromWorker(params: AgentApiUpdateContextItemRequest & { itemId: number }) {
    const initialFence = this.dependencies.inspectForWorkerUpdate(params.itemId);
    if (initialFence.kind === "missing") throw new HttpError(404, "context item not found");
    if (initialFence.kind === "ownership-mismatch") throw new HttpError(404, "context item ownership mismatch");
    if (initialFence.kind === "unchanged") return initialFence.item;

    const current = initialFence.item;
    const nextStatus = params.status ?? current.status;
    const nextOutput = await this.prepareUpdateArtifacts({ itemId: params.itemId, current, nextStatus, nextOutput: params.output, artifactUpdatedAt: params.updatedAt });
    const updatedAt = params.updatedAt ?? this.dependencies.nowMs();
    const update = this.dependencies.updateWithRunFence({
      itemId: params.itemId,
      status: params.status,
      output: nextOutput,
      updatedAt
    });
    if (update.kind === "missing") throw new HttpError(404, "context item not found");
    if (update.kind === "ownership-mismatch") throw new HttpError(404, "context item ownership mismatch");
    if (update.kind === "unchanged") return update.item;

    const item = update.item;
    if (item.kind === "tool" && item.status === "completed" && item.output.type === "tool" && item.output.toolName === "todolist") {
      const result = item.output.result && typeof item.output.result === "object"
        ? item.output.result as Record<string, unknown>
        : null;
      const title = this.dependencies.formatTodolistTitle(result?.goal);
      if (title) this.dependencies.updateSessionTitle({ sessionId: item.sessionId, title, updatedAt });
    }
    return item;
  }

  private async prepareUpdateArtifacts(params: {
    itemId: number;
    current: AgentContextItemRecord;
    nextStatus: AgentContextItemStatus;
    nextOutput: AgentContextItemOutput | undefined;
    artifactUpdatedAt?: number;
  }) {
    const { current, nextStatus } = params;
    let nextOutput = params.nextOutput;

    if (
      nextStatus === "completed" &&
      nextOutput?.type === "tool" &&
      nextOutput.toolName === "apply_patch" &&
      Object.prototype.hasOwnProperty.call(nextOutput, "result")
    ) {
      const toolCallId = typeof nextOutput.toolCallId === "string" ? nextOutput.toolCallId.trim() : "";
      const workspaceId = current.workspaceId;
      const { slim, artifact } = splitApplyPatchResult(nextOutput.result);
      if (toolCallId && workspaceId) {
        try {
          const written = await this.dependencies.uiArtifacts.writeApplyPatch({
            workspaceId,
            toolCallId,
            createdAt: params.artifactUpdatedAt ?? this.dependencies.nowMs(),
            artifact
          });
          if (written.kind === "outside-tmp-root") {
            this.dependencies.logArtifactError({ itemId: params.itemId, filePath: written.filePath, message: "apply_patch ui artifact path is outside tmpRoot" });
          }
        } catch (err) {
          this.dependencies.logArtifactError({ itemId: params.itemId, err, message: "failed to write apply_patch ui artifact" });
        }
      } else {
        this.dependencies.logArtifactWarning({
          itemId: params.itemId,
          hasToolCallId: !!toolCallId,
          hasWorkspaceId: !!workspaceId,
          message: "apply_patch completed but missing toolCallId/workspaceId; ui artifact skipped"
        });
      }
      nextOutput = { ...nextOutput, result: slim };
    }

    const isWriteTerminalStatus = nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled";
    if (nextOutput?.type === "tool" && nextOutput.toolName === "write" && isWriteTerminalStatus && nextStatus === "completed") {
      const toolCallId = typeof nextOutput.toolCallId === "string" ? nextOutput.toolCallId.trim() : "";
      const workspaceId = current.workspaceId;
      const { slim, artifact } = splitWriteResult(nextOutput.result);
      if (toolCallId && workspaceId) {
        try {
          const written = await this.dependencies.uiArtifacts.writeWrite({
            workspaceId,
            toolCallId,
            createdAt: params.artifactUpdatedAt ?? this.dependencies.nowMs(),
            artifact
          });
          if (written.kind === "outside-tmp-root") {
            this.dependencies.logArtifactError({ itemId: params.itemId, filePath: written.filePath, message: "write ui artifact path is outside tmpRoot" });
          }
        } catch (err) {
          this.dependencies.logArtifactError({ itemId: params.itemId, err, message: "failed to write write ui artifact" });
        }
      } else {
        this.dependencies.logArtifactWarning({
          itemId: params.itemId,
          hasToolCallId: !!toolCallId,
          hasWorkspaceId: !!workspaceId,
          message: "write completed but missing toolCallId/workspaceId; ui artifact skipped"
        });
      }
      nextOutput = { ...nextOutput, result: slim };
    }

    return nextOutput;
  }
}
