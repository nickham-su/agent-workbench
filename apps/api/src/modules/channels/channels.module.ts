import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import type { AgentRuntimePort } from "../agent/agent.runtime-port.js";
import type { AgentPluginHostClient } from "../agent/agent.plugin-host-client.js";
import { AgentService } from "../agent/agent.service.js";
import { registerChannelsRoutes } from "./channels.routes.js";
import { ChannelsService } from "./channels.service.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

export async function registerChannelsModule(
  app: FastifyInstance,
  params: {
    ctx: AppContext;
    agentService: AgentService;
    runtime: AgentRuntimePort;
    pluginHost?: AgentPluginHostClient | null;
  }
) {
  const service = new ChannelsService(params.ctx, app.log, params.agentService, params.runtime);
  await registerChannelsRoutes(app, { service, agentService: params.agentService });

  // Reply dispatcher (final-only): poll reply jobs and send outbound messages.
  // Runs in API process and calls plugin-host for outbound (do NOT import plugin here).
  if (params.pluginHost && params.ctx.agentPluginHostEnabled && params.ctx.agentPluginServicesEnabled === true) {
    const dispatcher = createReplyDispatcher({
      ctx: params.ctx,
      logger: app.log,
      agentService: params.agentService,
      pluginHost: params.pluginHost
    });

    app.addHook("onReady", async () => {
      dispatcher.start();
    });
    app.addHook("onClose", async () => {
      await dispatcher.stop();
    });
  }
}
