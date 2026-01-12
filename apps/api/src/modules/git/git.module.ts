import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerGitRoutes } from "./git.routes.js";

export async function registerGitModule(app: FastifyInstance, ctx: AppContext) {
  await registerGitRoutes(app, ctx);
}

