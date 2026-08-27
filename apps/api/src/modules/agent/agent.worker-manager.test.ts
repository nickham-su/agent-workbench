import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentWorkerSpawnEnv } from "./agent.worker-manager.js";

test("normalized AppContext response validation is explicitly propagated to worker spawn env", () => {
  const env = buildAgentWorkerSpawnEnv(
    {
      parentEnv: { AWB_DATA_DIR: "/wrong-data", AWB_INTERNAL_RPC_RESPONSE_VALIDATION: "invalid", OTHER: "keep" },
      dataDir: "/resolved/api-data",
      workerHost: "127.0.0.1",
      workerPort: 4312,
      socketPath: "worker.sock",
      workerConcurrency: 2,
      apiOrigin: "http://api",
      internalToken: "TOKEN",
      responseValidation: "warn",
      pidFilePath: "worker.pid",
      repoRoot: "/repo"
    }
  );

  assert.equal(env.AWB_INTERNAL_RPC_RESPONSE_VALIDATION, "warn");
  assert.equal(env.OTHER, "keep");
  assert.equal(env.AWB_DATA_DIR, "/resolved/api-data");
});
