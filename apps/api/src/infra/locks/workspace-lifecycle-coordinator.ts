import { AsyncLocalStorage } from "node:async_hooks";
import { workspaceDeletingFence } from "../../modules/agent/lifecycle/workspace-deleting-fence.js";

type Unlock = () => void;

/**
 * 单 API 进程内的 Workspace 生命周期 admission gate。
 *
 * 它不替代 repo/workspace 细粒度锁，也不跨进程：唯一职责是使「检查删除 fence
 * 并开始可变副作用」与「建立 durable deletion intent」串行，防止 check-then-delete
 * 窗口。调用者必须把全部文件/Git/tmux/DB mutation 放在 withMutation 回调内。
 */
export class WorkspaceLifecycleCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly activeWorkspaces = new AsyncLocalStorage<ReadonlySet<string>>();

  private async acquire(workspaceId: string): Promise<Unlock> {
    const previous = this.tails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    this.tails.set(workspaceId, current);
    await previous;
    return () => {
      release();
      if (this.tails.get(workspaceId) === current) this.tails.delete(workspaceId);
    };
  }

  async withAdmission<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const active = this.activeWorkspaces.getStore();
    // Workspace 聚合服务会委托到同一 Workspace 的底层 Files/Git service；支持
    // 同一异步调用链重入，避免外层 admission 与内层 mutation 相互等待。
    if (active?.has(workspaceId)) return fn();
    const unlock = await this.acquire(workspaceId);
    try {
      return await this.activeWorkspaces.run(
        new Set([...(active ?? []), workspaceId]),
        fn,
      );
    } finally {
      unlock();
    }
  }

  async withMutation<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    return this.withAdmission(workspaceId, async () => {
      workspaceDeletingFence.assertWritable(workspaceId);
      return fn();
    });
  }
}

export const workspaceLifecycleCoordinator = new WorkspaceLifecycleCoordinator();
