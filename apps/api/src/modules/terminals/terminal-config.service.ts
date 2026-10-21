import fs from "node:fs/promises";
import path from "node:path";
import { isWorkspaceEnvironmentUnicodeValid, TERMINAL_CONFIG_COMMAND_MAX_LENGTH, type TerminalConfigInput, type TerminalConfigRecord, type UpdateTerminalConfigRequest } from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import type { AppContext } from "../../app/context.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";
import { newId } from "../../utils/ids.js";
import { getWorkspace } from "../workspaces/workspace.store.js";
import * as store from "./terminal-config.store.js";

export function normalizeTerminalConfig(input: TerminalConfigInput): TerminalConfigInput {
  const name = input.name.trim();
  const cwd = input.cwd.trim() || ".";
  if (!name || !isWorkspaceEnvironmentUnicodeValid(name) || name.length > 120 || /[\0\r\n]/.test(name)) throw new HttpError(400, "Invalid configuration name", "TERMINAL_CONFIG_INVALID");
  if (!input.command.trim() || input.command.length > TERMINAL_CONFIG_COMMAND_MAX_LENGTH || input.command.includes("\0") || !isWorkspaceEnvironmentUnicodeValid(input.command)) {
    throw new HttpError(400, "Invalid startup command", "TERMINAL_CONFIG_INVALID");
  }
  if (cwd.length > 4096 || !isWorkspaceEnvironmentUnicodeValid(cwd) || /[\0\r\n\\]/.test(cwd) || path.posix.isAbsolute(cwd) || path.win32.isAbsolute(cwd)
    || cwd.split("/").includes("..")) throw new HttpError(400, "Working directory must be inside the Workspace", "TERMINAL_CONFIG_CWD_INVALID");
  return { name, cwd: path.posix.normalize(cwd), command: input.command };
}
export async function resolveTerminalConfigCwd(root: string, cwd: string): Promise<string> {
  try {
    const relative = normalizeTerminalConfig({ name: "cwd", cwd, command: "true" }).cwd;
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid root");
    const realRoot = await fs.realpath(root);
    const target = await fs.realpath(path.resolve(realRoot, relative));
    const rel = path.relative(realRoot, target);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !(await fs.stat(target)).isDirectory()) throw new Error("invalid");
    return target;
  } catch {
    throw new HttpError(400, "Working directory is missing or outside the Workspace", "TERMINAL_CONFIG_CWD_INVALID");
  }
}
export function requireTerminalConfigWorkspace(ctx: AppContext, workspaceId: string) {
  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");
  return ws;
}
export function requireTerminalConfig(ctx: AppContext, workspaceId: string, id: string): TerminalConfigRecord {
  const config = store.getTerminalConfig(ctx.db, workspaceId, id);
  if (!config) throw new HttpError(404, "Terminal configuration not found");
  return config;
}
export async function listWorkspaceTerminalConfigs(ctx: AppContext, workspaceId: string) {
  return workspaceLifecycleCoordinator.withAdmission(workspaceId, async () => {
    requireTerminalConfigWorkspace(ctx, workspaceId);
    return store.listTerminalConfigs(ctx.db, workspaceId);
  });
}
export async function saveWorkspaceTerminalConfig(ctx: AppContext, workspaceId: string, input: TerminalConfigInput | UpdateTerminalConfigRequest, id?: string) {
  return workspaceLifecycleCoordinator.withMutation(workspaceId, async () => {
    requireTerminalConfigWorkspace(ctx, workspaceId);
    const existing = id ? requireTerminalConfig(ctx, workspaceId, id) : null;
    const values = normalizeTerminalConfig({ ...existing, ...input } as TerminalConfigInput);
    const now = Date.now();
    const config: TerminalConfigRecord = { ...values, id: existing?.id ?? newId("tc"), workspaceId, createdAt: existing?.createdAt ?? now, updatedAt: now };
    if (existing) store.updateTerminalConfig(ctx.db, config);
    else store.insertTerminalConfig(ctx.db, config);
    return config;
  });
}
export async function deleteWorkspaceTerminalConfig(ctx: AppContext, workspaceId: string, id: string) {
  return workspaceLifecycleCoordinator.withMutation(workspaceId, async () => {
    requireTerminalConfigWorkspace(ctx, workspaceId);
    requireTerminalConfig(ctx, workspaceId, id);
    store.deleteTerminalConfig(ctx.db, workspaceId, id);
  });
}
