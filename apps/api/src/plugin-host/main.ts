import fs from "node:fs/promises";
import path from "node:path";
import { openDb } from "../infra/db/db.js";
import { createPluginHostServer } from "./server.js";
import { loadPluginHostEnv } from "./pluginHostEnv.js";

const env = loadPluginHostEnv(process.env);

const db = await openDb(env.dataDir);
const server = createPluginHostServer({
  socketPath: env.socketPath,
  internalToken: env.internalToken,
  apiOrigin: env.apiOrigin,
  db,
  dataDir: env.dataDir
});

await server.listen();
console.log(`[agent-plugin-host] listening on unix://${env.socketPath}`);

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
  db.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
