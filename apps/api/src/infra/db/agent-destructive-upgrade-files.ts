import path from "node:path";
import { workspaceAgentArtifactsRoot, workspacesRoot } from "../fs/paths.js";
import {
  closeSecureDirectories,
  openSecureRootDirectory,
  removeSecureDirectoryTree,
  type SecureDirectory,
} from "../fs/secure-directory.js";
import type { Db } from "./db.js";

export type AgentUpgradeFileCleanupDiagnostic = {
  code: "AGENT_UPGRADE_FILE_CLEANUP_SKIPPED_UNSAFE" | "AGENT_UPGRADE_FILE_CLEANUP_FAILED";
  target: string;
  reason: string;
};

export type AgentUpgradeFileCleanupResult = {
  diagnostics: AgentUpgradeFileCleanupDiagnostic[];
};

function safeSegment(raw: string) {
  return /^[A-Za-z0-9._-]{1,160}$/.test(raw) && raw !== "." && raw !== "..";
}

async function removeSafeDirectory(params: {
  dataRoot: SecureDirectory;
  relativeSegments: string[];
  target: string;
  diagnostics: AgentUpgradeFileCleanupDiagnostic[];
}) {
  try {
    const result = await removeSecureDirectoryTree({
      root: params.dataRoot,
      relativeSegments: params.relativeSegments,
      quarantineDirectory: ".agent-upgrade-quarantine",
    });
    if (result === "replacement_pending") {
      params.diagnostics.push({
        code: "AGENT_UPGRADE_FILE_CLEANUP_SKIPPED_UNSAFE",
        target: params.target,
        reason: "secure replacement pending in cleanup quarantine",
      });
    }
  } catch (error) {
    params.diagnostics.push({
      code: "AGENT_UPGRADE_FILE_CLEANUP_SKIPPED_UNSAFE",
      target: params.target,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 只按 dataDir 与不可穿越的 dir_name 推导路径，绝不读取或信任 `workspaces.path`。
 * 每个目标在固定 dataDir 目录 fd 下移入 quarantine，递归失败留下同一 quarantine
 * 供后续启动重试；文件系统能力不足、路径被替换或清理失败时保持 pending 并 fail-closed。
 */
export async function cleanupDestructiveAgentUpgradeFiles(db: Db, dataDir: string): Promise<AgentUpgradeFileCleanupResult> {
  const diagnostics: AgentUpgradeFileCleanupDiagnostic[] = [];
  let dataRoot: SecureDirectory;
  try {
    dataRoot = await openSecureRootDirectory(dataDir);
  } catch (error) {
    return {
      diagnostics: [{
        code: "AGENT_UPGRADE_FILE_CLEANUP_SKIPPED_UNSAFE",
        target: path.resolve(dataDir),
        reason: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  try {
    await removeSafeDirectory({ dataRoot, relativeSegments: ["agent", "archive"], target: path.join(dataDir, "agent", "archive"), diagnostics });
    await removeSafeDirectory({ dataRoot, relativeSegments: ["tmp", "agent", "ui-artifacts"], target: path.join(dataDir, "tmp", "agent", "ui-artifacts"), diagnostics });
    await removeSafeDirectory({ dataRoot, relativeSegments: ["tmp", "agent", "compaction-snippets"], target: path.join(dataDir, "tmp", "agent", "compaction-snippets"), diagnostics });

    const rows = db.prepare("select id, dir_name as dirName from workspaces").all() as Array<{ id: string; dirName: string }>;
    for (const row of rows) {
      const dirName = typeof row.dirName === "string" ? row.dirName.trim() : "";
      if (!safeSegment(dirName)) {
        diagnostics.push({
          code: "AGENT_UPGRADE_FILE_CLEANUP_SKIPPED_UNSAFE",
          target: String(row.id),
          reason: "workspace dir_name is not a safe single path segment",
        });
        continue;
      }
      await removeSafeDirectory({
        dataRoot,
        relativeSegments: ["workspaces", dirName, ".agent-workbench", "internal", "artifacts"],
        target: workspaceAgentArtifactsRoot(path.join(workspacesRoot(dataDir), dirName)),
        diagnostics,
      });
    }
  } finally {
    await closeSecureDirectories(dataRoot);
  }
  return { diagnostics };
}
