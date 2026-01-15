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
import { ensureDir, rmrf } from "../../infra/fs/fs.js";
import { workspaceRepoDirPath, workspaceRoot } from "../../infra/fs/paths.js";
import { ensureRepoMirror } from "../../infra/git/mirror.js";
import { buildGitEnv } from "../../infra/git/gitEnv.js";
import {
  deleteWorkspaceRecord,
  deleteWorkspaceReposByWorkspace,
  getWorkspace,
  insertWorkspace,
  insertWorkspaceRepo,
  listWorkspaceRepos,
  listWorkspaces,
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

function resolveTerminalCredentialId(params: { repoCredentialIds: Array<string | null>; useTerminalCredential?: boolean }) {
  if (!params.useTerminalCredential) return null;
  // 允许“有凭证 repo + 无凭证 repo”的组合：只要所有非空 credentialId 相同即可。
  const ids = params.repoCredentialIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (ids.length === 0) return null;
  const uniq = new Set(ids);
  if (uniq.size !== 1) return null;
  return ids[0]!;
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

  const dirNames = new Set<string>();
  const workspaceId = newId("ws");
  const workspacePath = workspaceRoot(ctx.dataDir, workspaceId);
  const workItems = repos.map(({ repo, branchHint }) => {
    const dirName = pickDirName({ repoUrl: repo.url, existing: dirNames });
    dirNames.add(dirName);
    return {
      repo,
      branchHint,
      dirName,
      path: workspaceRepoDirPath(ctx.dataDir, workspaceId, dirName)
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

  const title = String(params.title || "").trim() || buildDefaultWorkspaceTitle(workItems.map((item) => item.repo.url));
  const ts = nowMs();
  const ws: WorkspaceRecord = {
    id: workspaceId,
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

  const expectedPath = workspaceRoot(ctx.dataDir, ws.id);
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
