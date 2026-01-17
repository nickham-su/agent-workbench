import { createRouter, createWebHistory } from "vue-router";
import WorkbenchPage from "@/features/workbench/views/WorkbenchPage.vue";
import WorkspacePage from "@/features/workspace/views/WorkspacePage.vue";
import LoginPage from "@/features/auth/views/LoginPage.vue";
import { loadAuthStatus } from "@/features/auth/session";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "login", component: LoginPage },
    { path: "/workspaces", name: "workbench-workspaces", component: WorkbenchPage },
    { path: "/repos", name: "workbench-repos", component: WorkbenchPage },
    // 设置页二级 tabs 绑定到 URL：/settings/<tab>
    { path: "/settings", redirect: "/settings/general" },
    {
      path: "/settings/:tab(general|gitIdentity|credentials|network|security)",
      name: "workbench-settings",
      component: WorkbenchPage
    },
    { path: "/workspaces/:workspaceId", name: "workspace", component: WorkspacePage, props: true }
  ]
});

router.beforeEach(async (to) => {
  let status;
  try {
    status = await loadAuthStatus();
  } catch {
    return true;
  }
  if (!status.authEnabled) {
    if (to.path === "/") return "/workspaces";
    return true;
  }

  if (to.path === "/") {
    if (status.authed) return "/workspaces";
    return true;
  }

  if (!status.authed) {
    return { path: "/", query: { next: to.fullPath } };
  }
  return true;
});
