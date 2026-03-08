<template>
  <a-tabs
    v-if="tabs.length > 0"
    :activeKey="activeTabKey"
    size="small"
    :animated="false"
    class="editor-tabs bg-[var(--panel-bg-elevated)]"
    @update:activeKey="onUpdateActiveKey"
  >
    <a-tab-pane v-for="tab in tabs" :key="tab.key">
      <template #tab>
        <span class="editor-tab-label px-1.5 inline-flex items-center">
          <a-tooltip :title="tab.path || tab.title" placement="top" :mouseEnterDelay="0.8" :mouseLeaveDelay="0.1" :autoAdjustOverflow="false">
            <span class="truncate max-w-[220px]">{{ tab.title }}</span>
          </a-tooltip>
          <span v-if="tab.kind === 'file' && tab.dirty && !tab.saving" class="ml-1 text-[10px] text-[color:var(--warning-color)]">●</span>
          <CloseOutlined
            class="cursor-pointer text-[color:var(--text-tertiary)] hover:text-[color:var(--text-secondary)] !ml-1 !mr-0 text-xs"
            @mousedown.stop.prevent
            @click.stop.prevent="requestCloseTab(tab.key)"
          />
        </span>
      </template>
    </a-tab-pane>
  </a-tabs>
</template>

<script setup lang="ts">
import { CloseOutlined } from "@ant-design/icons-vue";

const props = defineProps<{
  tabs: Array<{ key: string; title: string; path?: string; kind: "file" | "preview" | "diff"; dirty?: boolean; saving?: boolean }>;
  activeTabKey: string;
  onActiveTabUpdate: (key: string) => void;
  requestCloseTab: (key: string) => void;
}>();

function onUpdateActiveKey(key: string | number) {
  props.onActiveTabUpdate(String(key));
}
</script>

<style scoped>
.editor-tabs :deep(.ant-tabs-nav) {
  margin-bottom: 0 !important;
  background: var(--panel-bg-elevated);
}

.editor-tabs :deep(.ant-tabs-content-holder) {
  padding: 0 !important;
}

.editor-tabs :deep(.ant-tabs-tab) {
  margin-left: 0 !important;
}
</style>
