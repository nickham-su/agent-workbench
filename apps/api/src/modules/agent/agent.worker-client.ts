import type { FastifyBaseLogger } from "fastify";
import { request as httpRequest } from "node:http";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { AgentWorkerEndpoints } from "@agent-workbench/shared/internal-contracts/endpoints";
import {
  AgentWorkerCancelSessionRequestSchema,
  AgentWorkerCancelSessionResponseSchema,
  AgentWorkerEnqueueResponseSchema,
  type AgentWorkerCancelSessionRequest,
  type AgentWorkerEnqueueRequest
} from "@agent-workbench/shared/internal-contracts/agent-worker";
import { HttpError } from "../../app/errors.js";
import type { AgentRuntimePort, AgentRuntimeRun } from "./agent.runtime-port.js";

type WorkerQueuedRun = AgentRuntimeRun;

type WorkerResponse = {
  statusCode: number;
  body: string;
};

export class AgentWorkerClient implements AgentRuntimePort {
  constructor(
    private readonly params: {
      workerOrigin: string;
      workerSocketPath: string;
      internalToken: string;
      responseValidation?: "strict" | "warn";
      logger: FastifyBaseLogger;
    }
  ) {}

  private async postBySocket(pathname: string, body: unknown, timeoutMs: number): Promise<WorkerResponse> {
    const payload = JSON.stringify(body);
    return await new Promise<WorkerResponse>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.params.workerSocketPath,
          path: pathname,
          method: this.methodFor(pathname),
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
  }

  private methodFor(pathname: string) {
    if (pathname === AgentWorkerEndpoints.enqueueRun.path) return AgentWorkerEndpoints.enqueueRun.method;
    if (pathname === AgentWorkerEndpoints.cancelSession.path) return AgentWorkerEndpoints.cancelSession.method;
    throw new Error(`unknown agent worker endpoint: ${pathname}`);
  }

  private async post(pathname: string, body: unknown, timeoutMs = 3000): Promise<unknown> {
    let response: WorkerResponse;
    if (this.params.workerSocketPath) {
      response = await this.postBySocket(pathname, body, timeoutMs);
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const fetchResponse = await fetch(`${this.params.workerOrigin}${pathname}`, {
          method: this.methodFor(pathname),
          headers: {
            "content-type": "application/json",
            "x-awb-agent-internal-token": this.params.internalToken
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        response = {
          statusCode: fetchResponse.status,
          body: await fetchResponse.text()
        };
      } finally {
        clearTimeout(timer);
      }
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`worker request failed ${response.statusCode}: ${response.body}`);
    }

    try {
      return JSON.parse(response.body) as unknown;
    } catch (err) {
      throw new Error(`worker response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async postAndValidate(params: {
    endpoint: string;
    body: unknown;
    timeoutMs: number;
    responseSchema: TSchema;
  }) {
    const response = await this.post(params.endpoint, params.body, params.timeoutMs);
    if (Value.Check(params.responseSchema, response)) return response;

    const errors = [...Value.Errors(params.responseSchema, response)].map((error) => error.message).join("; ");
    const validationError = new Error(`invalid worker response for ${params.endpoint}: ${errors}`);
    if (this.params.responseValidation === "warn") {
      this.params.logger.warn(
        { err: validationError, endpoint: params.endpoint },
        "agent worker response validation failed; continuing in warn mode"
      );
      return response;
    }
    throw validationError;
  }

  async enqueueRun(run: WorkerQueuedRun): Promise<void> {
    try {
      const payload: AgentWorkerEnqueueRequest = run;
      await this.postAndValidate({
        endpoint: AgentWorkerEndpoints.enqueueRun.path,
        body: payload,
        timeoutMs: 4000,
        responseSchema: AgentWorkerEnqueueResponseSchema
      });
    } catch (err) {
      this.params.logger.error({ err, runId: run.runId, sessionId: run.sessionId }, "enqueue run to worker failed");
      throw new HttpError(503, "agent worker unavailable");
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    try {
      const payload: AgentWorkerCancelSessionRequest = { sessionId };
      await this.postAndValidate({
        endpoint: AgentWorkerEndpoints.cancelSession.path,
        body: payload,
        timeoutMs: 2500,
        responseSchema: AgentWorkerCancelSessionResponseSchema
      });
    } catch (err) {
      this.params.logger.warn({ err, sessionId }, "cancel session in worker failed");
    }
  }
}
