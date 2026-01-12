import type { FastifyBaseLogger } from "fastify";
import type { WorkspaceDetail, WorkspaceRecord } from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import type { AppContext } from "../../app/context.js";
import { newId } from "../../utils/ids.js";
import { nowMs } from "../../utils/time.js";
import { getRepo } from "../repos/repo.store.js";
import { listHeadsBranches } from "../../infra/git/refs.js";
import { withRepoLock } from "../../infra/locks/repoLock.js";
import { createWorktree, removeWorktree, switchWorktreeBranch } from "../../infra/git/worktree.js";
import { workspaceRepoPath } from "../../infra/fs/paths.js";
import { insertWorkspace, getWorkspace, listWorkspaces, updateWorkspaceBranch, deleteWorkspaceRecord } from "./workspace.store.js";
import {
  countActiveTerminalsByWorkspace,
  countActiveTerminalsByWorkspaceIds,
  deleteTerminalRecord,
  listTerminalsByWorkspace
} from "../terminals/terminal.store.js";
import { tmuxHasSession, tmuxKillSession } from "../../infra/tmux/session.js";

export async function createWorkspace(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  params: { repoId: string; branch: string }
): Promise<WorkspaceRecord> {
  const repoId = params.repoId.trim();
  const branch = params.branch.trim();
  if (!repoId) throw new HttpError(400, "repoId is required");
  if (!branch) throw new HttpError(400, "branch is required");

  const repo = getRepo(ctx.db, repoId);
  if (!repo) throw new HttpError(404, "Repo not found");
  if (repo.syncStatus === "syncing") throw new HttpError(409, "Repo is syncing");
  if (repo.syncStatus === "failed") throw new HttpError(409, "Repo sync failed. Retry sync first.");

  const branches = await listHeadsBranches({ mirrorPath: repo.mirrorPath, cwd: ctx.dataDir });
  if (!branches.some((b) => b.name === branch)) {
    throw new HttpError(409, `Branch not found: ${branch}`);
  }

  const workspaceId = newId("ws");
  const worktreePath = workspaceRepoPath(ctx.dataDir, workspaceId);

  await withRepoLock(repo.id, async () => {
    await createWorktree({ mirrorPath: repo.mirrorPath, worktreePath, branch, dataDir: ctx.dataDir });
  });

  const ts = nowMs();
  const ws: WorkspaceRecord = {
    id: workspaceId,
    repoId: repo.id,
    branch,
    path: worktreePath,
    createdAt: ts,
    updatedAt: ts
  };
  insertWorkspace(ctx.db, ws);
  logger.info({ workspaceId, repoId: repo.id, branch }, "workspace created");
  return ws;
}

export async function getWorkspaceById(ctx: AppContext, workspaceId: string) {
  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");
  return ws;
}

export async function getWorkspaceDetailById(ctx: AppContext, workspaceId: string): Promise<WorkspaceDetail> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const repo = getRepo(ctx.db, ws.repoId);
  if (!repo) throw new HttpError(404, "Repo not found");
  const terminalCount = countActiveTerminalsByWorkspace(ctx.db, ws.id);
  return {
    id: ws.id,
    repo: { id: repo.id, url: repo.url },
    checkout: { branch: ws.branch },
    terminalCount,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt
  };
}

export function listWorkspaceDetails(ctx: AppContext): WorkspaceDetail[] {
  const workspaces = listWorkspaces(ctx.db);
  const terminalCounts = countActiveTerminalsByWorkspaceIds(
    ctx.db,
    workspaces.map((w) => w.id)
  );
  return workspaces.map((ws) => {
    const repo = getRepo(ctx.db, ws.repoId);
    if (!repo) throw new HttpError(500, "Workspace references a missing repo");
    return {
      id: ws.id,
      repo: { id: repo.id, url: repo.url },
      checkout: { branch: ws.branch },
      terminalCount: terminalCounts[ws.id] ?? 0,
      createdAt: ws.createdAt,
      updatedAt: ws.updatedAt
    };
  });
}

export async function switchWorkspaceBranch(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string,
  branch: string
) {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const repo = getRepo(ctx.db, ws.repoId);
  if (!repo) throw new HttpError(404, "Repo not found");
  if (repo.syncStatus === "syncing") throw new HttpError(409, "Repo is syncing");
  if (repo.syncStatus === "failed") throw new HttpError(409, "Repo sync failed. Retry sync first.");

  const branches = await listHeadsBranches({ mirrorPath: repo.mirrorPath, cwd: ctx.dataDir });
  if (!branches.some((b) => b.name === branch)) {
    throw new HttpError(409, `Branch not found: ${branch}`);
  }

  await withRepoLock(repo.id, async () => {
    await switchWorktreeBranch({ worktreePath: ws.path, branch, dataDir: ctx.dataDir });
  });

  updateWorkspaceBranch(ctx.db, ws.id, branch, nowMs());
  logger.info({ workspaceId: ws.id, branch }, "workspace branch switched");
  return { branch };
}

export async function deleteWorkspace(ctx: AppContext, logger: FastifyBaseLogger, workspaceId: string) {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const repo = getRepo(ctx.db, ws.repoId);
  if (!repo) throw new HttpError(404, "Repo not found");

  const terminals = listTerminalsByWorkspace(ctx.db, ws.id);
  for (const term of terminals) {
    try {
      const exists = await tmuxHasSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
      if (exists) {
        await tmuxKillSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
      }
    } catch (err) {
      logger.warn({ terminalId: term.id, err }, "kill terminal session failed");
    } finally {
      deleteTerminalRecord(ctx.db, term.id);
    }
  }

  await withRepoLock(repo.id, async () => {
    await removeWorktree({ mirrorPath: repo.mirrorPath, worktreePath: ws.path, dataDir: ctx.dataDir });
  });

  deleteWorkspaceRecord(ctx.db, ws.id);
  logger.info({ workspaceId: ws.id }, "workspace deleted");
}
