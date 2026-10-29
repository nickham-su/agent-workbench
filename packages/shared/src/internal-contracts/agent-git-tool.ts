import { Type, type Static } from "@sinclair/typebox";

/** Registered directory names only; never normalize a name into another target. */
export const GitRepoNameSchema = Type.String({
  minLength: 1,
  pattern: "^(?!\\.\\.?$)[^\\s/\\\\\\u0000-\\u001f\\u007f](?:[^/\\\\\\u0000-\\u001f\\u007f]*[^\\s/\\\\\\u0000-\\u001f\\u007f])?$",
});

/** The builder and Worker share the same fixed SSH transport spelling. */
export function formatRepoGitSshCommand(keyPath: string, knownHostsPath: string) {
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  return ["ssh", "-i", quote(keyPath), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
    "-o", quote(`UserKnownHostsFile=${knownHostsPath}`), "-o", "StrictHostKeyChecking=accept-new"].join(" ");
}

export const GIT_TOOL_DEFAULT_TIMEOUT_SECONDS = 120;
export const GIT_TOOL_MAX_TIMEOUT_SECONDS = 3600;

export const GitToolInputSchema = Type.Object({
  repo: GitRepoNameSchema,
  args: Type.Array(Type.String({ pattern: "^[^\\u0000]*$" }), { minItems: 1 }),
  timeout: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: GIT_TOOL_MAX_TIMEOUT_SECONDS,
    default: GIT_TOOL_DEFAULT_TIMEOUT_SECONDS,
    description: "Timeout in seconds. Default 120; range 1..3600. Cancellation does not roll back Git effects.",
  })),
}, { additionalProperties: false });
export type GitToolInput = Static<typeof GitToolInputSchema>;

const GitResultFields = {
  repo: GitRepoNameSchema,
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  timedOut: Type.Boolean(),
  cancelled: Type.Boolean(),
  outputLimitExceeded: Type.Boolean(),
  outputRedacted: Type.Boolean(),
  stdout: Type.String(),
  stderr: Type.String(),
  durationMs: Type.Number({ minimum: 0 }),
  warnings: Type.Array(Type.Literal("LEASE_CLEANUP_FAILED"), { uniqueItems: true }),
};
const ReleasedDispositionSchema = Type.Union([Type.Literal("released"), Type.Literal("release_unconfirmed")]);

/** Parent process exit and managed-group settlement are separate facts. */
export const GitToolResultSchema = Type.Union([
  Type.Object({
    ...GitResultFields,
    ok: Type.Literal(true),
    exitCode: Type.Literal(0),
    timedOut: Type.Literal(false),
    cancelled: Type.Literal(false),
    outputLimitExceeded: Type.Literal(false),
    processStopConfirmed: Type.Literal(true),
    failureCode: Type.Null(),
    leaseDisposition: ReleasedDispositionSchema,
  }, { additionalProperties: false }),
  Type.Object({
    ...GitResultFields,
    ok: Type.Literal(false),
    processStopConfirmed: Type.Literal(true),
    failureCode: Type.Null(),
    leaseDisposition: ReleasedDispositionSchema,
  }, { additionalProperties: false }),
  Type.Object({
    ...GitResultFields,
    ok: Type.Literal(false),
    processStopConfirmed: Type.Literal(false),
    failureCode: Type.Literal("GIT_PROCESS_STOP_UNCONFIRMED"),
    leaseDisposition: Type.Literal("retained"),
  }, { additionalProperties: false }),
]);
export type GitToolResult = Static<typeof GitToolResultSchema>;

export const AgentGitToolEndpoints = {
  prepareRepoGitEnvLease: { method: "POST", path: "/api/internal/agent/git-env/prepare" },
  releaseRepoGitEnvLease: { method: "POST", path: "/api/internal/agent/git-env/release" },
} as const;

export const RepoGitEnvLeaseIdSchema = Type.String({ pattern: "^lease_[0-9a-z]{14}[0-9a-f]{12}$" });
const LeaseOwnerFields = {
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  toolExecutionId: Type.String({ minLength: 1 }),
};
export const RepoGitEnvLeaseOwnerSchema = Type.Object(LeaseOwnerFields, { additionalProperties: false });
export type RepoGitEnvLeaseOwner = Static<typeof RepoGitEnvLeaseOwnerSchema>;

export const PrepareRepoGitEnvRequestSchema = Type.Object({
  ...LeaseOwnerFields,
  repo: GitRepoNameSchema,
  timeoutMs: Type.Integer({ minimum: 1000, maximum: GIT_TOOL_MAX_TIMEOUT_SECONDS * 1000, multipleOf: 1000 }),
}, { additionalProperties: false });
export type PrepareRepoGitEnvRequest = Static<typeof PrepareRepoGitEnvRequestSchema>;

const EnvStringSchema = Type.String({ pattern: "^[^\\u0000]*$" });
const EnvPathSchema = Type.String({ minLength: 1, pattern: "^[^\\u0000]*$" });
const CommonGitEnvFields = {
  GIT_TERMINAL_PROMPT: Type.Literal("0"),
  HTTP_PROXY: Type.Optional(EnvStringSchema),
  http_proxy: Type.Optional(EnvStringSchema),
  HTTPS_PROXY: Type.Optional(EnvStringSchema),
  https_proxy: Type.Optional(EnvStringSchema),
  NO_PROXY: Type.Optional(EnvStringSchema),
  no_proxy: Type.Optional(EnvStringSchema),
  GIT_SSL_CAINFO: Type.Optional(EnvPathSchema),
  SSL_CERT_FILE: Type.Optional(EnvPathSchema),
};
const PreparedLeaseFields = {
  ok: Type.Literal(true),
  repo: GitRepoNameSchema,
  leaseId: RepoGitEnvLeaseIdSchema,
  expiresAt: Type.String({ minLength: 1 }),
};

/** Whitelisted builder keys; no secret contents, AWB_* or arbitrary environment keys. */
export const PrepareRepoGitEnvResponseSchema = Type.Union([
  Type.Object({
    ...PreparedLeaseFields,
    kind: Type.Literal("https"),
    env: Type.Object({
      ...CommonGitEnvFields,
      GIT_ASKPASS: EnvPathSchema,
      GIT_ASKPASS_USERNAME: EnvStringSchema,
      GIT_ASKPASS_TOKEN_FILE: EnvPathSchema,
    }, { additionalProperties: false }),
    sensitiveFilePaths: Type.Array(EnvPathSchema, { minItems: 1, maxItems: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    ...PreparedLeaseFields,
    kind: Type.Literal("ssh"),
    env: Type.Object({ ...CommonGitEnvFields, GIT_SSH_COMMAND: EnvPathSchema }, { additionalProperties: false }),
    sensitiveFilePaths: Type.Array(EnvPathSchema, { minItems: 1, maxItems: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    ...PreparedLeaseFields,
    kind: Type.Literal("none"),
    env: Type.Object(CommonGitEnvFields, { additionalProperties: false }),
    sensitiveFilePaths: Type.Array(EnvPathSchema, { maxItems: 0 }),
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    errorCode: Type.String({ minLength: 1, pattern: "^[A-Z][A-Z0-9_]*$" }),
    error: Type.String(),
    availableRepos: Type.Optional(Type.Array(GitRepoNameSchema)),
  }, { additionalProperties: false }),
]);
export type PrepareRepoGitEnvResponse = Static<typeof PrepareRepoGitEnvResponseSchema>;

export const ReleaseRepoGitEnvRequestSchema = Type.Object({
  ...LeaseOwnerFields,
  leaseId: RepoGitEnvLeaseIdSchema,
  stopEvidence: Type.Union([Type.Literal("not_started"), Type.Literal("managed_group_absent")]),
}, { additionalProperties: false });
export type ReleaseRepoGitEnvRequest = Static<typeof ReleaseRepoGitEnvRequestSchema>;
export const ReleaseRepoGitEnvResponseSchema = Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false });
export type ReleaseRepoGitEnvResponse = Static<typeof ReleaseRepoGitEnvResponseSchema>;
