import { HttpError } from "../../../app/errors.js";

/**
 * 单 API 进程的 Workspace 删除运行态 fence。
 *
 * 它刻意不持有 SQLite 锁：删除流程先登记 fence 并在短事务内收敛运行态，
 * 再请求 runtime cancel，最终由单一删除事务完成物理清理。
 */
export class WorkspaceDeletingFence {
  private readonly deleting = new Set<string>();

  begin(workspaceId: string) {
    if (this.deleting.has(workspaceId)) {
      throw new HttpError(409, "workspace is being deleted", "WORKSPACE_DELETING");
    }
    this.deleting.add(workspaceId);
  }

  restore(workspaceId: string) {
    this.deleting.add(workspaceId);
  }

  end(workspaceId: string) {
    this.deleting.delete(workspaceId);
  }

  assertWritable(workspaceId: string) {
    if (this.deleting.has(workspaceId)) {
      throw new HttpError(409, "workspace is being deleted", "WORKSPACE_DELETING");
    }
  }

  isDeleting(workspaceId: string) {
    return this.deleting.has(workspaceId);
  }
}

export const workspaceDeletingFence = new WorkspaceDeletingFence();
