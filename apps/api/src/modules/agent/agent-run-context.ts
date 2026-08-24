import path from "node:path";
import type { AppContext } from "../../app/context.js";
import { getWorkspace, listWorkspaceRepos } from "../workspaces/workspace.store.js";

export type AgentWorkspaceRunContext = {
  workspacePath: string;
  workspaceRepoDirNames: string[];
};

// The API and Worker validate independently across their deployment boundary; keep this rule aligned with the Worker helper.
function isSafeWorkspaceRepoDirName(value: string): boolean {
  if (!value || value.trim() !== value || value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\") || value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    return false;
  }
  return !path.isAbsolute(value) && !path.win32.isAbsolute(value);
}

/**
 * Builds the non-persistent filesystem context required to execute an Agent run.
 *
 * Workspace repositories are intentionally represented only by their registered
 * directory names. The Worker combines them with workspacePath, so repository
 * absolute paths never cross the API-to-Worker boundary.
 */
export function getAgentWorkspaceRunContext(ctx: AppContext, workspaceId: string): AgentWorkspaceRunContext | null {
  const workspace = getWorkspace(ctx.db, workspaceId);
  if (!workspace) return null;

  const workspaceRepoDirNames: string[] = [];
  const seen = new Set<string>();
  for (const repo of listWorkspaceRepos(ctx.db, workspaceId)) {
    const dirName = repo.dirName;
    if (!isSafeWorkspaceRepoDirName(dirName) || seen.has(dirName)) continue;
    seen.add(dirName);
    workspaceRepoDirNames.push(dirName);
  }

  return {
    workspacePath: workspace.path,
    workspaceRepoDirNames
  };
}
