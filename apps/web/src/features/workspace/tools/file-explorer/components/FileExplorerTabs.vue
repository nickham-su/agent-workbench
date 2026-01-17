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
        <span class="files-tab-label px-1.5">
          <span class="truncate max-w-[180px]">{{ tab.title }}</span>
          <span v-if="tab.dirty && !tab.saving" class="ml-1 text-[10px] text-[color:var(--warning-color)]">●</span>
          <a-tooltip :title="t('files.actions.close')" :mouseEnterDelay="0" :mouseLeaveDelay="0">
            <CloseOutlined
              class="cursor-pointer text-[color:var(--text-tertiary)] hover:text-[color:var(--text-secondary)] !ml-1 !mr-0 text-xs"
              @mousedown.stop.prevent
              @click.stop.prevent="requestCloseTab(tab.path)"
            />
          </a-tooltip>
        </span>
      </template>
    </a-tab-pane>
  </a-tabs>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { CloseOutlined } from "@ant-design/icons-vue";

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
}>();

const { t } = useI18n();
</script>
