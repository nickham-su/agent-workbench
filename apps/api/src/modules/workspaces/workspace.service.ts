import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type {
  WorkspaceDetail,
  WorkspaceAgentEnablementMode,
  WorkspaceAgentEnablementSettingsResponse,
  UpdateWorkspaceAgentEnablementSettingsRequest,
  WorkspaceAgentEnablementDetectResponse,
  WorkspaceAgentSessionTabVisibilityMutation,
  WorkspaceAgentTabState
} from "@agent-workbench/shared";
import type { WorkspaceRecord } from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import type { AppContext } from "../../app/context.js";
import { newId } from "../../utils/ids.js";
import { nowMs } from "../../utils/time.js";
import { getSettingJson, setSettingJson } from "../settings/settings.store.js";
import { getRepo } from "../repos/repo.store.js";
import { getAgentSettings } from "../settings/settings.service.js";
import { getOriginDefaultBranch, listHeadsBranches } from "../../infra/git/refs.js";
import { withRepoLock } from "../../infra/locks/repoLock.js";
import { cloneFromMirror } from "../../infra/git/clone.js";
import { ensureDir, pathExists, rmrf } from "../../infra/fs/fs.js";
import { closeSecureDirectories, openSecureRootDirectory, removeSecureDirectoryTree } from "../../infra/fs/secure-directory.js";
import { deleteWorkspaceAgentData } from "../../infra/db/workspace-agent-data-cleanup.js";
import { applyPatchUiArtifactsWorkspaceDir, workspaceRepoDirPath, workspaceRoot, writeUiArtifactsWorkspaceDir } from "../../infra/fs/paths.js";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { getWorkspaceRuntime } from "../agent/lifecycle/workspace-runtime-registry.js";
import { ensureRepoMirror } from "../../infra/git/mirror.js";
import { buildGitEnv } from "../../infra/git/gitEnv.js";
import {
  deleteWorkspaceRecord,
  deleteWorkspaceReposByWorkspace,
  deleteWorkspaceRepoByRepoId,
  getWorkspace,
  getWorkspaceRepoByRepoId,
  insertWorkspace,
  insertWorkspaceRepo,
  listWorkspaceRepos,
  listWorkspaces,
  touchWorkspaceUpdatedAt,
  updateWorkspaceTerminalCredentialId,
  updateWorkspaceTitle
} from "./workspace.store.js";
import {
  getWorkspaceDeletionIntent,
  listWorkspaceDeletionIntents,
  recordWorkspaceDeletionFailure,
  upsertWorkspaceDeletionIntent,
} from "./workspace-deletion.store.js";
import {
  countActiveTerminalsByWorkspace,
  countActiveTerminalsByWorkspaceIds,
  deleteTerminalRecordsByWorkspace,
  listTerminalsByWorkspace
} from "../terminals/terminal.store.js";
import { tmuxHasSession, tmuxKillSession } from "../../infra/tmux/session.js";
import { assertTerminalGitAuthCleanupRootAnchors, cleanupTerminalGitAuthArtifacts } from "../terminals/terminal.gitAuth.js";
import { clearTerminalAuthCleanupIntent, listTerminalAuthCleanupIntents } from "../terminals/terminal-auth-cleanup-intent.store.js";
import { withWorkspaceRepoLock } from "../../infra/locks/workspaceRepoLock.js";
import { withWorkspaceLock } from "../../infra/locks/workspaceLock.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";
import {
  deleteWorkspaceSessionTabStateOverride,
  findAgentSessionKindInWorkspace,
  listEffectiveWorkspaceSessionTabStateOverrides,
  upsertWorkspaceSessionTabStateOverride,
  workspaceExistsForAgentTabState
} from "./workspace-session-tab-state.store.js";

const WORKSPACE_AGENT_ENABLEMENT_SETTINGS_KEY = "workspace_agent_enablement_v1";
const BUILTIN_SKILLS_ROOT = "skills";

export type WorkspaceDeletionTerminalOperations = {
  hasSession: (params: { sessionName: string; cwd: string }) => Promise<"exists" | "not_found">;
  killSession: (params: { sessionName: string; cwd: string }) => Promise<void>;
  cleanupAuthArtifacts?: (dataDir: string, terminalId: string, intents?: import("../terminals/terminal-auth-cleanup-intent.store.js").TerminalAuthCleanupIntent[]) => Promise<void>;
};

const defaultWorkspaceDeletionTerminalOperations: WorkspaceDeletionTerminalOperations = {
  hasSession: tmuxHasSession,
  killSession: tmuxKillSession,
  cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts,
};

function formatRepoDisplayName(rawUrl: string) {
  let s = String(rawUrl || "").trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  if (s.toLowerCase().endsWith(".git")) s = s.slice(0, -4);

  let pathPart = "";
  try {
    if (s.includes("://")) {
      const u = new URL(s);
      pathPart = u.pathname || "";
    }
  } catch {
    // ignore
  }

  if (!pathPart) {
    const colonIdx = s.lastIndexOf(":");
    if (colonIdx > 0 && s.includes("@") && !s.includes("://")) {
      pathPart = s.slice(colonIdx + 1);
    } else {
      pathPart = s;
    }
  }

  pathPart = pathPart.replace(/\\/g, "/").replace(/^\/+/, "");
  const segs = pathPart.split("/").filter(Boolean);
  if (segs.length >= 1) return segs[segs.length - 1]!;
  return s;
}

function sanitizeDirName(raw: string) {
  const base = String(raw || "").replace(/[^A-Za-z0-9._-]/g, "_");
  let name = base || "repo";
  if (name === "." || name === "..") name = "repo";
  if (name.startsWith(".")) name = `repo_${name.slice(1)}`;
  return name;
}

function hash8(input: string) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 8);
}

function randomDirToken(bytes: number) {
  return crypto.randomBytes(bytes).toString("base64url").replace(/=+$/g, "");
}

async function isWorkspaceDirAvailable(dataDir: string, dirName: string, existsInDb: (d: string) => boolean) {
  if (existsInDb(dirName)) return false;
  const p = workspaceRoot(dataDir, dirName);
  return !(await pathExists(p));
}

async function pickWorkspaceDirName(params: { dataDir: string; existsInDb: (d: string) => boolean }) {
  for (let i = 0; i < 50; i += 1) {
    const candidate = `w_${randomDirToken(6)}`;
    if (await isWorkspaceDirAvailable(params.dataDir, candidate, params.existsInDb)) return candidate;
  }

  // 兜底分支也必须做可用性检查，避免直接返回潜在撞名目录。
  for (let i = 0; i < 50; i += 1) {
    const salt = `${Date.now()}:${i}:${randomDirToken(8)}`;
    const fallback = `w_${hash8(salt)}`;
    if (await isWorkspaceDirAvailable(params.dataDir, fallback, params.existsInDb)) return fallback;
  }

  throw new HttpError(500, "Failed to allocate workspace directory name");
}

function uniqueDirName(preferred: string, exists: (d: string) => boolean) {
  const base = sanitizeDirName(preferred);
  if (!exists(base)) return base;
  for (let i = 2; i <= 99; i += 1) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${hash8(preferred + Date.now())}`;
}

function resolveTerminalCredentialId(params: {
  repoCredentialIds: Array<string | null | undefined>;
  useTerminalCredential: boolean;
}) {
  if (!params.useTerminalCredential) return null;
  const ids = Array.from(new Set(params.repoCredentialIds.filter((v): v is string => !!v)));
  if (ids.length !== 1) return null;
  return ids[0]!;
}

function buildWorkspaceDetail(ctx: AppContext, ws: WorkspaceRecord, terminalCount?: number): WorkspaceDetail {
  const repos = listWorkspaceRepos(ctx.db, ws.id)
    .map((row) => {
      const repo = getRepo(ctx.db, row.repoId);
      if (!repo) return null;
      return {
        repo: { id: repo.id, url: repo.url },
        dirName: row.dirName
      };
    })
    .filter((v): v is NonNullable<typeof v> => !!v);

  const useTerminalCredential = ws.terminalCredentialId !== null;
  const resolvedTerminalCount =
    typeof terminalCount === "number" && Number.isFinite(terminalCount)
      ? Math.max(0, Math.floor(terminalCount))
      : countActiveTerminalsByWorkspace(ctx.db, ws.id);

  return {
    id: ws.id,
    dirName: ws.dirName,
    title: ws.title,
    repos,
    useTerminalCredential,
    terminalCount: resolvedTerminalCount,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt
  };
}

export async function getWorkspaceById(ctx: AppContext, workspaceId: string): Promise<WorkspaceRecord> {
  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");
  return ws;
}

function requireWorkspaceForAgentTabState(ctx: AppContext, workspaceId: string) {
  if (!workspaceExistsForAgentTabState(ctx.db, workspaceId)) {
    throw new HttpError(404, "Workspace not found", "WORKSPACE_NOT_FOUND");
  }
}

export async function getWorkspaceAgentTabState(ctx: AppContext, workspaceId: string): Promise<WorkspaceAgentTabState> {
  requireWorkspaceForAgentTabState(ctx, workspaceId);
  const overrides = listEffectiveWorkspaceSessionTabStateOverrides(ctx.db, workspaceId);
  return {
    workspaceId,
    closedSessionIds: overrides.filter((override) => override.kind === "primary" && !override.visible).map((override) => override.sessionId),
    openedSubtaskSessionIds: overrides.filter((override) => override.kind === "subtask" && override.visible).map((override) => override.sessionId)
  };
}

export async function setWorkspaceAgentSessionTabVisibility(
  ctx: AppContext,
  input: { workspaceId: string; sessionId: string; visible: boolean }
): Promise<WorkspaceAgentSessionTabVisibilityMutation> {
  return workspaceLifecycleCoordinator.withMutation(input.workspaceId, async () =>
    ctx.db.transaction(() => {
      requireWorkspaceForAgentTabState(ctx, input.workspaceId);
      const kind = findAgentSessionKindInWorkspace(ctx.db, input.workspaceId, input.sessionId);
      if (!kind) {
        throw new HttpError(404, "Agent Session not found in Workspace", "AGENT_SESSION_NOT_FOUND_IN_WORKSPACE");
      }

      if (kind === "primary" && !input.visible) {
        upsertWorkspaceSessionTabStateOverride(ctx.db, { ...input, updatedAt: nowMs() });
      } else if (kind === "subtask" && input.visible) {
        upsertWorkspaceSessionTabStateOverride(ctx.db, { ...input, updatedAt: nowMs() });
      } else {
        deleteWorkspaceSessionTabStateOverride(ctx.db, input.workspaceId, input.sessionId);
      }

      return { ...input };
    })()
  );
}

export async function createWorkspace(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  params: { repoIds: string[]; title?: string; useTerminalCredential?: boolean }
): Promise<WorkspaceRecord> {
  const ids = Array.from(new Set((params.repoIds || []).map((s) => String(s || "").trim()).filter(Boolean)));
  const title = String(params.title || "").trim();
  if (!title) throw new HttpError(400, "title is required");

  const repos = ids.map((id) => {
    const r = getRepo(ctx.db, id);
    if (!r) throw new HttpError(404, `Repo not found: ${id}`);
    return r;
  });

  const wsId = newId("ws");
  const existingDirNames = new Set(listWorkspaces(ctx.db).map((w) => w.dirName));
  const wsDirName = await pickWorkspaceDirName({ dataDir: ctx.dataDir, existsInDb: (d) => existingDirNames.has(d) });
  const wsPath = workspaceRoot(ctx.dataDir, wsDirName);
  const ts = nowMs();
  const terminalCredentialId = resolveTerminalCredentialId({
    repoCredentialIds: repos.map((r) => r.credentialId),
    useTerminalCredential: Boolean(params.useTerminalCredential)
  });
  if (params.useTerminalCredential && !terminalCredentialId) {
    throw new HttpError(409, "No shared credential available for terminal");
  }

  await fs.mkdir(wsPath, { recursive: true });

  ctx.db.transaction(() => {
    insertWorkspace(ctx.db, {
      id: wsId,
      dirName: wsDirName,
      title,
      path: wsPath,
      terminalCredentialId,
      createdAt: ts,
      updatedAt: ts
    });

    const used = new Set<string>();
    for (const r of repos) {
      const preferred = formatRepoDisplayName(r.url) || r.id;
      const dirName = uniqueDirName(preferred, (d) => used.has(d));
      used.add(dirName);
      insertWorkspaceRepo(ctx.db, {
        workspaceId: wsId,
        repoId: r.id,
        dirName,
        path: workspaceRepoDirPath(ctx.dataDir, wsDirName, dirName),
        createdAt: ts,
        updatedAt: ts
      });
    }
  })();

  try {
    for (const r of repos) {
      const row = getWorkspaceRepoByRepoId(ctx.db, wsId, r.id)!;
      await withWorkspaceRepoLock({ workspaceId: wsId, dirName: row.dirName }, async () => {
        const gitEnv = await buildGitEnv({ ctx, repoUrl: r.url, credentialId: r.credentialId });
        try {
          await ensureRepoMirror({
            repoId: r.id,
            url: r.url,
            dataDir: ctx.dataDir,
            mirrorPath: r.mirrorPath,
            env: gitEnv.env
          });
          await ensureDir(row.path);
          await cloneFromMirror({
            mirrorPath: r.mirrorPath,
            repoUrl: r.url,
            worktreePath: row.path,
            branch: r.defaultBranch || "main",
            dataDir: ctx.dataDir,
            env: gitEnv.env
          });
        } finally {
          await gitEnv.cleanup();
        }
      });
    }
  } catch (err) {
    // git 初始化失败时回滚，避免留下“前端报错但 workspace 已创建”的脏状态
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ workspaceId: wsId, err: message }, "workspace create failed; rollback");
    try {
      ctx.db.transaction(() => {
        deleteWorkspaceReposByWorkspace(ctx.db, wsId);
        deleteWorkspaceRecord(ctx.db, wsId);
      })();
    } catch (rollbackErr) {
      logger.error({ workspaceId: wsId, err: rollbackErr }, "workspace create rollback db failed");
    }
    try {
      await rmrf(wsPath);
    } catch (rollbackErr) {
      logger.error({ workspaceId: wsId, err: rollbackErr }, "workspace create rollback dir failed");
    }
    throw new HttpError(409, `Failed to initialize workspace repositories: ${message}`);
  }

  logger.info({ workspaceId: wsId, title, repoCount: repos.length }, "workspace created");
  return getWorkspace(ctx.db, wsId)!;
}

export async function getWorkspaceDetailById(ctx: AppContext, workspaceId: string): Promise<WorkspaceDetail> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  return buildWorkspaceDetail(ctx, ws);
}

export async function listWorkspaceDetails(ctx: AppContext): Promise<WorkspaceDetail[]> {
  const workspaces = listWorkspaces(ctx.db);
  const terminalCounts = countActiveTerminalsByWorkspaceIds(
    ctx.db,
    workspaces.map((w) => w.id)
  );
  return workspaces.map((ws) => buildWorkspaceDetail(ctx, ws, terminalCounts[ws.id] ?? 0));
}

export async function updateWorkspaceById(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string,
  params: { title?: string; useTerminalCredential?: boolean }
) {
  return workspaceLifecycleCoordinator.withMutation(workspaceId, async () => {
    return withWorkspaceLock({ workspaceId }, async () => {
  const ws = await getWorkspaceById(ctx, workspaceId);
  workspaceDeletingFence.assertWritable(ws.id);
  const wantsTitleUpdate = params.title !== undefined;
  const wantsTerminalCredentialUpdate = params.useTerminalCredential !== undefined;
  if (!wantsTitleUpdate && !wantsTerminalCredentialUpdate) throw new HttpError(400, "No fields to update");

  const title = wantsTitleUpdate ? String(params.title || "").trim() : null;
  if (wantsTitleUpdate && !title) throw new HttpError(400, "title is required");

  // 仅影响之后新创建的终端会话：已存在的 tmux session 环境变量不会被 retroactive 修改。
  const terminalCredentialId = wantsTerminalCredentialUpdate
    ? resolveTerminalCredentialId({
        repoCredentialIds: listWorkspaceRepos(ctx.db, ws.id).map((r) => getRepo(ctx.db, r.repoId)?.credentialId ?? null),
        useTerminalCredential: Boolean(params.useTerminalCredential)
      })
    : null;
  if (params.useTerminalCredential && wantsTerminalCredentialUpdate && !terminalCredentialId) {
    throw new HttpError(409, "No shared credential available for terminal");
  }

  const ts = nowMs();
  ctx.db.transaction(() => {
    if (wantsTitleUpdate && title) updateWorkspaceTitle(ctx.db, ws.id, title, ts);
    if (wantsTerminalCredentialUpdate) {
      updateWorkspaceTerminalCredentialId(ctx.db, ws.id, params.useTerminalCredential ? terminalCredentialId : null, ts);
    }
  })();

  logger.info(
    { workspaceId: ws.id, updatedTitle: wantsTitleUpdate, updatedTerminalCredential: wantsTerminalCredentialUpdate },
    "workspace updated"
  );
  return getWorkspaceDetailById(ctx, ws.id);
    });
  });
}

export async function attachRepoToWorkspace(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string,
  params: { repoId: string; branch?: string }
) {
  return workspaceLifecycleCoordinator.withMutation(workspaceId, async () => {
  const ws = await getWorkspaceById(ctx, workspaceId);
  workspaceDeletingFence.assertWritable(ws.id);

  return withWorkspaceLock({ workspaceId: ws.id }, async () => {
    const repoId = String(params.repoId || "").trim();
    if (!repoId) throw new HttpError(400, "repoId is required");
    const repo = getRepo(ctx.db, repoId);
    if (!repo) throw new HttpError(404, "Repo not found");

    const existing = listWorkspaceRepos(ctx.db, ws.id);
    if (existing.some((item) => item.repoId === repoId)) {
      throw new HttpError(409, "Repo already attached to workspace");
    }

    const preferred = formatRepoDisplayName(repo.url) || repo.id;
    const used = new Set(existing.map((item) => item.dirName));
    const dirName = uniqueDirName(preferred, (d) => used.has(d));

    let branch = String(params.branch || "").trim();
    const gitEnv = await buildGitEnv({ ctx, repoUrl: repo.url, credentialId: repo.credentialId });
    try {
      await ensureRepoMirror({
        repoId: repo.id,
        url: repo.url,
        dataDir: ctx.dataDir,
        mirrorPath: repo.mirrorPath,
        env: gitEnv.env
      });

      if (!branch) {
        try {
          branch = (await getOriginDefaultBranch({ mirrorPath: repo.mirrorPath, cwd: ctx.dataDir })) || "";
        } catch {
          branch = "";
        }
      }
      if (!branch) {
        const heads = await listHeadsBranches({ mirrorPath: repo.mirrorPath, cwd: ctx.dataDir });
        if (heads.length === 1) branch = heads[0]?.name || "";
        if (!branch) branch = repo.defaultBranch || "";
      }

      const ts = nowMs();
      const row = {
        workspaceId: ws.id,
        repoId: repo.id,
        dirName,
        path: workspaceRepoDirPath(ctx.dataDir, ws.dirName, dirName),
        createdAt: ts,
        updatedAt: ts
      };

      await withWorkspaceRepoLock({ workspaceId: ws.id, dirName: row.dirName }, async () => {
        await ensureDir(row.path);
        await cloneFromMirror({
          mirrorPath: repo.mirrorPath,
          repoUrl: repo.url,
          worktreePath: row.path,
          branch,
          dataDir: ctx.dataDir,
          env: gitEnv.env
        });
      });

      const nextTerminalCredentialId = resolveTerminalCredentialId({
        repoCredentialIds: [...existing.map((item) => getRepo(ctx.db, item.repoId)?.credentialId ?? null), repo.credentialId],
        useTerminalCredential: ws.terminalCredentialId !== null
      });

      ctx.db.transaction(() => {
        insertWorkspaceRepo(ctx.db, row);
        if (ws.terminalCredentialId !== null) {
          updateWorkspaceTerminalCredentialId(ctx.db, ws.id, nextTerminalCredentialId, nowMs());
        }
        touchWorkspaceUpdatedAt(ctx.db, ws.id, nowMs());
      })();

      logger.info({ workspaceId: ws.id, repoId: repo.id, dirName }, "repo attached to workspace");
      return getWorkspaceDetailById(ctx, ws.id);
    } finally {
      await gitEnv.cleanup();
    }
  });
  });
}

export async function detachRepoFromWorkspace(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string,
  repoId: string
) {
  return workspaceLifecycleCoordinator.withMutation(workspaceId, async () => {
  const ws = await getWorkspaceById(ctx, workspaceId);
  workspaceDeletingFence.assertWritable(ws.id);

  return withWorkspaceLock({ workspaceId: ws.id }, async () => {
    const id = String(repoId || "").trim();
    if (!id) throw new HttpError(400, "repoId is required");
    const row = getWorkspaceRepoByRepoId(ctx.db, ws.id, id);
    if (!row) throw new HttpError(404, "Repo not attached to workspace");

    const nextRows = listWorkspaceRepos(ctx.db, ws.id).filter((r) => r.repoId !== id);
    const nextTerminalCredentialId = resolveTerminalCredentialId({
      repoCredentialIds: nextRows.map((item) => getRepo(ctx.db, item.repoId)?.credentialId ?? null),
      useTerminalCredential: ws.terminalCredentialId !== null
    });

    try {
      await rmrf(row.path);
    } catch (err) {
      logger.warn({ workspaceId: ws.id, repoId: id, path: row.path, err }, "remove workspace repo path failed");
      throw new HttpError(409, "Failed to remove workspace repo path");
    }

    ctx.db.transaction(() => {
      deleteWorkspaceRepoByRepoId(ctx.db, ws.id, id);
      if (ws.terminalCredentialId !== null) {
        updateWorkspaceTerminalCredentialId(ctx.db, ws.id, nextTerminalCredentialId, nowMs());
      }
      touchWorkspaceUpdatedAt(ctx.db, ws.id, nowMs());
    })();

    logger.info({ workspaceId: ws.id, repoId: id }, "repo detached from workspace");
    return getWorkspaceDetailById(ctx, ws.id);
  });
  });
}

const WORKSPACE_AGENT_DRAIN_TIMEOUT_MS = 10_000;

function listWorkspaceSessionIds(ctx: AppContext, workspaceId: string) {
  return (ctx.db.prepare(`
    select id as sessionId from agent_session where workspace_id = ? order by id
  `).all(workspaceId) as Array<{ sessionId: string }>).map((row) => row.sessionId);
}

async function removeWorkspaceFileDomains(ctx: AppContext, ws: WorkspaceRecord) {
  const dataRoot = await openSecureRootDirectory(ctx.dataDir);
  try {
    const domains = [
      ["workspaces", ws.dirName],
      ["agent", "attachments", "by_workspace", ws.id],
      ["tmp", "agent", "ui-artifacts", "apply_patch", path.basename(applyPatchUiArtifactsWorkspaceDir(ctx.dataDir, ws.id))],
      ["tmp", "agent", "ui-artifacts", "write", path.basename(writeUiArtifactsWorkspaceDir(ctx.dataDir, ws.id))],
    ];
    for (const relativeSegments of domains) {
      const result = await removeSecureDirectoryTree({
        root: dataRoot,
        relativeSegments,
        quarantineDirectory: ".workspace-delete-quarantine",
      });
      if (result === "replacement_pending") {
        throw new HttpError(409, "Workspace file cleanup has a replacement pending; deletion remains pending.", "WORKSPACE_FILE_CLEANUP_REPLACEMENT_PENDING");
      }
    }
  } finally {
    await closeSecureDirectories(dataRoot);
  }
}

function deletionFailureCode(error: unknown) {
  return error instanceof HttpError ? error.code ?? "WORKSPACE_DELETION_PENDING" : "WORKSPACE_DELETION_PENDING";
}

function deletionFailureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/**
 * 删除从 durable intent 开始。任一步失败都保留 tombstone 与 fence；重试或启动续作
 * 将从当前可达步骤继续。只有文件域全部安全清理且最终 SQLite 事务成功后才释放 fence。
 */
export async function deleteWorkspace(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string,
  terminalOperations = defaultWorkspaceDeletionTerminalOperations,
) {
  const ws = await workspaceLifecycleCoordinator.withAdmission(workspaceId, async () =>
    withWorkspaceLock({ workspaceId }, async () => {
      const ws = await getWorkspaceById(ctx, workspaceId);
      if (!/^[A-Za-z0-9._-]{1,160}$/.test(ws.dirName) || ws.dirName === "." || ws.dirName === "..") throw new HttpError(409, "Workspace path is invalid; aborting delete.", "WORKSPACE_PATH_INVALID");
      const expectedPath = workspaceRoot(ctx.dataDir, ws.dirName);
      if (path.resolve(ws.path) !== path.resolve(expectedPath)) {
        logger.error({ workspaceId: ws.id, wsPath: ws.path, expectedPath }, "workspace path mismatch; abort delete");
        throw new HttpError(409, "Workspace path is invalid; aborting delete.", "WORKSPACE_PATH_INVALID");
      }
      const existingIntent = getWorkspaceDeletionIntent(ctx.db, ws.id);
      if (!existingIntent) {
        ctx.db.transaction(() => {
          upsertWorkspaceDeletionIntent(ctx.db, { workspaceId: ws.id, dirName: ws.dirName, now: nowMs() });
        })();
      }
      if (!workspaceDeletingFence.isDeleting(ws.id)) workspaceDeletingFence.begin(ws.id);
      return ws;
    })
  );

  const expectedPath = workspaceRoot(ctx.dataDir, ws.dirName);
  try {
    const workspaceSessionIds = listWorkspaceSessionIds(ctx, ws.id);
    if (workspaceSessionIds.length > 0) {
      const registration = getWorkspaceRuntime();
      if (!registration) {
        throw new HttpError(503, "agent worker unavailable", "WORKSPACE_AGENT_WORKER_UNAVAILABLE");
      }
      await registration.handoffCoordinator.runExclusiveMany(workspaceSessionIds, async () => {
        registration.settleWorkspaceRunsForDeletion(ws.id);
        if (!registration.runtime.cancelSessionAndWait) {
          throw new HttpError(503, "agent worker unavailable", "WORKSPACE_AGENT_WORKER_UNAVAILABLE");
        }
        for (const sessionId of workspaceSessionIds) {
          let idle: boolean;
          try {
            idle = await registration.runtime.cancelSessionAndWait!({ sessionId, timeoutMs: WORKSPACE_AGENT_DRAIN_TIMEOUT_MS });
          } catch (err) {
            logger.warn({ workspaceId: ws.id, sessionId, err }, "agent worker unavailable during workspace deletion");
            throw new HttpError(503, "agent worker unavailable", "WORKSPACE_AGENT_WORKER_UNAVAILABLE");
          }
          if (!idle) throw new HttpError(409, "agent worker did not stop in time", "WORKSPACE_AGENT_WORKER_DRAIN_TIMEOUT");
        }
      });
    }

    const terms = listTerminalsByWorkspace(ctx.db, ws.id);
    for (const term of terms) {
      try {
        const presence = await terminalOperations.hasSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
        if (presence === "exists") {
          await terminalOperations.killSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
        }
      } catch (err) {
        logger.warn({ workspaceId: ws.id, terminalId: term.id, sessionName: term.sessionName, err }, "tmux kill-session failed");
        throw new HttpError(409, "Failed to kill one or more terminal sessions; deletion remains pending.", "TERMINAL_KILL_FAILED");
      }
    }

    for (const term of terms) {
      try {
        const intents = listTerminalAuthCleanupIntents(ctx.db, term.id);
        if (intents.some((intent) => intent.phase !== "recoverable")) {
          throw new Error("auth cleanup locator is not recoverable");
        }
        await assertTerminalGitAuthCleanupRootAnchors(ctx.dataDir, intents);
        await (terminalOperations.cleanupAuthArtifacts ?? cleanupTerminalGitAuthArtifacts)(ctx.dataDir, term.id, intents);
        // 仅 recoverable 经过实际 root-slot cleanup 后可移除 latch；同时和最终
        // terminal/Workspace record 删除位于下面同一 SQLite transaction。
        const current = listTerminalAuthCleanupIntents(ctx.db, term.id);
        if (current.some((intent) => intent.phase !== "recoverable")) throw new Error("auth cleanup locator is not recoverable");
      } catch (err) {
        logger.warn({ workspaceId: ws.id, terminalId: term.id, err }, "terminal Git auth artifact cleanup failed");
        throw new HttpError(409, "Failed to clean terminal Git authentication artifacts; deletion remains pending.", "TERMINAL_AUTH_CLEANUP_FAILED");
      }
    }

    await removeWorkspaceFileDomains(ctx, ws);
    ctx.db.transaction(() => {
      for (const term of terms) {
        const intents = listTerminalAuthCleanupIntents(ctx.db, term.id);
        if (intents.some((intent) => intent.phase !== "recoverable")) throw new Error("auth cleanup locator is not recoverable");
        for (const intent of intents) clearTerminalAuthCleanupIntent(ctx.db, term.id, intent.artifactKind);
      }
      // Task history is scoped to this Workspace and cascades with its Task.
      // Remove it before the Agent graph and the Workspace FK are deleted.
      ctx.db.prepare("delete from scheduled_agent_task where workspace_id=?").run(ws.id);
      deleteWorkspaceAgentData(ctx.db, ws.id);
      deleteWorkspaceReposByWorkspace(ctx.db, ws.id);
      deleteTerminalRecordsByWorkspace(ctx.db, ws.id);
      deleteWorkspaceRecord(ctx.db, ws.id);
    })();
    workspaceDeletingFence.end(ws.id);
    logger.info({ workspaceId: ws.id }, "workspace deleted");
  } catch (error) {
    const code = deletionFailureCode(error);
    const message = deletionFailureMessage(error);
    recordWorkspaceDeletionFailure(ctx.db, { workspaceId: ws.id, now: nowMs(), code, message });
    throw error instanceof HttpError
      ? error
      : new HttpError(409, "Workspace deletion remains pending; retry later.", "WORKSPACE_DELETION_PENDING");
  }
}

/** 进程重启后恢复 durable fence，并在运行时可用时尝试续作。 */
export async function resumePendingWorkspaceDeletions(ctx: AppContext, logger: FastifyBaseLogger) {
  const intents = listWorkspaceDeletionIntents(ctx.db);
  for (const intent of intents) workspaceDeletingFence.restore(intent.workspaceId);
  for (const intent of intents) {
    try {
      await deleteWorkspace(ctx, logger, intent.workspaceId);
    } catch (error) {
      logger.warn({ workspaceId: intent.workspaceId, err: error }, "workspace deletion remains pending during startup resume");
    }
  }
}


type WorkspaceAgentEnablementSettingsPayload = {
  workspaces?: Record<string, { mode?: WorkspaceAgentEnablementMode; enabledAgentIds?: string[]; updatedAt?: number }>;
};

function readWorkspaceAgentEnablementSettings(ctx: AppContext): WorkspaceAgentEnablementSettingsPayload {
  const found = getSettingJson(ctx.db, WORKSPACE_AGENT_ENABLEMENT_SETTINGS_KEY);
  const value = found?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { workspaces: {} };
  const workspaces = (value as any).workspaces;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return { workspaces: {} };
  return { workspaces: workspaces as WorkspaceAgentEnablementSettingsPayload["workspaces"] };
}

function persistWorkspaceAgentEnablementSettings(ctx: AppContext, payload: WorkspaceAgentEnablementSettingsPayload, updatedAt: number) {
  setSettingJson(ctx.db, WORKSPACE_AGENT_ENABLEMENT_SETTINGS_KEY, payload, updatedAt);
}

function normalizeEnabledAgentIds(raw: unknown) {
  if (!Array.isArray(raw)) return [] as string[];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = String(item || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function getWorkspaceEnabledAgentIds(ctx: AppContext, workspaceId: string) {
  const settings = readWorkspaceAgentEnablementSettings(ctx);
  const ws = settings.workspaces?.[workspaceId];
  const mode: WorkspaceAgentEnablementMode = String(ws?.mode || "").trim() === "subset" ? "subset" : "all";
  const enabledAgentIds = normalizeEnabledAgentIds(ws?.enabledAgentIds);
  const updatedAt = Number(ws?.updatedAt || 0) || 0;
  return {
    mode,
    enabledAgentIds,
    updatedAt,
    isDefaultAll: mode === "all"
  };
}

export function filterAgentsByWorkspaceEnablement<T extends { id: string }>(params: {
  agents: T[];
  enabledAgentIds: string[];
  mode: WorkspaceAgentEnablementMode;
}) {
  if (params.mode !== "subset") return params.agents;
  const enabledSet = new Set(params.enabledAgentIds);
  return params.agents.filter((item) => enabledSet.has(item.id));
}

export async function detectWorkspaceAgentEnablement(
  ctx: AppContext,
  workspaceId: string
): Promise<WorkspaceAgentEnablementDetectResponse> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const globalAgents = getAgentSettings(ctx).agents;
  const setting = getWorkspaceEnabledAgentIds(ctx, ws.id);
  const enabledSet = new Set(setting.enabledAgentIds);
  const items = globalAgents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    scope: agent.scope,
    enabled: setting.mode === "all" ? true : enabledSet.has(agent.id)
  }));
  return { workspaceId: ws.id, items, updatedAt: setting.updatedAt || nowMs() };
}

export async function getWorkspaceAgentEnablementSettings(
  ctx: AppContext,
  workspaceId: string
): Promise<WorkspaceAgentEnablementSettingsResponse> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const setting = getWorkspaceEnabledAgentIds(ctx, ws.id);
  return {
    workspaceId: ws.id,
    mode: setting.mode,
    enabledAgentIds: setting.enabledAgentIds,
    updatedAt: setting.updatedAt
  };
}

export async function updateWorkspaceAgentEnablementSettings(
  ctx: AppContext,
  workspaceId: string,
  payload: UpdateWorkspaceAgentEnablementSettingsRequest
): Promise<WorkspaceAgentEnablementSettingsResponse> {
  return workspaceLifecycleCoordinator.withMutation(workspaceId, async () => {
    return withWorkspaceLock({ workspaceId }, async () => {
  const ws = await getWorkspaceById(ctx, workspaceId);
  workspaceDeletingFence.assertWritable(ws.id);
  const mode: WorkspaceAgentEnablementMode = String((payload as any)?.mode || "").trim() === "subset" ? "subset" : "all";
  const now = nowMs();

  let enabledAgentIds: string[] = [];
  if (mode === "subset") {
    const existing = new Set(getAgentSettings(ctx).agents.map((item) => item.id));
    enabledAgentIds = normalizeEnabledAgentIds((payload as any)?.enabledAgentIds).filter((id) => existing.has(id));
  }

  const settings = readWorkspaceAgentEnablementSettings(ctx);
  const workspaces = { ...(settings.workspaces || {}) };
  workspaces[ws.id] = {
    mode,
    enabledAgentIds,
    updatedAt: now
  };
  persistWorkspaceAgentEnablementSettings(ctx, { workspaces }, now);

  return {
    workspaceId: ws.id,
    mode,
    enabledAgentIds,
    updatedAt: now
  };
    });
  });
}
