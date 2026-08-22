import type { Db } from "../../../infra/db/db.js";
import { appendSystemSummaryAndArchiveItems } from "../agent.store.js";

export type AppendSummaryAndArchiveItemsCommand = Parameters<typeof appendSystemSummaryAndArchiveItems>[1];

/** Named P2 persistence boundary; its single SQLite transaction remains in agent.store during migration. */
export class SqliteCompactionArchivePersistence {
  constructor(private readonly db: Db) {}

  appendSummaryAndArchiveItems(command: AppendSummaryAndArchiveItemsCommand) {
    return appendSystemSummaryAndArchiveItems(this.db, command);
  }
}
