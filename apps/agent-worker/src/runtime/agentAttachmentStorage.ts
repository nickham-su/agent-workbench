import type { AgentImageMediaType } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import { readWorkspaceImage } from "./workspaceImageReader.js";

const SAFE_ATTACHMENT_ID = /^att_[A-Za-z0-9-]+$/;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type AgentAttachmentStorage = Readonly<{
  read(input: {
    workspaceId: string;
    runWorkspaceId: string;
    workspacePath: string;
    attachmentId: string;
    path: string;
    mediaType: AgentImageMediaType;
  }): Promise<{ bytes: Uint8Array; mediaType: AgentImageMediaType }>;
}>;

function expectedPath(attachmentId: string, mediaType: AgentImageMediaType) {
  if (!SAFE_ATTACHMENT_ID.test(attachmentId)) throw new Error("invalid attachment ID");
  const ext = mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpg" : mediaType === "image/webp" ? "webp" : null;
  if (!ext) throw new Error("invalid attachment MIME type");
  return `.awb/agent/attachments/${attachmentId}.${ext}`;
}

/** The API pairs a trusted attachment ID and path; recheck before opening the current Run's Workspace. */
export function createAgentAttachmentStorage(): AgentAttachmentStorage {
  return Object.freeze({
    async read(input) {
      if (!SAFE_WORKSPACE_ID.test(input.workspaceId) || input.workspaceId !== input.runWorkspaceId) {
        throw new Error("attachment belongs to a different Workspace");
      }
      if (input.path !== expectedPath(input.attachmentId, input.mediaType)) {
        throw new Error("attachment path does not match its ID and MIME type");
      }
      const image = await readWorkspaceImage({ workspacePath: input.workspacePath, path: input.path });
      if (image.mediaType !== input.mediaType) throw new Error("attachment MIME type does not match its bytes");
      return image;
    }
  });
}
