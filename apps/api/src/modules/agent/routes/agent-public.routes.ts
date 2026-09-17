import { createReadStream } from "node:fs";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AgentCancelSessionRequestSchema,
  AgentCreateSessionRequestSchema,
  AgentUpdateSessionTitleRequestSchema,
  AgentForkSessionRequestSchema,
  AgentRevertSessionRequestSchema,
  AgentInternalCreateSessionRequestSchema,
  AgentSendMessageMultipartPayloadSchema,
  AgentSendMessageRequestSchema,
  AgentSendMessageResponseSchema,
  AgentChannelAllowlistCheckRequestSchema,
  AgentChannelAllowlistCheckResponseSchema,
  type AgentSendMessageRequest,
  type AgentUpdateSessionTitleRequest,
  AgentSessionRecordSchema,
  AgentUiLocaleSchema,
  AgentProviderNpmSchema,
  AgentRecentSessionsRequestSchema,
  AgentRecentSessionsResponseSchema,
  AgentListAvailableAgentsRequestSchema,
  AgentListAvailableAgentsResponseSchema,
  AgentRecentWorkspacesRequestSchema,
  AgentRecentWorkspacesResponseSchema,
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
  ErrorResponseSchema,
} from "@agent-workbench/shared/internal-contracts/agent-api-session";
import {
  AgentCompactSessionRequestSchema,
  AgentCompactSessionResponseSchema,
  AgentMessageControlResultSchema,
  AgentMessageDetailRequestSchema,
  AgentMessageSessionRunStateSchema,
  AgentMessageDetailResponseSchema,
  AgentTimelineDeltaRequestSchema,
  AgentTimelineDeltaResponseSchema,
  AgentToolExecutionDetailSchema
} from "@agent-workbench/shared";
import {
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
  AgentApiExecutionProfileRequestSchema,
  AgentApiExecutionProfileResponseSchema,
  AgentApiMessagesContextRequestSchema,
  AgentApiMessagesContextResponseSchema,
  AgentApiPromptContextRequestSchema,
  AgentApiPromptContextResponseSchema,
  type AgentApiSubtaskPreforkPlanRequest,
  type AgentApiSubtaskStartRequest,
  type AgentApiSubtaskResultRequest,
  type AgentApiSubtaskStatusRequest,
  type AgentApiRunCompleteRequest,
  type AgentApiExecutionProfileRequest,
  type AgentApiMessagesContextRequest,
  type AgentApiPromptContextRequest,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../../app/errors.js";
import { newSortableId } from "../../../utils/ids.js";
import {
  AGENT_IMAGE_MAX_COUNT,
  AGENT_IMAGE_MAX_TOTAL_BYTES,
} from "../attachments/agent-attachment-limits.js";
import {
  removeAgentAttachmentTempFile,
  stageAgentImageUpload,
} from "../attachments/agent-attachment-storage.js";
import type { AgentPublicRouteDependencies } from "./agent-route-types.js";
import {
  assertInternalToken,
  assertOnlyAllowedBodyKeys,
  assertPluginCaller,
  AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS,
  AGENT_PRIMARY_SESSION_FORK_BODY_KEYS,
  AGENT_SESSION_TITLE_UPDATE_BODY_KEYS,
} from "./agent-route-auth.js";

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
  return (
    String(value || "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase() || ""
  );
}

function hasMultipartBoundary(value: unknown) {
  return /(?:^|;)\s*boundary=(?:"[^"]+"|[^;\s]+)/i.test(String(value || ""));
}

async function drainMultipartFile(stream: AsyncIterable<unknown>) {
  for await (const _chunk of stream) {
    // Consume rejected parts so Busboy can finish the request safely.
  }
}

async function parseAgentMessageMultipart(
  req: FastifyRequest,
  dataDir: string,
): Promise<NormalizedSendMessageBody> {
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
        if (
          part.fieldname !== "payload" ||
          payloadRaw !== null ||
          part.valueTruncated
        ) {
          invalid = new Error("invalid multipart payload field");
          continue;
        }
        const value =
          typeof part.value === "string" ? part.value : String(part.value);
        if (
          Buffer.byteLength(value, "utf8") > AGENT_MULTIPART_MAX_PAYLOAD_BYTES
        ) {
          invalid = new Error("multipart payload is too large");
          continue;
        }
        payloadRaw = value;
        continue;
      }
      if (
        part.fieldname !== "images" ||
        images.length >= AGENT_IMAGE_MAX_COUNT
      ) {
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
          },
        });
        images.push({ ...image, position: images.length });
        // 当前文件必须被完整消费，否则 Busboy 会中止整个 multipart 请求并丢失稳定错误语义。
        if (totalBytes > AGENT_IMAGE_MAX_TOTAL_BYTES) {
          invalid = new HttpError(400, "agent images exceed total byte size limit", "AGENT_IMAGE_TOTAL_BYTES_EXCEEDED");
        }
      } catch (error) {
        await drainMultipartFile(part.file);
        invalid =
          error instanceof Error ? error : new Error("invalid multipart image");
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
      images,
    };
  } catch (error) {
    await Promise.all(
      images.map((image) =>
        removeAgentAttachmentTempFile({ dataDir, tempId: image.tempId }).catch(
          () => undefined,
        ),
      ),
    );
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "invalid multipart request",
    );
  }
}

async function removeStagedAgentMessageTemps(
  dataDir: string,
  body: NormalizedSendMessageBody,
) {
  await Promise.all(
    body.images.map((image) =>
      removeAgentAttachmentTempFile({ dataDir, tempId: image.tempId }).catch(
        () => undefined,
      ),
    ),
  );
}

async function handleCompactRequest(
  dependencies: AgentPublicRouteDependencies,
  sessionId: string,
  body: {
    workspaceId: string;
    clientRequestId: string;
    agentId?: string;
    uiLocale?: "zh-CN" | "en-US";
  },
) {
  return await dependencies.service.compactSession({
    sessionId,
    body,
    runtime: dependencies.runtime,
  });
}

export async function registerAgentPublicRoutes(
  app: FastifyInstance,
  dependencies: AgentPublicRouteDependencies,
) {
  app.get(
    "/api/agent/sessions/:sessionId/attachments/:attachmentId/content",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          attachmentId: Type.String({ minLength: 1 }),
        }),
        querystring: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
        }),
        response: { 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const params = req.params as { sessionId: string; attachmentId: string };
      const query = req.query as { workspaceId: string };
      const content = await dependencies.service.getAttachmentContent({
        workspaceId: query.workspaceId,
        sessionId: params.sessionId,
        attachmentId: params.attachmentId,
      });
      if (!content) throw new HttpError(404, "Not Found");
      return reply
        .header("Content-Type", content.mediaType)
        .header("Content-Disposition", "inline")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, no-store")
        .header("Content-Length", String(content.byteSize))
        .send((() => {
          const stream = createReadStream(content.filePath, {
            fd: content.handle.fd,
            autoClose: false,
          });
          const close = () => { void content.handle.close().catch(() => undefined); };
          stream.once("end", close);
          stream.once("error", close);
          stream.once("close", close);
          return stream;
        })());
    },
  );

  app.get(
    "/api/agent/sessions",
    {
      schema: {
        tags: ["agent"],
        querystring: Type.Object({
          workspaceId: Type.String({ minLength: 1 }),
        }),
        response: {
          200: Type.Array(AgentSessionRecordSchema),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req) => {
      const query = req.query as { workspaceId: string };
      return dependencies.service.listSessions(query.workspaceId);
    },
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
          409: ErrorResponseSchema,
        },
      },
    },
    async (req) => {
      const params = req.params as { sessionId: string };
      const query = req.query as { workspaceId: string };
      return dependencies.service.listSessionModelOverrides({
        sessionId: params.sessionId,
        workspaceId: query.workspaceId,
      });
    },
  );

  app.put(
    "/api/agent/sessions/:sessionId/agents/:agentId/model-override",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          agentId: Type.String({ minLength: 1 }),
        }),
        body: UpdateAgentSessionModelOverrideRequestSchema,
        response: {
          200: AgentSessionAgentModelStateSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req) => {
      const params = req.params as { sessionId: string; agentId: string };
      const body = req.body as {
        workspaceId: string;
        providerId: string;
        modelId: string;
      };
      return dependencies.service.setSessionModelOverride({
        sessionId: params.sessionId,
        agentId: params.agentId,
        body,
      });
    },
  );

  app.delete(
    "/api/agent/sessions/:sessionId/agents/:agentId/model-override",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          agentId: Type.String({ minLength: 1 }),
        }),
        querystring: AgentSessionModelWorkspaceQuerySchema,
        response: {
          200: AgentSessionAgentModelStateSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req) => {
      const params = req.params as { sessionId: string; agentId: string };
      const query = req.query as { workspaceId: string };
      return dependencies.service.resetSessionModelOverride({
        sessionId: params.sessionId,
        agentId: params.agentId,
        workspaceId: query.workspaceId,
      });
    },
  );

  app.post(
    "/api/agent/sessions",
    {
      schema: {
        tags: ["agent"],
        body: AgentCreateSessionRequestSchema,
        response: {
          201: AgentSessionRecordSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
      preValidation: async (req) =>
        assertOnlyAllowedBodyKeys(req, AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS),
    },
    async (req, reply) => {
      const body = req.body as { workspaceId: string; title?: string };
      const session = dependencies.service.createPrimarySession(body);
      return reply.code(201).send(session);
    },
  );

  app.put(
    "/api/agent/sessions/:sessionId/title",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentUpdateSessionTitleRequestSchema,
        response: {
          200: AgentSessionRecordSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
      preValidation: async (req) => {
        assertOnlyAllowedBodyKeys(req, AGENT_SESSION_TITLE_UPDATE_BODY_KEYS);
        // Fastify/Ajv 的 maxLength 按 code point 计数，与文档约定的 JavaScript
        // string.length（UTF-16 code unit）不一致；此处按 JS length 做权威结构校验。
        // 仅在 body 为普通对象且 title 为 string 时检查，其余结构问题交给 Fastify Schema 返回 400。
        const body = req.body;
        if (body && typeof body === "object" && !Array.isArray(body)) {
          const title = (body as { title?: unknown }).title;
          if (typeof title === "string" && title.length > 1000) {
            throw new HttpError(400, "title is too long");
          }
        }
      },
    },
    async (req) => {
      const params = req.params as { sessionId: string };
      const body = req.body as AgentUpdateSessionTitleRequest;
      return dependencies.service.updateSessionTitle({
        sessionId: params.sessionId,
        body,
      });
    },
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
          500: ErrorResponseSchema,
        },
      },
      preValidation: async (req) =>
        assertOnlyAllowedBodyKeys(req, AGENT_PRIMARY_SESSION_FORK_BODY_KEYS),
    },
    async (req, reply) => {
      const body = req.body as {
        fromSessionId: string;
        fromMessageId: string;
        title?: string;
      };
      const session = await dependencies.service.forkPrimarySession(body);
      return reply.code(201).send(session);
    },
  );

  app.get(
    "/api/agent/sessions/:sessionId/timeline",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        querystring: AgentTimelineDeltaRequestSchema,
        response: {
          200: AgentTimelineDeltaResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema
        },
      },
    },
    async (req) => {
      const params = req.params as { sessionId: string };
      const query = req.query as { workspaceId: string; mode?: "snapshot" | "delta" | "before"; sinceRevision?: number; knownHeadMessageId?: string; knownContextRootMessageId?: string; beforeMessageId?: string; limit?: number };
      return dependencies.service.getMessageTimeline({
        workspaceId: query.workspaceId,
        sessionId: params.sessionId,
        ...(query.mode === undefined ? {} : { mode: query.mode }), ...(query.sinceRevision === undefined ? {} : { sinceRevision: query.sinceRevision }),
        ...(query.knownHeadMessageId === undefined ? {} : { knownHeadMessageId: query.knownHeadMessageId }), ...(query.knownContextRootMessageId === undefined ? {} : { knownContextRootMessageId: query.knownContextRootMessageId }),
        ...(query.beforeMessageId === undefined ? {} : { beforeMessageId: query.beforeMessageId }), ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
    },
  );

  app.get(
    "/api/agent/sessions/:sessionId/messages/:messageId",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          messageId: Type.String({ minLength: 1 }),
        }),
        querystring: AgentMessageDetailRequestSchema,
        response: {
          200: AgentMessageDetailResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req) => {
      const params = req.params as { sessionId: string; messageId: string };
      const query = req.query as { workspaceId: string };
      return { message: dependencies.service.getMessageDetail({
        workspaceId: query.workspaceId,
        sessionId: params.sessionId,
        messageId: params.messageId
      }) };
    },
  );

  app.get(
    "/api/agent/sessions/:sessionId/tool-executions/:toolExecutionId",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          toolExecutionId: Type.String({ minLength: 1 }),
        }),
        querystring: AgentMessageDetailRequestSchema,
        response: {
          200: AgentToolExecutionDetailSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req) => {
      const params = req.params as { sessionId: string; toolExecutionId: string };
      const query = req.query as { workspaceId: string };
      return dependencies.service.getToolExecutionDetail({
        workspaceId: query.workspaceId,
        sessionId: params.sessionId,
        toolExecutionId: params.toolExecutionId,
      });
    },
  );

  app.get(
    "/api/agent/sessions/:sessionId/tool-executions/:toolExecutionId/apply-patch-artifact",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          toolExecutionId: Type.String({ minLength: 1 }),
        }),
        querystring: AgentMessageDetailRequestSchema,
        response: { 200: Type.Any(), 404: ErrorResponseSchema },
      },
    },
    async (req) => {
      const params = req.params as { sessionId: string; toolExecutionId: string };
      const query = req.query as { workspaceId: string };
      return await dependencies.service.getApplyPatchUiArtifact({
        workspaceId: query.workspaceId,
        sessionId: params.sessionId,
        toolExecutionId: params.toolExecutionId,
      });
    },
  );

  app.get(
    "/api/agent/sessions/:sessionId/tool-executions/:toolExecutionId/write-artifact",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          toolExecutionId: Type.String({ minLength: 1 }),
        }),
        querystring: AgentMessageDetailRequestSchema,
        response: { 200: Type.Any(), 404: ErrorResponseSchema },
      },
    },
    async (req) => {
      const params = req.params as { sessionId: string; toolExecutionId: string };
      const query = req.query as { workspaceId: string };
      return await dependencies.service.getWriteUiArtifact({
        workspaceId: query.workspaceId,
        sessionId: params.sessionId,
        toolExecutionId: params.toolExecutionId,
      });
    },
  );

  app.get(
    "/api/agent/sessions/:sessionId/run-state",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        querystring: AgentMessageDetailRequestSchema,
        response: { 200: AgentMessageSessionRunStateSchema, 404: ErrorResponseSchema },
      },
    },
    async (req) => {
      const params = req.params as { sessionId: string };
      const query = req.query as { workspaceId: string };
      return dependencies.service.getMessageRunState({
        workspaceId: query.workspaceId,
        sessionId: params.sessionId,
      });
    },
  );

  app.post(
    "/api/agent/sessions/:sessionId/messages",
    {
      schema: {
        tags: ["agent"],
        description:
          "Accepts application/json for text-only messages. multipart/form-data is also accepted for image messages and requires one JSON `payload` field plus one to four `images` file fields.",
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        // This is documentation-only media-type mapping. A normal Fastify
        // `body` schema would incorrectly validate multipart streams as the
        // JSON contract before the handler can parse their parts.
        body: {
          content: {
            "application/json": {
              schema: AgentSendMessageRequestSchema,
            },
          },
        },
        response: {
          201: AgentSendMessageResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          415: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const p = req.params as { sessionId: string };
      const contentType = req.headers["content-type"];
      const mediaType = contentTypeBase(contentType);
      if (mediaType === "application/json") {
        const body = req.body as AgentSendMessageRequest;
        if (!Value.Check(AgentSendMessageRequestSchema, body))
          throw new HttpError(400, "request body is invalid");
        const result = await dependencies.service.sendMessage({
          sessionId: p.sessionId,
          body: { ...body, images: [] },
          runtime: dependencies.runtime,
        });
        return reply.code(201).send(result);
      }
      if (mediaType !== "multipart/form-data")
        throw new HttpError(415, "Unsupported Media Type");
      if (!hasMultipartBoundary(contentType) || !req.isMultipart())
        throw new HttpError(400, "invalid multipart boundary");
      let body: NormalizedSendMessageBody | null = null;
      try {
        body = await parseAgentMessageMultipart(req, dependencies.dataDir);
        const result = await dependencies.service.sendMessage({
          sessionId: p.sessionId,
          body,
          runtime: dependencies.runtime,
        });
        await removeStagedAgentMessageTemps(dependencies.dataDir, body);
        body = null;
        return reply.code(201).send(result);
      } finally {
        if (body) {
          await removeStagedAgentMessageTemps(dependencies.dataDir, body);
        }
      }
    },
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
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const p = req.params as { sessionId: string };
      const body = req.body as {
        workspaceId: string;
        clientRequestId: string;
        agentId?: string;
        uiLocale?: "zh-CN" | "en-US";
      };
      const result = await handleCompactRequest(
        dependencies,
        p.sessionId,
        body,
      );
      return reply.code(201).send(result);
    },
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
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      assertInternalToken(req, dependencies.internalToken);
      const p = req.params as { sessionId: string };
      const body = req.body as {
        workspaceId: string;
        clientRequestId: string;
        agentId?: string;
        uiLocale?: "zh-CN" | "en-US";
      };
      const result = await handleCompactRequest(
        dependencies,
        p.sessionId,
        body,
      );
      return reply.code(201).send(result);
    },
  );

  app.post(
    "/api/agent/sessions/:sessionId/revert",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentRevertSessionRequestSchema,
        response: {
          200: AgentMessageControlResultSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      const body = req.body as {
        workspaceId: string;
        messageId: string;
        reason?: string;
      };
      return await dependencies.service.revertSession({
        sessionId: p.sessionId,
        body,
        runtime: dependencies.runtime,
      });
    },
  );

  app.post(
    "/api/agent/sessions/:sessionId/cancel",
    {
      schema: {
        tags: ["agent"],
        params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
        body: AgentCancelSessionRequestSchema,
        response: {
          200: AgentMessageControlResultSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req) => {
      const p = req.params as { sessionId: string };
      const body = req.body as { workspaceId: string };
      return dependencies.service.cancelSessionWithRuntime({
        sessionId: p.sessionId,
        workspaceId: body.workspaceId,
        runtime: dependencies.runtime,
      });
    },
  );
}
