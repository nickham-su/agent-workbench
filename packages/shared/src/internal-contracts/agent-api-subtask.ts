import { Type, type Static } from "@sinclair/typebox";

export const AgentApiSubtaskSessionSchema = Type.Union([
  Type.Object({
    mode: Type.Literal("new"),
    sessionId: Type.Optional(Type.String({ minLength: 1 }))
  }),
  Type.Object({
    mode: Type.Literal("existing"),
    sessionId: Type.String({ minLength: 1 })
  }),
  Type.Object({
    mode: Type.Literal("fork"),
    sessionId: Type.Optional(Type.String({ minLength: 1 })),
    sourceSessionId: Type.Optional(Type.String({ minLength: 1 }))
  })
]);
export type AgentApiSubtaskSession = Static<typeof AgentApiSubtaskSessionSchema>;

export const AgentApiSubtaskPreforkMetaSchema = Type.Object(
  {
    thresholdPct: Type.Integer({ minimum: 50, maximum: 99 }),
    parentLastResponseTotalTokens: Type.Number({ minimum: 0 }),
    childContextWindowTokens: Type.Integer({ minimum: 1 })
  },
  { additionalProperties: false }
);

export const AgentApiSubtaskPreforkPlanRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  parentSessionId: Type.String({ minLength: 1 }),
  parentRunId: Type.String({ minLength: 1 }),
  parentToolExecutionId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  thresholdPct: Type.Optional(Type.Number())
});
export type AgentApiSubtaskPreforkPlanRequest = Static<typeof AgentApiSubtaskPreforkPlanRequestSchema>;

export const AgentApiSubtaskPreforkPlanResponseSchema = Type.Object({
  shouldPrefork: Type.Boolean(),
  thresholdPct: Type.Integer({ minimum: 50, maximum: 99 }),
  parentLastResponseTotalTokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  childContextWindowTokens: Type.Integer({ minimum: 1 }),
  thresholdTokens: Type.Integer({ minimum: 1 })
});
export type AgentApiSubtaskPreforkPlanResponse = Static<typeof AgentApiSubtaskPreforkPlanResponseSchema>;

export const AgentApiSubtaskStartRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  parentSessionId: Type.String({ minLength: 1 }),
  parentRunId: Type.String({ minLength: 1 }),
  parentToolExecutionId: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  session: AgentApiSubtaskSessionSchema,
  preforkSummaryText: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
  preforkMeta: Type.Optional(AgentApiSubtaskPreforkMetaSchema)
});
export type AgentApiSubtaskStartRequest = Static<typeof AgentApiSubtaskStartRequestSchema>;

export const AgentApiSubtaskStartResponseSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  workspacePath: Type.String({ minLength: 1 }),
  agentName: Type.String({ minLength: 1 }),
  reused: Type.Boolean(),
  sourceSessionId: Type.Optional(Type.String({ minLength: 1 }))
});
export type AgentApiSubtaskStartResponse = Static<typeof AgentApiSubtaskStartResponseSchema>;

export const AgentApiSubtaskResultRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 })
});
export type AgentApiSubtaskResultRequest = Static<typeof AgentApiSubtaskResultRequestSchema>;

export const AgentApiSubtaskResultResponseSchema = Type.Object({
  resultText: Type.String()
});
export type AgentApiSubtaskResultResponse = Static<typeof AgentApiSubtaskResultResponseSchema>;

export const AgentApiSubtaskStatusRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 })
});
export type AgentApiSubtaskStatusRequest = Static<typeof AgentApiSubtaskStatusRequestSchema>;

export const AgentApiSubtaskStatusResponseSchema = Type.Object({
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled")
  ])
});
export type AgentApiSubtaskStatusResponse = Static<typeof AgentApiSubtaskStatusResponseSchema>;

export const AgentSubtaskErrorCode = {
  AnchorRunMismatch: "AGENT_SUBTASK_ANCHOR_RUN_MISMATCH",
  AnchorInvalid: "AGENT_SUBTASK_ANCHOR_INVALID",
  AgentRequired: "AGENT_SUBTASK_AGENT_REQUIRED",
  DisabledInWorkspace: "AGENT_DISABLED_IN_WORKSPACE",
  PreforkThresholdInvalid: "AGENT_SUBTASK_PREFORK_THRESHOLD_INVALID",
  DescriptionRequired: "AGENT_SUBTASK_DESCRIPTION_REQUIRED",
  PreforkNotAllowed: "AGENT_SUBTASK_PREFORK_NOT_ALLOWED",
  PreforkSummaryTooLong: "AGENT_SUBTASK_PREFORK_SUMMARY_TOO_LONG",
  PreforkMetaInvalid: "AGENT_SUBTASK_PREFORK_META_INVALID",
  PreforkMetaMismatch: "AGENT_SUBTASK_PREFORK_META_MISMATCH",
  ExistingSessionMismatch: "AGENT_SUBTASK_EXISTING_SESSION_MISMATCH",
  DepthUnknown: "AGENT_SUBTASK_DEPTH_UNKNOWN",
  MaxDepthExceeded: "AGENT_SUBTASK_MAX_DEPTH_EXCEEDED",
  ExistingSessionRequired: "AGENT_SUBTASK_EXISTING_SESSION_REQUIRED",
  SessionNotFound: "AGENT_SUBTASK_SESSION_NOT_FOUND",
  WorkspaceMismatch: "AGENT_SUBTASK_WORKSPACE_MISMATCH",
  KindMismatch: "AGENT_SUBTASK_KIND_MISMATCH",
  SessionIdNotAllowed: "AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED",
  SessionModeInvalid: "AGENT_SUBTASK_SESSION_MODE_INVALID",
  SessionRunning: "AGENT_SUBTASK_SESSION_RUNNING",
  SourceSessionNotAllowed: "AGENT_SUBTASK_SOURCE_SESSION_NOT_ALLOWED",
  SourceSessionInvalid: "AGENT_SUBTASK_SOURCE_SESSION_INVALID",
  ForkSourceUnavailable: "AGENT_SUBTASK_FORK_SOURCE_UNAVAILABLE",
  ForkSourceNoStableContext: "AGENT_SUBTASK_FORK_SOURCE_NO_STABLE_CONTEXT",
  ForkSourceContextInvalid: "AGENT_SUBTASK_FORK_SOURCE_CONTEXT_INVALID",
  ForkSourceMismatch: "AGENT_SUBTASK_FORK_SOURCE_MISMATCH",
  ParentNotActive: "AGENT_SUBTASK_PARENT_NOT_ACTIVE",
  PromptRequired: "AGENT_SUBTASK_PROMPT_REQUIRED",
  ForkBoundaryInvalid: "AGENT_SUBTASK_FORK_BOUNDARY_INVALID"
} as const;
export type AgentSubtaskErrorCode = (typeof AgentSubtaskErrorCode)[keyof typeof AgentSubtaskErrorCode];

type AgentSubtaskSourceValidationCode =
  | typeof AgentSubtaskErrorCode.SessionModeInvalid
  | typeof AgentSubtaskErrorCode.SourceSessionNotAllowed
  | typeof AgentSubtaskErrorCode.SourceSessionInvalid
  | typeof AgentSubtaskErrorCode.PreforkNotAllowed;

export type AgentSubtaskSourceValidationResult =
  | { ok: true; sourceSessionId?: string }
  | { ok: false; code: AgentSubtaskSourceValidationCode; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Detect presence before schema coercion/removal, including null or undefined values. */
export function hasAgentSubtaskSource(input: unknown): boolean {
  return isRecord(input) && isRecord(input.session) && Object.hasOwn(input.session, "sourceSessionId");
}

/**
 * Validate only the new source semantics. Callers still own authentication and
 * legacy request validation; requests without a source are intentionally untouched.
 */
export function normalizeAgentSubtaskSource(input: unknown): AgentSubtaskSourceValidationResult {
  if (!isRecord(input) || !isRecord(input.session) || !Object.hasOwn(input.session, "sourceSessionId")) {
    return { ok: true };
  }
  const session = input.session;
  if (session.mode !== "new" && session.mode !== "existing" && session.mode !== "fork") {
    return {
      ok: false,
      code: AgentSubtaskErrorCode.SessionModeInvalid,
      message: "subtask session mode is invalid"
    };
  }
  if (session.mode !== "fork") {
    return {
      ok: false,
      code: AgentSubtaskErrorCode.SourceSessionNotAllowed,
      message: "sourceSessionId is only allowed for fork mode"
    };
  }
  if (typeof session.sourceSessionId !== "string" || !session.sourceSessionId.trim()) {
    return {
      ok: false,
      code: AgentSubtaskErrorCode.SourceSessionInvalid,
      message: "sourceSessionId must be a non-empty string"
    };
  }
  if (Object.hasOwn(input, "preforkSummaryText") || Object.hasOwn(input, "preforkMeta")) {
    return {
      ok: false,
      code: AgentSubtaskErrorCode.PreforkNotAllowed,
      message: "prefork fields are not allowed with an explicit sourceSessionId"
    };
  }
  return { ok: true, sourceSessionId: session.sourceSessionId.trim() };
}
