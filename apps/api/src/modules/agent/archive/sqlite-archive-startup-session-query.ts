import type { Db } from "../../../infra/db/db.js";
import { listAgentSessionsForArchiveReconcile } from "../agent.store.js";

export type ArchiveStartupSessionQuery = {
  listForReconcile(): Array<{ workspaceId: string; sessionId: string }>;
};

/** Named SQLite adapter for the archive startup candidate query. */
export class SqliteArchiveStartupSessionQuery implements ArchiveStartupSessionQuery {
  constructor(private readonly db: Db) {}

  listForReconcile() {
    return listAgentSessionsForArchiveReconcile(this.db);
  }
}
