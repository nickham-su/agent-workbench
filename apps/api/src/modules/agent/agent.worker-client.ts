import type { FastifyBaseLogger } from "fastify";
import { request as httpRequest } from "node:http";
import { HttpError } from "../../app/errors.js";
import type { AgentRuntimePort } from "./agent.runtime-port.js";
import type { AgentQueuedRun } from "./agent.service.js";

type WorkerQueuedRun = AgentQueuedRun & {
  inputText: string;
  workspacePath: string;
};

export class AgentWorkerClient implements AgentRuntimePort {
  constructor(
    private readonly params: {
      workerOrigin: string;
      workerSocketPath: string;
      internalToken: string;
      logger: FastifyBaseLogger;
    }
  ) {}

  private async postBySocket(pathname: string, body: unknown, timeoutMs: number) {
    const payload = JSON.stringify(body);
    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.params.workerSocketPath,
          path: pathname,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            "x-awb-agent-internal-token": this.params.internalToken
          }
        },
        (res) => {
          let txt = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            txt += chunk;
          });
          res.on("end", () => {
            resolve({ statusCode: res.statusCode ?? 0, body: txt });
          });
        }
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error("worker request timeout"));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`worker request failed ${response.statusCode}: ${response.body}`);
    }
  }

  private async post(path: string, body: unknown, timeoutMs = 3000) {
    if (this.params.workerSocketPath) {
      await this.postBySocket(path, body, timeoutMs);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.params.workerOrigin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-awb-agent-internal-token": this.params.internalToken
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`worker request failed ${response.status}: ${text}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async enqueueRun(run: WorkerQueuedRun): Promise<void> {
    try {
      await this.post("/internal/runs/enqueue", run, 4000);
    } catch (err) {
      this.params.logger.error({ err, runId: run.runId, sessionId: run.sessionId }, "enqueue run to worker failed");
      throw new HttpError(503, "agent worker unavailable");
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    try {
      await this.post("/internal/runs/cancel-session", { sessionId }, 2500);
    } catch (err) {
      this.params.logger.warn({ err, sessionId }, "cancel session in worker failed");
    }
  }
}
