<template>
  <a-popconfirm
      :open="activeSource === source"
      :title="t('terminal.confirmClose.title')"
      :ok-text="t('terminal.confirmClose.ok')"
      :cancel-text="t('terminal.confirmClose.cancel')"
      :ok-button-props="{ danger: true, loading: deleting }"
      :cancel-button-props="{ disabled: deleting }"
      placement="topRight"
      @openChange="emit('openChange', source, $event)"
      @confirm="emit('confirm', source)"
  >
    <button
        type="button"
        class="terminal-tab-close text-[color:var(--text-tertiary)] hover:text-[color:var(--text-secondary)]"
        :aria-label="t('terminal.tab.close')"
        @mousedown.stop.prevent
        @click.stop
        @keydown.stop
    ><CloseOutlined /></button>
    <!-- 异步关闭由父组件管理，避免默认 ActionButton 收起失败后需要重试的提示。 -->
    <template #okButton="buttonProps">
      <a-button v-bind="buttonProps">{{ t('terminal.confirmClose.ok') }}</a-button>
    </template>
  </a-popconfirm>
</template>

<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { CloseOutlined } from "@ant-design/icons-vue";

defineProps<{ activeSource?: symbol | null; deleting: boolean }>();
const emit = defineEmits<{
  openChange: [source: symbol, open: boolean];
  confirm: [source: symbol];
  dispose: [source: symbol];
}>();
const { t } = useI18n();
// Tabs 会在普通栏和溢出菜单重复渲染标签；身份必须属于具体渲染实例。
const source = Symbol("terminal-tab-close");
onBeforeUnmount(() => emit("dispose", source));
</script>

<style scoped>
.terminal-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}

.terminal-tab-close :deep(.anticon) { margin-right: 0; }
</style>
