import { AgentClearMessageQueueRequestSchema, AgentClearMessageQueueResponseSchema, type AgentClearMessageQueueRequest } from "@agent-workbench/shared";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance } from "fastify";
import {
  AgentAcceptUserMessageRequestSchema, AgentAcceptUserMessageMultipartPayloadSchema, AgentAcceptUserMessageResponseSchema,
  AgentMessageQueueEndpoints, AgentMessageQueueQuerySchema, AgentMessageQueueSnapshotSchema,
  AgentReceiptByRequestQuerySchema, AgentReceiptResponseSchema, AgentReceiptDetailResponseSchema,
  AgentCancelReceiptRequestSchema, AgentStopMessageQueueRequestSchema, AgentStopMessageQueueResponseSchema,
  AgentAttachmentRetentionResponseSchema, AGENT_QUEUE_MAX_TEXT_BYTES,
  type AgentAcceptUserMessageRequest, type AgentMessageQueueQuery, type AgentReceiptByRequestQuery, type AgentStopMessageQueueRequest,
} from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import { parseAgentMessageMultipart } from "../attachments/agent-message-multipart.js";
import type { AgentMessageQueueService } from "./message-queue.service.js";

/** Strict, non-mutating validation: default AJV removeAdditional is unsuitable for control operations. */
export const queueValidatorCompiler = ({ schema, httpPart }: { schema: unknown; httpPart?: string }) => (value: unknown) => {
  // Multipart streams have a null/undefined JSON body. Their payload is validated by the same public contract after staging.
  if (httpPart === "body" && value == null) return { value };
  return Value.Check(schema as TSchema, value) ? { value } : { error: new HttpError(400, "Invalid message queue request", "AGENT_QUEUE_REQUEST_INVALID") };
};
const sessionParams = Type.Object({ sessionId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const receiptParams = Type.Object({ ...sessionParams.properties, receiptId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const schemas = (schema: Record<string, unknown>) => ({ validatorCompiler: queueValidatorCompiler, schema: { tags: ["agent"], ...schema } });

/** Public routes share the application auth boundary; admission opens only after trusted runtime recovery. */
export async function registerAgentMessageQueueRoutes(app: FastifyInstance, dependencies: { dataDir: string; service: AgentMessageQueueService }) {
  const { service, dataDir } = dependencies;
  const admittedGenerations = new WeakMap<object, string>();
  app.post(AgentMessageQueueEndpoints.accept.path, { ...schemas({ params: sessionParams, body: AgentAcceptUserMessageRequestSchema,
    description: "Durably accepts text JSON or multipart payload + images; returns a receipt, not necessarily a new Run.", response: { 202: AgentAcceptUserMessageResponseSchema } }),
    onRequest: async req => { admittedGenerations.set(req, service.captureStopGeneration((req.params as { sessionId: string }).sessionId)); },
  }, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const contentType = String(req.headers["content-type"] ?? "");
    const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
    if (mediaType === "application/json") {
      if (!Value.Check(AgentAcceptUserMessageRequestSchema, req.body)) throw new HttpError(400, "Invalid receipt payload");
      return reply.code(202).send(await service.accept(sessionId, req.body as AgentAcceptUserMessageRequest, admittedGenerations.get(req)));
    }
    if (mediaType !== "multipart/form-data") throw new HttpError(415, "Unsupported message media type");
    if (!/(?:^|;)\s*boundary=(?:"[^"]+"|[^;\s]+)/i.test(contentType)) throw new HttpError(400, "Invalid multipart boundary");
    const input = await parseAgentMessageMultipart(req, dataDir, AgentAcceptUserMessageMultipartPayloadSchema, AGENT_QUEUE_MAX_TEXT_BYTES * 6 + 4096);
    return reply.code(202).send(await service.accept(sessionId, input, admittedGenerations.get(req)));
  });
  app.get(AgentMessageQueueEndpoints.snapshot.path, schemas({ params: sessionParams, querystring: AgentMessageQueueQuerySchema, response: { 200: AgentMessageQueueSnapshotSchema } }), async req =>
    service.snapshot({ ...(req.query as AgentMessageQueueQuery), sessionId: (req.params as { sessionId: string }).sessionId }));
  app.get(AgentMessageQueueEndpoints.byRequest.path, schemas({ params: sessionParams, querystring: AgentReceiptByRequestQuerySchema, response: { 200: AgentReceiptResponseSchema } }), async req =>
    service.byRequest({ ...(req.query as AgentReceiptByRequestQuery), sessionId: (req.params as { sessionId: string }).sessionId }));
  app.get(AgentMessageQueueEndpoints.receipt.path, schemas({ params: receiptParams, querystring: AgentMessageQueueQuerySchema, response: { 200: AgentReceiptDetailResponseSchema } }), async req => {
    const { sessionId, receiptId } = req.params as { sessionId: string; receiptId: string };
    return service.detail({ ...(req.query as AgentMessageQueueQuery), sessionId }, receiptId);
  });
  app.get(AgentMessageQueueEndpoints.attachment.path, schemas({ params: Type.Object({ ...receiptParams.properties, attachmentId: Type.String({ minLength: 1 }) }, { additionalProperties: false }), querystring: AgentMessageQueueQuerySchema }), async (req, reply) => {
    const { sessionId, receiptId, attachmentId } = req.params as { sessionId: string; receiptId: string; attachmentId: string };
    const image = await service.attachment({ ...(req.query as AgentMessageQueueQuery), sessionId }, receiptId, attachmentId);
    return reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").type(image.mediaType).send(image.content);
  });
  app.post(AgentMessageQueueEndpoints.cancel.path, schemas({ params: receiptParams, body: AgentCancelReceiptRequestSchema, response: { 200: AgentReceiptResponseSchema } }), async req => {
    if (!Value.Check(AgentCancelReceiptRequestSchema, req.body)) throw new HttpError(400, "Invalid receipt cancellation");
    const { sessionId, receiptId } = req.params as { sessionId: string; receiptId: string };
    return service.cancel({ ...req.body, sessionId }, receiptId);
  });
  app.post(AgentMessageQueueEndpoints.clear.path, schemas({ params: sessionParams, body: AgentClearMessageQueueRequestSchema, response: { 200: AgentClearMessageQueueResponseSchema } }), async req => {
    if (!Value.Check(AgentClearMessageQueueRequestSchema, req.body)) throw new HttpError(400, "Invalid queue clear");
    const { workspaceId, receiptIds } = req.body as AgentClearMessageQueueRequest;
    return service.clear({ workspaceId, sessionId: (req.params as { sessionId: string }).sessionId }, receiptIds);
  });
  app.post(AgentMessageQueueEndpoints.stop.path, schemas({ params: sessionParams, body: AgentStopMessageQueueRequestSchema, response: { 200: AgentStopMessageQueueResponseSchema } }), async req => {
    if (!Value.Check(AgentStopMessageQueueRequestSchema, req.body)) throw new HttpError(400, "Invalid queue stop");
    const { workspaceId, operationId } = req.body as AgentStopMessageQueueRequest;
    return service.stop({ workspaceId, sessionId: (req.params as { sessionId: string }).sessionId }, operationId);
  });
  app.get(AgentMessageQueueEndpoints.retention.path, schemas({ querystring: Type.Object({}, { additionalProperties: false }), response: { 200: AgentAttachmentRetentionResponseSchema } }), async () => service.retention());
}
