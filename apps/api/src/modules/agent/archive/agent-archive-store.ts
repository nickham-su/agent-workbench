import { HttpError } from "../../../app/errors.js";
import type { Db } from "../../../infra/db/db.js";

const ELIGIBLE_MESSAGE_TYPES = new Set(["user", "assistant", "system", "compaction"]);

type ArchiveCursor = {
  workspaceId: string;
  sessionId: string;
  contextRootMessageId: string;
  messageId: string;
  messageDepth: number;
  partId: string;
  partPosition: number;
};

type ArchiveRow = {
  partId: string;
  messageId: string;
  messageDepth: number;
  partPosition: number;
  text: string;
  excerpt?: string;
};

export type AgentArchiveEntry = {
  partId: string;
  messageId: string;
  messageDepth: number;
  partPosition: number;
  text: string;
  excerpt?: string;
};

export type AgentArchivePage = {
  items: AgentArchiveEntry[];
  nextCursor: string | null;
};

function encodeCursor(cursor: ArchiveCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function invalidCursor(): never {
  throw new HttpError(400, "invalid archive cursor", "AGENT_ARCHIVE_CURSOR_INVALID");
}

function decodeCursor(raw: string | undefined): ArchiveCursor | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalidCursor();
    const value = parsed as Record<string, unknown>;
    const keys = ["workspaceId", "sessionId", "contextRootMessageId", "messageId", "messageDepth", "partId", "partPosition"];
    if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) return invalidCursor();
    if (["workspaceId", "sessionId", "contextRootMessageId", "messageId", "partId"].some((key) => typeof value[key] !== "string" || !(value[key] as string))) return invalidCursor();
    if (!Number.isSafeInteger(value.messageDepth) || !Number.isSafeInteger(value.partPosition) || (value.messageDepth as number) < 0 || (value.partPosition as number) < 0) return invalidCursor();
    return value as unknown as ArchiveCursor;
  } catch {
    return invalidCursor();
  }
}

function getArchiveBoundary(db: Db, workspaceId: string, sessionId: string) {
  const session = db.prepare(`
    select head_message_id as headMessageId, context_root_message_id as contextRootMessageId
    from agent_session where id = ? and workspace_id = ?
  `).get(sessionId, workspaceId) as { headMessageId: string | null; contextRootMessageId: string | null } | undefined;
  if (!session) throw new HttpError(404, "session not found");
  if (!session.headMessageId || !session.contextRootMessageId) return null;
  const root = db.prepare(`
    select id, previous_message_id as previousMessageId
    from agent_message where id = ? and workspace_id = ?
  `).get(session.contextRootMessageId, workspaceId) as { id: string; previousMessageId: string | null } | undefined;
  if (!root) throw new Error("session context root is invalid");
  return { contextRootMessageId: root.id, archiveHeadMessageId: root.previousMessageId };
}

/** 验证 cursor 既属于当前会话归档祖先链，又完整匹配主表坐标。 */
function validateCursor(db: Db, params: { workspaceId: string; sessionId: string; boundary: NonNullable<ReturnType<typeof getArchiveBoundary>>; cursor: ArchiveCursor | null }) {
  const { cursor } = params;
  if (!cursor) return null;
  if (cursor.workspaceId !== params.workspaceId || cursor.sessionId !== params.sessionId || cursor.contextRootMessageId !== params.boundary.contextRootMessageId) invalidCursor();
  const row = db.prepare(`
    with recursive lineage(id, previous_message_id) as (
      select id, previous_message_id from agent_message where id = ? and workspace_id = ?
      union all
      select parent.id, parent.previous_message_id
      from agent_message parent join lineage child on parent.id = child.previous_message_id
    )
    select message.id as messageId, message.depth as messageDepth, part.id as partId, part.position as partPosition
    from lineage
    join agent_message message on message.id = lineage.id
    join agent_message_part part on part.message_id = message.id
    where message.id = ? and message.workspace_id = ? and part.id = ?
      and part.type = 'text'
      and message.status = 'completed'
      and message.type in ('user', 'assistant', 'system', 'compaction')
  `).get(params.boundary.archiveHeadMessageId, params.workspaceId, cursor.messageId, params.workspaceId, cursor.partId) as {
    messageId: string; messageDepth: number; partId: string; partPosition: number;
  } | undefined;
  if (!row || row.messageId !== cursor.messageId || Number(row.messageDepth) !== cursor.messageDepth || row.partId !== cursor.partId || Number(row.partPosition) !== cursor.partPosition) invalidCursor();
  return cursor;
}

function keysetWhere(cursor: ArchiveCursor | null) {
  if (!cursor) return { sql: "", params: {} };
  return {
    sql: `and (
      message.depth < @cursorDepth
      or (message.depth = @cursorDepth and message.id < @cursorMessageId)
      or (message.depth = @cursorDepth and message.id = @cursorMessageId and part.position < @cursorPartPosition)
      or (message.depth = @cursorDepth and message.id = @cursorMessageId and part.position = @cursorPartPosition and part.id < @cursorPartId)
    )`,
    params: {
      cursorDepth: cursor.messageDepth,
      cursorMessageId: cursor.messageId,
      cursorPartPosition: cursor.partPosition,
      cursorPartId: cursor.partId,
    },
  };
}

function toPage(fetchedRows: ArchiveRow[], limit: number, order: "oldest" | "newest", cursorParams: Pick<ArchiveCursor, "workspaceId" | "sessionId" | "contextRootMessageId">): AgentArchivePage {
  const hasMore = fetchedRows.length > limit;
  const rows = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
  const next = hasMore ? rows.at(-1) : null;
  const items = order === "oldest" ? [...rows].reverse() : rows;
  return {
    items: items.map((row) => ({ partId: row.partId, messageId: row.messageId, messageDepth: Number(row.messageDepth), partPosition: Number(row.partPosition), text: row.text, ...(row.excerpt ? { excerpt: row.excerpt } : {}) })),
    nextCursor: next ? encodeCursor({ ...cursorParams, messageId: next.messageId, messageDepth: Number(next.messageDepth), partId: next.partId, partPosition: Number(next.partPosition) }) : null,
  };
}

/** 在调用方已有的 completed 事务内维护 FTS/map；不能单独提交。 */
export function indexEligibleCompletedTextParts(db: Db, messageId: string, createdAt: number) {
  const message = db.prepare("select type, status from agent_message where id = ?").get(messageId) as { type: string; status: string } | undefined;
  if (!message || message.status !== "completed" || !ELIGIBLE_MESSAGE_TYPES.has(message.type)) return;
  const parts = db.prepare("select id, text, position from agent_message_part where message_id = ? and type = 'text' order by position, id").all(messageId) as Array<{ id: string; text: string; position: number }>;
  const depth = (db.prepare("select depth from agent_message where id = ?").get(messageId) as { depth: number }).depth;
  const find = db.prepare("select fts_rowid as ftsRowid from agent_text_part_fts_map where part_id = ?");
  const insertFts = db.prepare("insert into agent_archived_text_fts (text, message_depth, part_position) values (?, ?, ?)");
  const insertMap = db.prepare("insert into agent_text_part_fts_map (part_id, fts_rowid, created_at) values (?, ?, ?)");
  for (const part of parts) {
    if (find.get(part.id)) continue;
    const result = insertFts.run(part.text, depth, part.position);
    insertMap.run(part.id, Number(result.lastInsertRowid), createdAt);
  }
}

/** 仅用于维护/升级；入口自身原子，失败时保留原有 FTS/map。 */
export function rebuildArchivedTextFts(db: Db, createdAt: number) {
  return db.transaction(() => {
    db.prepare("delete from agent_text_part_fts_map").run();
    db.prepare("delete from agent_archived_text_fts").run();
    const messages = db.prepare(`select id from agent_message where status = 'completed' and type in ('user','assistant','system','compaction') order by created_at, id`).all() as Array<{ id: string }>;
    for (const message of messages) indexEligibleCompletedTextParts(db, message.id, createdAt);
  })();
}

export function archiveRead(db: Db, input: { workspaceId: string; sessionId: string; cursor?: string; limit?: number }): AgentArchivePage {
  const boundary = getArchiveBoundary(db, input.workspaceId, input.sessionId);
  if (!boundary?.archiveHeadMessageId) return { items: [], nextCursor: null };
  const cursor = validateCursor(db, { ...input, boundary, cursor: decodeCursor(input.cursor) });
  const keyset = keysetWhere(cursor);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 200);
  const fetchLimit = limit + 1;
  const rows = db.prepare(`
    with recursive lineage(id, previous_message_id) as (
      select id, previous_message_id from agent_message where id = @archiveHeadMessageId and workspace_id = @workspaceId
      union all
      select parent.id, parent.previous_message_id from agent_message parent join lineage child on parent.id = child.previous_message_id
    )
    select part.id as partId, message.id as messageId, message.depth as messageDepth, part.position as partPosition, part.text as text
    from lineage join agent_message message on message.id = lineage.id join agent_message_part part on part.message_id = message.id
    where message.workspace_id = @workspaceId and message.status = 'completed' and message.type in ('user','assistant','system','compaction') and part.type = 'text'
    ${keyset.sql}
    order by message.depth desc, message.id desc, part.position desc, part.id desc limit @limit
  `).all({ workspaceId: input.workspaceId, archiveHeadMessageId: boundary.archiveHeadMessageId, limit: fetchLimit, ...keyset.params }) as ArchiveRow[];
  return toPage(rows, limit, "oldest", { workspaceId: input.workspaceId, sessionId: input.sessionId, contextRootMessageId: boundary.contextRootMessageId });
}

function normalizeArchiveSearchQuery(rawQuery: string) {
  const query = rawQuery.trim();
  // SQLite bindings reject NUL text. 这是调用参数问题，而不是数据库/FTS 故障。
  if (query.includes("\0")) {
    throw new HttpError(400, "archive search query is invalid", "AGENT_ARCHIVE_QUERY_INVALID");
  }
  return query;
}

function toSafeTrigramMatchQuery(query: string) {
  return `"${query.replaceAll('"', '""')}"`;
}

export function archiveSearch(db: Db, input: { workspaceId: string; sessionId: string; query: string; cursor?: string; limit?: number }): AgentArchivePage {
  const query = normalizeArchiveSearchQuery(input.query);
  if ([...query].length < 3) throw new HttpError(400, "archive search query must contain at least 3 characters", "AGENT_ARCHIVE_QUERY_TOO_SHORT");
  const boundary = getArchiveBoundary(db, input.workspaceId, input.sessionId);
  if (!boundary?.archiveHeadMessageId) return { items: [], nextCursor: null };
  const cursor = validateCursor(db, { ...input, boundary, cursor: decodeCursor(input.cursor) });
  const keyset = keysetWhere(cursor);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 200);
  const fetchLimit = limit + 1;
  const rows = db.prepare(`
    with recursive lineage(id, previous_message_id) as (
      select id, previous_message_id from agent_message where id = @archiveHeadMessageId and workspace_id = @workspaceId
      union all
      select parent.id, parent.previous_message_id from agent_message parent join lineage child on parent.id = child.previous_message_id
    )
    select map.part_id as partId, message.id as messageId, message.depth as messageDepth, part.position as partPosition, part.text as text,
      snippet(agent_archived_text_fts, 0, '[', ']', ' … ', 24) as excerpt
    from agent_archived_text_fts
    join agent_text_part_fts_map map on map.fts_rowid = agent_archived_text_fts.rowid
    join agent_message_part part on part.id = map.part_id
    join agent_message message on message.id = part.message_id
    join lineage on lineage.id = message.id
    where agent_archived_text_fts match @query and message.workspace_id = @workspaceId
      and message.status = 'completed' and message.type in ('user','assistant','system','compaction') and part.type = 'text'
    ${keyset.sql}
    order by message.depth desc, message.id desc, part.position desc, part.id desc limit @limit
    `).all({ workspaceId: input.workspaceId, archiveHeadMessageId: boundary.archiveHeadMessageId, query: toSafeTrigramMatchQuery(query), limit: fetchLimit, ...keyset.params }) as ArchiveRow[];
  return toPage(rows, limit, "newest", { workspaceId: input.workspaceId, sessionId: input.sessionId, contextRootMessageId: boundary.contextRootMessageId });
}
