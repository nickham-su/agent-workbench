import fs from "node:fs/promises";
import path from "node:path";
import type { AgentImageMediaType } from "@agent-workbench/shared";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_ATTACHMENT_ID = /^att_[A-Za-z0-9-]+$/;

export type AgentAttachmentStorage = Readonly<{
  read(input: {
    workspaceId: string;
    attachmentId: string;
    mediaType: AgentImageMediaType;
  }): Promise<{ bytes: Uint8Array; mediaType: AgentImageMediaType }>;
}>;

function assertSafeIdentifier(value: string, pattern: RegExp, label: string) {
  if (!pattern.test(value)) throw new Error(`invalid attachment ${label}`);
  return value;
}

function assertContained(rootPath: string, targetPath: string) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("attachment path escapes storage root");
  }
  return target;
}

function detectImageMediaType(bytes: Uint8Array): AgentImageMediaType | null {
  const hasPrefix = (prefix: readonly number[]) => bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
  if (hasPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasPrefix([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

export function createAgentAttachmentStorage(dataDir: string): AgentAttachmentStorage {
  const attachmentsRoot = path.resolve(dataDir, "agent", "attachments");
  const workspaceRoot = path.resolve(attachmentsRoot, "by_workspace");

  return Object.freeze({
    async read(input) {
      const workspaceId = assertSafeIdentifier(input.workspaceId, SAFE_WORKSPACE_ID, "workspace ID");
      const attachmentId = assertSafeIdentifier(input.attachmentId, SAFE_ATTACHMENT_ID, "ID");
      const workspacePath = assertContained(workspaceRoot, path.join(workspaceRoot, workspaceId));
      const filePath = assertContained(workspacePath, path.join(workspacePath, attachmentId));

      const workspaceStat = await fs.lstat(workspacePath);
      if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
        throw new Error("attachment workspace path is not a real directory");
      }
      const [dataRealPath, workspaceRealPath, attachmentsRealPath] = await Promise.all([
        fs.realpath(dataDir), fs.realpath(workspacePath), fs.realpath(attachmentsRoot)
      ]);
      assertContained(dataRealPath, attachmentsRealPath);
      assertContained(attachmentsRealPath, workspaceRealPath);

      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("attachment is not a regular file");
      if (stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new Error("attachment size is invalid");

      const fileRealPath = await fs.realpath(filePath);
      assertContained(workspaceRealPath, fileRealPath);
      const bytes = await fs.readFile(fileRealPath);
      if (bytes.length !== stat.size) throw new Error("attachment size changed during read");
      const detectedMediaType = detectImageMediaType(bytes);
      if (!detectedMediaType || detectedMediaType !== input.mediaType) {
        throw new Error("attachment media type does not match its content");
      }
      return { bytes, mediaType: detectedMediaType };
    }
  });
}
