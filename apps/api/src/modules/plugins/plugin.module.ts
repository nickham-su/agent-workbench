import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerPluginRoutes } from "./plugin.routes.js";

export async function registerPluginsModule(app: FastifyInstance, ctx: AppContext) {
  await registerPluginRoutes(app, { ctx });
}
