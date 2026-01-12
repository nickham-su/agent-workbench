import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerWorkspacesRoutes } from "./workspaces.routes.js";

export async function registerWorkspacesModule(app: FastifyInstance, ctx: AppContext) {
  await registerWorkspacesRoutes(app, ctx);
}

