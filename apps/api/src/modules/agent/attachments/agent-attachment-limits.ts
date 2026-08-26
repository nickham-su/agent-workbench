import type { AgentImageMediaType } from "@agent-workbench/shared";

export const AGENT_IMAGE_MAX_COUNT = 4;
export const AGENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const AGENT_IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export const AGENT_IMAGE_MEDIA_TYPES: readonly AgentImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/webp"
];
