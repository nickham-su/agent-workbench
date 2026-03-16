import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type {
  UpdateWorkspaceExternalSkillRootsSettingsRequest,
  WorkspaceDetail,
  WorkspaceExternalSkillRoot,
  WorkspaceExternalSkillRootsDetectResponse,
  WorkspaceExternalSkillRootsSettingsResponse
} from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import type { AppContext } from "../../app/context.js";
import { newId } from "../../utils/ids.js";
import { nowMs } from "../../utils/time.js";
import { getSettingJson, setSettingJson } from "../settings/settings.store.js";
import { getRepo } from "../repos/repo.store.js";
import { getOriginDefaultBranch, listHeadsBranches } from "../../infra/git/refs.js";
import { withRepoLock } from "../../infra/locks/repoLock.js";
import { cloneFromMirror } from "../../infra/git/clone.js";
import { ensureDir, pathExists, rmrf } from "../../infra/fs/fs.js";
import { agentArchiveWorkspaceDir, workspaceRepoDirPath, workspaceRoot } from "../../infra/fs/paths.js";
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
import { scanReadableTopLevelSkills } from "../agent/top-level-skill.js";
import { withWorkspaceLock } from "../../infra/locks/workspaceLock.js";

const WORKSPACE_EXTERNAL_SKILL_ROOTS_SETTINGS_KEY = "workspace_external_skill_roots_v1";

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
  const baseName = sanitizeDirName(title) || "workspace";
  const wsDirName = uniqueDirName(baseName, (d) => existingDirNames.has(d));
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

  for (const r of repos) {
    const row = getWorkspaceRepoByRepoId(ctx.db, wsId, r.id)!;
    await withWorkspaceRepoLock({ workspaceId: wsId, repoId: r.id }, async () => {
      await ensureRepoMirror(ctx, logger, r.id);
      await ensureDir(row.path);
      await cloneFromMirror(
        {
          mirrorPath: r.mirrorPath,
          workspaceRepoPath: row.path,
          branch: r.defaultBranch,
          logger
        },
        { env: buildGitEnv(ctx, r.credentialId) }
      );
    });
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
    if (existing.some((item) => item.repoId === repoId)) {
      throw new HttpError(409, "Repo already attached to workspace");
    }

    const preferred = formatRepoDisplayName(repo.url) || repo.id;
    const used = new Set(existing.map((item) => item.dirName));
    const dirName = uniqueDirName(preferred, (d) => used.has(d));

    let branch = String(params.branch || "").trim();
    await ensureRepoMirror(ctx, logger, repo.id);

    if (!branch) {
      try {
        branch = await getOriginDefaultBranch(repo.mirrorPath);
      } catch {
        branch = "";
      }
    }
    if (!branch) {
      const heads = await listHeadsBranches(repo.mirrorPath);
      if (heads.length === 1) branch = heads[0]!;
      if (!branch) branch = repo.defaultBranch;
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

    await withWorkspaceRepoLock({ workspaceId: ws.id, repoId: repo.id }, async () => {
      await ensureDir(row.path);
      await cloneFromMirror(
        {
          mirrorPath: repo.mirrorPath,
          workspaceRepoPath: row.path,
          branch,
          logger
        },
        { env: buildGitEnv(ctx, repo.credentialId) }
      );
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
  });
}

export async function detachRepoFromWorkspace(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string,
  repoId: string
) {
  const ws = await getWorkspaceById(ctx, workspaceId);

  return withWorkspaceLock({ workspaceId: ws.id }, async () => {
    const id = String(repoId || "").trim();
    if (!id) throw new HttpError(400, "repoId is required");
    const row = getWorkspaceRepoByRepoId(ctx.db, ws.id, id);
    if (!row) throw new HttpError(404, "Repo not attached to workspace");

    const terms = listTerminalsByWorkspace(ctx.db, ws.id).filter((t) => t.workspaceRepoId === id);
    for (const term of terms) {
      try {
        if (await tmuxHasSession(term.tmuxSession)) {
          await tmuxKillSession(term.tmuxSession);
        }
      } finally {
        deleteTerminalRecord(ctx.db, term.id);
      }
    }

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
}

export async function deleteWorkspace(ctx: AppContext, logger: FastifyBaseLogger, workspaceId: string) {
  const ws = await getWorkspaceById(ctx, workspaceId);

  // 杀掉该 workspace 下所有 tmux 会话并删除 terminal 记录
  const terms = listTerminalsByWorkspace(ctx.db, ws.id);
  for (const term of terms) {
    try {
      if (await tmuxHasSession(term.tmuxSession)) {
        await tmuxKillSession(term.tmuxSession);
      }
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

  const archivePath = agentArchiveWorkspaceDir(ctx.dataDir, ws.id);
  const dataDirAbs = path.resolve(ctx.dataDir);
  const archiveAbs = path.resolve(archivePath);
  const archiveRel = path.relative(dataDirAbs, archiveAbs);
  const isArchiveInsideDataDir = archiveRel.length > 0 && !archiveRel.startsWith("..") && !path.isAbsolute(archiveRel);
  if (!isArchiveInsideDataDir) {
    logger.error({ workspaceId: ws.id, archivePath }, "agent archive path is invalid; skip archive cleanup");
  } else {
    try {
      await rmrf(archivePath);
    } catch (err) {
      // 归档属于附属数据,清理失败不阻塞 workspace 删除主流程。
      logger.warn({ workspaceId: ws.id, archivePath, err }, "remove workspace archive path failed");
    }
  }

  deleteWorkspaceReposByWorkspace(ctx.db, ws.id);
  deleteWorkspaceRecord(ctx.db, ws.id);
  logger.info({ workspaceId: ws.id }, "workspace deleted");
}

type ExternalSkillEnabledRoot = {
  sourceType: "workspace" | "repo";
  repoId?: string;
  rootDir: string;
  enabledAt: number;
};

type ExternalSkillSettingsPayload = {
  workspaces?: Record<string, { enabledRoots?: ExternalSkillEnabledRoot[]; updatedAt?: number }>;
};

type ExternalSkillCandidate = WorkspaceExternalSkillRoot & {
  rootPath: string;
};

function normalizeRelativeRepoPath(raw: string) {
  const normalized = String(raw || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") return "";
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((seg) => seg === "." || seg === "..")) return "";
  return segments.join("/");
}

function normalizeTopLevelSkillRootName(raw: string) {
  const normalized = normalizeRelativeRepoPath(raw);
  if (!normalized) return "";
  if (normalized.includes("/")) return "";
  if (!normalized.toLowerCase().includes("skill")) return "";
  return normalized;
}

function isPathInside(rootPath: string, targetPath: string) {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(withSep);
}

async function resolveWorkspaceRootPath(params: {
  workspace: Pick<WorkspaceRecord, "id" | "path">;
  rootDir: string;
}) {
  const normalizedRootName = normalizeTopLevelSkillRootName(params.rootDir);
  if (!normalizedRootName) return null;
  const rootPath = path.join(params.workspace.path, normalizedRootName);
  const rootStat = await fs.lstat(rootPath).catch((err: any) => {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  });
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  const [workspaceRealPath, rootRealPath] = await Promise.all([
    fs.realpath(params.workspace.path).catch(() => ""),
    fs.realpath(rootPath).catch(() => "")
  ]);
  if (!workspaceRealPath || !rootRealPath) return null;
  if (!isPathInside(workspaceRealPath, rootRealPath)) return null;
  return rootPath;
}

async function resolveWorkspaceRepoBasePath(params: {
  ctx: AppContext;
  workspace: Pick<WorkspaceRecord, "id" | "dirName" | "path">;
  repo: { repoId: string; dirName: string; path: string };
  logger: FastifyBaseLogger;
  source: "detect" | "settings";
}) {
  const expectedPath = workspaceRepoDirPath(params.ctx.dataDir, params.workspace.dirName, params.repo.dirName);
  if (path.resolve(params.repo.path) !== path.resolve(expectedPath)) {
    params.logger.warn(
      { workspaceId: params.workspace.id, repoId: params.repo.repoId, source: params.source },
      "skip repo skill roots: workspace repo path mismatch"
    );
    return null;
  }
  const repoStat = await fs.lstat(params.repo.path).catch((err: any) => {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  });
  if (!repoStat || !repoStat.isDirectory() || repoStat.isSymbolicLink()) return null;
  const [workspaceRealPath, repoRealPath] = await Promise.all([
    fs.realpath(params.workspace.path).catch((err: any) => {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return "";
      throw err;
    }),
    fs.realpath(params.repo.path).catch((err: any) => {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return "";
      throw err;
    })
  ]);
  if (!workspaceRealPath || !repoRealPath) return null;
  if (!isPathInside(workspaceRealPath, repoRealPath)) {
    params.logger.warn(
      { workspaceId: params.workspace.id, repoId: params.repo.repoId, source: params.source },
      "skip repo skill roots: workspace repo realpath is outside workspace"
    );
    return null;
  }
  return params.repo.path;
}

async function scanTopLevelSkillCount(rootPath: string, logger: FastifyBaseLogger) {
  const readableItems = await scanReadableTopLevelSkills({
    rootPath,
    logger,
    logMessage: "failed to read top-level skill summary"
  });
  return readableItems.length;
}

async function listWorkspaceExternalSkillsCandidates(ctx: AppContext, logger: FastifyBaseLogger, ws: WorkspaceRecord) {
  const workspaceEntries = await fs.readdir(ws.path, { withFileTypes: true }).catch((err: any) => {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return [] as Awaited<ReturnType<typeof fs.readdir>>;
    throw err;
  });

  const workspaceCandidates: ExternalSkillCandidate[] = [];
  for (const entry of workspaceEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const rootDir = normalizeTopLevelSkillRootName(String(entry.name || ""));
    if (!rootDir) continue;
    const rootPath = await resolveWorkspaceRootPath({ workspace: ws, rootDir });
    if (!rootPath) continue;
    const topLevelSkillCount = await scanTopLevelSkillCount(rootPath, logger).catch((err: any) => {
      logger.warn({ err, workspaceId: ws.id, rootDir }, "detect workspace skills roots failed to count top-level skills");
      return 0;
    });
    workspaceCandidates.push({
      sourceType: "workspace",
      rootDir,
      displayName: rootDir,
      topLevelSkillCount,
      enabled: false,
      rootPath
    });
  }

  const repos = listWorkspaceRepos(ctx.db, ws.id);
  const repoCandidates: ExternalSkillCandidate[] = [];
  for (const repo of repos) {
    const repoBasePath = await resolveWorkspaceRepoBasePath({ ctx, workspace: ws, repo, logger, source: "detect" });
    if (!repoBasePath) continue;
    let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }> = [];
    try {
      entries = await fs.readdir(repoBasePath, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") continue;
      logger.warn({ err, workspaceId: ws.id, repoId: repo.repoId }, "detect repo skills roots failed to list repo path");
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const rootDir = normalizeTopLevelSkillRootName(String(entry.name || ""));
      if (!rootDir) continue;
      const rootPath = await resolveWorkspaceRepoSkillRootPath({ ctx, workspace: ws, repo, relativePath: rootDir, logger, source: "detect" });
      if (!rootPath) continue;
      const topLevelSkillCount = await scanTopLevelSkillCount(rootPath, logger).catch((err: any) => {
        logger.warn({ err, workspaceId: ws.id, repoId: repo.repoId, rootDir }, "detect repo skills roots failed to count top-level skills");
        return 0;
      });
      repoCandidates.push({
        sourceType: "repo",
        repoId: repo.repoId,
        repoDirName: repo.dirName,
        rootDir,
        displayName: `${repo.dirName}/${rootDir}`,
        topLevelSkillCount,
        enabled: false,
        rootPath
      });
    }
  }

  workspaceCandidates.sort((a, b) => a.rootDir.localeCompare(b.rootDir));
  repoCandidates.sort((a, b) => (a.displayName === b.displayName ? String(a.repoId || "").localeCompare(String(b.repoId || "")) : a.displayName.localeCompare(b.displayName)));
  return [...workspaceCandidates, ...repoCandidates];
}

export async function resolveWorkspaceRepoSkillRootPath(params: {
  ctx: AppContext;
  workspace: Pick<WorkspaceRecord, "id" | "dirName" | "path">;
  repo: { repoId: string; dirName: string; path: string };
  relativePath: string;
  logger: FastifyBaseLogger;
  source: "detect" | "settings" | "prompt";
}) {
  const normalizedRootName = normalizeTopLevelSkillRootName(params.relativePath);
  if (!normalizedRootName) return null;
  const repoBasePath = await resolveWorkspaceRepoBasePath({
    ctx: params.ctx,
    workspace: params.workspace,
    repo: params.repo,
    logger: params.logger,
    source: params.source === "prompt" ? "settings" : params.source
  });
  if (!repoBasePath) return null;
  const rootPath = path.join(repoBasePath, normalizedRootName);
  const rootStat = await fs.lstat(rootPath).catch((err: any) => {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  });
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  const [repoRealPath, rootRealPath] = await Promise.all([
    fs.realpath(repoBasePath).catch(() => ""),
    fs.realpath(rootPath).catch(() => "")
  ]);
  if (!repoRealPath || !rootRealPath) return null;
  if (!isPathInside(repoRealPath, rootRealPath)) {
    params.logger.warn(
      { workspaceId: params.workspace.id, repoId: params.repo.repoId, relativePath: normalizedRootName, source: params.source },
      "skip repo skill root: resolved path outside repo root"
    );
    return null;
  }
  return rootPath;
}

type PromptEnabledExternalSkillRoot = {
  sourceType: "workspace" | "repo";
  repoId?: string;
  rootDir: string;
  rootPath: string;
};

export async function resolveWorkspaceExternalSkillRootPath(params: {
  ctx: AppContext;
  workspace: Pick<WorkspaceRecord, "id" | "dirName" | "path">;
  sourceType: "workspace" | "repo";
  rootDir: string;
  repoId?: string;
  logger: FastifyBaseLogger;
  source: "settings" | "prompt";
}) {
  const normalizedRootName = normalizeTopLevelSkillRootName(params.rootDir);
  if (!normalizedRootName) return null;

  if (params.sourceType === "workspace") {
    const rootPath = await resolveWorkspaceRootPath({ workspace: params.workspace, rootDir: normalizedRootName });
    if (!rootPath) return null;
    return {
      sourceType: "workspace" as const,
      rootDir: normalizedRootName,
      rootPath
    };
  }

  const repoId = String(params.repoId || "").trim();
  if (!repoId) return null;
  const repo = getWorkspaceRepoByRepoId(params.ctx.db, params.workspace.id, repoId);
  if (!repo) return null;
  const rootPath = await resolveWorkspaceRepoSkillRootPath({
    ctx: params.ctx,
    workspace: params.workspace,
    repo,
    relativePath: normalizedRootName,
    logger: params.logger,
    source: params.source
  });
  if (!rootPath) return null;
  return {
    sourceType: "repo" as const,
    repoId,
    rootDir: normalizedRootName,
    rootPath
  };
}

function readExternalSkillsSettings(ctx: AppContext): ExternalSkillSettingsPayload {
  const found = getSettingJson(ctx.db, WORKSPACE_EXTERNAL_SKILL_ROOTS_SETTINGS_KEY);
  const value = found?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { workspaces: {} };
  const workspaces = (value as any).workspaces;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) {
    return { workspaces: {} };
  }
  return { workspaces: workspaces as ExternalSkillSettingsPayload["workspaces"] };
}

function persistExternalSkillsSettings(ctx: AppContext, payload: ExternalSkillSettingsPayload, updatedAt: number) {
  setSettingJson(ctx.db, WORKSPACE_EXTERNAL_SKILL_ROOTS_SETTINGS_KEY, payload, updatedAt);
}

function getExternalRootIdentityKey(input: { sourceType: "workspace" | "repo"; rootDir: string; repoId?: string }) {
  return input.sourceType === "workspace"
    ? `workspace\u0000${input.rootDir}`
    : `repo\u0000${String(input.repoId || "")}\u0000${input.rootDir}`;
}

function listEnabledWorkspaceExternalSkillRootsRaw(ctx: AppContext, workspaceId: string) {
  const settings = readExternalSkillsSettings(ctx);
  const workspace = settings.workspaces?.[workspaceId];
  const entries = Array.isArray(workspace?.enabledRoots) ? workspace.enabledRoots : [];
  const normalized = new Map<string, ExternalSkillEnabledRoot>();
  for (const it of entries) {
    const sourceType = String((it as any)?.sourceType || "").trim() === "workspace" ? "workspace" : "repo";
    const rootDir = normalizeTopLevelSkillRootName(String((it as any)?.rootDir || ""));
    if (!rootDir) continue;
    const repoId = sourceType === "repo" ? String((it as any)?.repoId || "").trim() : undefined;
    if (sourceType === "repo" && !repoId) continue;
    if (sourceType === "workspace" && String((it as any)?.repoId || "").trim()) continue;
    const key = getExternalRootIdentityKey({ sourceType, repoId, rootDir });
    normalized.set(key, {
      sourceType,
      repoId,
      rootDir,
      enabledAt: Number.isFinite(Number((it as any)?.enabledAt)) ? Math.floor(Number((it as any).enabledAt)) : 0
    });
  }
  return [...normalized.values()].sort((a, b) => {
    if (a.sourceType !== b.sourceType) return a.sourceType === "workspace" ? -1 : 1;
    if (a.sourceType === "workspace") return a.rootDir.localeCompare(b.rootDir);
    const repoCmp = String(a.repoId || "").localeCompare(String(b.repoId || ""));
    if (repoCmp !== 0) return repoCmp;
    return a.rootDir.localeCompare(b.rootDir);
  });
}

export async function detectWorkspaceExternalSkillRoots(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string
): Promise<WorkspaceExternalSkillRootsDetectResponse> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const enabledSet = new Set(
    listEnabledWorkspaceExternalSkillRootsRaw(ctx, workspaceId).map((it) =>
      getExternalRootIdentityKey({ sourceType: it.sourceType, repoId: it.repoId, rootDir: it.rootDir })
    )
  );
  const items = (await listWorkspaceExternalSkillsCandidates(ctx, logger, ws)).map((item) => ({
    sourceType: item.sourceType,
    repoId: item.repoId,
    repoDirName: item.repoDirName,
    rootDir: item.rootDir,
    displayName: item.displayName,
    topLevelSkillCount: item.topLevelSkillCount,
    enabled: enabledSet.has(
      getExternalRootIdentityKey({ sourceType: item.sourceType, repoId: item.repoId, rootDir: item.rootDir })
    )
  }));
  return { workspaceId: ws.id, items, updatedAt: nowMs() };
}

export async function getWorkspaceExternalSkillRootsSettings(
  ctx: AppContext,
  workspaceId: string
): Promise<WorkspaceExternalSkillRootsSettingsResponse> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const reposById = new Map(listWorkspaceRepos(ctx.db, ws.id).map((repo) => [repo.repoId, repo] as const));
  const enabled = listEnabledWorkspaceExternalSkillRootsRaw(ctx, workspaceId);
  const enabledRoots = enabled
    .map((it) => {
      if (it.sourceType === "workspace") {
        return {
          sourceType: "workspace" as const,
          rootDir: it.rootDir,
          displayName: it.rootDir,
          enabledAt: it.enabledAt || 0
        };
      }
      const repo = it.repoId ? reposById.get(it.repoId) : null;
      if (!repo || !it.repoId) return null;
      return {
        sourceType: "repo" as const,
        repoId: it.repoId,
        rootDir: it.rootDir,
        displayName: `${repo.dirName}/${it.rootDir}`,
        enabledAt: it.enabledAt || 0
      };
    })
    .filter((it): it is NonNullable<typeof it> => it !== null);

  const settings = readExternalSkillsSettings(ctx);
  const updatedAt = Number(settings.workspaces?.[ws.id]?.updatedAt || 0) || 0;
  return { workspaceId: ws.id, enabledRoots, updatedAt };
}

export async function updateWorkspaceExternalSkillRootsSettings(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string,
  payload: UpdateWorkspaceExternalSkillRootsSettingsRequest
): Promise<WorkspaceExternalSkillRootsSettingsResponse> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const candidates = await listWorkspaceExternalSkillsCandidates(ctx, logger, ws);
  const candidateMap = new Map(candidates.map((it) => [
    getExternalRootIdentityKey({ sourceType: it.sourceType, repoId: it.repoId, rootDir: it.rootDir }),
    it
  ] as const));
  const reposById = new Map(listWorkspaceRepos(ctx.db, ws.id).map((repo) => [repo.repoId, repo] as const));
  const now = nowMs();

  const deduped = new Map<string, ExternalSkillEnabledRoot>();
  for (const item of payload.enabledRoots || []) {
    const sourceType = String((item as any)?.sourceType || "").trim();
    const normalizedSource = sourceType === "workspace" ? "workspace" : sourceType === "repo" ? "repo" : "";
    if (!normalizedSource) {
      throw new HttpError(400, "invalid external skills root source", "WORKSPACE_EXTERNAL_SKILL_ROOT_INVALID");
    }
    const rootDir = normalizeTopLevelSkillRootName(String((item as any)?.rootDir || ""));
    const repoId = normalizedSource === "repo" ? String((item as any)?.repoId || "").trim() : undefined;
    if (!rootDir) {
      throw new HttpError(400, `invalid external skills root: ${normalizedSource}/${rootDir}`, "WORKSPACE_EXTERNAL_SKILL_ROOT_INVALID");
    }
    if (normalizedSource === "workspace" && String((item as any)?.repoId || "").trim()) {
      throw new HttpError(400, "workspace root must not include repoId", "WORKSPACE_EXTERNAL_SKILL_ROOT_INVALID");
    }
    if (normalizedSource === "repo" && !repoId) {
      throw new HttpError(400, "repo root must include repoId", "WORKSPACE_EXTERNAL_SKILL_ROOT_INVALID");
    }

    const key = getExternalRootIdentityKey({ sourceType: normalizedSource, repoId, rootDir });
    const candidate = candidateMap.get(key);
    if (!candidate) {
      throw new HttpError(400, `invalid external skills root: ${normalizedSource}/${repoId || ""}/${rootDir}`, "WORKSPACE_EXTERNAL_SKILL_ROOT_INVALID");
    }

    const resolved = await resolveWorkspaceExternalSkillRootPath({
      ctx,
      workspace: ws,
      sourceType: normalizedSource,
      repoId,
      rootDir,
      logger,
      source: "settings"
    });
    if (!resolved) {
      throw new HttpError(400, `invalid external skills root: ${normalizedSource}/${repoId || ""}/${rootDir}`, "WORKSPACE_EXTERNAL_SKILL_ROOT_INVALID");
    }

    if (normalizedSource === "repo" && repoId && !reposById.has(repoId)) {
      throw new HttpError(400, `invalid external skills root: ${normalizedSource}/${repoId}/${rootDir}`, "WORKSPACE_EXTERNAL_SKILL_ROOT_INVALID");
    }

    deduped.set(key, {
      sourceType: normalizedSource,
      repoId,
      rootDir,
      enabledAt: now
    });
  }

  const settings = readExternalSkillsSettings(ctx);
  const workspaces = { ...(settings.workspaces || {}) };
  workspaces[ws.id] = {
    enabledRoots: [...deduped.values()],
    updatedAt: now
  };
  persistExternalSkillsSettings(ctx, { workspaces }, now);

  const enabledRoots = [...deduped.values()]
    .sort((a, b) => {
      if (a.sourceType !== b.sourceType) return a.sourceType === "workspace" ? -1 : 1;
      if (a.sourceType === "workspace") return a.rootDir.localeCompare(b.rootDir);
      const repoCmp = String(a.repoId || "").localeCompare(String(b.repoId || ""));
      if (repoCmp !== 0) return repoCmp;
      return a.rootDir.localeCompare(b.rootDir);
    })
    .map((it) => ({
      sourceType: it.sourceType,
      ...(it.sourceType === "repo" ? { repoId: it.repoId } : {}),
      rootDir: it.rootDir,
      displayName:
        it.sourceType === "workspace"
          ? it.rootDir
          : `${reposById.get(String(it.repoId || ""))?.dirName || it.repoId}/${it.rootDir}`,
      enabledAt: it.enabledAt
    }));

  return { workspaceId: ws.id, enabledRoots, updatedAt: now };
}

export async function listEnabledWorkspaceExternalSkillRoots(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string
): Promise<PromptEnabledExternalSkillRoot[]> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const enabled = listEnabledWorkspaceExternalSkillRootsRaw(ctx, workspaceId);
  const items: PromptEnabledExternalSkillRoot[] = [];
  for (const item of enabled) {
    const resolved = await resolveWorkspaceExternalSkillRootPath({
      ctx,
      workspace: ws,
      sourceType: item.sourceType,
      repoId: item.repoId,
      rootDir: item.rootDir,
      logger,
      source: "prompt"
    });
    if (!resolved) continue;
    items.push(resolved);
  }
  return items;
}
