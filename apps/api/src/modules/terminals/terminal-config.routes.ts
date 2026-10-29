import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { ErrorResponseSchema, ReorderTerminalConfigsRequestSchema, TerminalConfigInputSchema, TerminalConfigRecordSchema, UpdateTerminalConfigRequestSchema, TerminalRecordSchema, type ReorderTerminalConfigsRequest, type TerminalConfigInput, type UpdateTerminalConfigRequest } from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { runWorkspaceTerminalConfig } from "./terminal-config-run.service.js";
import { deleteWorkspaceTerminalConfig, listWorkspaceTerminalConfigs, reorderWorkspaceTerminalConfigs, saveWorkspaceTerminalConfig } from "./terminal-config.service.js";

export async function registerTerminalConfigRoutes(app: FastifyInstance, ctx: AppContext) {
  const base = "/api/workspaces/:workspaceId/terminal-configs";
  const errors = { 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema };
  app.get(base, { schema: { tags: ["terminals"], response: { 200: Type.Array(TerminalConfigRecordSchema), ...errors } } }, async (req) => {
    const { workspaceId } = req.params as { workspaceId: string };
    return listWorkspaceTerminalConfigs(ctx, workspaceId);
  });
  app.post(base, { schema: { tags: ["terminals"], body: TerminalConfigInputSchema, response: { 201: TerminalConfigRecordSchema, ...errors } } }, async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    return reply.code(201).send(await saveWorkspaceTerminalConfig(ctx, workspaceId, req.body as TerminalConfigInput));
  });
  app.put(`${base}/order`, { schema: { tags: ["terminals"], body: ReorderTerminalConfigsRequestSchema, response: { 204: Type.Null(), ...errors } } }, async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    await reorderWorkspaceTerminalConfigs(ctx, workspaceId, (req.body as ReorderTerminalConfigsRequest).orderedIds);
    return reply.code(204).send();
  });
  app.patch(`${base}/:configId`, { schema: { tags: ["terminals"], body: UpdateTerminalConfigRequestSchema, response: { 200: TerminalConfigRecordSchema, ...errors } } }, async (req) => {
    const { workspaceId, configId } = req.params as { workspaceId: string; configId: string };
    return saveWorkspaceTerminalConfig(ctx, workspaceId, req.body as UpdateTerminalConfigRequest, configId);
  });
  app.delete(`${base}/:configId`, { schema: { tags: ["terminals"], response: { 204: Type.Null(), ...errors } } }, async (req, reply) => {
    const { workspaceId, configId } = req.params as { workspaceId: string; configId: string };
    await deleteWorkspaceTerminalConfig(ctx, workspaceId, configId);
    return reply.code(204).send();
  });
  app.post(`${base}/:configId/run`, { schema: { tags: ["terminals"], response: { 201: TerminalRecordSchema, ...errors } } }, async (req, reply) => {
    const { workspaceId, configId } = req.params as { workspaceId: string; configId: string };
    const terminal = await runWorkspaceTerminalConfig(ctx, app.log, workspaceId, configId);
    return reply.code(201).send(terminal);
  });
}
