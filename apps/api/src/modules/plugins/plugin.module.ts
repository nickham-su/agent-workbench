import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import type { AppContext } from "../../app/context.js";
import { registerPluginRoutes } from "./plugin.routes.js";
import { registerPluginServicesRuntime } from "./plugin.services-runtime.js";

export async function registerPluginsModule(app: FastifyInstance, ctx: AppContext) {
  // Dedicated internal event bus for plugin runtime. Avoid relying on FastifyInstance.on/emit typings.
  if (!(app as any).awbPluginEvents) {
    (app as any).awbPluginEvents = new EventEmitter();
  }
  await registerPluginRoutes(app, { ctx });
  await registerPluginServicesRuntime(app, { ctx });
}
