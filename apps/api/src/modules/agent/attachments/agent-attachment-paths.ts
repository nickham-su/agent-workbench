import path from "node:path";

const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_ATTACHMENT_ID = /^att_[A-Za-z0-9-]+$/;
const SAFE_TEMP_ID = /^tmp_[A-Za-z0-9-]+$/;

function assertPathInside(rootPath: string, targetPath: string) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("Agent attachment path escapes its storage root");
  }
  return target;
}

function assertMatches(value: string, pattern: RegExp, label: string) {
  if (!pattern.test(value)) {
    throw new Error(`Invalid agent attachment ${label}`);
  }
  return value;
}

export function assertAgentAttachmentWorkspaceId(workspaceId: string) {
  return assertMatches(workspaceId, SAFE_WORKSPACE_ID, "workspace ID");
}

export function assertAgentAttachmentId(attachmentId: string) {
  return assertMatches(attachmentId, SAFE_ATTACHMENT_ID, "ID");
}

export function assertAgentAttachmentTempId(tempId: string) {
  return assertMatches(tempId, SAFE_TEMP_ID, "temporary ID");
}

export function agentAttachmentsRoot(dataDir: string) {
  return assertPathInside(path.resolve(dataDir), path.join(dataDir, "agent", "attachments"));
}

export function agentAttachmentTempDir(dataDir: string) {
  return assertPathInside(agentAttachmentsRoot(dataDir), path.join(agentAttachmentsRoot(dataDir), "temp"));
}

export function agentAttachmentTempFilePath(dataDir: string, tempId: string) {
  const name = `${assertAgentAttachmentTempId(tempId)}.part`;
  return assertPathInside(agentAttachmentTempDir(dataDir), path.join(agentAttachmentTempDir(dataDir), name));
}

export function agentAttachmentWorkspaceDir(dataDir: string, workspaceId: string) {
  return assertPathInside(
    agentAttachmentsRoot(dataDir),
    path.join(agentAttachmentsRoot(dataDir), "by_workspace", assertAgentAttachmentWorkspaceId(workspaceId))
  );
}

export function agentAttachmentFilePath(dataDir: string, workspaceId: string, storageKey: string) {
  return assertPathInside(
    agentAttachmentWorkspaceDir(dataDir, workspaceId),
    path.join(agentAttachmentWorkspaceDir(dataDir, workspaceId), assertAgentAttachmentId(storageKey))
  );
}
