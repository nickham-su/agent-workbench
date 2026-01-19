import crypto from "node:crypto";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { WorkspaceDetail, WorkspaceRecord } from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import type { AppContext } from "../../app/context.js";
import { newId } from "../../utils/ids.js";
import { nowMs } from "../../utils/time.js";
import { getRepo } from "../repos/repo.store.js";
import { getOriginDefaultBranch, listHeadsBranches } from "../../infra/git/refs.js";
import { withRepoLock } from "../../infra/locks/repoLock.js";
import { cloneFromMirror } from "../../infra/git/clone.js";
import { ensureDir, pathExists, rmrf } from "../../infra/fs/fs.js";
import { workspaceRepoDirPath, workspaceRoot } from "../../infra/fs/paths.js";
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
  countActiveTerminalsByWorkspace,
  countActiveTerminalsByWorkspaceIds,
  deleteTerminalRecord,
  listTerminalsByWorkspace
} from "../terminals/terminal.store.js";
import { tmuxHasSession, tmuxKillSession } from "../../infra/tmux/session.js";
import { withWorkspaceRepoLock } from "../../infra/locks/workspaceRepoLock.js";
import { withWorkspaceLock } from "../../infra/locks/workspaceLock.js";

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
  // base64url: 仅包含 [A-Za-z0-9_-]，适合做目录名；长度也比 hex 更短。
  return crypto.randomBytes(bytes).toString("base64url").replace(/=+$/g, "");
}

function pickDirName(params: { repoUrl: string; existing: Set<string> }) {
  const base = sanitizeDirName(formatRepoDisplayName(params.repoUrl));
  if (!params.existing.has(base)) return base;

  const suffix = hash8(params.repoUrl);
  let name = `${base}_${suffix}`;
  let seq = 0;
  while (params.existing.has(name)) {
    seq += 1;
    name = `${base}_${suffix}_${seq}`;
  }
  return name;
}

function buildDefaultWorkspaceTitle(repoUrls: string[]) {
  const title = repoUrls.map((url) => formatRepoDisplayName(url)).filter(Boolean).join(" + ");
  return title || "workspace";
}

async function pickWorkspaceDirName(params: { dataDir: string }) {
  // 不拼 title，避免目录过长；可读性由 UI 的 title 提供。
  for (let i = 0; i < 50; i += 1) {
    const candidate = `w_${randomDirToken(6)}`; // 6 bytes ~= 48 bits, 输出通常为 8 字符
    const p = workspaceRoot(params.dataDir, candidate);
    if (!(await pathExists(p))) return candidate;
  }
  // 极端情况下兜底，避免死循环（仍然是短名）。
  return `w_${hash8(`${Date.now()}:${randomDirToken(8)}`)}`;
}

function resolveTerminalCredentialId(params: { repoCredentialIds: Array<string | null>; useTerminalCredential?: boolean }) {
  if (!params.useTerminalCredential) return null;
  // 允许“有凭证 repo + 无凭证 repo”的组合：只要所有非空 credentialId 相同即可。
  const ids = params.repoCredentialIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (ids.length === 0) return null;
  const uniq = new Set(ids);
  if (uniq.size !== 1) return null;
  return ids[0]!;
}

function mapWorkspaceRepoConstraintError(err: unknown) {
  const anyErr = err as { code?: string; message?: string };
  if (!anyErr || anyErr.code !== "SQLITE_CONSTRAINT") return null;
  const message = String(anyErr.message || "");
  if (message.includes("idx_workspace_repos_workspace_dir")) {
    return new HttpError(409, "Workspace repo dir conflict", "WORKSPACE_REPO_DIR_CONFLICT");
  }
  return new HttpError(409, "Repo already attached to workspace", "WORKSPACE_REPO_ALREADY_EXISTS");
}

export async function createWorkspace(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  params: { repoIds: string[]; title?: string; useTerminalCredential?: boolean }
): Promise<WorkspaceRecord> {
  const repoIds = params.repoIds.map((id) => String(id || "").trim()).filter(Boolean);
  if (repoIds.length === 0) throw new HttpError(400, "repoIds is required");
  const unique = new Set(repoIds);
  if (unique.size !== repoIds.length) throw new HttpError(400, "repoIds contains duplicates");

  const repos = repoIds.map((repoId) => {
    const repo = getRepo(ctx.db, repoId);
    if (!repo) throw new HttpError(404, `Repo not found: ${repoId}`);
    // 强一致：创建 workspace 时会强制更新 mirror，因此这里不再依赖历史的 syncStatus/defaultBranch。
    const branchHint = String(repo.defaultBranch || "").trim();
    return { repo, branchHint };
  });

  const title = String(params.title || "").trim() || buildDefaultWorkspaceTitle(repos.map((r) => r.repo.url));

  const dirNames = new Set<string>();
  const workspaceId = newId("ws");
  const workspaceDirName = await pickWorkspaceDirName({ dataDir: ctx.dataDir });
  const workspacePath = workspaceRoot(ctx.dataDir, workspaceDirName);
  const workItems = repos.map(({ repo, branchHint }) => {
    const dirName = pickDirName({ repoUrl: repo.url, existing: dirNames });
    dirNames.add(dirName);
    return {
      repo,
      branchHint,
      dirName,
      path: workspaceRepoDirPath(ctx.dataDir, workspaceDirName, dirName)
    };
  });

  const terminalCredentialId = resolveTerminalCredentialId({
    repoCredentialIds: workItems.map((item) => item.repo.credentialId ?? null),
    useTerminalCredential: params.useTerminalCredential
  });
  if (params.useTerminalCredential && !terminalCredentialId) {
    throw new HttpError(409, "No shared credential available for terminal");
  }

  await ensureDir(workspacePath);
  const createdPaths: string[] = [];
  try {
    for (const item of workItems) {
      await withRepoLock(item.repo.id, async () => {
        // 强一致：clone 前先把 mirror 更新到最新（需要凭证时使用 repo 绑定/默认凭证）。
        const gitEnv = await buildGitEnv({ ctx, repoUrl: item.repo.url, credentialId: item.repo.credentialId });
        try {
          await ensureRepoMirror({
            repoId: item.repo.id,
            url: item.repo.url,
            dataDir: ctx.dataDir,
            mirrorPath: item.repo.mirrorPath,
            env: gitEnv.env
          });

          // 分支“真相”来自最新 mirror：优先 defaultBranch，否则从 origin/HEAD 推断。
          let branch = item.branchHint;
          if (!branch) {
            branch = String((await getOriginDefaultBranch({ mirrorPath: item.repo.mirrorPath, cwd: ctx.dataDir })) || "").trim();
          }
          if (!branch) throw new HttpError(409, `Repo default branch is unknown: ${item.repo.url}`, "REPO_DEFAULT_BRANCH_UNKNOWN");

          const branches = await listHeadsBranches({ mirrorPath: item.repo.mirrorPath, cwd: ctx.dataDir });
          if (!branches.some((b) => b.name === branch)) {
            throw new HttpError(409, `Branch not found: ${branch}`, "REPO_BRANCH_NOT_FOUND");
          }

          await cloneFromMirror({
            mirrorPath: item.repo.mirrorPath,
            repoUrl: item.repo.url,
            worktreePath: item.path,
            branch,
            dataDir: ctx.dataDir
          });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          throw new HttpError(409, `Failed to prepare workspace repo: ${item.repo.url}. ${msg}`, "WORKSPACE_PREPARE_REPO_FAILED");
        } finally {
          await gitEnv.cleanup();
        }
      });
      createdPaths.push(item.path);
    }
  } catch (err) {
    for (const p of createdPaths) {
      await rmrf(p);
    }
    await rmrf(workspacePath);
    throw err;
  }

  const ts = nowMs();
  const ws: WorkspaceRecord = {
    id: workspaceId,
    dirName: workspaceDirName,
    title,
    path: workspacePath,
    terminalCredentialId,
    createdAt: ts,
    updatedAt: ts
  };

  try {
    ctx.db.transaction(() => {
      insertWorkspace(ctx.db, ws);
      for (const item of workItems) {
        insertWorkspaceRepo(ctx.db, {
          workspaceId,
          repoId: item.repo.id,
          dirName: item.dirName,
          path: item.path,
          createdAt: ts,
          updatedAt: ts
        });
      }
    })();
  } catch (err) {
    for (const p of createdPaths) {
      await rmrf(p);
    }
    await rmrf(workspacePath);
    throw err;
  }

  logger.info({ workspaceId, repoCount: workItems.length }, "workspace created");
  return ws;
}

export async function getWorkspaceById(ctx: AppContext, workspaceId: string) {
  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");
  return ws;
}

function buildWorkspaceDetail(
  ctx: AppContext,
  ws: WorkspaceRecord,
  terminalCount: number
): WorkspaceDetail {
  const items = listWorkspaceRepos(ctx.db, ws.id);
  const repos = items.map((item) => {
    const repo = getRepo(ctx.db, item.repoId);
    if (!repo) throw new HttpError(500, "Workspace references a missing repo");
    return { repo: { id: repo.id, url: repo.url }, dirName: item.dirName };
  });
  return {
    id: ws.id,
    dirName: ws.dirName,
    title: ws.title,
    repos,
    useTerminalCredential: Boolean(ws.terminalCredentialId),
    terminalCount,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt
  };
}

export async function getWorkspaceDetailById(ctx: AppContext, workspaceId: string): Promise<WorkspaceDetail> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const terminalCount = countActiveTerminalsByWorkspace(ctx.db, ws.id);
  return buildWorkspaceDetail(ctx, ws, terminalCount);
}

export function listWorkspaceDetails(ctx: AppContext): WorkspaceDetail[] {
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
  const ws = await getWorkspaceById(ctx, workspaceId);
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
}

export async function attachRepoToWorkspace(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string,
  params: { repoId: string; branch?: string }
) {
  const ws = await getWorkspaceById(ctx, workspaceId);

  return withWorkspaceLock({ workspaceId: ws.id }, async () => {
    const repoId = String(params.repoId || "").trim();
    if (!repoId) throw new HttpError(400, "repoId is required");
    const repo = getRepo(ctx.db, repoId);
    if (!repo) throw new HttpError(404, "Repo not found");

    const existing = listWorkspaceRepos(ctx.db, ws.id);
    if (existing.some((item) => item.repoId === repo.id)) {
      throw new HttpError(409, "Repo already attached to workspace", "WORKSPACE_REPO_ALREADY_EXISTS");
    }

    const expectedRoot = workspaceRoot(ctx.dataDir, ws.dirName);
    if (path.resolve(ws.path) !== path.resolve(expectedRoot)) {
      throw new HttpError(409, "Workspace path is invalid; aborting attach.", "WORKSPACE_PATH_INVALID");
    }

    await ensureDir(expectedRoot);

    const dirNames = new Set(existing.map((item) => item.dirName));
    let dirName = pickDirName({ repoUrl: repo.url, existing: dirNames });
    let worktreePath = workspaceRepoDirPath(ctx.dataDir, ws.dirName, dirName);
    for (let i = 0; i < 50; i += 1) {
      if (!(await pathExists(worktreePath))) break;
      dirNames.add(dirName);
      dirName = pickDirName({ repoUrl: repo.url, existing: dirNames });
      worktreePath = workspaceRepoDirPath(ctx.dataDir, ws.dirName, dirName);
    }
    if (await pathExists(worktreePath)) {
      throw new HttpError(409, "Failed to allocate workspace repo dir", "WORKSPACE_REPO_DIR_CONFLICT");
    }

    const rawBranch = typeof params.branch === "string" ? params.branch.trim() : "";
    if (params.branch !== undefined && !rawBranch) throw new HttpError(400, "branch is required");
    const branchHint = rawBranch || String(repo.defaultBranch || "").trim();

    const ts = nowMs();
    try {
      await withRepoLock(repo.id, async () => {
        const gitEnv = await buildGitEnv({ ctx, repoUrl: repo.url, credentialId: repo.credentialId });
        try {
          await ensureRepoMirror({
            repoId: repo.id,
            url: repo.url,
            dataDir: ctx.dataDir,
            mirrorPath: repo.mirrorPath,
            env: gitEnv.env
          });

          let branch = branchHint;
          if (!branch) {
            branch = String((await getOriginDefaultBranch({ mirrorPath: repo.mirrorPath, cwd: ctx.dataDir })) || "").trim();
          }
          if (!branch) throw new HttpError(409, `Repo default branch is unknown: ${repo.url}`, "REPO_DEFAULT_BRANCH_UNKNOWN");

          const branches = await listHeadsBranches({ mirrorPath: repo.mirrorPath, cwd: ctx.dataDir });
          if (!branches.some((b) => b.name === branch)) {
            throw new HttpError(409, `Branch not found: ${branch}`, "REPO_BRANCH_NOT_FOUND");
          }

          await cloneFromMirror({
            mirrorPath: repo.mirrorPath,
            repoUrl: repo.url,
            worktreePath,
            branch,
            dataDir: ctx.dataDir
          });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          throw new HttpError(409, `Failed to prepare workspace repo: ${repo.url}. ${msg}`, "WORKSPACE_PREPARE_REPO_FAILED");
        } finally {
          await gitEnv.cleanup();
        }
      });
    } catch (err) {
      await rmrf(worktreePath);
      throw err;
    }

    const record = {
      workspaceId: ws.id,
      repoId: repo.id,
      dirName,
      path: worktreePath,
      createdAt: ts,
      updatedAt: ts
    };

    let nextTerminalCredentialId: string | null | undefined = undefined;
    if (ws.terminalCredentialId) {
      const repoCredentialIds = [
        ...existing.map((item) => getRepo(ctx.db, item.repoId)?.credentialId ?? null),
        repo.credentialId ?? null
      ];
      const resolved = resolveTerminalCredentialId({ repoCredentialIds, useTerminalCredential: true });
      if (!resolved) nextTerminalCredentialId = null;
    }

    try {
      ctx.db.transaction(() => {
        insertWorkspaceRepo(ctx.db, record);
        if (nextTerminalCredentialId !== undefined) {
          updateWorkspaceTerminalCredentialId(ctx.db, ws.id, nextTerminalCredentialId, ts);
        }
        touchWorkspaceUpdatedAt(ctx.db, ws.id, ts);
      })();
    } catch (err) {
      await rmrf(worktreePath);
      const mapped = mapWorkspaceRepoConstraintError(err);
      if (mapped) throw mapped;
      throw err;
    }

    logger.info({ workspaceId: ws.id, repoId: repo.id, dirName }, "workspace repo attached");
    return getWorkspaceDetailById(ctx, ws.id);
  });
}

export async function detachRepoFromWorkspace(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string,
  repoIdRaw: string
) {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const repoId = String(repoIdRaw || "").trim();
  if (!repoId) throw new HttpError(400, "repoId is required");

  const existing = listWorkspaceRepos(ctx.db, ws.id);
  const record = getWorkspaceRepoByRepoId(ctx.db, ws.id, repoId);
  if (!record) throw new HttpError(404, "Workspace repo not found", "WORKSPACE_REPO_NOT_FOUND");
  if (existing.length <= 1) {
    throw new HttpError(409, "Workspace must contain at least one repo", "WORKSPACE_LAST_REPO");
  }

  const activeCount = countActiveTerminalsByWorkspace(ctx.db, ws.id);
  if (activeCount > 0) {
    throw new HttpError(409, "Workspace has active terminals", "WORKSPACE_HAS_ACTIVE_TERMINALS");
  }

  const ts = nowMs();
  let nextTerminalCredentialId: string | null | undefined = undefined;
  if (ws.terminalCredentialId) {
    const remaining = existing.filter((item) => item.repoId !== repoId);
    const repoCredentialIds = remaining.map((item) => getRepo(ctx.db, item.repoId)?.credentialId ?? null);
    const resolved = resolveTerminalCredentialId({ repoCredentialIds, useTerminalCredential: true });
    if (resolved !== ws.terminalCredentialId) nextTerminalCredentialId = null;
  }

  await withWorkspaceRepoLock({ workspaceId: ws.id, dirName: record.dirName }, async () => {
    const expectedPath = workspaceRepoDirPath(ctx.dataDir, ws.dirName, record.dirName);
    if (path.resolve(record.path) !== path.resolve(expectedPath)) {
      throw new HttpError(409, "Workspace repo path is invalid; aborting delete.", "WORKSPACE_REPO_PATH_INVALID");
    }

    try {
      await rmrf(expectedPath);
    } catch (err) {
      logger.warn({ workspaceId: ws.id, repoId, path: expectedPath, err }, "remove workspace repo path failed");
      throw new HttpError(409, "Failed to delete workspace repo directory");
    }

    ctx.db.transaction(() => {
      deleteWorkspaceRepoByRepoId(ctx.db, ws.id, repoId);
      if (nextTerminalCredentialId !== undefined) {
        updateWorkspaceTerminalCredentialId(ctx.db, ws.id, nextTerminalCredentialId, ts);
      }
      touchWorkspaceUpdatedAt(ctx.db, ws.id, ts);
    })();
  });

  logger.info({ workspaceId: ws.id, repoId }, "workspace repo detached");
  return getWorkspaceDetailById(ctx, ws.id);
}

export async function deleteWorkspace(ctx: AppContext, logger: FastifyBaseLogger, workspaceId: string) {
  const ws = await getWorkspaceById(ctx, workspaceId);

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

  const expectedPath = workspaceRoot(ctx.dataDir, ws.dirName);
  // 删除前做强校验：即使 DB/path 字段出现脏数据，也不允许越界递归删除。
  if (path.resolve(ws.path) !== path.resolve(expectedPath)) {
    logger.error({ workspaceId: ws.id, wsPath: ws.path, expectedPath }, "workspace path mismatch; abort delete");
    throw new HttpError(409, "Workspace path is invalid; aborting delete.", "WORKSPACE_PATH_INVALID");
  }

  try {
    await rmrf(expectedPath);
  } catch (err) {
    // 删除失败时保留 DB 记录，便于后续重试/排障；避免变成“数据库已删但目录残留”的不可回收状态
    logger.warn({ workspaceId: ws.id, path: expectedPath, err }, "remove workspace path failed");
    throw new HttpError(409, "Failed to delete workspace directory");
  }

  deleteWorkspaceReposByWorkspace(ctx.db, ws.id);
  deleteWorkspaceRecord(ctx.db, ws.id);
  logger.info({ workspaceId: ws.id }, "workspace deleted");
}
