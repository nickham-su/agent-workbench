import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import { registerTerminalsRoutes } from "./terminals.routes.js";
import { registerTerminalWsRoute } from "./terminal.ws.js";

export async function registerTerminalsModule(app: FastifyInstance, ctx: AppContext) {
  await registerTerminalsRoutes(app, ctx);
  await registerTerminalWsRoute(app, ctx);
}

