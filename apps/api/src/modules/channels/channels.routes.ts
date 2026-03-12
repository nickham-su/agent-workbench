import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ChannelBuildAggregatedUserPromptRequestSchema,
  ChannelBuildAggregatedUserPromptResponseSchema,
  ChannelIngestInboundMessageRequestSchema,
  ChannelIngestInboundMessageResponseSchema,
  ChannelTriggerRunRequestSchema,
  ChannelTriggerRunResponseSchema,
  ChannelUpsertConversationBindingRequestSchema,
  ChannelGetConversationBindingRequestSchema,
  ChannelSetSelectedAgentRequestSchema,
  ChannelConversationBindingSchema,
  ErrorResponseSchema
} from "@agent-workbench/shared";
import { HttpError } from "../../app/errors.js";
import type { AgentService } from "../agent/agent.service.js";
import type { ChannelsService } from "./channels.service.js";

function assertInternalToken(req: FastifyRequest, service: AgentService) {
  const token = String(req.headers["x-awb-agent-internal-token"] || "");
  if (token !== service.getContext().agentInternalToken) {
    throw new HttpError(401, "Unauthorized");
  }
}

export async function registerChannelsRoutes(
  app: FastifyInstance,
  params: { service: ChannelsService; agentService: AgentService }
) {
  app.post(
    "/api/internal/agent/channels/conversations/upsert-binding",
    {
      schema: {
        tags: ["agent"],
        body: ChannelUpsertConversationBindingRequestSchema,
        response: {
          200: Type.Union([ChannelConversationBindingSchema, Type.Null()]),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.agentService);
      const body = req.body as any;
      return params.service.upsertConversationBinding(body);
    }
  );

  app.post(
    "/api/internal/agent/channels/conversations/get-binding",
    {
      schema: {
        tags: ["agent"],
        body: ChannelGetConversationBindingRequestSchema,
        response: {
          200: Type.Union([ChannelConversationBindingSchema, Type.Null()]),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.agentService);
      const body = req.body as any;
      return params.service.getConversationBinding(body);
    }
  );

  app.post(
    "/api/internal/agent/channels/conversations/set-agent",
    {
      schema: {
        tags: ["agent"],
        body: ChannelSetSelectedAgentRequestSchema,
        response: {
          200: Type.Object({ ok: Type.Boolean() }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.agentService);
      const body = req.body as any;
      params.service.setSelectedAgentId(body);
      return { ok: true };
    }
  );

  app.post(
    "/api/internal/agent/channels/inbound/ingest",
    {
      schema: {
        tags: ["agent"],
        body: ChannelIngestInboundMessageRequestSchema,
        response: {
          200: ChannelIngestInboundMessageResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.agentService);
      return params.service.ingestInboundMessage(req.body as any);
    }
  );

  app.post(
    "/api/internal/agent/channels/inbound/aggregate",
    {
      schema: {
        tags: ["agent"],
        body: ChannelBuildAggregatedUserPromptRequestSchema,
        response: {
          200: ChannelBuildAggregatedUserPromptResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.agentService);
      const body = req.body as any;
      return params.service.buildAggregatedUserPrompt(body);
    }
  );

  app.post(
    "/api/internal/agent/channels/run/trigger",
    {
      schema: {
        tags: ["agent"],
        body: ChannelTriggerRunRequestSchema,
        response: {
          200: ChannelTriggerRunResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema
        }
      }
    },
    async (req) => {
      assertInternalToken(req, params.agentService);
      const body = req.body as any;
      const res = await params.service.tryAppendUserMessageAndStartRun({
        pluginId: body.pluginId,
        channelName: body.channelName,
        accountId: body.accountId,
        conversationKey: body.conversationKey,
        triggerExternalMessageId: body.triggerExternalMessageId,
        text: body.text,
        clientRequestId: body.clientRequestId,
        watermarkAdvanceExternalMessageId: body.watermarkAdvanceExternalMessageId
      });
      return res as any;
    }
  );
}
