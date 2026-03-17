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
                @click.stop="emit('minimize')"
                :aria-label="collapseLabel"
            >
              <template #icon>
                <MinusOutlined/>
              </template>
            </a-button>
          </a-tooltip>
        </template>

        <a-tab-pane v-for="(term, idx) in terminals" :key="term.id" :forceRender="true">
          <template #tab>
            <span class="terminal-tab-label">
              <span>{{ t("terminal.tab.name", { index: terminalDisplayIndex(term.id) }) }}</span>
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
              <TerminalView :terminal="term" :active="effectiveActiveKey === term.id" @exited="onTerminalExited"/>
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
import {CloseOutlined, PlusOutlined, CodeOutlined, MinusOutlined} from "@ant-design/icons-vue";
import {computed, nextTick, ref, watch} from "vue";
import { useI18n } from "vue-i18n";
import type {TerminalRecord} from "@agent-workbench/shared";
import { createTerminal, deleteTerminal } from "@/shared/api";
import TerminalView from "./TerminalView.vue";

const ADD_TAB_KEY = "__terminal_add__";
const TERMINAL_ACTIVE_TAB_STORAGE_KEY_PREFIX = "agent-workbench.workspace.terminal.activeTab";

const props = defineProps<{
  workspaceId: string;
  terminals: TerminalRecord[];
}>();

const emit = defineEmits<{
  created: [];
  deleted: [];
  minimize: [];
  terminalExited: [terminalId: string];
}>();

const { t } = useI18n();

const activeKey = ref<string | undefined>(undefined);
const effectiveActiveKey = computed(() => {
  const key = activeKey.value;
  if (key && props.terminals.some((t) => t.id === key)) return key;
  return props.terminals[0]?.id;
});
const creating = ref(false);
const pendingActivateKey = ref<string | null>(null);
const suppressActiveKeyPersist = ref(false);
const tabNoMap = ref<Record<string, number>>({});

const collapseLabel = computed(() => t("terminal.panel.collapse"));

function terminalActiveTabStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return `${TERMINAL_ACTIVE_TAB_STORAGE_KEY_PREFIX}.v1`;
  return `${TERMINAL_ACTIVE_TAB_STORAGE_KEY_PREFIX}.v1.${id}`;
}

// 用 localStorage 记住当前选中的终端 Tab，刷新页面后可以恢复。
function restoreActiveKeyFromStorage(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return;
  try {
    const raw = localStorage.getItem(terminalActiveTabStorageKey(id));
    if (raw) activeKey.value = raw;
  } catch {
    // ignore
  }
}

function persistActiveKeyToStorage(workspaceId: string, key: string | undefined) {
  const id = String(workspaceId || "").trim();
  if (!id) return;
  try {
    if (!key) {
      localStorage.removeItem(terminalActiveTabStorageKey(id));
      return;
    }
    localStorage.setItem(terminalActiveTabStorageKey(id), key);
  } catch {
    // ignore
  }
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
  () => props.workspaceId,
  async (workspaceId) => {
    // workspace 切换时重新读取存储的激活 tab
    suppressActiveKeyPersist.value = true;
    activeKey.value = undefined;
    pendingActivateKey.value = null;
    tabNoMap.value = {};
    restoreActiveKeyFromStorage(workspaceId);
    await nextTick();
    suppressActiveKeyPersist.value = false;
  },
  { immediate: true }
);

function reconcileTabNoMap(params: { workspaceId: string; terminals: TerminalRecord[] }) {
  const id = String(params.workspaceId || "").trim();
  if (!id) return;

  // 只对当前 workspace 的 terminals 分配编号,避免 workspace 切换时短暂拿到旧列表导致污染映射。
  const terminals = params.terminals.filter((t) => String(t.workspaceId || "").trim() === id);
  const present = new Set(terminals.map((t) => t.id));
  const nextMap: Record<string, number> = { ...tabNoMap.value };

  // prune: 删除已关闭/不存在的 terminals,让 max 可以回退从而复用最大编号
  for (const k of Object.keys(nextMap)) {
    if (!present.has(k)) delete nextMap[k];
  }

  const used = new Set<number>();
  let max = 0;

  // 先保留当前可见 tabs 中有效且不冲突的已有编号
  for (const term of terminals) {
    const existing = nextMap[term.id];
    if (typeof existing !== "number" || !Number.isFinite(existing) || existing <= 0) {
      delete nextMap[term.id];
      continue;
    }
    const normalized = Math.floor(existing);
    if (used.has(normalized)) {
      delete nextMap[term.id];
      continue;
    }
    nextMap[term.id] = normalized;
    used.add(normalized);
    if (normalized > max) max = normalized;
  }

  // 对缺失/冲突项按当前 max+1 分配
  for (const term of terminals) {
    const existing = nextMap[term.id];
    if (typeof existing === "number" && Number.isFinite(existing) && existing > 0) continue;
    max += 1;
    while (used.has(max)) max += 1;
    nextMap[term.id] = max;
    used.add(max);
  }

  tabNoMap.value = nextMap;
}

function terminalDisplayIndex(terminalId: string) {
  const n = tabNoMap.value[terminalId];
  return Number.isFinite(n) && n > 0 ? n : 1;
}

watch(
    () => props.terminals,
    (list) => {
      reconcileTabNoMap({ workspaceId: props.workspaceId, terminals: list });
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

watch(
  activeKey,
  (key) => {
    if (suppressActiveKeyPersist.value) return;
    persistActiveKeyToStorage(props.workspaceId, key);
  }
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

function onTerminalExited(payload: { terminalId: string; exitCode: number }) {
  emit("terminalExited", payload.terminalId);
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
