import { ref } from "vue";

// 仅内存态：用于在 workbench 的 tabs 之间保留搜索词；刷新页面会丢失。
const workspacesQuery = ref("");
const reposQuery = ref("");

export function useWorkbenchSearchState() {
  return { workspacesQuery, reposQuery };
}

