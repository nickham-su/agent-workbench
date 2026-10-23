import type { TerminalConfigRecord } from "@agent-workbench/shared";
import type { Db } from "../../infra/db/db.js";

const columns = `id, workspace_id as workspaceId, name, cwd, command, created_at as createdAt, updated_at as updatedAt`;
export function listTerminalConfigs(db: Db, workspaceId: string): TerminalConfigRecord[] {
  return db.prepare(`select ${columns} from workspace_terminal_configs where workspace_id = ? order by sort_order, created_at, id`).all(workspaceId) as TerminalConfigRecord[];
}
export function getTerminalConfig(db: Db, workspaceId: string, id: string): TerminalConfigRecord | null {
  return db.prepare(`select ${columns} from workspace_terminal_configs where workspace_id = ? and id = ?`).get(workspaceId, id) as TerminalConfigRecord | undefined ?? null;
}
export function insertTerminalConfig(db: Db, config: TerminalConfigRecord) {
  db.prepare(`insert into workspace_terminal_configs (id, workspace_id, name, cwd, command, created_at, updated_at, sort_order)
    values (@id, @workspaceId, @name, @cwd, @command, @createdAt, @updatedAt,
      (select coalesce(max(sort_order), -1) + 1 from workspace_terminal_configs where workspace_id = @workspaceId))`).run(config);
}
export function updateTerminalConfigOrder(db: Db, workspaceId: string, orderedIds: string[]) {
  const update = db.prepare("update workspace_terminal_configs set sort_order = ? where workspace_id = ? and id = ?");
  orderedIds.forEach((id, index) => update.run(index, workspaceId, id));
}
export function updateTerminalConfig(db: Db, config: TerminalConfigRecord) {
  db.prepare(`update workspace_terminal_configs set name = @name, cwd = @cwd, command = @command, updated_at = @updatedAt
    where workspace_id = @workspaceId and id = @id`).run(config);
}
export function deleteTerminalConfig(db: Db, workspaceId: string, id: string) {
  db.prepare("delete from workspace_terminal_configs where workspace_id = ? and id = ?").run(workspaceId, id);
}
