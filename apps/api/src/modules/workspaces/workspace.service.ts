import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type {
  UpdateWorkspaceAgentsInstructionsSettingsRequest,
  UpdateWorkspaceExternalSkillRootsSettingsRequest,
  WorkspaceAgentsInstructionCandidate,
  WorkspaceAgentsInstructionsDetectResponse,
  WorkspaceAgentsInstructionsSettingsResponse,
  WorkspaceDetail,
  WorkspaceExternalSkillRoot,
  WorkspaceExternalSkillRootsDetectResponse,
  WorkspaceExternalSkillRootsSettingsResponse,
  WorkspaceAgentEnablementMode,
  WorkspaceAgentEnablementSettingsResponse,
  UpdateWorkspaceAgentEnablementSettingsRequest,
  WorkspaceAgentEnablementDetectResponse,
  WorkspaceTopLevelSkillsResponse
} from "@agent-workbench/shared";
import type { WorkspaceRecord } from "@agent-workbench/shared";
import { isValidSkillPathSegment } from "@agent-workbench/shared";
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
import { agentArchiveWorkspaceDir, workspaceRepoDirPath, workspaceRoot } from "../../infra/fs/paths.js";
import { removeAgentAttachmentWorkspaceDirectory } from "../agent/attachments/agent-attachment-storage.js";
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
import { parseSkillFrontmatter, scanReadableTopLevelSkills } from "../agent/top-level-skill.js";
import { withWorkspaceLock } from "../../infra/locks/workspaceLock.js";

const WORKSPACE_EXTERNAL_SKILL_ROOTS_SETTINGS_KEY = "workspace_external_skill_roots_v1";
const WORKSPACE_AGENTS_INSTRUCTIONS_SETTINGS_KEY = "workspace_agents_instructions_v1";
const WORKSPACE_AGENT_ENABLEMENT_SETTINGS_KEY = "workspace_agent_enablement_v1";
const BUILTIN_SKILLS_ROOT = "skills";
const WORKSPACE_AGENTS_FILENAME = "AGENTS.md";

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

export async function detectWorkspaceAgentsInstructions(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string
): Promise<WorkspaceAgentsInstructionsDetectResponse> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const enabledSet = new Set(
    listEnabledWorkspaceAgentsInstructionsSourcesRaw(ctx, workspaceId).map((it) =>
      getAgentsSourceIdentityKey({ sourceType: it.sourceType, repoId: it.repoId })
    )
  );
  const candidates = await listWorkspaceAgentsInstructionsCandidates(ctx, logger, ws);
  const items: WorkspaceAgentsInstructionCandidate[] = candidates.map((it) => ({
    sourceType: it.sourceType,
    ...(it.sourceType === "repo" ? { repoId: it.repoId } : {}),
    displayPath: it.displayPath,
    enabled: enabledSet.has(getAgentsSourceIdentityKey({ sourceType: it.sourceType, repoId: it.repoId }))
  }));

  items.sort((a, b) => {
    if (a.sourceType !== b.sourceType) return a.sourceType === "workspace" ? -1 : 1;
    if (a.sourceType === "workspace") return 0;
    return String(a.repoId || "").localeCompare(String(b.repoId || ""));
  });

  return { workspaceId: ws.id, items, updatedAt: nowMs() };
}

export async function getWorkspaceAgentsInstructionsSettings(
  ctx: AppContext,
  workspaceId: string
): Promise<WorkspaceAgentsInstructionsSettingsResponse> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const reposById = new Map(listWorkspaceRepos(ctx.db, ws.id).map((repo) => [repo.repoId, repo] as const));
  const enabled = listEnabledWorkspaceAgentsInstructionsSourcesRaw(ctx, workspaceId);
  const enabledSources = enabled
    .map((it) => {
      if (it.sourceType === "workspace") {
        return {
          sourceType: "workspace" as const,
          displayPath: WORKSPACE_AGENTS_FILENAME,
          enabledAt: it.enabledAt || 0
        };
      }
      if (!it.repoId) return null;
      const repo = reposById.get(it.repoId);
      if (!repo) return null;
      return {
        sourceType: "repo" as const,
        repoId: it.repoId,
        displayPath: `${repo.dirName}/${WORKSPACE_AGENTS_FILENAME}`,
        enabledAt: it.enabledAt || 0
      };
    })
    .filter((it): it is NonNullable<typeof it> => it !== null);

  const settings = readWorkspaceAgentsInstructionsSettings(ctx);
  const updatedAt = Number(settings.workspaces?.[ws.id]?.updatedAt || 0) || 0;
  return { workspaceId: ws.id, enabledSources, updatedAt };
}

export async function updateWorkspaceAgentsInstructionsSettings(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string,
  payload: UpdateWorkspaceAgentsInstructionsSettingsRequest
): Promise<WorkspaceAgentsInstructionsSettingsResponse> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const candidates = await listWorkspaceAgentsInstructionsCandidates(ctx, logger, ws);
  const candidateMap = new Map(
    candidates.map((it) => [getAgentsSourceIdentityKey({ sourceType: it.sourceType, repoId: it.repoId }), it] as const)
  );
  const reposById = new Map(listWorkspaceRepos(ctx.db, ws.id).map((repo) => [repo.repoId, repo] as const));
  const now = nowMs();

  const deduped = new Map<string, WorkspaceAgentsEnabledSource>();
  for (const item of payload.enabledSources || []) {
    const sourceType = String((item as any)?.sourceType || "").trim();
    const normalizedSource = sourceType === "workspace" ? "workspace" : sourceType === "repo" ? "repo" : "";
    if (!normalizedSource) {
      throw new HttpError(400, "invalid AGENTS instructions source", "WORKSPACE_AGENTS_INSTRUCTIONS_INVALID");
    }
    const repoId = normalizedSource === "repo" ? String((item as any)?.repoId || "").trim() : undefined;
    if (normalizedSource === "workspace" && String((item as any)?.repoId || "").trim()) {
      throw new HttpError(400, "workspace source must not include repoId", "WORKSPACE_AGENTS_INSTRUCTIONS_INVALID");
    }
    if (normalizedSource === "repo" && !repoId) {
      throw new HttpError(400, "repo source must include repoId", "WORKSPACE_AGENTS_INSTRUCTIONS_INVALID");
    }

    const key = getAgentsSourceIdentityKey({ sourceType: normalizedSource, repoId });
    const candidate = candidateMap.get(key);
    if (!candidate) {
      throw new HttpError(400, `invalid AGENTS instructions source: ${normalizedSource}/${repoId || ""}`, "WORKSPACE_AGENTS_INSTRUCTIONS_INVALID");
    }
    if (normalizedSource === "repo" && repoId && !reposById.has(repoId)) {
      throw new HttpError(400, `invalid AGENTS instructions source: ${normalizedSource}/${repoId}`, "WORKSPACE_AGENTS_INSTRUCTIONS_INVALID");
    }
    deduped.set(key, {
      sourceType: normalizedSource,
      repoId,
      enabledAt: now
    });
  }

  const settings = readWorkspaceAgentsInstructionsSettings(ctx);
  const workspaces = { ...(settings.workspaces || {}) };
  workspaces[ws.id] = {
    enabledSources: [...deduped.values()],
    updatedAt: now
  };
  persistWorkspaceAgentsInstructionsSettings(ctx, { workspaces }, now);

  const enabledSources = [...deduped.values()]
    .sort((a, b) => {
      if (a.sourceType !== b.sourceType) return a.sourceType === "workspace" ? -1 : 1;
      if (a.sourceType === "workspace") return 0;
      return String(a.repoId || "").localeCompare(String(b.repoId || ""));
    })
    .map((it) => ({
      sourceType: it.sourceType,
      ...(it.sourceType === "repo" ? { repoId: it.repoId } : {}),
      displayPath:
        it.sourceType === "workspace"
          ? WORKSPACE_AGENTS_FILENAME
          : `${reposById.get(String(it.repoId || ""))?.dirName || it.repoId}/${WORKSPACE_AGENTS_FILENAME}`,
      enabledAt: it.enabledAt
    }));

  return { workspaceId: ws.id, enabledSources, updatedAt: now };
}

export async function listEnabledWorkspaceAgentsInstructions(params: {
  ctx: AppContext;
  logger: FastifyBaseLogger;
  workspaceId: string;
}) {
  const ws = await getWorkspaceById(params.ctx, params.workspaceId);
  const enabled = listEnabledWorkspaceAgentsInstructionsSourcesRaw(params.ctx, params.workspaceId);
  const reposById = new Map(listWorkspaceRepos(params.ctx.db, ws.id).map((repo) => [repo.repoId, repo] as const));

  const workspaceItems: Array<{ sourceType: "workspace"; filePath: string; displayPath: string }> = [];
  const repoItems: Array<{ sourceType: "repo"; repoId: string; repoDirName: string; filePath: string; displayPath: string }> = [];

  for (const item of enabled) {
    if (item.sourceType === "workspace") {
      workspaceItems.push({
        sourceType: "workspace",
        filePath: path.join(ws.path, WORKSPACE_AGENTS_FILENAME),
        displayPath: WORKSPACE_AGENTS_FILENAME
      });
      continue;
    }

    if (!item.repoId) continue;
    const repo = reposById.get(item.repoId);
    if (!repo) continue;
    const repoBasePath = await resolveWorkspaceRepoBasePath({ ctx: params.ctx, workspace: ws, repo, logger: params.logger, source: "settings" });
    if (!repoBasePath) continue;
    repoItems.push({
      sourceType: "repo",
      repoId: item.repoId,
      repoDirName: repo.dirName,
      filePath: path.join(repoBasePath, WORKSPACE_AGENTS_FILENAME),
      displayPath: `${repo.dirName}/${WORKSPACE_AGENTS_FILENAME}`
    });
  }

  repoItems.sort((a, b) => {
    const nameCmp = a.repoDirName.localeCompare(b.repoDirName);
    if (nameCmp !== 0) return nameCmp;
    return a.repoId.localeCompare(b.repoId);
  });

  return [
    ...workspaceItems,
    ...repoItems.map((it) => ({
      sourceType: "repo" as const,
      repoId: it.repoId,
      filePath: it.filePath,
      displayPath: it.displayPath
    }))
  ];
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

  const expectedPath = workspaceRoot(ctx.dataDir, ws.dirName);
  // 删除前做强校验：即使 DB/path 字段出现脏数据，也不允许越界递归删除。
  // 同时前置校验，避免 ws.path 异常时先执行 tmux 等副作用操作。
  if (path.resolve(ws.path) !== path.resolve(expectedPath)) {
    logger.error({ workspaceId: ws.id, wsPath: ws.path, expectedPath }, "workspace path mismatch; abort delete");
    throw new HttpError(409, "Workspace path is invalid; aborting delete.", "WORKSPACE_PATH_INVALID");
  }

  // 杀掉该 workspace 下所有 tmux 会话并删除 terminal 记录
  const terms = listTerminalsByWorkspace(ctx.db, ws.id);
  let killFailed = false;
  for (const term of terms) {
    let killedOrMissing = false;
    try {
      const exists = await tmuxHasSession({ sessionName: term.sessionName, cwd: ws.path });
      if (!exists) {
        killedOrMissing = true;
      } else {
        await tmuxKillSession({ sessionName: term.sessionName, cwd: ws.path });
        killedOrMissing = true;
      }
    } catch (err) {
      // kill 失败不应中断整体流程，但也不能无条件删除 terminal 记录，避免产生新不一致
      killFailed = true;
      logger.warn({ workspaceId: ws.id, terminalId: term.id, sessionName: term.sessionName, err }, "tmux kill-session failed");
    }

    if (killedOrMissing) {
      deleteTerminalRecord(ctx.db, term.id);
    }
  }

  if (killFailed) {
    // 保留 workspace 记录与未清理的 terminal，便于用户重试或手工处理；避免“删一半”。
    throw new HttpError(409, "Failed to kill one or more terminal sessions; aborting delete.", "TERMINAL_KILL_FAILED");
  }

  // 先删 DB（事务），避免外键 restrict 导致“删一半”；目录与归档清理改为 best-effort。
  ctx.db.transaction(() => {
    // agent_session.workspace_id 对 workspaces 是 on delete restrict；必须先清理 workspace 下的 session。
    // agent_client_request 没有外键，需手动清理。
    ctx.db.prepare(`delete from agent_client_request where workspace_id = ?`).run(ws.id);
    // 删除 session 会 cascade 掉 context item 及其 attachment relation；附件记录需单独删除。
    ctx.db.prepare(`delete from agent_session where workspace_id = ?`).run(ws.id);
    ctx.db.prepare(`delete from agent_attachment where workspace_id = ?`).run(ws.id);
    deleteWorkspaceReposByWorkspace(ctx.db, ws.id);
    deleteWorkspaceRecord(ctx.db, ws.id);
  })();

  try {
    await rmrf(expectedPath);
  } catch (err) {
    logger.warn({ workspaceId: ws.id, path: expectedPath, err }, "remove workspace path failed");
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
      logger.warn({ workspaceId: ws.id, archivePath, err }, "remove workspace archive path failed");
    }
  }

  try {
    const attachmentCleanup = await removeAgentAttachmentWorkspaceDirectory({ dataDir: ctx.dataDir, workspaceId: ws.id });
    if (attachmentCleanup === "skipped_unsafe") {
      logger.warn({ workspaceId: ws.id }, "workspace attachment directory cleanup skipped due to unsafe path");
    }
  } catch (err) {
    logger.warn({ workspaceId: ws.id, err }, "remove workspace attachment directory failed");
  }

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

type WorkspaceAgentEnablementSettingsPayload = {
  workspaces?: Record<string, { mode?: WorkspaceAgentEnablementMode; enabledAgentIds?: string[]; updatedAt?: number }>;
};

type WorkspaceAgentsEnabledSource = {
  sourceType: "workspace" | "repo";
  repoId?: string;
  enabledAt: number;
};

type WorkspaceAgentsInstructionsSettingsPayload = {
  workspaces?: Record<string, { enabledSources?: WorkspaceAgentsEnabledSource[]; updatedAt?: number }>;
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

function readWorkspaceAgentsInstructionsSettings(ctx: AppContext): WorkspaceAgentsInstructionsSettingsPayload {
  const found = getSettingJson(ctx.db, WORKSPACE_AGENTS_INSTRUCTIONS_SETTINGS_KEY);
  const value = found?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { workspaces: {} };
  const workspaces = (value as any).workspaces;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return { workspaces: {} };
  return { workspaces: workspaces as WorkspaceAgentsInstructionsSettingsPayload["workspaces"] };
}

function persistWorkspaceAgentsInstructionsSettings(
  ctx: AppContext,
  payload: WorkspaceAgentsInstructionsSettingsPayload,
  updatedAt: number
) {
  setSettingJson(ctx.db, WORKSPACE_AGENTS_INSTRUCTIONS_SETTINGS_KEY, payload, updatedAt);
}

function getAgentsSourceIdentityKey(input: { sourceType: "workspace" | "repo"; repoId?: string }) {
  return input.sourceType === "workspace" ? "workspace" : `repo\u0000${String(input.repoId || "")}`;
}

function listEnabledWorkspaceAgentsInstructionsSourcesRaw(ctx: AppContext, workspaceId: string) {
  const settings = readWorkspaceAgentsInstructionsSettings(ctx);
  const workspace = settings.workspaces?.[workspaceId];
  const entries = Array.isArray(workspace?.enabledSources) ? workspace.enabledSources : [];
  const normalized = new Map<string, WorkspaceAgentsEnabledSource>();
  for (const it of entries) {
    const sourceType = String((it as any)?.sourceType || "").trim() === "workspace" ? "workspace" : "repo";
    const repoId = sourceType === "repo" ? String((it as any)?.repoId || "").trim() : undefined;
    if (sourceType === "repo" && !repoId) continue;
    if (sourceType === "workspace" && String((it as any)?.repoId || "").trim()) continue;
    const key = getAgentsSourceIdentityKey({ sourceType, repoId });
    normalized.set(key, {
      sourceType,
      repoId,
      enabledAt: Number.isFinite(Number((it as any)?.enabledAt)) ? Math.floor(Number((it as any).enabledAt)) : 0
    });
  }
  return [...normalized.values()].sort((a, b) => {
    if (a.sourceType !== b.sourceType) return a.sourceType === "workspace" ? -1 : 1;
    if (a.sourceType === "workspace") return 0;
    return String(a.repoId || "").localeCompare(String(b.repoId || ""));
  });
}

async function listWorkspaceAgentsInstructionsCandidates(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  ws: WorkspaceRecord
): Promise<Array<Pick<WorkspaceAgentsInstructionCandidate, "sourceType" | "repoId" | "displayPath">>> {
  const items: Array<Pick<WorkspaceAgentsInstructionCandidate, "sourceType" | "repoId" | "displayPath">> = [];

  const wsFilePath = path.join(ws.path, WORKSPACE_AGENTS_FILENAME);
  const wsStat = await fs.lstat(wsFilePath).catch((err: any) => {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  });
  if (wsStat && wsStat.isFile() && !wsStat.isSymbolicLink()) {
    items.push({ sourceType: "workspace", displayPath: WORKSPACE_AGENTS_FILENAME });
  }

  const repos = listWorkspaceRepos(ctx.db, ws.id);
  for (const repo of repos) {
    const repoBasePath = await resolveWorkspaceRepoBasePath({ ctx, workspace: ws, repo, logger, source: "detect" });
    if (!repoBasePath) continue;
    const repoFilePath = path.join(repoBasePath, WORKSPACE_AGENTS_FILENAME);
    const repoStat = await fs.lstat(repoFilePath).catch((err: any) => {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
      throw err;
    });
    if (repoStat && repoStat.isFile() && !repoStat.isSymbolicLink()) {
      items.push({ sourceType: "repo", repoId: repo.repoId, displayPath: `${repo.dirName}/${WORKSPACE_AGENTS_FILENAME}` });
    }
  }

  return items;
}

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
  const ws = await getWorkspaceById(ctx, workspaceId);
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

export async function listWorkspaceTopLevelSkills(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  workspaceId: string
): Promise<WorkspaceTopLevelSkillsResponse> {
  const ws = await getWorkspaceById(ctx, workspaceId);
  const rows: WorkspaceTopLevelSkillsResponse["items"] = [];

  const builtinRootPath = path.join(ctx.repoRoot, BUILTIN_SKILLS_ROOT);
  const builtin = await scanReadableTopLevelSkills({
    rootPath: builtinRootPath,
    logger,
    logMessage: "failed to read builtin top-level skill summary"
  });
  for (const item of builtin) {
    if (!["builtin", item.entryName].every(isValidSkillPathSegment)) {
      logger.warn({ sourceType: "builtin" }, "skip top-level skill with non-callable identifier");
      continue;
    }
    const parsed = parseSkillFrontmatter(item.text);
    rows.push({
      id: `builtin/${item.entryName}`,
      name: parsed.name.trim() || item.entryName,
      description: parsed.description.trim(),
      sourceType: "builtin"
    });
  }

  const enabledRoots = await listEnabledWorkspaceExternalSkillRoots(ctx, logger, workspaceId);
  for (const root of enabledRoots) {
    const skills = await scanReadableTopLevelSkills({
      rootPath: root.rootPath,
      logger,
      logMessage: "failed to read workspace top-level skill summary"
    });
    const idPrefix = root.sourceType === "workspace"
      ? `workspace/${root.rootDir}`
      : `repo/${root.repoId}/${root.rootDir}`;
    for (const item of skills) {
      const segments = root.sourceType === "workspace"
        ? ["workspace", root.rootDir, item.entryName]
        : ["repo", String(root.repoId || ""), root.rootDir, item.entryName];
      if (!segments.every(isValidSkillPathSegment)) {
        logger.warn({ sourceType: root.sourceType, ...(root.repoId ? { repoId: root.repoId } : {}), rootDir: root.rootDir }, "skip top-level skill with non-callable identifier");
        continue;
      }
      const parsed = parseSkillFrontmatter(item.text);
      rows.push({
        id: `${idPrefix}/${item.entryName}`,
        name: parsed.name.trim() || item.entryName,
        description: parsed.description.trim(),
        sourceType: root.sourceType,
        ...(root.repoId ? { repoId: root.repoId } : {}),
        rootDir: root.rootDir
      });
    }
  }

  rows.sort((a, b) => a.id.localeCompare(b.id));
  return { workspaceId: ws.id, items: rows, updatedAt: nowMs() };
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
