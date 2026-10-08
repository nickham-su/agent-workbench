import { Type, type Static } from "@sinclair/typebox";

export const AGENT_SESSION_QUERY_MAX_SECONDS = 90 * 24 * 60 * 60;
export const AGENT_SESSION_QUERY_ERROR_CODES = {
  invalid: "AGENT_SESSION_QUERY_INVALID",
  stateInvalid: "AGENT_SESSION_QUERY_STATE_INVALID"
} as const;

const WorkspaceIdSchema = Type.String({ minLength: 1, pattern: "\\S" });
const UpdatedWithinSecondsSchema = Type.Integer({
  minimum: 1,
  maximum: AGENT_SESSION_QUERY_MAX_SECONDS
});
const SessionKindSchema = Type.Union([Type.Literal("primary"), Type.Literal("subtask")]);
const SessionStatusSchema = Type.Union([Type.Literal("idle"), Type.Literal("running")]);
export const AgentSessionQueryKindSchema = Type.Union([SessionKindSchema, Type.Literal("all")]);
export const AgentSessionQueryStatusSchema = Type.Union([SessionStatusSchema, Type.Literal("all")]);
export type AgentSessionQueryKind = Static<typeof AgentSessionQueryKindSchema>;
export type AgentSessionQueryStatus = Static<typeof AgentSessionQueryStatusSchema>;

/** Normalized numeric contract. HTTP raw spelling/duplicates are checked before coercion. */
export const AgentSessionQueryRequestSchema = Type.Object({
  workspaceId: WorkspaceIdSchema,
  updatedWithinSeconds: UpdatedWithinSecondsSchema,
  kind: Type.Optional(Type.Union(AgentSessionQueryKindSchema.anyOf, { default: "all" })),
  status: Type.Optional(Type.Union(AgentSessionQueryStatusSchema.anyOf, { default: "all" }))
}, { additionalProperties: false });
export type AgentSessionQueryRequest = Static<typeof AgentSessionQueryRequestSchema>;

// Date's millisecond range is narrower than Number.MAX_SAFE_INTEGER.
const TimestampSchema = Type.Integer({ minimum: -8_640_000_000_000_000, maximum: 8_640_000_000_000_000 });
const CountSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const AgentSessionQueryItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  title: Type.String(),
  kind: SessionKindSchema,
  status: SessionStatusSchema,
  updatedAt: TimestampSchema,
  /** All retained native completed user rows, not restricted to the update window. */
  userMessageCount: CountSchema,
  /** All retained native completed assistant rows; inherited fork history is excluded. */
  completedAssistantMessageCount: CountSchema
}, { additionalProperties: false });
export type AgentSessionQueryItem = Static<typeof AgentSessionQueryItemSchema>;

/** Structural DTO schema; request echo, window width, total and uniqueness need cross-field checks. */
export const AgentSessionQueryResponseSchema = Type.Object({
  workspaceId: WorkspaceIdSchema,
  updatedWithinSeconds: UpdatedWithinSecondsSchema,
  updatedFrom: TimestampSchema,
  updatedTo: TimestampSchema,
  kind: AgentSessionQueryKindSchema,
  status: AgentSessionQueryStatusSchema,
  total: CountSchema,
  items: Type.Array(AgentSessionQueryItemSchema)
}, { additionalProperties: false });
export type AgentSessionQueryResponse = Static<typeof AgentSessionQueryResponseSchema>;
