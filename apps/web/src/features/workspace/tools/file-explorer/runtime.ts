import { effectScope, watch } from "vue";
import type { ToolRuntime, ToolRuntimeContext } from "@/features/workspace/runtime";
import { getFileExplorerStore } from "./store";

export function createFileExplorerRuntime(ctx: ToolRuntimeContext): ToolRuntime {
  const store = getFileExplorerStore(ctx.workspaceId);
  let scope = effectScope();

  const syncDot = () => {
    ctx.host.setToolDot(ctx.toolId, store.hasDirtyNotSaving.value);
  };

  return {
    start() {
      scope.run(() => {
        watch(
          store.hasDirtyNotSaving,
          () => {
            syncDot();
          },
          { immediate: true }
        );
      });
    },
    dispose() {
      store.resetTabs();
      ctx.host.setToolDot(ctx.toolId, false);
      scope.stop();
      scope = effectScope();
    },
    onRepoChange(nextTarget) {
      const nextKey = nextTarget ? `${nextTarget.workspaceId}:${nextTarget.dirName}` : "";
      if (store.setTargetKey(nextKey)) {
        store.resetTabs();
        ctx.host.setToolDot(ctx.toolId, false);
      }
    },
    onVisibilityChange() {
      // 文件浏览器红点与 tab 状态一致,可见性不影响计算
    },
    onCall() {
      // 本期 call 不做 files 处理
    }
  };
}
