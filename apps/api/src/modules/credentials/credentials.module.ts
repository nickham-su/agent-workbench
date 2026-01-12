import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerCredentialsRoutes } from "./credentials.routes.js";

export async function registerCredentialsModule(app: FastifyInstance, ctx: AppContext) {
  await registerCredentialsRoutes(app, ctx);
}

