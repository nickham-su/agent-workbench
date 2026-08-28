import { createReadStream } from "node:fs";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AgentCancelSessionRequestSchema,
  AgentContextItemRecordSchema,
  AgentContextItemStatusSchema,
  AgentContextItemsQuerySchema,
  AgentContextItemsResponseSchema,
  AgentControlResultSchema,
  AgentCreateSessionRequestSchema,
  AgentForkSessionRequestSchema,
  AgentRevertSessionRequestSchema,
  AgentInternalCreateSessionRequestSchema,
  AgentSendMessageMultipartPayloadSchema,
  AgentSendMessageRequestSchema,
  AgentSendMessageResponseSchema,
  AgentChannelAllowlistCheckRequestSchema,
  AgentChannelAllowlistCheckResponseSchema,
  type AgentSendMessageRequest,
  AgentClearSessionRequestSchema,
  AgentCompactSessionRequestSchema,
  AgentCompactSessionResponseSchema,
  AgentSessionRecordSchema,
  AgentSessionRunStateSchema,
  AgentUiLocaleSchema,
  AgentProviderNpmSchema,
  AgentRecentSessionsRequestSchema,
  AgentRecentSessionsResponseSchema,
  AgentListAvailableAgentsRequestSchema,
  AgentListAvailableAgentsResponseSchema,
  AgentSessionStatusSummaryRequestSchema,
  AgentSessionContextItemsTailRequestSchema,
  AgentSessionContextItemsTailResponseSchema,
  AgentRecentWorkspacesRequestSchema,
  AgentRecentWorkspacesResponseSchema,
  AgentSessionStatusSummaryResponseSchema,
  AgentSessionModelWorkspaceQuerySchema,
  AgentSessionModelOverridesResponseSchema,
  AgentSessionAgentModelStateSchema,
  UpdateAgentSessionModelOverrideRequestSchema,
  PluginToolCanonicalNameSchema,
  PluginRuntimeSnapshotsResponseSchema,
  PluginToolRpcExecuteRequestSchema,
  PluginToolRpcExecuteResponseSchema,
  PluginToolRpcListRequestSchema,
  PluginToolRpcListResponseSchema,
  ErrorResponseSchema
} from "@agent-workbench/shared";
import {
  AgentApiEndpoints,
  AgentApiContextItemParamsSchema,
  AgentApiCreateContextItemRequestSchema,
  AgentApiCreateContextItemResponseSchema,
  AgentApiUpdateContextItemRequestSchema,
  AgentApiUpdateContextItemResponseSchema,
  AgentApiCompactContextRequestSchema,
  AgentApiCompactContextResponseSchema,
  AgentApiSubtaskPreforkPlanRequestSchema,
  AgentApiSubtaskPreforkPlanResponseSchema,
  AgentApiSubtaskStartRequestSchema,
  AgentApiSubtaskStartResponseSchema,
  AgentApiSubtaskResultRequestSchema,
  AgentApiSubtaskResultResponseSchema,
  AgentApiSubtaskStatusRequestSchema,
  AgentApiSubtaskStatusResponseSchema,
  AgentApiRunCompleteRequestSchema,
  AgentApiRunCompleteResponseSchema,
  AgentApiRunStateRequestSchema,
  AgentApiRunStateResponseSchema,
  AgentApiExecutionProfileRequestSchema,
  AgentApiExecutionProfileResponseSchema,
  AgentApiMessagesContextRequestSchema,
  AgentApiMessagesContextResponseSchema,
  AgentApiPromptContextRequestSchema,
  AgentApiPromptContextResponseSchema,
  type AgentApiContextItemParams,
  type AgentApiCreateContextItemRequest,
  type AgentApiUpdateContextItemRequest,
  type AgentApiCompactContextRequest,
  type AgentApiSubtaskPreforkPlanRequest,
  type AgentApiSubtaskStartRequest,
  type AgentApiSubtaskResultRequest,
  type AgentApiSubtaskStatusRequest,
  type AgentApiRunCompleteRequest,
  type AgentApiRunStateRequest,
  type AgentApiExecutionProfileRequest,
  type AgentApiMessagesContextRequest,
  type AgentApiPromptContextRequest
} from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../../app/errors.js";
import { newSortableId } from "../../../utils/ids.js";
import { AGENT_IMAGE_MAX_COUNT, AGENT_IMAGE_MAX_TOTAL_BYTES } from "../attachments/agent-attachment-limits.js";
import { removeAgentAttachmentTempFile, stageAgentImageUpload } from "../attachments/agent-attachment-storage.js";
import type { AgentPublicRouteDependencies } from "./agent-route-types.js";
import { assertInternalToken, assertOnlyAllowedBodyKeys, assertPluginCaller, AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS, AGENT_PRIMARY_SESSION_FORK_BODY_KEYS } from "./agent-route-auth.js";

const AGENT_MULTIPART_MAX_PARTS = 1 + AGENT_IMAGE_MAX_COUNT;
const AGENT_MULTIPART_MAX_PAYLOAD_BYTES = 64 * 1024;

type NormalizedSendMessageBody = {
  workspaceId: string;
  clientRequestId: string;
  text: string;
  agentId?: string;
  uiLocale?: "zh-CN" | "en-US";
  images: Array<{
    attachmentId: string;
    storageKey: string;
    tempId: string;
    filename: string;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
    byteSize: number;
    position: number;
  }>;
};

function contentTypeBase(value: unknown) {
  return String(value || "").split(";", 1)[0]?.trim().toLowerCase() || "";
}

function hasMultipartBoundary(value: unknown) {
  return /(?:^|;)\s*boundary=(?:"[^"]+"|[^;\s]+)/i.test(String(value || ""));
}

async function drainMultipartFile(stream: AsyncIterable<unknown>) {
  for await (const _chunk of stream) {
    // Consume rejected parts so Busboy can finish the request safely.
  }
}

async function parseAgentMessageMultipart(req: FastifyRequest, dataDir: string): Promise<NormalizedSendMessageBody> {
  const images: NormalizedSendMessageBody["images"] = [];
  let payloadRaw: string | null = null;
  let totalBytes = 0;
  let partCount = 0;
  let invalid: Error | null = null;
  try {
    for await (const part of req.parts()) {
      partCount += 1;
      if (partCount > AGENT_MULTIPART_MAX_PARTS) {
        if (part.type === "file") await drainMultipartFile(part.file);
        invalid ??= new Error("too many multipart parts");
        continue;
      }
      if (invalid) {
        if (part.type === "file") await drainMultipartFile(part.file);
        continue;
      }
      if (part.type === "field") {
        if (part.fieldname !== "payload" || payloadRaw !== null || part.valueTruncated) {
          invalid = new Error("invalid multipart payload field");
          continue;
        }
        const value = typeof part.value === "string" ? part.value : String(part.value);
        if (Buffer.byteLength(value, "utf8") > AGENT_MULTIPART_MAX_PAYLOAD_BYTES) {
          invalid = new Error("multipart payload is too large");
          continue;
        }
        payloadRaw = value;
        continue;
      }
      if (part.fieldname !== "images" || images.length >= AGENT_IMAGE_MAX_COUNT) {
        await drainMultipartFile(part.file);
        invalid = new Error("invalid multipart image field");
        continue;
      }
      const tempId = newSortableId("tmp");
      try {
        const image = await stageAgentImageUpload({
          dataDir,
          tempId,
          attachmentId: newSortableId("att"),
          filename: part.filename,
          stream: part.file,
          onBytes: (byteLength) => {
            totalBytes += byteLength;
            if (totalBytes > AGENT_IMAGE_MAX_TOTAL_BYTES) throw new Error("agent images exceed total byte size limit");
          }
        });
        images.push({ ...image, position: images.length });
      } catch (error) {
        invalid = error instanceof Error ? error : new Error("invalid multipart image");
      }
    }
    if (invalid) throw invalid;
    if (payloadRaw === null) throw new Error("multipart payload is required");
    if (images.length === 0) throw new Error("multipart image is required");
    let payload: unknown;
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      throw new Error("multipart payload is not valid JSON");
    }
    if (!Value.Check(AgentSendMessageMultipartPayloadSchema, payload)) {
      throw new Error("multipart payload is invalid");
    }
    return {
      workspaceId: payload.workspaceId,
      clientRequestId: payload.clientRequestId,
      text: payload.text ?? "",
      ...(payload.agentId ? { agentId: payload.agentId } : {}),
      ...(payload.uiLocale ? { uiLocale: payload.uiLocale } : {}),
      images
    };
  } catch (error) {
    await Promise.all(images.map((image) => removeAgentAttachmentTempFile({ dataDir, tempId: image.tempId }).catch(() => undefined)));
    throw new HttpError(400, error instanceof Error ? error.message : "invalid multipart request");
  }
}

async function removeStagedAgentMessageTemps(dataDir: string, body: NormalizedSendMessageBody) {
  await Promise.all(
    body.images.map((image) => removeAgentAttachmentTempFile({ dataDir, tempId: image.tempId }).catch(() => undefined))
  );
}

async function handleCompactRequest(dependencies: AgentPublicRouteDependencies, sessionId: string, body: { workspaceId: string; clientRequestId: string; agentId?: string; uiLocale?: "zh-CN" | "en-US" }) {
  return await dependencies.service.compactSession({ sessionId, body, runtime: dependencies.runtime });
}

export async function registerAgentPublicRoutes(app: FastifyInstance, dependencies: AgentPublicRouteDependencies) {
  app.get(
    "/api/agent/attachments/:attachmentId/content",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ attachmentId: Type.String({ minLength: 1 }) }),
        response: { 404: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const attachmentId = (req.params as { attachmentId: string }).attachmentId;
      const content = await dependencies.service.getAttachmentContent(attachmentId);
      if (!content) throw new HttpError(404, "Not Found");
      return reply
        .header("Content-Type", content.mediaType)
        .header("Content-Disposition", "inline")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, no-store")
        .header("Content-Length", String(content.byteSize))
        .send(createReadStream(content.filePath));
    }
  );

  app.get(
    "/api/agent/sessions",
    {
      schema: {
        tags: ["agent"],
        querystring: Type.Object({ workspaceId: Type.String({ minLength: 1 }) }),
        response: { 200: Type.Array(AgentSessionRecordSchema), 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const query = req.query as { workspaceId: string };
      return dependencies.service.listSessions(query.workspaceId);
    }
  );

  app.get(
    "/api/agent/sessions/:sessionId/model-overrides",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        querystring: AgentSessionModelWorkspaceQuerySchema,
        response: {
          200: AgentSessionModelOverridesResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      const params = req.params as { sessionId: string };
      const query = req.query as { workspaceId: string };
      return dependencies.service.listSessionModelOverrides({ sessionId: params.sessionId, workspaceId: query.workspaceId });
    }
  );

  app.put(
    "/api/agent/sessions/:sessionId/agents/:agentId/model-override",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          agentId: Type.String({ minLength: 1 })
        }),
        body: UpdateAgentSessionModelOverrideRequestSchema,
        response: {
          200: AgentSessionAgentModelStateSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      const params = req.params as { sessionId: string; agentId: string };
      const body = req.body as { workspaceId: string; providerId: string; modelId: string };
      return dependencies.service.setSessionModelOverride({ sessionId: params.sessionId, agentId: params.agentId, body });
    }
  );

  app.delete(
    "/api/agent/sessions/:sessionId/agents/:agentId/model-override",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          agentId: Type.String({ minLength: 1 })
        }),
        querystring: AgentSessionModelWorkspaceQuerySchema,
        response: {
          200: AgentSessionAgentModelStateSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      const params = req.params as { sessionId: string; agentId: string };
      const query = req.query as { workspaceId: string };
      return dependencies.service.resetSessionModelOverride({
        sessionId: params.sessionId,
        agentId: params.agentId,
        workspaceId: query.workspaceId
      });
    }
  );

  app.post(
    "/api/agent/sessions",
    {
      schema: {
        tags: ["agent"],
        body: AgentCreateSessionRequestSchema,
        response: { 201: AgentSessionRecordSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema }
      },
      preValidation: async (req) => assertOnlyAllowedBodyKeys(req, AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS)
    },
    async (req, reply) => {
      const body = req.body as { workspaceId: string; title?: string };
      const session = dependencies.service.createPrimarySession(body);
      return reply.code(201).send(session);
    }
  );

  app.post(
    "/api/agent/sessions/fork",
    {
      schema: {
        tags: ["agent"],
        body: AgentForkSessionRequestSchema,
        response: {
          201: AgentSessionRecordSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      },
      preValidation: async (req) => assertOnlyAllowedBodyKeys(req, AGENT_PRIMARY_SESSION_FORK_BODY_KEYS)
    },
    async (req, reply) => {
      const body = req.body as {
        fromSessionId: string;
        fromItemId: number;
        mode: "with_archive" | "visible_only";
        title?: string;
      };
      const session = await dependencies.service.forkPrimarySession(body);
      return reply.code(201).send(session);
    }
  );

  app.get(
    "/api/agent/sessions/:sessionId/context-items",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        querystring: AgentContextItemsQuerySchema,
        response: {
          200: AgentContextItemsResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      const query = req.query as {
        afterId?: number;
        tailLimit?: number;
        beforeId?: number;
        limit?: number;
        expectedHeadItemId?: number;
      };
      return dependencies.service.getContextItems(p.sessionId, {
        afterId: query.afterId,
        tailLimit: query.tailLimit,
        beforeId: query.beforeId,
        limit: query.limit,
        expectedHeadItemId: query.expectedHeadItemId
      });
    }
  );

  app.get(
    "/api/agent/sessions/:sessionId/context-items/:itemId",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          itemId: Type.Number({ minimum: 1 })
        }),
        response: { 200: AgentContextItemRecordSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string; itemId: number };
      return dependencies.service.getContextItem(p.sessionId, p.itemId);
    }
  );

  app.get(
    "/api/agent/sessions/:sessionId/context-items/:itemId/apply-patch-artifact",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          itemId: Type.Number({ minimum: 1 })
        }),
        response: { 200: Type.Any(), 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string; itemId: number };
      return await dependencies.service.getApplyPatchUiArtifact({ sessionId: p.sessionId, itemId: p.itemId });
    }
  );

  app.get(
    "/api/agent/sessions/:sessionId/context-items/:itemId/write-artifact",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          itemId: Type.Number({ minimum: 1 })
        }),
        response: { 200: Type.Any(), 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string; itemId: number };
      return await dependencies.service.getWriteUiArtifact({ sessionId: p.sessionId, itemId: p.itemId });
    }
  );

  app.get(
    "/api/agent/sessions/:sessionId/run-state",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        response: { 200: AgentSessionRunStateSchema, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      return dependencies.service.getRunState(p.sessionId);
    }
  );

  app.post(
    "/api/agent/sessions/:sessionId/messages",
    {
      schema: {
        tags: ["agent"],
        description: "Accepts application/json for text-only messages. multipart/form-data is also accepted for image messages and requires one JSON `payload` field plus one to four `images` file fields.",
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        // This is documentation-only media-type mapping. A normal Fastify
        // `body` schema would incorrectly validate multipart streams as the
        // JSON contract before the handler can parse their parts.
        body: {
          content: {
            "application/json": {
              schema: AgentSendMessageRequestSchema
            }
          }
        },
        response: {
          201: AgentSendMessageResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          415: ErrorResponseSchema
        }
      }
    },
    async (req, reply) => {
      const p = req.params as { sessionId: string };
      const contentType = req.headers["content-type"];
      const mediaType = contentTypeBase(contentType);
      if (mediaType === "application/json") {
        const body = req.body as AgentSendMessageRequest;
        if (!Value.Check(AgentSendMessageRequestSchema, body)) throw new HttpError(400, "request body is invalid");
        const result = await dependencies.service.sendMessage({ sessionId: p.sessionId, body: { ...body, images: [] }, runtime: dependencies.runtime });
        return reply.code(201).send(result);
      }
      if (mediaType !== "multipart/form-data") throw new HttpError(415, "Unsupported Media Type");
      if (!hasMultipartBoundary(contentType) || !req.isMultipart()) throw new HttpError(400, "invalid multipart boundary");
      let body: NormalizedSendMessageBody | null = null;
      try {
        body = await parseAgentMessageMultipart(req, dependencies.dataDir);
        const result = await dependencies.service.sendMessage({ sessionId: p.sessionId, body, runtime: dependencies.runtime });
        await removeStagedAgentMessageTemps(dependencies.dataDir, body);
        body = null;
        return reply.code(201).send(result);
      } finally {
        if (body) {
          await removeStagedAgentMessageTemps(dependencies.dataDir, body);
        }
      }
    }
  );

  app.post(
    "/api/agent/sessions/:sessionId/compact",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentCompactSessionRequestSchema,
        response: {
          201: AgentCompactSessionResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema
        }
      }
    },
    async (req, reply) => {
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string; clientRequestId: string; agentId?: string; uiLocale?: "zh-CN" | "en-US" };
      const result = await handleCompactRequest(dependencies, p.sessionId, body);
      return reply.code(201).send(result);
    }
  );

  app.post(
    "/api/internal/agent/sessions/:sessionId/compact",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentCompactSessionRequestSchema,
        response: {
          201: AgentCompactSessionResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema
        }
      }
    },
    async (req, reply) => {
      assertInternalToken(req, dependencies.internalToken);
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string; clientRequestId: string; agentId?: string; uiLocale?: "zh-CN" | "en-US" };
      const result = await handleCompactRequest(dependencies, p.sessionId, body);
      return reply.code(201).send(result);
    }
  );

  app.post(
    "/api/agent/sessions/:sessionId/clear",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentClearSessionRequestSchema,
        response: {
          200: AgentControlResultSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string; reason?: string; uiLocale?: "zh-CN" | "en-US" };
      return dependencies.service.clearSession(p.sessionId, body);
    }
  );

  app.post(
    "/api/agent/sessions/:sessionId/revert",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentRevertSessionRequestSchema,
        response: { 200: AgentControlResultSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string; itemId: number; reason?: string };
      return await dependencies.service.revertSession({ sessionId: p.sessionId, body, runtime: dependencies.runtime });
    }
  );

  app.post(
    "/api/agent/sessions/:sessionId/cancel",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentCancelSessionRequestSchema,
        response: { 200: AgentControlResultSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema }
      }
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string };
      return dependencies.service.cancelSessionWithRuntime({
        sessionId: p.sessionId,
        workspaceId: body.workspaceId,
        runtime: dependencies.runtime
      });
    }
  );
}
