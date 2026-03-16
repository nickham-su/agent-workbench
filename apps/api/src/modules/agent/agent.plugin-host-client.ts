import type { FastifyBaseLogger } from "fastify";
import { request as httpRequest } from "node:http";
import { HttpError } from "../../app/errors.js";
import type {
  PluginToolRpcExecuteRequest,
  PluginToolRpcExecuteResponse,
  PluginToolRpcListRequest,
  PluginToolRpcListResponse
} from "@agent-workbench/shared";

type RpcError = {
  message?: unknown;
  code?: unknown;
};

export class AgentPluginHostClient {
  constructor(
    private readonly params: {
      pluginHostSocketPath: string;
      internalToken: string;
      logger: FastifyBaseLogger;
    }
  ) {}

  private async requestBySocket(method: "GET" | "POST", pathname: string, body: unknown, timeoutMs: number) {
    const payload = JSON.stringify(body ?? {});
    const headers: Record<string, string | number> = {
      "x-awb-agent-internal-token": this.params.internalToken
    };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.params.pluginHostSocketPath,
          path: pathname,
          method,
          headers
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
        req.destroy(new Error("plugin-host request timeout"));
      });
      req.on("error", reject);
      if (method === "POST") {
        req.write(payload);
      }
      req.end();
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.body ? (JSON.parse(response.body) as any) : ({} as any);
    }

    // plugin-host 的错误 body 约定为 { message, code? }
    let errBody: RpcError | null = null;
    try {
      errBody = JSON.parse(response.body) as RpcError;
    } catch {
      errBody = null;
    }
    const message =
      typeof errBody?.message === "string" && errBody.message.trim()
        ? errBody.message
        : response.body || `plugin-host request failed (status=${response.statusCode})`;
    const code = typeof errBody?.code === "string" && errBody.code.trim() ? errBody.code : undefined;

    throw new HttpError(response.statusCode || 500, message, code);
  }

  private async postBySocket(pathname: string, body: unknown, timeoutMs: number) {
    return await this.requestBySocket("POST", pathname, body, timeoutMs);
  }

  private async getBySocket(pathname: string, timeoutMs: number) {
    return await this.requestBySocket("GET", pathname, {}, timeoutMs);
  }

  async listTools(input: PluginToolRpcListRequest): Promise<PluginToolRpcListResponse> {
    try {
      return await this.postBySocket("/internal/plugins/tools/list", input ?? {}, 4000);
    } catch (err) {
      this.params.logger.error({ err }, "plugin-host listTools failed");
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, "plugin host unavailable", "PLUGIN_HOST_UNAVAILABLE");
    }
  }

  async executeTool(input: PluginToolRpcExecuteRequest): Promise<PluginToolRpcExecuteResponse> {
    try {
      return await this.postBySocket("/internal/plugins/tools/execute", input ?? {}, 30_000);
    } catch (err) {
      this.params.logger.error({ err }, "plugin-host executeTool failed");
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, "plugin host unavailable", "PLUGIN_HOST_UNAVAILABLE");
    }
  }

  async reconcileServices(): Promise<{ running: boolean; lastError?: { message: string; code?: string } | null }> {
    try {
      return await this.postBySocket("/internal/plugins/services/reconcile", {}, 4000);
    } catch (err) {
      this.params.logger.error({ err }, "plugin-host reconcileServices failed");
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, "plugin host unavailable", "PLUGIN_HOST_UNAVAILABLE");
    }
  }

  async getServicesStatus(): Promise<{ running: boolean; lastError?: { message: string; code?: string } | null }> {
    try {
      return await this.getBySocket("/internal/plugins/services/status", 4000);
    } catch (err) {
      this.params.logger.error({ err }, "plugin-host getServicesStatus failed");
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, "plugin host unavailable", "PLUGIN_HOST_UNAVAILABLE");
    }
  }

  async feishuReplyText(input: { chatId: string; messageId: string; text: string }): Promise<{ ok: true }> {
    try {
      return await this.postBySocket("/internal/plugins/feishu/reply-text", input ?? {}, 15_000);
    } catch (err) {
      this.params.logger.error({ err }, "plugin-host feishuReplyText failed");
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, "plugin host unavailable", "PLUGIN_HOST_UNAVAILABLE");
    }
  }

  async feishuSendText(input: { chatId: string; text: string }): Promise<{ ok: true }> {
    try {
      return await this.postBySocket("/internal/plugins/feishu/send-text", input ?? {}, 15_000);
    } catch (err) {
      this.params.logger.error({ err }, "plugin-host feishuSendText failed");
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, "plugin host unavailable", "PLUGIN_HOST_UNAVAILABLE");
    }
  }
}
