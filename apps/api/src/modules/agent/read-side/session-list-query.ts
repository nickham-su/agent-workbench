import { HttpError } from "../../../app/errors.js";

export type SessionListQuery =
  | { workspaceId: string; scope: "tabs" }
  | { workspaceId: string; scope: "continuable"; limit: number; cursor?: string };
export type ContinuableCursor = { v: 1; workspaceId: string; scope: "continuable"; limit: number; updatedAt: number; id: string };
const MAX_CURSOR_LENGTH = 8192;
const keys = ["v", "workspaceId", "scope", "limit", "updatedAt", "id"];
const invalidCursor = () => new HttpError(400, "invalid session cursor", "AGENT_SESSION_CURSOR_INVALID");

function validCursor(value: unknown): value is ContinuableCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === keys.length && keys.every((key) => Object.hasOwn(item, key))
    && item.v === 1 && item.scope === "continuable"
    && typeof item.workspaceId === "string" && item.workspaceId.length > 0
    && typeof item.id === "string" && item.id.length > 0
    && typeof item.limit === "number" && Number.isInteger(item.limit) && item.limit >= 1 && item.limit <= 100
    && typeof item.updatedAt === "number" && Number.isSafeInteger(item.updatedAt) && item.updatedAt >= 0;
}

/** Opaque position only: authorization and workspace SQL conditions remain independent. */
export function decodeSessionCursor(raw: string, query: { workspaceId: string; limit: number }): ContinuableCursor {
  try {
    if (!raw || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalidCursor();
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw invalidCursor();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!validCursor(value) || value.workspaceId !== query.workspaceId || value.limit !== query.limit) throw invalidCursor();
    return value;
  } catch { throw invalidCursor(); }
}

export function encodeSessionCursor(value: ContinuableCursor): string {
  const raw = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (!validCursor(value) || raw.length > MAX_CURSOR_LENGTH) {
    // Historical metadata must not be silently truncated into a different position.
    throw new HttpError(500, "session metadata cannot be paginated", "AGENT_SESSION_METADATA_INVALID");
  }
  return raw;
}

/** Inspect raw parameters as Fastify may coerce or strip malformed query fields. */
export function parseSessionListQuery(rawUrl: string): SessionListQuery {
  const position = rawUrl.indexOf("?");
  const params = new URLSearchParams(position < 0 ? "" : rawUrl.slice(position + 1));
  const invalid = () => new HttpError(400, "invalid session list query", "AGENT_SESSION_QUERY_INVALID");
  for (const key of params.keys()) {
    if (!["workspaceId", "scope", "limit", "cursor"].includes(key) || params.getAll(key).length !== 1) throw invalid();
  }
  const workspaceId = params.get("workspaceId");
  const scope = params.get("scope");
  if (!workspaceId || (scope !== "tabs" && scope !== "continuable")) throw invalid();
  if (scope === "tabs") {
    if (params.has("limit") || params.has("cursor")) throw invalid();
    return { workspaceId, scope };
  }
  const limitRaw = params.get("limit");
  if (limitRaw !== null && !/^[1-9]\d*$/.test(limitRaw)) throw invalid();
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  const cursor = params.get("cursor");
  if (cursor !== null) decodeSessionCursor(cursor, { workspaceId, limit });
  return { workspaceId, scope, limit, ...(cursor === null ? {} : { cursor }) };
}
