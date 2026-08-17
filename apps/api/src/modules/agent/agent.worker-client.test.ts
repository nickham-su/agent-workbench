import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { AgentWorkerClient } from "./agent.worker-client.js";

test("AgentWorkerClient sends workspace repo directory names with enqueue payload", async () => {
  let received: unknown = null;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received = JSON.parse(body);
      res.statusCode = 202;
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address() as AddressInfo;
    const client = new AgentWorkerClient({
      workerOrigin: `http://127.0.0.1:${address.port}`,
      workerSocketPath: "",
      internalToken: "test-token",
      logger: { error() {} } as unknown as FastifyBaseLogger
    });

    await client.enqueueRun({
      workspaceId: "ws-a",
      sessionId: "sess-a",
      runId: "run-a",
      inputText: "read src/index.ts",
      workspacePath: "/workspace/a",
      workspaceRepoDirNames: ["repo-a", "repo-b"]
    });

    assert.deepEqual(received, {
      workspaceId: "ws-a",
      sessionId: "sess-a",
      runId: "run-a",
      inputText: "read src/index.ts",
      workspacePath: "/workspace/a",
      workspaceRepoDirNames: ["repo-a", "repo-b"]
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
