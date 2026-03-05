import path from "node:path";

export function dbPath(dataDir: string) {
  return path.join(dataDir, "db.sqlite");
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

export function agentArchiveRoot(dataDir: string) {
  return path.join(dataDir, "agent", "archive");
}

export function agentArchiveWorkspaceDir(dataDir: string, workspaceId: string) {
  const ws = safePathSegment(workspaceId);
  return path.join(agentArchiveRoot(dataDir), ws);
}

export function agentArchiveSessionDir(dataDir: string, workspaceId: string, sessionId: string) {
  const session = safePathSegment(sessionId);
  return path.join(agentArchiveWorkspaceDir(dataDir, workspaceId), session);
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

export function agentWorkerPidPath(dataDir: string) {
  return path.join(dataDir, "agent-worker.pid");
}

export function agentWorkerSocketPath(dataDir: string) {
  return path.join(dataDir, "agent-worker.sock");
}
