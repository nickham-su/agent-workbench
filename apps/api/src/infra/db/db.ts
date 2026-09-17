import Database from "better-sqlite3";
import { ensureDir } from "../fs/fs.js";
import { dbPath } from "../fs/paths.js";
import { cleanupDestructiveAgentUpgradeFiles } from "./agent-destructive-upgrade-files.js";
import { assertAgentSchemaSupported, initSchema, markAgentFileCleanupComplete } from "./schema.js";

export type Db = Database.Database;

export async function openDb(dataDir: string): Promise<Db> {
  await ensureDir(dataDir);
  const db = new Database(dbPath(dataDir));
  // multi-process: reduce SQLITE_BUSY failures (plugin-host/worker/api may share the same db file)
  db.pragma("busy_timeout = 8000");
  db.pragma("foreign_keys = ON");

  try {
    // journal_mode 是持久化数据库设置，必须在 fail-closed 分类成功后才能修改。
    assertAgentSchemaSupported(db);
    const init = initSchema(db);
    db.pragma("journal_mode = WAL");
    if (init.fileCleanupPending) {
      const cleanup = await cleanupDestructiveAgentUpgradeFiles(db, dataDir);
      for (const diagnostic of cleanup.diagnostics) {
        // 不带 workspaces.path；仅记录受信任根推导的路径或安全的 workspace id。
        console.warn(`[${diagnostic.code}] ${diagnostic.target}: ${diagnostic.reason}`);
      }
      if (cleanup.diagnostics.length === 0) {
        markAgentFileCleanupComplete(db);
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
