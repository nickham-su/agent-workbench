import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerReposRoutes } from "./repos.routes.js";

export async function registerReposModule(app: FastifyInstance, ctx: AppContext) {
  await registerReposRoutes(app, ctx);
}

