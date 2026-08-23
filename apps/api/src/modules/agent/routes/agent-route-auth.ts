import type { FastifyRequest } from "fastify";
import { HttpError } from "../../../app/errors.js";

export const AGENT_PRIMARY_SESSION_CREATE_BODY_KEYS = new Set(["workspaceId", "title"]);
export const AGENT_PRIMARY_SESSION_FORK_BODY_KEYS = new Set(["fromSessionId", "fromItemId", "mode", "title"]);

export function assertInternalToken(req: FastifyRequest, internalToken: string) {
  const token = String(req.headers["x-awb-agent-internal-token"] || "");
  if (token !== internalToken) throw new HttpError(401, "Unauthorized");
}

export function assertPluginCaller(req: FastifyRequest, pluginId: string) {
  const caller = String(req.headers["x-awb-plugin-id"] || "").trim();
  if (!caller) throw new HttpError(401, "Unauthorized", "PLUGIN_CALLER_REQUIRED");
  if (caller !== String(pluginId || "").trim()) throw new HttpError(401, "Unauthorized", "PLUGIN_CALLER_MISMATCH");
}

export function assertOnlyAllowedBodyKeys(req: FastifyRequest, allowedKeys: ReadonlySet<string>) {
  const body = req.body;
  if (body == null || typeof body !== "object" || Array.isArray(body)) return;
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) throw new HttpError(400, "request body contains unknown field", "AGENT_REQUEST_UNKNOWN_FIELD");
  }
}
