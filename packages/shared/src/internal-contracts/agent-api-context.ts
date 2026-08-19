import { Type, type Static } from "@sinclair/typebox";
import {
  AgentContextItemKindSchema,
  AgentContextItemOutputSchema,
  AgentContextItemRecordSchema,
  AgentContextItemStatusSchema
} from "../contracts/agent.js";

export const AgentApiContextItemParamsSchema = Type.Object({
  itemId: Type.Number({ minimum: 1 })
});
export type AgentApiContextItemParams = Static<typeof AgentApiContextItemParamsSchema>;

export const AgentApiCreateContextItemRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  runId: Type.Union([Type.String(), Type.Null()]),
  turnId: Type.Union([Type.String(), Type.Null()]),
  step: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  prevId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  kind: AgentContextItemKindSchema,
  status: AgentContextItemStatusSchema,
  output: AgentContextItemOutputSchema,
  createdAt: Type.Optional(Type.Number())
});
export type AgentApiCreateContextItemRequest = Static<typeof AgentApiCreateContextItemRequestSchema>;

export const AgentApiCreateContextItemResponseSchema = Type.Object({
  ok: Type.Literal(true),
  item: AgentContextItemRecordSchema
});
export type AgentApiCreateContextItemResponse = Static<typeof AgentApiCreateContextItemResponseSchema>;

export const AgentApiUpdateContextItemRequestSchema = Type.Object({
  status: Type.Optional(AgentContextItemStatusSchema),
  output: Type.Optional(AgentContextItemOutputSchema),
  updatedAt: Type.Optional(Type.Number())
});
export type AgentApiUpdateContextItemRequest = Static<typeof AgentApiUpdateContextItemRequestSchema>;

export const AgentApiUpdateContextItemResponseSchema = Type.Object({
  ok: Type.Literal(true),
  item: AgentContextItemRecordSchema
});
export type AgentApiUpdateContextItemResponse = Static<typeof AgentApiUpdateContextItemResponseSchema>;

export const AgentApiCompactContextRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  expectedHeadItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  summaryText: Type.String({ minLength: 1 })
});
export type AgentApiCompactContextRequest = Static<typeof AgentApiCompactContextRequestSchema>;

export const AgentApiCompactContextResponseSchema = Type.Object({
  compacted: Type.Boolean(),
  summaryItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  archivedCount: Type.Number({ minimum: 0 })
});
export type AgentApiCompactContextResponse = Static<typeof AgentApiCompactContextResponseSchema>;

export const AgentApiContextItemPathTemplate = "/api/internal/agent/context-items/:itemId";

export function buildAgentApiContextItemPath(itemId: number): string {
  if (!Number.isFinite(itemId) || !Number.isInteger(itemId) || itemId < 1) {
    throw new RangeError("itemId must be a positive integer");
  }
  return AgentApiContextItemPathTemplate.replace(":itemId", String(itemId));
}
