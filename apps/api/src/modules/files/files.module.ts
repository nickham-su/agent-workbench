import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerFilesRoutes } from "./files.routes.js";

export async function registerFilesModule(app: FastifyInstance, ctx: AppContext) {
  await registerFilesRoutes(app, ctx);
}

