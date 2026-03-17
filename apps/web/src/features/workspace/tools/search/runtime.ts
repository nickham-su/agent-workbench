import type { ToolRuntime, ToolRuntimeContext } from "@/features/workspace/runtime";
import { getSearchStore } from "./store";

export function createSearchRuntime(ctx: ToolRuntimeContext): ToolRuntime {
  const store = getSearchStore(ctx.workspaceId);

  return {
    start() {
      // 无需常驻轮询
    },
    dispose() {
      store.resetAll();
    },
    onRepoChange() {
      // 搜索范围由 path 控制,不跟随当前 repo 自动重置
    },
    onVisibilityChange() {
      // 无需处理可见性
    },
    onCall() {
      // 本期 call 不做 search 处理
    },
    onEvent(event) {
      const type = String((event as any)?.type ?? "");
      if (type !== "search.prefillPath") return;
      const payload = (event as any)?.payload as any;
      const path = typeof payload?.path === "string" ? payload.path.trim() : "";
      store.path.value = path || ".";
      // 仅预填路径，不自动触发搜索，但需要清理旧结果与 in-flight 请求
      store.nextRequestSeq();
      store.resetResults();
      store.loading.value = false;
    }
  };
}
