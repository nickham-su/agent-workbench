import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { EnqueuePayload } from "./runtime/runner.js";
import { AgentRunner } from "./runtime/runner.js";

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

      if (method === "GET" && pathname === "/internal/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/internal/runs/enqueue") {
        const body = (await readJsonBody(req)) as Partial<EnqueuePayload>;
        if (
          typeof body.workspaceId !== "string" ||
          typeof body.sessionId !== "string" ||
          typeof body.runId !== "string" ||
          typeof body.inputText !== "string" ||
          typeof body.workspacePath !== "string"
        ) {
          sendJson(res, 400, { message: "invalid enqueue payload" });
          return;
        }
        params.runner.enqueueRun({
          workspaceId: body.workspaceId,
          sessionId: body.sessionId,
          runId: body.runId,
          inputText: body.inputText,
          workspacePath: body.workspacePath
        });
        sendJson(res, 202, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/internal/runs/cancel-session") {
        const body = (await readJsonBody(req)) as { sessionId?: unknown };
        if (typeof body.sessionId !== "string") {
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
