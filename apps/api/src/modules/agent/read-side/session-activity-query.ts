import {
  AGENT_SESSION_QUERY_ERROR_CODES,
  AGENT_SESSION_QUERY_MAX_SECONDS,
  type AgentSessionQueryRequest
} from "@agent-workbench/shared/contracts/agent-session-query";
import { HttpError } from "../../../app/errors.js";

export type SessionActivityQuery = Required<AgentSessionQueryRequest>;
const allowedKeys = new Set(["workspaceId", "updatedWithinSeconds", "kind", "status"]);
const invalidQuery = () => new HttpError(400, "invalid session activity query", AGENT_SESSION_QUERY_ERROR_CODES.invalid);

/** Read the original query string: framework coercion/field stripping must not relax this contract. */
export function parseSessionActivityQuery(rawUrl: string): SessionActivityQuery {
  const position = rawUrl.indexOf("?");
  const params = new URLSearchParams(position < 0 ? "" : rawUrl.slice(position + 1));
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowedKeys.has(key) || seen.has(key)) throw invalidQuery();
    seen.add(key);
  }
  const workspaceId = params.get("workspaceId");
  const secondsRaw = params.get("updatedWithinSeconds");
  if (workspaceId === null || workspaceId.trim().length === 0 || secondsRaw === null || !/^[1-9][0-9]*$/.test(secondsRaw)) {
    throw invalidQuery();
  }
  const updatedWithinSeconds = Number(secondsRaw);
  if (!Number.isSafeInteger(updatedWithinSeconds) || updatedWithinSeconds > AGENT_SESSION_QUERY_MAX_SECONDS) throw invalidQuery();
  const kind = params.get("kind") ?? "all";
  const status = params.get("status") ?? "all";
  if (kind !== "primary" && kind !== "subtask" && kind !== "all") throw invalidQuery();
  if (status !== "idle" && status !== "running" && status !== "all") throw invalidQuery();
  return { workspaceId, updatedWithinSeconds, kind, status };
}
