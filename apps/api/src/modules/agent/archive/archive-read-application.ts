import { HttpError } from "../../../app/errors.js";

type SessionReader = { get(sessionId: string): { workspaceId: string; id: string } | null };
type ArchiveReader = { search(params: { workspaceId: string; sessionId: string; query: string; beforePos?: number; maxHits: number; maxChars: number; snippet: boolean; regex: boolean }): Promise<{ text: string; noArchive?: true }>; read(params: { workspaceId: string; sessionId: string; beforePos?: number; lineCount: number; maxChars: number }): Promise<{ text: string; noArchive?: true }> };
function positive(value: unknown, fallback: number, min: number, max: number) { if (value == null || value === "") return fallback; const n = Math.floor(Number(value)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; }
function before(value: unknown) { if (value == null || value === "") return undefined; const n = Number(value); if (!Number.isInteger(n) || n < 2) throw new HttpError(400, "beforePos must be an integer >= 2", "AGENT_ARCHIVE_BEFORE_POS_INVALID"); return n; }
/** Transport-neutral owner for archive search/read validation and ownership checks. */
export class ArchiveReadApplication {
  constructor(private readonly sessions: SessionReader, private readonly storage: ArchiveReader) {}
  async search(params: { workspaceId: string; sessionId: string; query: string; beforePos?: number; maxHits?: number; maxChars?: number; snippet?: boolean; regex?: boolean }) {
    const session = this.requireSession(params); const query = String(params.query || "").trim(); if (!query) throw new HttpError(400, "query is required", "AGENT_ARCHIVE_QUERY_REQUIRED");
    const beforePos = before(params.beforePos);
    try { return await this.storage.search({ workspaceId: params.workspaceId, sessionId: session.id, query, ...(beforePos != null ? { beforePos } : {}), maxHits: positive(params.maxHits, 10, 1, 100), maxChars: positive(params.maxChars, 8000, 1000, 10000), snippet: params.snippet === true, regex: params.regex === true }); } catch (error) { if (error instanceof HttpError) throw error; const message = error instanceof Error ? error.message : String(error); throw new HttpError(400, message, "AGENT_ARCHIVE_SEARCH_FAILED"); }
  }
  async read(params: { workspaceId: string; sessionId: string; beforePos?: number; lineCount?: number; maxChars?: number }) { const session = this.requireSession(params); const beforePos = before(params.beforePos); return this.storage.read({ workspaceId: params.workspaceId, sessionId: session.id, ...(beforePos != null ? { beforePos } : {}), lineCount: positive(params.lineCount, 40, 1, 200), maxChars: positive(params.maxChars, 8000, 1000, 10000) }); }
  private requireSession(params: { workspaceId: string; sessionId: string }) { const session = this.sessions.get(params.sessionId); if (!session) throw new HttpError(404, "session not found"); if (session.workspaceId !== params.workspaceId) throw new HttpError(400, "workspaceId mismatch"); return session; }
}
