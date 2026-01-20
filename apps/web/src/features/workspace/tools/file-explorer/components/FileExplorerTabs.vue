<template>
  <a-tabs
    v-if="tabs.length > 0"
    :activeKey="activeTabKey"
    size="small"
    :animated="false"
    class="files-tabs bg-[var(--panel-bg-elevated)]"
    @update:activeKey="onActiveTabUpdate"
  >
    <a-tab-pane v-for="tab in tabs" :key="tab.path">
      <template #tab>
        <a-dropdown :trigger="['contextmenu']" class="block">
          <span class="files-tab-label px-1.5" @contextmenu.prevent="onTabContextMenu(tab.path)">
            <a-tooltip :title="tab.path" placement="top" :mouseEnterDelay="0.8" :mouseLeaveDelay="0.1" :autoAdjustOverflow="false">
              <span class="truncate max-w-[180px]">{{ tab.title }}</span>
            </a-tooltip>
            <span v-if="tab.dirty && !tab.saving" class="ml-1 text-[10px] text-[color:var(--warning-color)]">●</span>
            <CloseOutlined
              class="cursor-pointer text-[color:var(--text-tertiary)] hover:text-[color:var(--text-secondary)] !ml-1 !mr-0 text-xs"
              @mousedown.stop.prevent
              @click.stop.prevent="requestCloseTab(tab.path)"
            />
          </span>
          <template #overlay>
            <a-menu @click="onContextMenuClick($event, tab.path)">
              <a-menu-item key="closeOthers" :disabled="!hasClosableOthers(tab.path)">
                {{ t("files.actions.closeOthers") }}
              </a-menu-item>
              <a-menu-item key="closeAll" :disabled="!hasClosableAll">
                {{ t("files.actions.closeAll") }}
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </template>
    </a-tab-pane>
  </a-tabs>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { CloseOutlined } from "@ant-design/icons-vue";
import { computed } from "vue";

type FileTabItem = {
  path: string;
  title: string;
  dirty: boolean;
  saving: boolean;
};

const props = defineProps<{
  tabs: FileTabItem[];
  activeTabKey: string;
  onActiveTabUpdate: (key: string) => void;
  requestCloseTab: (path: string) => void;
  requestCloseOtherTabs: (path: string) => void;
  requestCloseAllTabs: () => void;
  onTabContextMenu: (path: string) => void;
}>();

const { t } = useI18n();

const hasClosableAll = computed(() => props.tabs.some((tab) => !tab.dirty));

function hasClosableOthers(path: string) {
  return props.tabs.some((tab) => tab.path !== path && !tab.dirty);
}

function onContextMenuClick(info: any, path: string) {
  const key = String(info?.key || "");
  if (key === "closeOthers") {
    props.requestCloseOtherTabs(path);
    return;
  }
  if (key === "closeAll") {
    props.requestCloseAllTabs();
  }
}

function onTabContextMenu(path: string) {
  props.onTabContextMenu(path);
}
</script>
