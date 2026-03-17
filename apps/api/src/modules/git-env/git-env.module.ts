import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerGitEnvRoutes } from "./git-env.routes.js";
import { startGitEnvJanitor } from "./git-env.janitor.js";

export async function registerGitEnvModule(app: FastifyInstance, ctx: AppContext) {
  await registerGitEnvRoutes(app, ctx);
  startGitEnvJanitor({ app, dataDir: ctx.dataDir, logger: app.log });
}
