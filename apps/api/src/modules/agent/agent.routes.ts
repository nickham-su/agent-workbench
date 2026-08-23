import type { FastifyInstance } from "fastify";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import type { AgentPluginHostClient } from "./agent.plugin-host-client.js";
import type { AgentRunCompletedEventHub } from "./run-completed-events.js";
import type { AgentService } from "./agent.service.js";
import { registerAgentPeripheralRoutes } from "./routes/agent-peripheral.routes.js";
import { registerAgentPublicRoutes } from "./routes/agent-public.routes.js";
import { registerAgentStatusSseRoutes } from "./routes/agent-status-sse.routes.js";
import { registerAgentWorkerRoutes } from "./routes/agent-worker.routes.js";

/** P3 aggregation entry: route groups receive only their transport dependencies. */
export async function registerAgentRoutes(
  app: FastifyInstance,
  params: {
    service: AgentService;
    runtime: AgentRuntimePort;
    internalToken: string;
    pluginHost?: AgentPluginHostClient | null;
    runCompletedEventHub: AgentRunCompletedEventHub;
  }
) {
  await registerAgentPublicRoutes(app, params);
  await registerAgentWorkerRoutes(app, params);
  await registerAgentPeripheralRoutes(app, params);
  await registerAgentStatusSseRoutes(app, params);
}
