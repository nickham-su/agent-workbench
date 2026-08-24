import { captureLosslessSnapshot, type LosslessSnapshot } from "./losslessValueGraph.js";
import {
  storeToolErrorArtifact,
  type FailureKind,
  type ToolErrorArtifact,
  type ToolErrorArtifactIdentity,
  type ToolErrorStoreResult
} from "./toolErrorStore.js";

export function isToolErrorStoreEnabled(env: Record<string, string | undefined> = process.env) {
  return env.AWB_TOOL_ERROR_STORE_ENABLED === "1";
}

const TOOL_ERROR_STORE_ENABLED = isToolErrorStoreEnabled();

export type ToolErrorStage =
  | "provider_execute_rejected"
  | "provider_partial_result"
  | "tool_disabled_pending_precheck"
  | "tool_disabled_execute_check"
  | "running_item_recovered_as_failed"
  | "running_writeback_failed"
  | "completed_output_build_failed"
  | "completed_writeback_failed"
  | "failed_writeback_failed"
  | "runner_outer_unhandled"
  | "outer_failed_writeback_failed";

const FAILURE_KIND_BY_STAGE: Record<ToolErrorStage, FailureKind> = {
  provider_execute_rejected: "tool",
  provider_partial_result: "tool",
  tool_disabled_pending_precheck: "policy",
  tool_disabled_execute_check: "policy",
  running_item_recovered_as_failed: "recovery",
  running_writeback_failed: "runtime",
  completed_output_build_failed: "runtime",
  completed_writeback_failed: "runtime",
  failed_writeback_failed: "runtime",
  runner_outer_unhandled: "runtime",
  outer_failed_writeback_failed: "runtime"
};

export type ToolErrorCaptureIdentity = ToolErrorArtifactIdentity & {
  workspacePath: string;
  toolName: string;
  toolSource: "builtin" | "mcp" | "plugin" | "unknown";
};

type CapturedEvent = {
  stage: ToolErrorStage;
  occurredAt: number;
  errorId?: string;
  detail?: LosslessSnapshot;
};

type CapturedWriteback = {
  role: string;
  attemptedAt: number;
  output: LosslessSnapshot;
  outcome: "pending" | "succeeded" | "failed";
  response?: LosslessSnapshot;
  errorId?: string;
};

type CapturedError = {
  id: string;
  capturedAt: number;
  value: LosslessSnapshot;
};

export type ToolFailureCapture = {
  recordProviderStarted(): void;
  recordProviderResult(result: unknown): void;
  recordPartialResult(source: string, result: unknown): void;
  recordWritebackAttempt(role: string, output: unknown): void;
  recordWritebackSuccess(role: string, response: unknown): void;
  recordWritebackFailure(role: string, error: unknown): void;
  recordEvent(stage: ToolErrorStage, error?: unknown, detail?: unknown): void;
  discard(): void;
  hasEvents(): boolean;
  publish(): Promise<ToolErrorStoreResult[]>;
};

function sourceForTool(toolName: string): ToolErrorCaptureIdentity["toolSource"] {
  if (toolName.startsWith("mcp_")) return "mcp";
  if (toolName.startsWith("plugin_")) return "plugin";
  return "builtin";
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function getToolErrorStoreEnabledForTest() {
  return TOOL_ERROR_STORE_ENABLED;
}

export function extractPartialToolResults(error: unknown, toolName: string) {
  const results: Array<{ source: string; value: unknown }> = [];
  for (const key of ["partialResult", "partialResults", "result"]) {
    const value = ownDataProperty(error, key);
    if (value !== undefined) results.push({ source: key, value });
  }
  if (toolName === "subtask") {
    const sessionId = ownDataProperty(error, "subtaskSessionId");
    const resultText = ownDataProperty(error, "subtaskResultText");
    if (sessionId !== undefined || resultText !== undefined) {
      results.push({ source: "subtask", value: { ...(sessionId !== undefined ? { subtaskSessionId: sessionId } : {}), ...(resultText !== undefined ? { resultText } : {}) } });
    }
  }
  return results;
}

export function createToolFailureCaptureIfEnabled(identity: ToolErrorCaptureIdentity, args: unknown, now = Date.now): ToolFailureCapture | null {
  if (!TOOL_ERROR_STORE_ENABLED) return null;

  const createdAt = now();
  const baseIdentity: ToolErrorArtifactIdentity = {
    workspaceId: identity.workspaceId,
    sessionId: identity.sessionId,
    runId: identity.runId,
    itemId: identity.itemId,
    toolCallId: identity.toolCallId
  };
  const eventsByKind = new Map<FailureKind, CapturedEvent[]>();
  const writebacks: CapturedWriteback[] = [];
  const errors: CapturedError[] = [];
  const argsSnapshot = captureLosslessSnapshot(args, createdAt);
  const errorIds = new Map<unknown, string>();
  let nextErrorId = 1;
  let providerResult: LosslessSnapshot | undefined;
  let providerStarted = false;
  let discarded = false;
  let partialResults: Array<{ source: string; value: LosslessSnapshot }> = [];

  const captureError = (value: unknown) => {
    const existing = value && (typeof value === "object" || typeof value === "function") ? errorIds.get(value) : undefined;
    if (existing) return existing;
    const id = `error-${nextErrorId++}`;
    if (value && (typeof value === "object" || typeof value === "function")) errorIds.set(value, id);
    errors.push({ id, capturedAt: now(), value: captureLosslessSnapshot(value, now()) });
    return id;
  };
  const event = (stage: ToolErrorStage, error?: unknown, detail?: unknown) => {
    const kind = FAILURE_KIND_BY_STAGE[stage];
    const list = eventsByKind.get(kind) ?? [];
    const errorId = error === undefined ? undefined : captureError(error);
    list.push({ stage, occurredAt: now(), ...(errorId ? { errorId } : {}), ...(detail === undefined ? {} : { detail: captureLosslessSnapshot(detail, now()) }) });
    eventsByKind.set(kind, list);
  };
  const pendingWriteback = (role: string) => [...writebacks].reverse().find((item) => item.role === role && item.outcome === "pending");

  return {
    recordProviderStarted() {
      providerStarted = true;
    },
    recordProviderResult(result) {
      providerResult = captureLosslessSnapshot(result, now());
    },
    recordPartialResult(source, result) {
      partialResults.push({ source, value: captureLosslessSnapshot(result, now()) });
      event("provider_partial_result", undefined, { source });
    },
    recordWritebackAttempt(role, output) {
      writebacks.push({ role, attemptedAt: now(), output: captureLosslessSnapshot(output, now()), outcome: "pending" });
    },
    recordWritebackSuccess(role, response) {
      const item = pendingWriteback(role);
      if (!item) return;
      item.outcome = "succeeded";
      item.response = captureLosslessSnapshot(response, now());
    },
    recordWritebackFailure(role, error) {
      const item = pendingWriteback(role);
      if (!item) return;
      item.outcome = "failed";
      item.errorId = captureError(error);
    },
    recordEvent: event,
    discard() {
      discarded = true;
    },
    hasEvents() {
      return !discarded && eventsByKind.size > 0;
    },
    async publish() {
      if (discarded) return [];
      const results: ToolErrorStoreResult[] = [];
      for (const [failureKind, events] of eventsByKind) {
        const artifact: ToolErrorArtifact = {
          schemaVersion: 1,
          kind: "tool_error",
          captureId: `${identity.runId}:${identity.itemId}:${createdAt}:${failureKind}`,
          recordedAt: createdAt,
          failureKind,
          identity: baseIdentity,
          tool: {
            name: identity.toolName,
            source: identity.toolSource ?? sourceForTool(identity.toolName),
            toolCallId: identity.toolCallId,
            args: argsSnapshot
          },
          execution: {
            providerStarted,
            providerReturned: Boolean(providerResult),
            resultAvailability: providerResult ? "returned" : partialResults.length > 0 ? "partial_from_error" : providerStarted ? "not_returned" : "not_started",
            ...(providerResult ? { result: providerResult } : {}),
            ...(partialResults.length > 0 ? { partialResults } : {})
          },
          writebacks,
          errors,
          events,
          publication: { source: "agent-worker" }
        };
        results.push(await storeToolErrorArtifact({ workspacePath: identity.workspacePath, artifact }));
      }
      return results;
    }
  };
}
