import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "../infra/db/db.js";
import { createPluginToolsRuntime } from "./toolsRuntime.js";
import { createPluginServicesRuntime } from "./servicesRuntime.js";

const DEFAULT_BODY_MAX_BYTES = 1024 * 1024;

async function readJsonBody(req: IncomingMessage, maxBytes = DEFAULT_BODY_MAX_BYTES) {
  const contentLengthRaw = String(req.headers["content-length"] || "").trim();
  if (contentLengthRaw) {
    const len = Number.parseInt(contentLengthRaw, 10);
    if (Number.isFinite(len) && len > maxBytes) {
      const err: any = new Error("payload too large");
      err.statusCode = 413;
      err.code = "PAYLOAD_TOO_LARGE";
      try {
        req.destroy();
      } catch {
        // ignore destroy error
      }
      throw err;
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      const err: any = new Error("payload too large");
      err.statusCode = 413;
      err.code = "PAYLOAD_TOO_LARGE";
      try {
        req.destroy();
      } catch {
        // ignore destroy error
      }
      throw err;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as any;
  } catch {
    const err: any = new Error("invalid json body");
    err.statusCode = 400;
    err.code = "INVALID_JSON";
    throw err;
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(body);
}

export function createPluginHostServer(params: {
  socketPath: string;
  internalToken: string;
  apiOrigin: string;
  db: Db;
  dataDir: string;
  repoRoot: string;
}) {
  const runtime = createPluginToolsRuntime({ db: params.db, dataDir: params.dataDir, repoRoot: params.repoRoot });
  const servicesRuntime = createPluginServicesRuntime({
    db: params.db,
    dataDir: params.dataDir,
    apiOrigin: params.apiOrigin,
    internalToken: params.internalToken,
    repoRoot: params.repoRoot
  });

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

      if (method === "POST" && pathname === "/internal/plugins/tools/list") {
        const body = await readJsonBody(req);
        const result = await runtime.listTools(body);
        sendJson(res, 200, result);
        return;
      }

      if (method === "POST" && pathname === "/internal/plugins/services/reconcile") {
        const body = await readJsonBody(req);
        const result = await servicesRuntime.reconcile(body);
        sendJson(res, 200, result);
        return;
      }

      if (method === "GET" && pathname === "/internal/plugins/services/status") {
        const result = servicesRuntime.getStatus();
        sendJson(res, 200, result);
        return;
      }

      if (method === "POST" && pathname === "/internal/plugins/feishu/reply-text") {
        const body = await readJsonBody(req);
        const result = await servicesRuntime.feishuReplyText(body as any);
        sendJson(res, 200, result);
        return;
      }

      if (method === "POST" && pathname === "/internal/plugins/tools/execute") {
        const body = await readJsonBody(req);
        const result = await runtime.executeTool(body);
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { message: "Not Found" });
    } catch (err) {
      const statusCode = typeof (err as any)?.statusCode === "number" ? Number((err as any).statusCode) : 500;
      const message = err instanceof Error ? err.message : String(err);
      const code = typeof (err as any)?.code === "string" ? (err as any).code : undefined;
      sendJson(res, statusCode, { message, ...(code ? { code } : {}) });
    }
  });

  return {
    async listen() {
      await fs.mkdir(path.dirname(params.socketPath), { recursive: true });
      try {
        const stat = await fs.lstat(params.socketPath);
        if (stat.isSocket()) {
          await fs.rm(params.socketPath, { force: true });
        }
      } catch {
        // ignore stale socket cleanup error
      }
      return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(params.socketPath, () => {
          server.off("error", reject);
          void fs.chmod(params.socketPath, 0o600).catch(() => {
            // ignore chmod error
          });
          resolve();
        });
      });
    },
    async close() {
      try {
        await servicesRuntime.stop();
      } catch {
        // ignore stop error
      }
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }

          void (async () => {
            try {
              const stat = await fs.lstat(params.socketPath);
              if (stat.isSocket()) {
                await fs.rm(params.socketPath, { force: true });
                return;
              }
              // best-effort diagnostics, do not block shutdown
              console.warn(`[agent-plugin-host] skip removing non-socket path: ${params.socketPath}`);
            } catch (e: any) {
              if (e?.code !== "ENOENT") {
                console.warn(
                  `[agent-plugin-host] failed to remove socketPath on close: ${params.socketPath}: ${e instanceof Error ? e.message : String(e)}`
                );
              }
            }
          })().finally(() => resolve());
        });
      });
    }
  };
}
