import type { Db } from "../../infra/db/db.js";

/** Ciphertext-only persistence. Plaintext never appears in SQL parameters. */
export type WorkspaceEnvironmentRow = {
  id: string; workspaceId: string; name: string; valueEnc: string; remark: string;
  enabled: number; createdAt: number; updatedAt: number;
};
const COLUMNS = `id, workspace_id as workspaceId, name, value_enc as valueEnc, remark,
  enabled, created_at as createdAt, updated_at as updatedAt`;

export class WorkspaceEnvironmentStore {
  constructor(private readonly db: Db) {}

  workspaceExists(workspaceId: string): boolean {
    return Boolean(this.db.prepare("select 1 from workspaces where id=?").get(workspaceId));
  }

  workspaceDeleting(workspaceId: string): boolean {
    return Boolean(this.db.prepare("select 1 from workspace_deletion where workspace_id=?").get(workspaceId));
  }

  list(workspaceId: string): WorkspaceEnvironmentRow[] {
    return this.db.prepare(`select ${COLUMNS} from workspace_environment_variables
      where workspace_id=? order by created_at asc, id asc`).all(workspaceId) as WorkspaceEnvironmentRow[];
  }

  insert(row: WorkspaceEnvironmentRow): void {
    this.db.prepare(`insert into workspace_environment_variables
      (id, workspace_id, name, value_enc, remark, enabled, created_at, updated_at)
      values (@id, @workspaceId, @name, @valueEnc, @remark, @enabled, @createdAt, @updatedAt)`).run(row);
  }

  update(row: WorkspaceEnvironmentRow): void {
    this.db.prepare(`update workspace_environment_variables set name=@name, value_enc=@valueEnc,
      remark=@remark, enabled=@enabled, updated_at=@updatedAt where workspace_id=@workspaceId and id=@id`).run(row);
  }

  delete(workspaceId: string, variableId: string): void {
    this.db.prepare("delete from workspace_environment_variables where workspace_id=? and id=?").run(workspaceId, variableId);
  }
}
