import type { AgentApiPromptContextResponse } from "./internal-contracts/agent-api-read.js";
import type { AgentEffectiveInputPolicy } from "./internal-contracts/agent-input-binding.js";

/** One projection rule for main prompts, replay and compaction; no filesystem or DB access. */
export function effectiveUserInput(input: {
  messageId: string;
  triggerMessageId: string | null;
  policy?: AgentEffectiveInputPolicy;
}) {
  const receipt = input.policy?.inputs.find(item => item.messageId === input.messageId);
  return {
    realAttachments: input.messageId === input.triggerMessageId || receipt?.currentRunInput === true
  };
}

export type { AgentEffectiveInputPolicy };

/** Same trusted user projection for API history and Worker candidate preparation. */
export function projectEffectiveUserContent(input: {
  workspaceId: string; text: string;
  images: readonly { attachmentId: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; filename: string; path: string }[];
}): Extract<AgentApiPromptContextResponse["messages"][number], { role: "user" }>["content"] {
  if (input.images.length > 4) throw new Error("User input exceeds the trusted image count");
  if (!input.images.length) return input.text;
  const text = { type: "text" as const, text: input.text || `[The user sent ${input.images.length} image attachment(s) without accompanying text.]` };
  const content: Array<{ type: "text"; text: string } | { type: "attachment_ref"; workspaceId: string; attachmentId: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; filename: string; path: string }> = [text];
  for (const [index, image] of input.images.entries()) {
    if (!image.path) throw new Error("Current input image has no trusted Workspace path");
    text.text += `\n\n[Image attachment ${index + 1} included in this run. Workspace-relative path: ${image.path}]`;
    content.push({ type: "attachment_ref", workspaceId: input.workspaceId, ...image });
  }
  return content as Exclude<ReturnType<typeof projectEffectiveUserContent>, string>;
}
