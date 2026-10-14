import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { PrepareRepoGitEnvRequestSchema, PrepareRepoGitEnvResponseSchema, type PrepareRepoGitEnvRequest, type PrepareRepoGitEnvResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { buildGitEnv, GitEnvBuildError, type GitEnvResult } from "../../infra/git/gitEnv.js";
import { closeSecureDirectories, isSecurePathInside, openExistingSecureChildDirectory, openSecureRootDirectory, type SecureDirectory } from "../../infra/fs/secure-directory.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";
import { newSortableId } from "../../utils/ids.js";
import { getMessageSession, getMessageRunState, getRunRecord, getToolExecution } from "../agent/agent-message.store.js";
import { listAgentWorkspaceRepoNames } from "../agent/agent-run-context.js";
import { resolveExecutionProfile } from "../settings/settings.service.js";
import { getWorkspace, getWorkspaceRepoByDirName } from "../workspaces/workspace.store.js";
import { getWorkspaceEnabledAgentIds } from "../workspaces/workspace.service.js";
import { getRepo } from "../repos/repo.store.js";
import { withCreatedRepoGitEnvLease, REPO_GIT_ENV_LEASE_GRACE_MS, REPO_GIT_ENV_LEASE_MIN_TTL_MS, type RepoGitEnvLeaseMeta } from "./git-env.lease.js";

function fail(errorCode: string, error: string, availableRepos?: string[]): PrepareRepoGitEnvResponse {
  return { ok: false, errorCode, error, ...(availableRepos === undefined ? {} : { availableRepos }) };
}

/** DB identity is checked before repository names or any filesystem/credential read. */
function requireExecutableOwner(ctx: AppContext, request: PrepareRepoGitEnvRequest) {
  const { workspaceId, sessionId, runId, toolExecutionId } = request;
  const session = getMessageSession(ctx.db, workspaceId, sessionId);
  const run = getRunRecord(ctx.db, runId);
  const execution = getToolExecution(ctx.db, toolExecutionId);
  const part = execution ? ctx.db.prepare(`
    select part.tool_name as toolName, message.workspace_id as workspaceId,
      message.origin_session_id as sessionId, message.origin_run_id as runId
    from agent_message_part part join agent_message message on message.id=part.message_id
    where part.id=? and part.type='tool_call'
  `).get(execution.callPartId) as { toolName: string; workspaceId: string; sessionId: string; runId: string } | undefined : undefined;
  if (!session || !run || run.workspaceId !== workspaceId || run.sessionId !== sessionId
    || !execution || execution.originRunId !== runId || execution.originSessionId !== sessionId
    || !part || part.toolName !== "git" || part.workspaceId !== workspaceId || part.sessionId !== sessionId || part.runId !== runId) {
    throw new HttpError(400, "The Git tool execution context is invalid.", "RUN_CONTEXT_INVALID");
  }
  const state = getMessageRunState(ctx.db, workspaceId, sessionId);
  if (run.status !== "running" || run.intendedTerminalStatus !== null
    || !["work_pending", "work_in_progress"].includes(run.executionPhase)
    || state?.status !== "running" || state.activeRunId !== runId || execution.status !== "running") {
    throw new HttpError(409, "The Git tool execution is no longer executable.", "RUN_NOT_EXECUTABLE");
  }
  try {
    const profile = resolveExecutionProfile(ctx, {
      surface: session.kind === "subtask" ? "subtask" : "user",
      workspaceEnablement: getWorkspaceEnabledAgentIds(ctx, workspaceId),
      agentIdFromRun: run.agentId, providerIdFromRun: run.providerId, modelIdFromRun: run.modelId,
    });
    if (!profile.agent.tools.includes("git")) throw new Error("disabled");
  } catch {
    throw new HttpError(403, "Git is not enabled for this execution.", "GIT_TOOL_DISABLED");
  }
}

async function assertInitialRepositoryPath(ctx: AppContext, workspace: NonNullable<ReturnType<typeof getWorkspace>>, registeredPath: string, repo: string) {
  const expectedWorkspacePath = path.join(ctx.dataDir, "workspaces", workspace.dirName);
  if (path.resolve(workspace.path) !== path.resolve(expectedWorkspacePath)
    || path.resolve(registeredPath) !== path.resolve(path.join(workspace.path, repo))) throw new Error("registered path mismatch");
  let data: SecureDirectory | undefined, workspaces: SecureDirectory | undefined, root: SecureDirectory | undefined;
  try {
    data = await openSecureRootDirectory(ctx.dataDir);
    workspaces = await openExistingSecureChildDirectory(data, "workspaces");
    root = await openExistingSecureChildDirectory(workspaces, workspace.dirName);
    const [physicalPath, stat] = await Promise.all([fs.realpath(registeredPath), fs.stat(registeredPath)]);
    if (!stat.isDirectory() || !isSecurePathInside(root.realPath, physicalPath)) throw new Error("repository path invalid");
  } finally { await closeSecureDirectories(root, workspaces, data); }
}

/** All preparation/admission is inside the existing Workspace mutation gate. */
export async function prepareRepoGitEnvLease(params: { ctx: AppContext; request: PrepareRepoGitEnvRequest; nowMs?: number }): Promise<PrepareRepoGitEnvResponse> {
  const { ctx, request } = params;
  if (!Value.Check(PrepareRepoGitEnvRequestSchema, request)) return fail("GIT_INPUT_INVALID", "Invalid Git environment request.");
  try { requireExecutableOwner(ctx, request); }
  catch (error) { return safePreparationFailure(error); }
  try {
    return await workspaceLifecycleCoordinator.withMutation(request.workspaceId, async () => {
      requireExecutableOwner(ctx, request);
      const workspace = getWorkspace(ctx.db, request.workspaceId);
      if (!workspace) return fail("RUN_CONTEXT_INVALID", "The Git Workspace context is invalid.");
      const availableRepos = listAgentWorkspaceRepoNames(ctx.db, workspace.id);
      const row = availableRepos.includes(request.repo) ? getWorkspaceRepoByDirName(ctx.db, workspace.id, request.repo) : null;
      const repo = row ? getRepo(ctx.db, row.repoId) : null;
      if (!row || !repo) return fail("REPO_NOT_AVAILABLE", "The selected repository is no longer available.", availableRepos);
      try { await assertInitialRepositoryPath(ctx, workspace, row.path, row.dirName); }
      catch { return fail("REPO_PATH_INVALID", "The initial repository directory is invalid."); }
      const now = params.nowMs ?? Date.now();
      const leaseId = newSortableId("lease");
      const owner = { workspaceId: request.workspaceId, sessionId: request.sessionId, runId: request.runId, toolExecutionId: request.toolExecutionId };
      const meta: RepoGitEnvLeaseMeta = {
        ...owner, schemaVersion: 2, purpose: "git", leaseId, repo: row.dirName, repoId: repo.id, kind: "none",
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + Math.max(REPO_GIT_ENV_LEASE_MIN_TTL_MS, request.timeoutMs + REPO_GIT_ENV_LEASE_GRACE_MS)).toISOString(),
        timeoutMs: request.timeoutMs, stopState: "unconfirmed",
      };
      let releaseUnstarted: (() => Promise<void>) | undefined;
      try {
        const prepared = await withCreatedRepoGitEnvLease({ dataDir: ctx.dataDir, meta }, async (lease) => {
          releaseUnstarted = lease.releaseUnstarted;
          let built: GitEnvResult | undefined;
          try {
            built = await buildGitEnv({ ctx, repoUrl: repo.url, credentialId: repo.credentialId, artifactDir: lease.artifactDir, strictBoundCredential: true });
            await lease.complete({ ...meta, kind: built.kind });
            const response = {
              ok: true as const, repo: row.dirName, kind: built.kind, env: built.env, leaseId, expiresAt: meta.expiresAt, sensitiveFilePaths: built.sensitiveFilePaths,
            };
            if (!Value.Check(PrepareRepoGitEnvResponseSchema, response)) throw new GitEnvBuildError("GIT_ENV_PREPARE_FAILED");
            await lease.artifactDir.assertCurrent();
            // Check while pinned so an already-terminal Run can recover artifacts here.
            requireExecutableOwner(ctx, request);
            return { response, assertCurrent: lease.artifactDir.assertCurrent };
          } catch (error) {
            // Recover through the still-live original handle, not a replaced path.
            // The protective metadata belongs to the lease service, not the builder.
            await built?.cleanup().catch(() => undefined);
            throw error;
          }
        });
        // Handle teardown is asynchronous. Recheck the captured path identities
        // (not reopened capabilities) and live owner after it, before delivery.
        await prepared.assertCurrent();
        requireExecutableOwner(ctx, request);
        return prepared.response;
      } catch (error) {
        // Non-delivery proves not_started, not physical authority over a replacement.
        // Only this creation's identity-bound rollback may delete; initialization
        // failures have their own pinned cleanup and must not fall back to ID release.
        await releaseUnstarted?.().catch(() => undefined);
        return safePreparationFailure(error);
      }
    });
  } catch (error) { return safePreparationFailure(error); }
}

function safePreparationFailure(error: unknown): PrepareRepoGitEnvResponse {
  if (error instanceof GitEnvBuildError) {
    if (error.code === "CREDENTIAL_NOT_FOUND") return fail(error.code, "The bound repository credential no longer exists.");
    if (error.code === "CREDENTIAL_DECRYPT_FAILED") return fail(error.code, "The repository credential could not be decrypted.");
  }
  if (error instanceof HttpError && ["RUN_CONTEXT_INVALID", "RUN_NOT_EXECUTABLE", "GIT_TOOL_DISABLED", "WORKSPACE_DELETING"].includes(error.code ?? "")) {
    return fail(error.code!, error.code === "WORKSPACE_DELETING" ? "The Workspace is being deleted." : "The Git execution is not permitted in the current context.");
  }
  return fail("GIT_ENV_PREPARE_FAILED", "The Git environment could not be prepared safely.");
}
