import { createRouter, createWebHistory } from "vue-router";
import WorkbenchPage from "../pages/WorkbenchPage.vue";
import WorkspacePage from "../pages/WorkspacePage.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/workspaces" },
    { path: "/workspaces", name: "workbench-workspaces", component: WorkbenchPage },
    { path: "/repos", name: "workbench-repos", component: WorkbenchPage },
    { path: "/settings", name: "workbench-settings", component: WorkbenchPage },
    { path: "/workspaces/:workspaceId", name: "workspace", component: WorkspacePage, props: true }
  ]
});
