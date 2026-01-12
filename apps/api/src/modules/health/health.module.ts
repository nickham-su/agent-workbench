import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerHealthRoutes } from "./health.routes.js";

export async function registerHealthModule(app: FastifyInstance, ctx: AppContext) {
  await registerHealthRoutes(app, ctx);
}
