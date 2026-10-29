import { getWorkspacePreviewResourceDescriptor, type AgentTimelineToolExecution, type AgentToolCallPart } from "@agent-workbench/shared";
import { AGENT_IMAGE_MEDIA_TYPES } from "./agentImageAttachments";

/** UI eligibility only; the editor file API remains responsible for filesystem containment. */
export function getAgentViewImagePath(
  part: AgentToolCallPart,
  execution: AgentTimelineToolExecution | null,
): string | null {
  if (part.toolName !== "view_image" || execution?.status !== "completed") return null;
  const path = part.input.path;
  // Pass the Workspace path verbatim: no URL decoding, trimming, or repository guessing.
  if (typeof path !== "string" || !path || path !== path.trim() ||
      /[\\:\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/.test(path) ||
      path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  const descriptor = getWorkspacePreviewResourceDescriptor(path);
  return descriptor && AGENT_IMAGE_MEDIA_TYPES.has(descriptor.mime) ? path : null;
}
