import type { GitStatusResponse } from "@agent-workbench/shared";
import type { ToolRuntime, ToolRuntimeContext } from "@/features/workspace/runtime";

const POLL_INTERVAL_MS = 5000;

export function createCodeReviewRuntime(ctx: ToolRuntimeContext): ToolRuntime {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let visible = ctx.getVisible();
  let inFlight = false;
  let pending = false;
  let disposed = false;

  const updateDotFromStatus = (status: GitStatusResponse | null) => {
    const dirty = status?.dirty;
    const total = (dirty?.staged ?? 0) + (dirty?.unstaged ?? 0) + (dirty?.untracked ?? 0);
    ctx.host.setToolDot(ctx.toolId, total > 0);
  };

  const runLight = async () => {
    const target = ctx.getCurrentTarget();
    if (!target) {
      ctx.host.setToolDot(ctx.toolId, false);
      return;
    }
    if (!ctx.api?.getGitStatus) return;
    try {
      const status = (await ctx.api.getGitStatus({ target })) as GitStatusResponse;
      updateDotFromStatus(status);
    } catch {
      // 忽略失败,避免影响 UI
    }
  };

  const runHeavy = async () => {
    try {
      await ctx.refreshView?.();
    } catch {
      // 忽略刷新失败,避免影响轮询
    }
    await runLight();
  };

  const tick = async () => {
    if (disposed) return;
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      if (visible) await runHeavy();
      else await runLight();
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        void tick();
      }
    }
  };

  const start = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    void tick();
  };

  const dispose = () => {
    disposed = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  return {
    start,
    dispose,
    onRepoChange() {
      void tick();
    },
    onVisibilityChange(next) {
      visible = next;
      void tick();
    },
    onCall() {
      // 本期 call 不做 code-review 处理
    }
  };
}
