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
      // 搜索范围由 scope 与 repo 选择控制,不跟随当前 repo 自动重置
    },
    onVisibilityChange() {
      // 无需处理可见性
    },
    onCall() {
      // 本期 call 不做 search 处理
    }
  };
}
