import { loadWorkerEnv } from "./config/env.js";
import { AgentApiClient } from "./runtime/apiClient.js";
import { McpManager } from "./runtime/mcpManager.js";
import { AgentRunner } from "./runtime/runner.js";
import { createWorkerServer } from "./server.js";
import fs from "node:fs/promises";
import path from "node:path";

const env = loadWorkerEnv(process.env);

const apiClient = new AgentApiClient({
  apiOrigin: env.apiOrigin,
  internalToken: env.internalToken
});

const mcpManager = new McpManager(apiClient, console);
const runner = new AgentRunner(apiClient, mcpManager, console, env.concurrency);
const server = createWorkerServer({
  host: env.host,
  port: env.port,
  socketPath: env.socketPath,
  internalToken: env.internalToken,
  runner
});

await server.listen();
if (env.socketPath) {
  console.log(`[agent-worker] listening on unix://${env.socketPath}`);
} else {
  console.log(`[agent-worker] listening on http://${env.host}:${env.port}`);
}

if (env.pidFilePath) {
  await fs.mkdir(path.dirname(env.pidFilePath), { recursive: true });
  await fs.writeFile(env.pidFilePath, String(process.pid), "utf8");
}

const shutdown = async () => {
  if (env.pidFilePath) {
    try {
      await fs.rm(env.pidFilePath, { force: true });
    } catch {
      // ignore cleanup error
    }
  }
  await server.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
