import type { ToolRuntime, ToolRuntimeContext } from "@/features/workspace/runtime";

export function createFileExplorerRuntime(ctx: ToolRuntimeContext): ToolRuntime {
  return {
    start() {
      ctx.host.setToolDot(ctx.toolId, false);
    },
    dispose() {
      ctx.host.setToolDot(ctx.toolId, false);
    },
    onRepoChange(_nextTarget) {
    },
    onVisibilityChange(visible) {
      if (!visible) return;
      void ctx.refreshView?.();
    },
    onCall(_envelope) {
      // no-op: files 仅负责文件管理，编辑/定位统一由 editor 承担
    }
  };
}
