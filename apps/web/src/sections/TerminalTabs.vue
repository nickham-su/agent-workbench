<template>
  <div class="h-full flex flex-col min-h-0">
    <div v-if="terminals.length === 0"
         class="p-1"
    >
      <a-tooltip :title="t('terminal.empty.create')">
        <a-button
          class="!p-0"
          size="small"
          type="text"
          @click="createOne"
          :loading="creating"
          :aria-label="t('terminal.empty.create')"
        >
          <CodeOutlined class="text-xl"/>
        </a-button>
      </a-tooltip>
    </div>

    <template v-else>
      <a-tabs
          :activeKey="effectiveActiveKey"
          @update:activeKey="handleActiveKeyUpdate"
          size="small"
          :animated="false"
          class="terminal-tabs"
      >
        <template #rightExtra>
          <a-tooltip :title="collapseLabel" placement="topRight">
            <a-button
                v-if="terminals.length > 0"
                size="small"
                type="text"
                class="mr-1"
                @click.stop="collapsePanel"
                :aria-label="collapseLabel"
            >
              <template #icon>
                <EyeInvisibleOutlined/>
              </template>
            </a-button>
          </a-tooltip>

          <a-tooltip :title="layoutToggleLabel" placement="topRight">
            <a-button
                size="small"
                type="text"
                class="mr-1"
                @click.stop="toggleLayoutMode"
                :aria-label="layoutToggleLabel"
            >
              <template #icon>
                <RightOutlined v-if="isVerticalLayout"/>
                <DownOutlined v-else/>
              </template>
            </a-button>
          </a-tooltip>
        </template>

        <a-tab-pane v-for="(term, idx) in terminals" :key="term.id" :forceRender="true">
          <template #tab>
            <span class="terminal-tab-label">
              <span>{{ t("terminal.tab.name", { index: idx + 1 }) }}</span>
              <a-tooltip :title="t('terminal.tab.close')">
                <CloseOutlined
                    class="cursor-pointer text-[color:var(--text-tertiary)] hover:text-[color:var(--text-secondary)] !mr-0 text-xs"
                    @mousedown.stop.prevent
                    @click.stop.prevent="confirmDelete(term.id)"
                />
              </a-tooltip>
            </span>
          </template>
          <div class="h-full flex flex-col min-h-0">
            <div class="flex-1 min-h-0">
              <TerminalView :terminal="term" :active="effectiveActiveKey === term.id"/>
            </div>
          </div>
        </a-tab-pane>

        <a-tab-pane :key="ADD_TAB_KEY">
          <template #tab>
            <a-tooltip :title="creating ? t('terminal.empty.creating') : t('terminal.empty.create')">
              <PlusOutlined
                  class="px-2 cursor-pointer text-[color:var(--text-tertiary)] hover:text-[color:var(--text-secondary)] !mr-0 text-sm"
              />
            </a-tooltip>
          </template>
        </a-tab-pane>
      </a-tabs>
    </template>
  </div>
</template>

<script setup lang="ts">
import {Modal, message} from "ant-design-vue";
import {CloseOutlined, DownOutlined, PlusOutlined, RightOutlined, CodeOutlined, EyeInvisibleOutlined} from "@ant-design/icons-vue";
import {computed, ref, watch} from "vue";
import { useI18n } from "vue-i18n";
import type {TerminalRecord} from "@agent-workbench/shared";
import {createTerminal, deleteTerminal} from "../services/api";
import TerminalView from "../terminal/TerminalView.vue";

const ADD_TAB_KEY = "__terminal_add__";
type LayoutMode = "vertical" | "horizontal";

const props = defineProps<{
  workspaceId: string;
  terminals: TerminalRecord[];
  layoutMode: LayoutMode;
  collapsed?: boolean;
}>();

const emit = defineEmits<{
  created: [];
  deleted: [];
  "update:layoutMode": [mode: LayoutMode];
  "update:collapsed": [collapsed: boolean];
}>();

const { t } = useI18n();

const activeKey = ref<string | undefined>(undefined);
const effectiveActiveKey = computed(() => activeKey.value ?? props.terminals[0]?.id);
const creating = ref(false);
const pendingActivateKey = ref<string | null>(null);

const isVerticalLayout = computed(() => props.layoutMode === "vertical");
const layoutToggleLabel = computed(() => (isVerticalLayout.value ? t("terminal.layout.moveRight") : t("terminal.layout.moveBottom")));
const collapseLabel = computed(() => t("terminal.panel.collapse"));

function toggleLayoutMode() {
  const nextMode: LayoutMode = props.layoutMode === "vertical" ? "horizontal" : "vertical";
  emit("update:layoutMode", nextMode);
}

function collapsePanel() {
  emit("update:collapsed", true);
}

function handleActiveKeyUpdate(k: string | number) {
  const key = String(k);
  if (key === ADD_TAB_KEY) {
    if (!creating.value) void createOne();
    return;
  }
  activeKey.value = key;
}

watch(
    () => props.terminals,
    (list) => {
      if (pendingActivateKey.value && list.some((t) => t.id === pendingActivateKey.value)) {
        activeKey.value = pendingActivateKey.value;
        pendingActivateKey.value = null;
        return;
      }
      if (!activeKey.value && list.length > 0) activeKey.value = list[0].id;
      if (activeKey.value && !list.some((t) => t.id === activeKey.value)) {
        activeKey.value = list[0]?.id;
      }
    },
    {immediate: true}
);


async function createOne() {
  creating.value = true;
  try {
    const created = await createTerminal(props.workspaceId, {});
    pendingActivateKey.value = created.id;
    emit("created");
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    creating.value = false;
  }
}

function confirmDelete(terminalId: string) {
  Modal.confirm({
    title: t("terminal.confirmClose.title"),
    content: t("terminal.confirmClose.content"),
    okText: t("terminal.confirmClose.ok"),
    okType: "danger",
    cancelText: t("terminal.confirmClose.cancel"),
    onOk: async () => {
      await deleteTerminal(terminalId);
      emit("deleted");
    }
  });
}
</script>

<style scoped>
.terminal-tabs {
  flex: 1;
  min-height: 0;
  height: 100%;
  background: var(--panel-bg);
}

.terminal-tabs :deep(.ant-tabs-content-holder) {
  flex: 1;
  min-height: 0;
  padding: 0 !important;
}

.terminal-tabs :deep(.ant-tabs-content) {
  height: 100%;
}

.terminal-tabs :deep(.ant-tabs-tabpane) {
  height: 100%;
  padding: 0 !important;
}

.terminal-tabs :deep(.ant-tabs-nav) {
  margin-bottom: 0 !important;
  background: var(--panel-bg-elevated);
}

.terminal-tabs :deep(.ant-tabs-tab) {
  margin-left: 0 !important;
}

.terminal-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px;
}

.terminal-tab-add {
  display: inline-flex;
  align-items: center;
  padding: 0 10px;
}

.terminal-tab-add.is-loading {
  opacity: 0.6;
}
</style>
