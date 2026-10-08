import path from "node:path";

export function dbPath(dataDir: string) {
  return path.join(dataDir, "db.sqlite");
}

/** Isolated root owned exclusively by the Analytics child process. */
export function analyticsDataRoot(dataDir: string) {
  return path.join(dataDir, "analytics");
}

export function analyticsDbPath(dataDir: string) {
  return path.join(analyticsDataRoot(dataDir), "analytics.sqlite");
}

/** API-owned ordering source for Analytics configuration control messages. */
export function analyticsConfigSourcePath(dataDir: string) {
  return path.join(analyticsDataRoot(dataDir), "config-source.json");
}

/** Reserved for producer-private Model Analytics outboxes. */
export function analyticsModelOutboxRoot(dataDir: string) {
  return path.join(analyticsDataRoot(dataDir), "model-outbox");
}

export function reposRoot(dataDir: string) {
  return path.join(dataDir, "repos");
}

export function repoRoot(dataDir: string, repoId: string) {
  return path.join(reposRoot(dataDir), repoId);
}

export function repoMirrorPath(dataDir: string, repoId: string) {
  return path.join(repoRoot(dataDir, repoId), "mirror.git");
}

export function workspacesRoot(dataDir: string) {
  return path.join(dataDir, "workspaces");
}

export function workspaceRoot(dataDir: string, workspaceDirName: string) {
  return path.join(workspacesRoot(dataDir), workspaceDirName);
}

export function workspaceRepoDirPath(dataDir: string, workspaceDirName: string, dirName: string) {
  return path.join(workspaceRoot(dataDir, workspaceDirName), dirName);
}

export function tmpRoot(dataDir: string) {
  return path.join(dataDir, "tmp");
}

function safePathSegment(raw: string) {
  const value = String(raw || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_");
  if (!value) return "unknown";
  const maxLen = 120;
  return value.length <= maxLen ? value : value.slice(0, maxLen);
}

export function applyPatchUiArtifactsWorkspaceDir(dataDir: string, workspaceId: string) {
  return path.join(tmpRoot(dataDir), "agent", "ui-artifacts", "apply_patch", safePathSegment(workspaceId));
}

export function writeUiArtifactsWorkspaceDir(dataDir: string, workspaceId: string) {
  return path.join(tmpRoot(dataDir), "agent", "ui-artifacts", "write", safePathSegment(workspaceId));
}

export function applyPatchUiArtifactPath(dataDir: string, workspaceId: string, toolCallId: string) {
  const ws = safePathSegment(workspaceId);
  const call = safePathSegment(toolCallId);
  return path.join(tmpRoot(dataDir), "agent", "ui-artifacts", "apply_patch", ws, `${call}.json`);
}

export function writeUiArtifactPath(dataDir: string, workspaceId: string, toolCallId: string) {
  const ws = safePathSegment(workspaceId);
  const call = safePathSegment(toolCallId);
  return path.join(tmpRoot(dataDir), "agent", "ui-artifacts", "write", ws, `${call}.json`);
}

export function compactionSnippetPath(dataDir: string, workspaceId: string, sessionId: string, summaryItemId: number) {
  const ws = safePathSegment(workspaceId);
  const session = safePathSegment(sessionId);
  const id = safePathSegment(String(summaryItemId));
  return path.join(tmpRoot(dataDir), "agent", "compaction-snippets", ws, session, `${id}.txt`);
}

export function sshRoot(dataDir: string) {
  return path.join(dataDir, "ssh");
}

export function sshKnownHostsPath(dataDir: string) {
  return path.join(sshRoot(dataDir), "known_hosts");
}

export function certsRoot(dataDir: string) {
  return path.join(dataDir, "certs");
}

export function caCertPath(dataDir: string) {
  return path.join(certsRoot(dataDir), "ca.pem");
}

export function caBundlePath(dataDir: string) {
  return path.join(certsRoot(dataDir), "ca-bundle.pem");
}

export function keysRoot(dataDir: string) {
  return path.join(dataDir, "keys");
}

export function credentialMasterKeyJsonPath(dataDir: string) {
  return path.join(keysRoot(dataDir), "credential-master-key.json");
}

export function workspaceAgentRoot(workspacePath: string) {
  return path.join(workspacePath, ".agent-workbench");
}

export function workspaceAgentInternalRoot(workspacePath: string) {
  return path.join(workspaceAgentRoot(workspacePath), "internal");
}

export function workspaceAgentArtifactsRoot(workspacePath: string) {
  return path.join(workspaceAgentInternalRoot(workspacePath), "artifacts");
}

export function pluginsRoot(dataDir: string) {
  return path.join(dataDir, "plugins");
}

export function pluginRoot(dataDir: string, pluginId: string) {
  return path.join(pluginsRoot(dataDir), pluginId);
}

export function agentWorkerPidPath(dataDir: string) {
  return path.join(dataDir, "agent-worker.pid");
}

export function agentWorkerSocketPath(dataDir: string) {
  return path.join(dataDir, "agent-worker.sock");
}
