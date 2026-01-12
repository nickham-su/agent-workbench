import type { Db } from "../../infra/db/db.js";

export function getSettingJson(db: Db, key: string): { key: string; value: unknown; updatedAt: number } | null {
  const row = db
    .prepare(
      `
        select key, value_json as valueJson, updated_at as updatedAt
        from settings
        where key = ?
      `
    )
    .get(key) as { key: string; valueJson: string; updatedAt: number } | undefined;
  if (!row) return null;
  try {
    return { key: row.key, value: JSON.parse(row.valueJson), updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}

export function setSettingJson(db: Db, key: string, value: unknown, updatedAt: number) {
  const valueJson = JSON.stringify(value ?? null);
  db.prepare(
    `
      insert into settings (key, value_json, updated_at)
      values (@key, @valueJson, @updatedAt)
      on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at
    `
  ).run({ key, valueJson, updatedAt });
}

