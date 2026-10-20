import type { WorkspaceGitStatusResponse } from "@agent-workbench/shared";
import type { ToolRuntime, ToolRuntimeContext } from "@/features/workspace/runtime";

const POLL_INTERVAL_MS = 5000;
const FAILURES_BEFORE_NOTIFICATION = 12;

export function createCodeReviewRuntime(ctx: ToolRuntimeContext): ToolRuntime {
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let visible = ctx.getVisible();
  let inFlight: Promise<void> | null = null;
  let started = false;
  let disposed = false;
  let failures = 0;

  const refreshDetails = async () => {
    if (!visible || disposed) return;
    try {
      await ctx.refreshView?.();
    } catch {
      // 详细列表失败独立于 Workspace 摘要，不计入后台提示限频。
    }
  };

  const query = async (includeDetails: boolean) => {
    let status: WorkspaceGitStatusResponse | undefined;
    try {
      status = await ctx.api?.getWorkspaceGitStatus?.({ workspaceId: ctx.workspaceId });
    } catch (error) {
      if (disposed) return;
      failures += 1;
      if (failures === FAILURES_BEFORE_NOTIFICATION) {
        failures = 0;
        ctx.onBackgroundError?.(error);
      }
    }
    if (disposed) return;
    if (status) {
      failures = 0;
      ctx.onWorkspaceGitStatus?.(status);
      ctx.host.setToolDot(ctx.toolId, status.repos.some((repo) => repo.hasChanges));
    }
    if (includeDetails) await refreshDetails();
  };

  const refresh = (includeDetails: boolean): Promise<void> => {
    if (disposed || !started) return Promise.resolve();
    // 显式刷新可加入当前请求；冷却期快速返回，不阻塞操作，也不重排下一轮。
    if (inFlight) return inFlight;
    if (pollTimer !== null) return Promise.resolve();

    inFlight = query(includeDetails).finally(() => {
      inFlight = null;
      if (disposed) return;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void refresh(true);
      }, POLL_INTERVAL_MS);
    });
    return inFlight;
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      void refresh(true);
    },
    dispose() {
      disposed = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
    },
    // 操作方已经刷新详细列表，此入口只刷新共享摘要。
    refresh: () => refresh(false),
    onRepoChange() {
      // 面板负责即时刷新新选择的列表；摘要始终针对整个 Workspace。
    },
    onVisibilityChange(next) {
      visible = next;
      if (next) void refreshDetails();
    },
    onCall() {
      // 代码审查目前不处理工具调用。
    }
  };
}
