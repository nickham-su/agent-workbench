import { AgentSubtaskErrorCode } from "@agent-workbench/shared/internal-contracts/agent-api";
import type {
  AgentApiSubtaskPreforkPlanRequest,
  AgentApiSubtaskPreforkPlanResponse,
  AgentApiSubtaskResultRequest,
  AgentApiSubtaskResultResponse,
  AgentApiSubtaskStartRequest,
  AgentApiSubtaskStartResponse,
  AgentApiSubtaskStatusRequest,
  AgentApiSubtaskStatusResponse,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../../app/errors.js";
import type {
  CleanupSubtaskOrphansOnStartupCommand,
  CleanupSubtaskOrphansOnStartupResult,
  SubtaskApplicationDependencies,
  SubtaskApplicationPort,
  SubtaskRunRecord,
} from "./subtask-ports.js";

const SUBTASK_PREFORK_SUMMARY_MAX_CHARS = 20_000;

/**
 * Owns Subtask prefork/start, result/status projection, and orphan startup
 * policy. SQLite activation remains a narrow Lifecycle capability.
 */
export class SubtaskApplication implements SubtaskApplicationPort {
  constructor(private readonly dependencies: SubtaskApplicationDependencies) {}

  getPreforkPlan(
    request: AgentApiSubtaskPreforkPlanRequest,
  ): AgentApiSubtaskPreforkPlanResponse {
    this.dependencies.parentAnchorReader.resolve(request);

    const resolvedAgentId = String(request.agentId || "").trim();
    if (!resolvedAgentId) {
      throw new HttpError(
        400,
        "subtask agentId is required",
        AgentSubtaskErrorCode.AgentRequired,
      );
    }

    const thresholdRaw = request.thresholdPct;
    const thresholdPct =
      thresholdRaw == null
        ? 95
        : Number.isFinite(Number(thresholdRaw))
          ? Math.floor(Number(thresholdRaw))
          : Number.NaN;
    if (
      !Number.isFinite(thresholdPct) ||
      thresholdPct < 50 ||
      thresholdPct > 99
    ) {
      throw new HttpError(
        400,
        "thresholdPct must be between 50 and 99",
        AgentSubtaskErrorCode.PreforkThresholdInvalid,
      );
    }

    const profile = this.dependencies.executionProfileReader.resolve({
      workspaceId: request.workspaceId,
      requestedAgentId: resolvedAgentId,
    });
    const childContextWindowTokens = Math.max(
      1,
      Math.floor(Number(profile.contextWindowTokens || 0)),
    );
    const thresholdTokens = Math.max(
      1,
      Math.floor(childContextWindowTokens * (thresholdPct / 100)),
    );
    const parentState = this.dependencies.parentRunStateReader.get(
      request.workspaceId,
      request.parentSessionId,
    );
    const parentLastResponseTotalTokens =
      typeof parentState.lastResponseTotalTokens === "number"
        ? Math.max(0, Math.floor(parentState.lastResponseTotalTokens))
        : null;

    return {
      shouldPrefork:
        parentLastResponseTotalTokens != null &&
        parentLastResponseTotalTokens >= thresholdTokens,
      thresholdPct,
      parentLastResponseTotalTokens,
      childContextWindowTokens,
      thresholdTokens,
    };
  }

  async startSubtask(
    request: AgentApiSubtaskStartRequest,
  ): Promise<AgentApiSubtaskStartResponse> {
    const { parentRun, parentUiLocale, anchor } =
      this.dependencies.parentAnchorReader.resolve({
        workspaceId: request.workspaceId,
        parentSessionId: request.parentSessionId,
        parentRunId: request.parentRunId,
        parentToolItemId: request.parentToolItemId,
      });

    const description = request.description.trim().slice(0, 50);
    if (!description) {
      throw new HttpError(
        400,
        "subtask description is required",
        AgentSubtaskErrorCode.DescriptionRequired,
      );
    }
    const resolvedAgentId = String(request.agentId || "").trim();
    if (!resolvedAgentId) {
      throw new HttpError(
        400,
        "subtask agentId is required",
        AgentSubtaskErrorCode.AgentRequired,
      );
    }
    if (
      (request.session.mode === "new" || request.session.mode === "fork") &&
      String(request.session.sessionId || "").trim()
    ) {
      throw new HttpError(
        400,
        `sessionId is not allowed when mode=${request.session.mode}`,
        AgentSubtaskErrorCode.SessionIdNotAllowed,
      );
    }

    const hasPreforkSummaryText = Object.prototype.hasOwnProperty.call(
      request,
      "preforkSummaryText",
    );
    const hasPreforkMeta =
      Object.prototype.hasOwnProperty.call(request, "preforkMeta") &&
      request.preforkMeta != null;
    if (
      request.session.mode !== "fork" &&
      (hasPreforkSummaryText || hasPreforkMeta)
    ) {
      throw new HttpError(
        400,
        "preforkSummaryText/preforkMeta is only allowed when session.mode=fork",
        AgentSubtaskErrorCode.PreforkNotAllowed,
      );
    }
    const preforkSummaryText = String(request.preforkSummaryText || "").trim();
    if (preforkSummaryText.length > SUBTASK_PREFORK_SUMMARY_MAX_CHARS) {
      throw new HttpError(
        400,
        `preforkSummaryText must be <= ${SUBTASK_PREFORK_SUMMARY_MAX_CHARS} characters`,
        AgentSubtaskErrorCode.PreforkSummaryTooLong,
      );
    }
    if (hasPreforkMeta && !preforkSummaryText) {
      throw new HttpError(
        400,
        "preforkMeta requires non-empty preforkSummaryText",
        AgentSubtaskErrorCode.PreforkMetaInvalid,
      );
    }
    if (hasPreforkMeta) {
      const meta = request.preforkMeta!;
      const expected = this.getPreforkPlan({
        workspaceId: request.workspaceId,
        parentSessionId: request.parentSessionId,
        parentRunId: request.parentRunId,
        parentToolItemId: request.parentToolItemId,
        agentId: resolvedAgentId,
        thresholdPct: meta.thresholdPct,
      });
      if (
        expected.parentLastResponseTotalTokens == null ||
        expected.parentLastResponseTotalTokens !==
          meta.parentLastResponseTotalTokens ||
        expected.childContextWindowTokens !== meta.childContextWindowTokens
      ) {
        throw new HttpError(
          400,
          "preforkMeta does not match current prefork plan",
          AgentSubtaskErrorCode.PreforkMetaMismatch,
        );
      }
    }

    const existing = this.dependencies.lineagePersistence.findChildByParentTool(
      {
        workspaceId: request.workspaceId,
        parentRunId: parentRun.runId,
        parentToolItemId: anchor.id,
      },
    );
    if (existing) {
      this.ensureExistingSessionMatches(request, existing);
      const workspace = this.dependencies.workspaceReader.get(
        request.workspaceId,
      );
      if (!workspace) throw new HttpError(404, "workspace not found");
      return this.toReusedResponse(existing, workspace.path);
    }

    if (parentRun.subtaskDepth == null) {
      throw new HttpError(
        409,
        "subtask depth cannot be determined for current parent run",
        AgentSubtaskErrorCode.DepthUnknown,
      );
    }
    const childDepth = parentRun.subtaskDepth + 1;
    if (childDepth > this.dependencies.executionProfileReader.getMaxDepth()) {
      throw new HttpError(
        409,
        "subtask depth exceeds configured maximum",
        AgentSubtaskErrorCode.MaxDepthExceeded,
      );
    }

    const forkBoundaryItemId =
      request.session.mode === "fork"
        ? this.dependencies.sessionMaterializer.resolveForkBoundary({
            workspaceId: request.workspaceId,
            sessionId: request.parentSessionId,
            anchor,
          })
        : null;
    const shouldUsePreforkSummary =
      request.session.mode === "fork" && preforkSummaryText.length > 0;
    if (
      request.session.mode !== "new" &&
      request.session.mode !== "fork" &&
      request.session.mode !== "existing"
    ) {
      throw new HttpError(
        400,
        "invalid subtask session mode",
        AgentSubtaskErrorCode.SessionModeInvalid,
      );
    }

    const { session, createdSessionId } =
      await this.dependencies.sessionMaterializer.resolveForStart({
        workspaceId: request.workspaceId,
        parentSessionId: request.parentSessionId,
        parentToolItemId: request.parentToolItemId,
        session: request.session,
        subtaskTitleBase: description,
        forkBoundaryItemId,
        shouldUsePreforkSummary,
      });

    let workspacePath = "";
    try {
      const state = this.dependencies.parentRunStateReader.get(
        session.workspaceId,
        session.id,
      );
      if (state.status !== "idle") {
        throw new HttpError(
          409,
          "subtask session is running",
          AgentSubtaskErrorCode.SessionRunning,
        );
      }
      const profile = this.dependencies.executionProfileReader.resolve({
        workspaceId: request.workspaceId,
        requestedAgentId: resolvedAgentId,
      });
      const workspace = this.dependencies.workspaceReader.get(
        request.workspaceId,
      );
      if (!workspace) throw new HttpError(404, "workspace not found");
      workspacePath = workspace.path;
      const prompt = request.prompt.trim();
      if (!prompt)
        throw new HttpError(
          400,
          "subtask prompt is required",
          AgentSubtaskErrorCode.PromptRequired,
        );

      const runId = this.dependencies.ids.newId("run");
      const seedItems: Array<{
        kind: "system" | "user";
        text: string;
        attachToRun: boolean;
      }> = [];
      if (shouldUsePreforkSummary)
        seedItems.push({
          kind: "system",
          text: preforkSummaryText,
          attachToRun: false,
        });
      if (request.session.mode === "fork") {
        seedItems.push({
          kind: "system",
          text: this.dependencies.forkGuardTextReader.get(parentUiLocale),
          attachToRun: false,
        });
      }
      seedItems.push({ kind: "user", text: prompt, attachToRun: true });

      const activation = this.dependencies.childRunActivator.activate({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        runId,
        parentRunId: parentRun.runId,
        parentToolItemId: anchor.id,
        subtaskDepth: childDepth,
        agentId: profile.agentId,
        providerId: profile.providerId,
        modelId: profile.modelId,
        uiLocale: parentUiLocale,
        createdAt: this.dependencies.clock.nowMs(),
        seedItems: seedItems as Array<
          | { kind: "system"; text: string; attachToRun: false }
          | { kind: "user"; text: string; attachToRun: true }
        >,
      });
      if (activation.kind === "session-running") {
        throw new HttpError(
          409,
          "subtask session is running",
          AgentSubtaskErrorCode.SessionRunning,
        );
      }

      return {
        sessionId: session.id,
        runId,
        workspacePath,
        agentName: profile.agentName,
        reused: false,
      };
    } catch (error) {
      this.compensateNewSession(request.workspaceId, createdSessionId);
      if (
        this.dependencies.lineagePersistence.isParentToolUniqueConflict(error)
      ) {
        const winner =
          this.dependencies.lineagePersistence.findChildByParentTool({
            workspaceId: request.workspaceId,
            parentRunId: parentRun.runId,
            parentToolItemId: anchor.id,
          });
        if (winner) return this.toReusedResponse(winner, workspacePath);
      }
      throw error;
    }
  }

  getResult(request: AgentApiSubtaskResultRequest): AgentApiSubtaskResultResponse {
    this.requireOwnedRun(request);
    const items = this.dependencies.runQuery.listVisibleItemsByRun(request);

    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.kind === "assistant" && item.output.type === "assistant_text" && String(item.output.text || "").trim()) {
        // Failed/cancelled runs may still expose their useful partial output.
        return { resultText: item.output.text || "" };
      }
    }
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.kind === "system" && item.output.type === "system_text" && String(item.output.text || "").trim()) {
        return { resultText: item.output.text || "" };
      }
    }
    return { resultText: "" };
  }

  getStatus(request: AgentApiSubtaskStatusRequest): AgentApiSubtaskStatusResponse {
    return { status: this.requireOwnedRun(request).status };
  }

  cleanupOrphansOnStartup(
    command: CleanupSubtaskOrphansOnStartupCommand = {},
  ): CleanupSubtaskOrphansOnStartupResult {
    const now = command.now ?? this.dependencies.clock.nowMs();
    const suspectBefore = now - 60 * 60 * 1000;
    const deleteBefore = now - 24 * 60 * 60 * 1000;
    const result: CleanupSubtaskOrphansOnStartupResult = {
      scanned: 0,
      retained: 0,
      deleted: 0,
      skippedAfterRecheck: 0,
      failed: 0,
    };
    const candidates = this.dependencies.orphanPersistence.listSuspects({
      olderThan: suspectBefore,
    });
    result.scanned = candidates.length;

    for (const candidate of candidates) {
      try {
        const eligibleForDeletion =
          candidate.createdAt < deleteBefore
          && candidate.forkedFromSessionId != null
          && candidate.forkedFromItemId != null;
        if (!eligibleForDeletion) {
          result.retained += 1;
          this.dependencies.logger.warn(
            { workspaceId: candidate.workspaceId, sessionId: candidate.sessionId },
            "subtask orphan suspect retained",
          );
          continue;
        }
        const deleted = this.dependencies.orphanPersistence.deleteSuspectIfStillEligible({
          workspaceId: candidate.workspaceId,
          sessionId: candidate.sessionId,
          olderThan: deleteBefore,
        });
        if (deleted) result.deleted += 1;
        else result.skippedAfterRecheck += 1;
        this.dependencies.logger.warn(
          { workspaceId: candidate.workspaceId, sessionId: candidate.sessionId, deleted },
          deleted ? "subtask orphan deleted" : "subtask orphan cleanup skipped after recheck",
        );
      } catch (err) {
        result.failed += 1;
        this.dependencies.logger.warn(
          { err, workspaceId: candidate.workspaceId, sessionId: candidate.sessionId },
          "subtask orphan scan failed for session",
        );
      }
    }
    return result;
  }

  private requireOwnedRun(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }): SubtaskRunRecord {
    const session = this.dependencies.runQuery.findSession(input.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== input.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    const run = this.dependencies.runQuery.findRunInSession(input);
    if (!run) throw new HttpError(404, "run not found");
    return run;
  }

  private ensureExistingSessionMatches(
    request: AgentApiSubtaskStartRequest,
    existing: SubtaskRunRecord,
  ) {
    if (
      request.session.mode === "existing" &&
      existing.sessionId !== String(request.session.sessionId || "").trim()
    ) {
      throw new HttpError(
        409,
        "existing subtask session does not match the previously created child run",
        AgentSubtaskErrorCode.ExistingSessionMismatch,
      );
    }
  }

  private toReusedResponse(
    existing: SubtaskRunRecord,
    workspacePath: string,
  ): AgentApiSubtaskStartResponse {
    return {
      sessionId: existing.sessionId,
      runId: existing.runId,
      workspacePath,
      agentName:
        this.dependencies.executionProfileReader.findAgentName(
          existing.agentId,
        ) || existing.agentId,
      reused: true,
    };
  }

  private compensateNewSession(
    workspaceId: string,
    createdSessionId: string | null,
  ) {
    if (!createdSessionId) return;
    try {
      this.dependencies.localCompensationPersistence.deleteNewSessionIfStillEmpty(
        { workspaceId, sessionId: createdSessionId },
      );
    } catch (error) {
      this.dependencies.logger.warn(
        { error, workspaceId, sessionId: createdSessionId },
        "subtask local compensation failed",
      );
    }
  }
}
