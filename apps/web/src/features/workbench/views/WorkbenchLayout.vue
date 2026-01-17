<template>
  <a-layout class="min-h-screen !bg-[var(--app-bg)]">
    <a-layout-header class="flex items-center !h-12 !px-5 !bg-[var(--panel-bg-elevated)]">
      <div class="text-[color:var(--text-color)] font-semibold text-sm">{{ t("app.title") }}</div>
    </a-layout-header>

    <a-layout-content class="p-0">
      <div class="h-[calc(100vh-48px)] bg-[var(--panel-bg)]">
        <a-tabs
          :activeKey="activeKey"
          size="small"
          :animated="false"
          class="workbench-tabs h-full"
          @update:activeKey="onTabChange"
        >
          <a-tab-pane key="workspaces" :tab="t('workbench.tabs.workspaces')" class="h-full">
            <WorkspacesTab v-if="activeKey === 'workspaces'" />
          </a-tab-pane>
          <a-tab-pane key="repos" :tab="t('workbench.tabs.repos')">
            <ReposTab v-if="activeKey === 'repos'" />
          </a-tab-pane>
          <a-tab-pane key="settings" :tab="t('workbench.tabs.settings')">
            <SettingsTab v-if="activeKey === 'settings'" />
          </a-tab-pane>
        </a-tabs>
      </div>
    </a-layout-content>
  </a-layout>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import ReposTab from "@/features/repos/views/ReposTab.vue";
import WorkspacesTab from "@/features/workspaces/views/WorkspacesTab.vue";
import SettingsTab from "@/features/settings/views/SettingsTab.vue";

const { t } = useI18n();

const route = useRoute();
const router = useRouter();

const activeKey = computed<"workspaces" | "repos" | "settings">(() => {
  const path = String(route.path || "");
  if (path === "/repos" || path.startsWith("/repos/")) return "repos";
  if (path === "/settings" || path.startsWith("/settings/")) return "settings";
  return "workspaces";
});

function onTabChange(key: string) {
  if (key === "repos") void router.push("/repos");
  else if (key === "settings") void router.push("/settings/general");
  else void router.push("/workspaces");
}
</script>

<style scoped>
.workbench-tabs :deep(.ant-tabs-nav) {
  padding: 0 20px;
}

.workbench-tabs :deep(.ant-tabs-content-holder) {
  padding: 0;
}

.workbench-tabs :deep(.ant-tabs-content) {
  height: 100%;
}
</style>
