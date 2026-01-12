import Database from "better-sqlite3";
import { ensureDir } from "../fs/fs.js";
import { dbPath } from "../fs/paths.js";
import { initSchema } from "./schema.js";

export type Db = Database.Database;

export async function openDb(dataDir: string): Promise<Db> {
  await ensureDir(dataDir);
  const db = new Database(dbPath(dataDir));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

