import { Type, type Static } from "@sinclair/typebox";
import { PluginToolCanonicalNameSchema } from "./plugin.js";

/** Agent 协议共用的基础值对象；不得承载消息读写投影。 */
export const AgentSessionKindSchema = Type.Union([Type.Literal("primary"), Type.Literal("subtask")]);
export type AgentSessionKind = Static<typeof AgentSessionKindSchema>;

export const AgentMcpToolNameSchema = Type.String({ pattern: "^mcp_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$" });
export const AgentContextToolNameSchema = Type.Union([
  Type.Literal("bash"),
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("apply_patch"),
  Type.Literal("scratchpad"),
  Type.Literal("todolist"),
  Type.Literal("subtask"),
  Type.Literal("skill"),
  Type.Literal("visual_analyze"),
  Type.Literal("archive_read"),
  Type.Literal("archive_search"),
  AgentMcpToolNameSchema,
  PluginToolCanonicalNameSchema
]);
export type AgentContextToolName = Static<typeof AgentContextToolNameSchema>;

export const AgentImageMediaTypeSchema = Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp")]);
export type AgentImageMediaType = Static<typeof AgentImageMediaTypeSchema>;
