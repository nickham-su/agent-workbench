import fs, { constants } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import {
  compareWorkspaceRelativePathsUtf8,
  parseExternalWorkspaceSkillId,
  parseSkillFrontmatter,
  parseWorkspaceAgentsInstructionPath,
  isValidSkillPathSegment,
  type UpdateWorkspaceContextFilesSettingsRequest,
  type WorkspaceContextFilesSettingsResponse,
  type WorkspaceContextFilesDetectResponse,
  type WorkspaceTopLevelSkillsResponse,
} from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { workspaceRoot } from "../../infra/fs/paths.js";
import { nowMs } from "../../utils/time.js";
import { getSettingJson, setSettingJson } from "../settings/settings.store.js";
import { getWorkspaceById } from "./workspace.service.js";
import { discoverWorkspaceContextFiles, WorkspaceContextScanError, type WorkspaceContextFileDiscovery } from "./workspace-context-discovery.js";
import { scanReadableTopLevelSkills } from "../agent/top-level-skill.js";

const SETTINGS_KEY = "workspace_context_files_v2";
type SettingsPayload = { workspaces?: Record<string, { updatedAt: number; enabledSkillIds: string[]; enabledAgentsInstructionPaths: string[] }> };
export type AvailableExternalSkill = { skillId: string; skillDirectoryPath: string; name: string; description: string };
export type ReadAgentsInstruction = (source: { filePath: string; displayPath: string; workspacePath: string }) => Promise<{ filePath: string; displayPath: string; content: string } | null>;

async function workspaceContext(ctx: AppContext, workspaceId: string) {
  const ws = await getWorkspaceById(ctx, workspaceId);
  return { ws, workspacePath: workspaceRoot(ctx.dataDir, ws.dirName) };
}

export function readWorkspaceContextFilesSettings(ctx: AppContext, workspaceId: string): WorkspaceContextFilesSettingsResponse {
  const value = getSettingJson(ctx.db, SETTINGS_KEY)?.value as SettingsPayload | null;
  const setting = value?.workspaces?.[workspaceId];
  const enabledSkillIds = Array.isArray(setting?.enabledSkillIds) ? setting.enabledSkillIds.filter((item): item is string => typeof item === "string") : [];
  const enabledAgentsInstructionPaths = Array.isArray(setting?.enabledAgentsInstructionPaths) ? setting.enabledAgentsInstructionPaths.filter((item): item is string => typeof item === "string") : [];
  return { workspaceId, updatedAt: Number.isSafeInteger(setting?.updatedAt) && setting!.updatedAt >= 0 ? setting!.updatedAt : 0, enabledSkillIds, enabledAgentsInstructionPaths };
}

async function completeDiscovery(workspacePath: string): Promise<WorkspaceContextFileDiscovery> {
  try {
    return await discoverWorkspaceContextFiles(workspacePath);
  } catch (error) {
    if (error instanceof WorkspaceContextScanError) {
      throw new HttpError(409, "Workspace context scan failed", "WORKSPACE_CONTEXT_SCAN_FAILED");
    }
    throw error;
  }
}

export async function detectWorkspaceContextFiles(ctx: AppContext, workspaceId: string): Promise<WorkspaceContextFilesDetectResponse> {
  const { workspacePath } = await workspaceContext(ctx, workspaceId);
  const discovered = await completeDiscovery(workspacePath);
  const settings = readWorkspaceContextFilesSettings(ctx, workspaceId);
  const skills = new Set(settings.enabledSkillIds);
  const instructions = new Set(settings.enabledAgentsInstructionPaths);
  return {
    workspaceId, updatedAt: settings.updatedAt,
    skills: discovered.skills.map((skill) => ({ ...skill, enabled: skills.has(skill.skillId) })),
    agentsInstructions: discovered.agentsInstructions.map((instruction) => ({ ...instruction, enabled: instructions.has(instruction.path) })),
  };
}

export async function getWorkspaceContextFilesSettings(ctx: AppContext, workspaceId: string) {
  await getWorkspaceById(ctx, workspaceId);
  return readWorkspaceContextFilesSettings(ctx, workspaceId);
}

export async function updateWorkspaceContextFilesSettings(ctx: AppContext, workspaceId: string, input: UpdateWorkspaceContextFilesSettingsRequest): Promise<WorkspaceContextFilesSettingsResponse> {
  const { workspacePath } = await workspaceContext(ctx, workspaceId);
  const discovered = await completeDiscovery(workspacePath);
  const validSkills = new Set(discovered.skills.map((item) => item.skillId));
  const validInstructions = new Set(discovered.agentsInstructions.map((item) => item.path));
  const selectedSkills = input.enabledSkillIds;
  const selectedInstructions = input.enabledAgentsInstructionPaths;
  if (selectedSkills.some((id) => !parseExternalWorkspaceSkillId(id) || !validSkills.has(id))
    || selectedInstructions.some((item) => !parseWorkspaceAgentsInstructionPath(item) || !validInstructions.has(item))
    || new Set(selectedSkills).size !== selectedSkills.length || new Set(selectedInstructions).size !== selectedInstructions.length) {
    throw new HttpError(400, "Invalid context selection", "INVALID_CONTEXT_SELECTION");
  }
  const updatedAt = nowMs();
  const next: WorkspaceContextFilesSettingsResponse = {
    workspaceId, updatedAt,
    enabledSkillIds: [...selectedSkills].sort(compareWorkspaceRelativePathsUtf8),
    enabledAgentsInstructionPaths: [...selectedInstructions].sort(compareWorkspaceRelativePathsUtf8),
  };
  const previous = getSettingJson(ctx.db, SETTINGS_KEY)?.value as SettingsPayload | null;
  setSettingJson(ctx.db, SETTINGS_KEY, {
    workspaces: { ...(previous?.workspaces && typeof previous.workspaces === "object" ? previous.workspaces : {}), [workspaceId]: {
      updatedAt, enabledSkillIds: next.enabledSkillIds, enabledAgentsInstructionPaths: next.enabledAgentsInstructionPaths,
    } },
  }, updatedAt);
  return next;
}

/** The full current scan is the only authority for nested-skill eligibility. */
export async function resolveWorkspaceContextCandidates(ctx: AppContext, workspaceId: string) {
  const { workspacePath } = await workspaceContext(ctx, workspaceId);
  const [discovered, settings] = await Promise.all([completeDiscovery(workspacePath), Promise.resolve(readWorkspaceContextFilesSettings(ctx, workspaceId))]);
  return { workspacePath, discovered, settings };
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Before and after open, recheck physical containment and identity. Never expose physical paths in diagnostics. */
export async function readSafeContextFile(workspacePath: string, relativePath: string, maxBytes?: number): Promise<Buffer | null> {
  const absolute = path.join(workspacePath, ...relativePath.split("/"));
  let fd: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const rootBefore = await fs.lstat(workspacePath);
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) return null;
    const root = await fs.realpath(workspacePath);
    // A metadata scan is not a lease: recheck every ancestor when resolving the summary.
    const ancestors: Array<{ path: string; dev: number; ino: number }> = [];
    let parent = workspacePath;
    for (const segment of relativePath.split("/").slice(0, -1)) {
      parent = path.join(parent, segment);
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      ancestors.push({ path: parent, dev: stat.dev, ino: stat.ino });
    }
    const before = await fs.lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink() || !contained(root, await fs.realpath(absolute))) return null;
    fd = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await fd.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    const content = maxBytes == null ? await fd.readFile() : await (async () => {
      const buf = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buf.length) {
        const read = await fd!.read(buf, size, buf.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      return buf.subarray(0, size);
    })();
    for (const ancestor of ancestors) {
      const stat = await fs.lstat(ancestor.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== ancestor.dev || stat.ino !== ancestor.ino) return null;
    }
    const rootAfter = await fs.lstat(workspacePath);
    if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink() || rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino || await fs.realpath(workspacePath) !== root) return null;
    const after = await fs.lstat(absolute);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || !contained(root, await fs.realpath(absolute))) return null;
    return content;
  } catch {
    return null;
  } finally {
    await fd?.close().catch(() => undefined);
  }
}

export async function resolveAvailableExternalSkills(input: { workspacePath: string; discovered: WorkspaceContextFileDiscovery; enabledSkillIds: string[]; logger: FastifyBaseLogger }): Promise<AvailableExternalSkill[]> {
  const enabled = new Set(input.enabledSkillIds);
  const result: AvailableExternalSkill[] = [];
  for (const candidate of input.discovered.skills) {
    if (!enabled.has(candidate.skillId)) continue;
    const bytes = await readSafeContextFile(input.workspacePath, candidate.skillFilePath);
    if (!bytes || bytes.includes(0)) {
      input.logger.warn({ skillId: candidate.skillId }, "unavailable external skill summary");
      continue;
    }
    const parsed = parseSkillFrontmatter(bytes.toString("utf8"));
    result.push({ skillId: candidate.skillId, skillDirectoryPath: path.join(input.workspacePath, ...candidate.skillId.split("/")), name: parsed.name.trim() || candidate.skillId.split("/").at(-1)!, description: parsed.description.trim() });
  }
  return result;
}

/** Used for static prompts only; /skills/top-level never reads AGENTS files. */
export async function resolvePromptWorkspaceContext(ctx: AppContext, logger: FastifyBaseLogger, workspaceId: string, readInstruction: ReadAgentsInstruction) {
  const { workspacePath, discovered, settings } = await resolveWorkspaceContextCandidates(ctx, workspaceId);
  const enabled = new Set(settings.enabledAgentsInstructionPaths);
  const availableExternalSkills = await resolveAvailableExternalSkills({ workspacePath, discovered, enabledSkillIds: settings.enabledSkillIds, logger });
  const sources = discovered.agentsInstructions.filter((item) => enabled.has(item.path));
  const enabledAgentsInstructions = (await Promise.all(sources.map((item) => readInstruction({ filePath: path.join(workspacePath, ...item.path.split("/")), displayPath: item.path, workspacePath })))).filter((item): item is NonNullable<typeof item> => item !== null);
  return { enabledAgentsInstructions, availableExternalSkills };
}

export async function listWorkspaceContextTopLevelSkills(ctx: AppContext, logger: FastifyBaseLogger, workspaceId: string): Promise<WorkspaceTopLevelSkillsResponse> {
  const { workspacePath, discovered, settings } = await resolveWorkspaceContextCandidates(ctx, workspaceId);
  const builtin = await scanReadableTopLevelSkills({ rootPath: path.join(ctx.repoRoot, "skills"), logger, logMessage: "failed to read builtin top-level skill summary" });
  const items: WorkspaceTopLevelSkillsResponse["items"] = [];
  for (const item of builtin) {
    if (!isValidSkillPathSegment(item.entryName)) continue;
    const parsed = parseSkillFrontmatter(item.text);
    items.push({ id: `builtin/${item.entryName}`, name: parsed.name.trim() || item.entryName, description: parsed.description.trim(), sourceType: "builtin" });
  }
  const external = await resolveAvailableExternalSkills({ workspacePath, discovered, enabledSkillIds: settings.enabledSkillIds, logger });
  for (const item of external) items.push({ id: item.skillId, name: item.name, description: item.description, sourceType: "workspace" });
  items.sort((a, b) => compareWorkspaceRelativePathsUtf8(a.id, b.id));
  return { workspaceId, items, updatedAt: nowMs() };
}
