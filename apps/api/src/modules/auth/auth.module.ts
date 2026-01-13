import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerAuthRoutes } from "./auth.routes.js";

export async function registerAuthModule(app: FastifyInstance, ctx: AppContext) {
  await registerAuthRoutes(app, ctx);
}

