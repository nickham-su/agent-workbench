import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { AgentWorkerEndpoints } from "@agent-workbench/shared/internal-contracts/endpoints";
import {
  AgentWorkerCancelSessionRequestSchema,
  AgentWorkerEnqueueRequestSchema
} from "@agent-workbench/shared/internal-contracts/agent-worker";
import type { AgentWorkerEnqueueRequest } from "@agent-workbench/shared/internal-contracts/agent-worker";
import { AgentRunner } from "./runtime/runner.js";
import { normalizeWorkspaceRepoDirNames as normalizeWorkerWorkspaceRepoDirNames } from "./runtime/workspaceRepoDirNames.js";

/** Normalizes untrusted enqueue JSON without touching the filesystem. */
export function normalizeWorkspaceRepoDirNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeWorkerWorkspaceRepoDirNames(value);
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw) as any;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(body);
}

export function createWorkerServer(params: {
  host: string;
  port: number;
  socketPath: string | null;
  internalToken: string;
  runner: AgentRunner;
}) {
  const server = createServer(async (req, res) => {
    try {
      const token = String(req.headers["x-awb-agent-internal-token"] || "");
      if (token !== params.internalToken) {
        sendJson(res, 401, { message: "Unauthorized" });
        return;
      }

      const method = String(req.method || "GET").toUpperCase();
      const pathname = String(req.url || "").split("?")[0] || "";

      if (method === AgentWorkerEndpoints.health.method && pathname === AgentWorkerEndpoints.health.path) {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === AgentWorkerEndpoints.enqueueRun.method && pathname === AgentWorkerEndpoints.enqueueRun.path) {
        const body: unknown = await readJsonBody(req);
        if (!Value.Check(AgentWorkerEnqueueRequestSchema, body)) {
          const diagnostics = [...Value.Errors(AgentWorkerEnqueueRequestSchema, body)].map((error) => ({
            path: error.path,
            message: error.message
          }));
          console.warn("invalid agent-worker enqueue payload", { diagnostics });
          sendJson(res, 400, { message: "invalid enqueue payload" });
          return;
        }
        const enqueue = body as AgentWorkerEnqueueRequest;
        params.runner.enqueueRun({
          workspaceId: enqueue.workspaceId,
          sessionId: enqueue.sessionId,
          runId: enqueue.runId,
          inputText: enqueue.inputText === null ? undefined : enqueue.inputText,
          workspacePath: enqueue.workspacePath,
          workspaceRepoDirNames: normalizeWorkspaceRepoDirNames(enqueue.workspaceRepoDirNames)
        });
        sendJson(res, 202, { ok: true });
        return;
      }

      if (method === AgentWorkerEndpoints.cancelSession.method && pathname === AgentWorkerEndpoints.cancelSession.path) {
        const body: unknown = await readJsonBody(req);
        if (!Value.Check(AgentWorkerCancelSessionRequestSchema, body)) {
          const diagnostics = [...Value.Errors(AgentWorkerCancelSessionRequestSchema, body)].map((error) => ({
            path: error.path,
            message: error.message
          }));
          console.warn("invalid agent-worker cancel-session payload", { diagnostics });
          sendJson(res, 400, { message: "invalid sessionId" });
          return;
        }
        params.runner.cancelSession(body.sessionId);
        sendJson(res, 202, { ok: true });
        return;
      }

      sendJson(res, 404, { message: "Not Found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { message });
    }
  });

  return {
    async listen() {
      if (params.socketPath) {
        await fs.mkdir(path.dirname(params.socketPath), { recursive: true });
        await fs.rm(params.socketPath, { force: true }).catch(() => {
          // ignore stale socket cleanup error
        });
      }
      return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        if (params.socketPath) {
          server.listen(params.socketPath, () => {
            server.off("error", reject);
            resolve();
          });
          return;
        }
        server.listen(params.port, params.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    async close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          if (!params.socketPath) {
            resolve();
            return;
          }
          fs.rm(params.socketPath, { force: true })
            .catch(() => {
              // ignore socket cleanup error
            })
            .finally(() => resolve());
        });
      });
    }
  };
}
