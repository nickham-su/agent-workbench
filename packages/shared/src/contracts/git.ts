import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const ChangeModeSchema = Type.Union([Type.Literal("unstaged"), Type.Literal("staged")]);
export type ChangeMode = Static<typeof ChangeModeSchema>;

export const WorkspaceRepoTargetSchema = Type.Object(
  {
    kind: Type.Literal("workspaceRepo"),
    workspaceId: Type.String({ minLength: 1 }),
    dirName: Type.String({ minLength: 1 })
  }
);
export type WorkspaceRepoTarget = Static<typeof WorkspaceRepoTargetSchema>;

export const GitTargetSchema = Type.Union([WorkspaceRepoTargetSchema]);
export type GitTarget = Static<typeof GitTargetSchema>;

export const ChangeItemSchema = Type.Object(
  {
    path: Type.String(),
    status: Type.String(),
    oldPath: Type.Optional(Type.String()),
    worktreeMtimeMs: Type.Optional(Type.Number()),
    worktreeSize: Type.Optional(Type.Number()),
    indexSha: Type.Optional(Type.String())
  }
);
export type ChangeItem = Static<typeof ChangeItemSchema>;

export const GitChangesRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    mode: ChangeModeSchema
  }
);
export type GitChangesRequest = Static<typeof GitChangesRequestSchema>;

export const ChangesResponseSchema = Type.Object(
  {
    mode: ChangeModeSchema,
    files: Type.Array(ChangeItemSchema)
  }
);
export type ChangesResponse = Static<typeof ChangesResponseSchema>;

export const GitFileCompareRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    mode: ChangeModeSchema,
    path: Type.String({ minLength: 1 }),
    oldPath: Type.Optional(Type.String({ minLength: 1 }))
  }
);
export type GitFileCompareRequest = Static<typeof GitFileCompareRequestSchema>;

export const FileCompareResponseSchema = Type.Object(
  {
    mode: ChangeModeSchema,
    path: Type.String(),
    language: Type.Optional(Type.String()),
    base: Type.Object({
      label: Type.String(),
      path: Type.String(),
      previewable: Type.Boolean(),
      reason: Type.Optional(
        Type.Union([
          Type.Literal("too_large"),
          Type.Literal("binary"),
          Type.Literal("decode_failed"),
          Type.Literal("unsafe_path")
        ])
      ),
      bytes: Type.Optional(Type.Number()),
      content: Type.Optional(Type.String())
    }),
    current: Type.Object({
      label: Type.String(),
      path: Type.String(),
      previewable: Type.Boolean(),
      reason: Type.Optional(
        Type.Union([
          Type.Literal("too_large"),
          Type.Literal("binary"),
          Type.Literal("decode_failed"),
          Type.Literal("unsafe_path")
        ])
      ),
      bytes: Type.Optional(Type.Number()),
      content: Type.Optional(Type.String())
    })
  }
);
export type FileCompareResponse = Static<typeof FileCompareResponseSchema>;

export const GitPathspecItemSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    oldPath: Type.Optional(Type.String({ minLength: 1 }))
  }
);
export type GitPathspecItem = Static<typeof GitPathspecItemSchema>;

export const GitStageRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    all: Type.Optional(Type.Boolean()),
    items: Type.Optional(Type.Array(GitPathspecItemSchema))
  }
);
export type GitStageRequest = Static<typeof GitStageRequestSchema>;

export const GitUnstageRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    all: Type.Optional(Type.Boolean()),
    items: Type.Optional(Type.Array(GitPathspecItemSchema))
  }
);
export type GitUnstageRequest = Static<typeof GitUnstageRequestSchema>;

export const GitDiscardRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    all: Type.Optional(Type.Boolean()),
    items: Type.Optional(Type.Array(GitPathspecItemSchema)),
    includeUntracked: Type.Optional(Type.Boolean())
  }
);
export type GitDiscardRequest = Static<typeof GitDiscardRequestSchema>;

export const GitIdentityScopeSchema = Type.Union([Type.Literal("session"), Type.Literal("repo"), Type.Literal("global")]);
export type GitIdentityScope = Static<typeof GitIdentityScopeSchema>;

export const GitIdentityInputSchema = Type.Object({
  scope: GitIdentityScopeSchema,
  name: Type.String({ minLength: 1 }),
  email: Type.String({ minLength: 1 })
});
export type GitIdentityInput = Static<typeof GitIdentityInputSchema>;

export const GitIdentitySetRequestSchema = Type.Object({
  target: GitTargetSchema,
  name: Type.String({ minLength: 1 }),
  email: Type.String({ minLength: 1 })
});
export type GitIdentitySetRequest = Static<typeof GitIdentitySetRequestSchema>;

export const GitIdentitySourceSchema = Type.Union([Type.Literal("repo"), Type.Literal("global"), Type.Literal("none")]);
export type GitIdentitySource = Static<typeof GitIdentitySourceSchema>;

export const GitIdentityStateSchema = Type.Object({
  name: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()])
});
export type GitIdentityState = Static<typeof GitIdentityStateSchema>;

export const GitIdentityStatusSchema = Type.Object({
  effective: Type.Intersect([
    GitIdentityStateSchema,
    Type.Object({ source: GitIdentitySourceSchema })
  ]),
  repo: GitIdentityStateSchema,
  global: GitIdentityStateSchema
});
export type GitIdentityStatus = Static<typeof GitIdentityStatusSchema>;

export const GitIdentityStatusRequestSchema = Type.Object({
  target: GitTargetSchema
});
export type GitIdentityStatusRequest = Static<typeof GitIdentityStatusRequestSchema>;

export const GitCommitRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    message: Type.String({ minLength: 1 }),
    identity: Type.Optional(GitIdentityInputSchema),
    amend: Type.Optional(Type.Boolean()),
    signoff: Type.Optional(Type.Boolean()),
    noVerify: Type.Optional(Type.Boolean()),
    allowEmpty: Type.Optional(Type.Boolean())
  }
);
export type GitCommitRequest = Static<typeof GitCommitRequestSchema>;

export const GitCommitResponseSchema = Type.Object(
  {
    sha: Type.String(),
    branch: Type.String()
  }
);
export type GitCommitResponse = Static<typeof GitCommitResponseSchema>;

export const GitPushRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    remote: Type.Optional(Type.String({ minLength: 1 })),
    branch: Type.Optional(Type.String({ minLength: 1 })),
    setUpstream: Type.Optional(Type.Boolean()),
    forceWithLease: Type.Optional(Type.Boolean()),
    tags: Type.Optional(Type.Boolean()),
    dryRun: Type.Optional(Type.Boolean())
  }
);
export type GitPushRequest = Static<typeof GitPushRequestSchema>;

export const GitPushResponseSchema = Type.Object(
  {
    remote: Type.String(),
    branch: Type.String()
  }
);
export type GitPushResponse = Static<typeof GitPushResponseSchema>;

export const GitPullRequestSchema = Type.Object({ target: GitTargetSchema });
export type GitPullRequest = Static<typeof GitPullRequestSchema>;

export const GitPullResponseSchema = Type.Object(
  {
    branch: Type.String(),
    updated: Type.Boolean(),
    beforeSha: Type.String(),
    afterSha: Type.String()
  }
);
export type GitPullResponse = Static<typeof GitPullResponseSchema>;

export const GitCheckoutRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    branch: Type.String({ minLength: 1 })
  }
);
export type GitCheckoutRequest = Static<typeof GitCheckoutRequestSchema>;

export const GitCheckoutResponseSchema = Type.Object(
  {
    branch: Type.String()
  }
);
export type GitCheckoutResponse = Static<typeof GitCheckoutResponseSchema>;

export const GitStatusRequestSchema = Type.Object(
  {
    target: GitTargetSchema
  }
);
export type GitStatusRequest = Static<typeof GitStatusRequestSchema>;

export const GitStatusResponseSchema = Type.Object(
  {
    head: Type.Object({
      branch: Type.Union([Type.String(), Type.Null()]),
      detached: Type.Boolean(),
      sha: Type.String()
    }),
    upstream: Type.Optional(
      Type.Object({
        name: Type.Union([Type.String(), Type.Null()]),
        ahead: Type.Number(),
        behind: Type.Number()
      })
    ),
    dirty: Type.Optional(
      Type.Object({
        staged: Type.Number(),
        unstaged: Type.Number(),
        untracked: Type.Number()
      })
    )
  }
);
export type GitStatusResponse = Static<typeof GitStatusResponseSchema>;
