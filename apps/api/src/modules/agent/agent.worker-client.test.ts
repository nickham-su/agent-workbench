import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentWorkerEndpoints } from "@agent-workbench/shared/internal-contracts/endpoints";
import type { FastifyBaseLogger } from "fastify";
import { AgentWorkerClient } from "./agent.worker-client.js";

const validRun = {
  workspaceId: "ws-a",
  sessionId: "sess-a",
  runId: "run-a",
  inputText: "read src/index.ts",
  workspacePath: "/workspace/a",
  workspaceRepoDirNames: ["repo-a", "repo-b"]
};

const logger = { error() {}, warn() {} } as unknown as FastifyBaseLogger;

type LogCall = {
  payload: unknown;
  message: string;
};

function createSpyLogger() {
  const warnings: LogCall[] = [];
  const errors: LogCall[] = [];
  return {
    logger: {
      error(payload: unknown, message: string) {
        errors.push({ payload, message });
      },
      warn(payload: unknown, message: string) {
        warnings.push({ payload, message });
      }
    } as unknown as FastifyBaseLogger,
    warnings,
    errors
  };
}

async function listen(server: ReturnType<typeof createServer>, target: string | number) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (typeof target === "string") {
      server.listen(target, () => resolve());
      return;
    }
    server.listen(target, "127.0.0.1", () => resolve());
  });
}

async function close(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

async function withTcpServer(
  handler: RequestListener,
  callback: (origin: string) => Promise<void>
) {
  const server = createServer(handler);
  await listen(server, 0);
  try {
    const address = server.address() as AddressInfo;
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await close(server);
  }
}

function createClient(params: {
  workerOrigin: string;
  workerSocketPath?: string;
  responseValidation?: "strict" | "warn";
  logger?: FastifyBaseLogger;
}) {
  return new AgentWorkerClient({
    workerOrigin: params.workerOrigin,
    workerSocketPath: params.workerSocketPath || "",
    internalToken: "test-token",
    responseValidation: params.responseValidation,
    logger: params.logger ?? logger
  });
}

function respondWithInvalidSuccess(_req: Parameters<RequestListener>[0], res: Parameters<RequestListener>[1]) {
  res.statusCode = 202;
  res.end(JSON.stringify({ ok: false }));
}

test("AgentWorkerClient sends workspace repo directory names with enqueue payload", async () => {
  let received: unknown = null;
  await withTcpServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received = JSON.parse(body);
      res.statusCode = 202;
      res.end(JSON.stringify({ ok: true }));
    });
  }, async (workerOrigin) => {
    await createClient({ workerOrigin }).enqueueRun(validRun);
  });

  assert.deepEqual(received, validRun);
});

test("AgentWorkerClient validates cancel success response and sends shared endpoint", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  await withTcpServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method || "", path: req.url || "", body: JSON.parse(body) });
      res.statusCode = 202;
      res.end(JSON.stringify({ ok: true }));
    });
  }, async (workerOrigin) => {
    await createClient({ workerOrigin }).cancelSession("sess-a");
  });

  assert.deepEqual(requests, [{
    method: AgentWorkerEndpoints.cancelSession.method,
    path: AgentWorkerEndpoints.cancelSession.path,
    body: { sessionId: "sess-a" }
  }]);
});

test("AgentWorkerClient supports Unix Socket enqueue", async () => {
  let received: unknown = null;
  const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-worker-client-"));
  const socketPath = path.join(socketDir, "worker.sock");
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received = JSON.parse(body);
      assert.equal(req.method, AgentWorkerEndpoints.enqueueRun.method);
      assert.equal(req.url, AgentWorkerEndpoints.enqueueRun.path);
      res.statusCode = 202;
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await listen(server, socketPath);
  try {
    await createClient({ workerOrigin: "http://unused", workerSocketPath: socketPath }).enqueueRun(validRun);
    assert.deepEqual(received, validRun);
  } finally {
    await close(server);
    await fs.rm(socketDir, { recursive: true, force: true });
  }
});

test("AgentWorkerClient strict mode maps enqueue response schema mismatch to unavailable", async () => {
  await withTcpServer(respondWithInvalidSuccess, async (workerOrigin) => {
    await assert.rejects(() => createClient({ workerOrigin }).enqueueRun(validRun), (error: unknown) => {
      return error instanceof Error && error.message === "agent worker unavailable";
    });
  });
});

test("AgentWorkerClient warn mode logs response schema warning and continues enqueue", async () => {
  const spy = createSpyLogger();
  await withTcpServer(respondWithInvalidSuccess, async (workerOrigin) => {
    await createClient({ workerOrigin, responseValidation: "warn", logger: spy.logger }).enqueueRun(validRun);
  });

  assert.deepEqual(spy.errors, []);
  assert.equal(spy.warnings.length, 1);
  assert.equal(spy.warnings[0]?.message, "agent worker response validation failed; continuing in warn mode");
  const payload = spy.warnings[0]?.payload as { err: unknown; endpoint: string };
  assert.ok(payload.err instanceof Error);
  assert.equal(payload.endpoint, AgentWorkerEndpoints.enqueueRun.path);
});

test("AgentWorkerClient strict mode logs cancel best-effort warning after response schema mismatch", async () => {
  const spy = createSpyLogger();
  await withTcpServer(respondWithInvalidSuccess, async (workerOrigin) => {
    await createClient({ workerOrigin, logger: spy.logger }).cancelSession("sess-a");
  });

  assert.equal(spy.warnings.length, 1);
  assert.equal(spy.warnings[0]?.message, "cancel session in worker failed");
  const payload = spy.warnings[0]?.payload as { err: unknown; sessionId: string };
  assert.ok(payload.err instanceof Error);
  assert.equal(payload.sessionId, "sess-a");
});

test("AgentWorkerClient warn mode logs schema warning without cancel best-effort warning", async () => {
  const spy = createSpyLogger();
  await withTcpServer(respondWithInvalidSuccess, async (workerOrigin) => {
    await createClient({ workerOrigin, responseValidation: "warn", logger: spy.logger }).cancelSession("sess-a");
  });

  assert.equal(spy.warnings.length, 1);
  assert.equal(spy.warnings[0]?.message, "agent worker response validation failed; continuing in warn mode");
  const payload = spy.warnings[0]?.payload as { err: unknown; endpoint: string };
  assert.ok(payload.err instanceof Error);
  assert.equal(payload.endpoint, AgentWorkerEndpoints.cancelSession.path);
});

test("AgentWorkerClient warn mode does not bypass non-2xx failures", async () => {
  const spy = createSpyLogger();
  await withTcpServer((_req, res) => {
    res.statusCode = 503;
    res.end(JSON.stringify({ message: "unavailable" }));
  }, async (workerOrigin) => {
    const client = createClient({ workerOrigin, responseValidation: "warn", logger: spy.logger });
    await assert.rejects(() => client.enqueueRun(validRun), (error: unknown) => {
      return error instanceof Error && error.message === "agent worker unavailable";
    });
    await client.cancelSession("sess-a");
  });

  assert.equal(spy.errors.length, 1);
  assert.equal(spy.errors[0]?.message, "enqueue run to worker failed");
  assert.equal(spy.warnings.length, 1);
  assert.equal(spy.warnings[0]?.message, "cancel session in worker failed");
});
