import { effectScope, watch } from "vue";
import type { ToolRuntime, ToolRuntimeContext } from "@/features/workspace/runtime";
import { getFileExplorerStore, type FileOpenAtRequest } from "./store";

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
      void nextTarget;
    },
    onVisibilityChange() {
      // 文件浏览器红点与 tab 状态一致,可见性不影响计算
    },
    onCall(envelope) {
      if (envelope.type !== "files.openAt") return;
      const payload = (envelope.payload ?? {}) as Partial<FileOpenAtRequest>;
      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      const line = typeof payload.line === "number" ? payload.line : 0;
      if (!path || line <= 0) return;
      const highlight = payload.highlight;
      if (!highlight || (highlight.kind !== "line" && highlight.kind !== "range")) return;
      if (highlight.kind === "range") {
        if (typeof highlight.startCol !== "number" || typeof highlight.endCol !== "number") return;
      }
      const targetDirName = typeof payload.targetDirName === "string" ? payload.targetDirName : envelope.targetAtCall?.dirName;
      store.setPendingOpenAt({ path, line, highlight, targetDirName } as FileOpenAtRequest);
    }
  };
}
