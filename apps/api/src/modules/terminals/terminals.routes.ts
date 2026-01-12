import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { ErrorResponseSchema } from "@agent-workbench/shared";
import { CreateTerminalRequestSchema, TerminalRecordSchema } from "@agent-workbench/shared";
import { getWorkspaceById } from "../workspaces/workspace.service.js";
import { createTerminal, deleteTerminal, getTerminalById, reconcileWorkspaceActiveTerminals } from "./terminal.service.js";
import { listActiveTerminalsByWorkspace } from "./terminal.store.js";

export async function registerTerminalsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get(
    "/api/workspaces/:workspaceId/terminals",
    {
      schema: {
        tags: ["terminals"],
        response: { 200: { type: "array", items: TerminalRecordSchema }, 404: ErrorResponseSchema }
      }
    },
    async (req) => {
      const params = req.params as { workspaceId: string };
      await getWorkspaceById(ctx, params.workspaceId);
      await reconcileWorkspaceActiveTerminals(ctx, app.log, params.workspaceId);
      return listActiveTerminalsByWorkspace(ctx.db, params.workspaceId);
    }
  );

  app.post(
    "/api/workspaces/:workspaceId/terminals",
    {
      schema: {
        tags: ["terminals"],
        body: CreateTerminalRequestSchema,
        response: { 201: TerminalRecordSchema, 404: ErrorResponseSchema }
      }
    },
    async (req, reply) => {
      const params = req.params as { workspaceId: string };
      const body = (req.body ?? {}) as { shell?: string };
      const term = await createTerminal(ctx, app.log, { workspaceId: params.workspaceId, shell: body.shell });
      return reply.code(201).send(term);
    }
  );

  app.get(
    "/api/terminals/:terminalId",
    {
      schema: { tags: ["terminals"], response: { 200: TerminalRecordSchema, 404: ErrorResponseSchema } }
    },
    async (req) => {
      const params = req.params as { terminalId: string };
      return getTerminalById(ctx, params.terminalId);
    }
  );

  app.delete(
    "/api/terminals/:terminalId",
    {
      schema: { tags: ["terminals"], response: { 204: { type: "null" }, 404: ErrorResponseSchema } }
    },
    async (req, reply) => {
      const params = req.params as { terminalId: string };
      await deleteTerminal(ctx, app.log, params.terminalId);
      return reply.code(204).send();
    }
  );
}
