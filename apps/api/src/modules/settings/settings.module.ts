import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerSettingsRoutes } from "./settings.routes.js";

export async function registerSettingsModule(app: FastifyInstance, ctx: AppContext) {
  await registerSettingsRoutes(app, ctx);
}

