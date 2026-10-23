<template>
  <aside class="terminal-config-panel" :aria-label="t('terminal.config.run')">
    <header class="config-heading">
      <span class="config-heading-title">{{ t('terminal.config.run') }}</span>
      <span class="spacer" />
      <template v-if="ordering">
        <a-button type="text" size="small" :loading="orderSaving" :disabled="orderSaving" :aria-label="t('terminal.config.orderDone')" @click="saveOrder">{{ t('terminal.config.orderDone') }}</a-button>
        <a-button type="text" size="small" :disabled="orderSaving" :aria-label="t('terminal.config.cancel')" @click="cancelOrder">{{ t('terminal.config.cancel') }}</a-button>
      </template>
      <a-tooltip v-else :title="t('terminal.config.reorder')"><a-button type="text" class="config-icon" :disabled="loading || !!loadError || configs.length < 2 || editorOpen || saving || deleting" :aria-label="t('terminal.config.reorder')" @click="startOrder"><SortAscendingOutlined /></a-button></a-tooltip>
      <a-tooltip v-if="!ordering" :title="t('terminal.config.add')"><a-button type="text" class="config-icon" :disabled="loading || ordering" :aria-label="t('terminal.config.add')" @click="openEditor()"><PlusOutlined /></a-button></a-tooltip>
      <a-tooltip v-if="!ordering" :title="t('terminal.config.collapse')"><a-button type="text" class="config-icon" :disabled="orderSaving" :aria-label="t('terminal.config.collapse')" @click="collapse"><CloseOutlined /></a-button></a-tooltip>
    </header>
    <a-alert v-if="orderError" type="error" :message="orderError" show-icon class="config-order-error" />
    <div class="config-list">
      <a-spin v-if="loading" class="config-loading" />
      <a-alert v-else-if="loadError" type="error" :message="loadError" show-icon />
      <div v-else-if="configs.length === 0" class="config-empty">{{ t('terminal.config.empty') }}</div>
      <div v-for="(config, index) in displayedConfigs" v-else :key="config.id" class="config-row"
        :class="{ 'config-drop-before': dragOverId === config.id && !dropAfter(index), 'config-drop-after': dragOverId === config.id && dropAfter(index) }"
        @dragenter.prevent="dragOver(config.id)" @dragover.prevent="dragOver(config.id)" @drop.prevent="drop(index)">
        <button v-if="ordering" type="button" class="config-drag" :draggable="!orderSaving" :disabled="orderSaving" :aria-label="t('terminal.config.drag')" @dragstart="startDrag($event, config.id)" @dragend="endDrag"><HolderOutlined /></button>
        <span class="config-name" :title="config.name">{{ config.name }}</span>
        <template v-if="ordering">
          <a-button type="text" class="config-icon" :disabled="orderSaving || index === 0" :aria-label="t('terminal.config.moveUp')" @click="moveOrder(index, index - 1)"><ArrowUpOutlined /></a-button>
          <a-button type="text" class="config-icon" :disabled="orderSaving || index === displayedConfigs.length - 1" :aria-label="t('terminal.config.moveDown')" @click="moveOrder(index, index + 1)"><ArrowDownOutlined /></a-button>
        </template>
        <template v-else>
          <a-button type="text" class="config-icon config-run" :loading="runningIds.has(config.id)" :disabled="runningIds.has(config.id)" :aria-label="t('terminal.config.run')" @click="run(config)"><CaretRightOutlined v-if="!runningIds.has(config.id)" /></a-button>
          <a-dropdown :trigger="['click']">
            <a-button type="text" class="config-icon" :aria-label="t('terminal.config.more')"><MoreOutlined /></a-button>
            <template #overlay><a-menu @click="handleMenu(String($event.key), config)"><a-menu-item key="edit">{{ t('terminal.config.edit') }}</a-menu-item><a-menu-item key="delete" danger>{{ t('terminal.config.delete') }}</a-menu-item></a-menu></template>
          </a-dropdown>
        </template>
      </div>
    </div>
    <a-drawer :open="editorOpen" :title="t(editingId ? 'terminal.config.edit' : 'terminal.config.add')" :width="500" :destroy-on-close="true" @close="closeEditor">
      <a-alert v-if="saveError" type="error" :message="saveError" class="mb-4" show-icon />
      <a-form ref="formRef" :model="form" layout="vertical">
        <a-form-item :label="t('terminal.config.name')" name="name" :rules="[{ required: true, whitespace: true, message: t('terminal.config.nameRequired') }]">
          <a-input v-model:value="form.name" :maxlength="120" :aria-label="t('terminal.config.name')" />
        </a-form-item>
        <a-form-item :label="t('terminal.config.cwd')" name="cwd" :extra="t('terminal.config.cwdHint')">
          <a-auto-complete v-model:value="form.cwd" :options="directoryOptions" :filter-option="filterDirectory" class="w-full" :aria-label="t('terminal.config.cwd')">
            <a-input :placeholder="t('terminal.config.root')"><template #suffix><DownOutlined /></template></a-input>
          </a-auto-complete>
        </a-form-item>
        <a-form-item :label="t('terminal.config.command')" name="command" :rules="[{ required: true, whitespace: true, message: t('terminal.config.commandRequired') }]">
          <a-textarea v-model:value="form.command" :rows="7" :maxlength="TERMINAL_CONFIG_COMMAND_MAX_LENGTH" class="config-command" :aria-label="t('terminal.config.command')" spellcheck="false" />
        </a-form-item>
      </a-form>
      <template #footer><div class="config-editor-footer"><a-button :disabled="saving" @click="closeEditor">{{ t('terminal.config.cancel') }}</a-button><a-button type="primary" :loading="saving" @click="save">{{ t('terminal.config.save') }}</a-button></div></template>
    </a-drawer>
  </aside>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Modal, message, type FormInstance } from "ant-design-vue";
import { ArrowDownOutlined, ArrowUpOutlined, CaretRightOutlined, CloseOutlined, DownOutlined, HolderOutlined, MoreOutlined, PlusOutlined, SortAscendingOutlined } from "@ant-design/icons-vue";
import { TERMINAL_CONFIG_COMMAND_MAX_LENGTH, type TerminalConfigRecord, type TerminalRecord } from "@agent-workbench/shared";
import { createTerminalConfig, deleteTerminalConfig, getWorkspace, listTerminalConfigs, reorderTerminalConfigs, runTerminalConfig, updateTerminalConfig } from "@/shared/api";

const props = withDefaults(defineProps<{ workspaceId: string; active?: boolean }>(), { active: true });
const emit = defineEmits<{ close: []; created: [terminal: TerminalRecord] }>();
const { t } = useI18n();
const configs = ref<TerminalConfigRecord[]>([]);
const orderDraft = ref<TerminalConfigRecord[]>([]);
const ordering = ref(false), orderSaving = ref(false), orderError = ref("");
const draggingId = ref<string | null>(null), dragOverId = ref<string | null>(null);
const deleting = ref(false);
const displayedConfigs = computed(() => ordering.value ? orderDraft.value : configs.value);
let orderGeneration = 0;
const repoDirectories = ref<string[]>([]);
const loading = ref(false), loadError = ref("");
const editorOpen = ref(false), editingId = ref<string | null>(null), saving = ref(false), saveError = ref("");
const formRef = ref<FormInstance>();
const form = reactive({ name: "", cwd: "", command: "" });
const runningIds = reactive(new Set<string>());
const cacheActive = ref(true);
let disposed = false, loadGeneration = 0;
onBeforeUnmount(() => { disposed = true; loadGeneration++; orderGeneration++; });
onDeactivated(() => {
  cacheActive.value = false;
  cancelOrder(); loadGeneration++; loading.value = false;
});
// The initial activation leaves this true, so the immediate watcher loads only once.
onActivated(() => { cacheActive.value = true; });
const directoryOptions = computed(() => [
  { value: ".", label: t("terminal.config.root") },
  ...repoDirectories.value.map((dirName) => ({ value: dirName, label: dirName }))
]);
function filterDirectory(input: string, option: { value?: unknown; label?: unknown }) {
  return String(option.value ?? "").toLowerCase().includes(input.toLowerCase()) || String(option.label ?? "").toLowerCase().includes(input.toLowerCase());
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
async function load() {
  const generation = ++loadGeneration, workspaceId = props.workspaceId;
  loading.value = true; loadError.value = "";
  try {
    const [items, workspace] = await Promise.all([listTerminalConfigs(workspaceId), getWorkspace(workspaceId)]);
    if (generation !== loadGeneration || disposed) return;
    configs.value = items;
    repoDirectories.value = workspace.repos.map((repo) => repo.dirName);
  } catch (error) {
    if (generation === loadGeneration && !disposed) loadError.value = errorText(error);
  } finally { if (generation === loadGeneration && !disposed) loading.value = false; }
}
watch([() => props.workspaceId, () => props.active && cacheActive.value], ([workspaceId, active], [previousWorkspaceId]) => {
  cancelOrder(); loadGeneration++; loading.value = false;
  if (workspaceId !== previousWorkspaceId) {
    editorOpen.value = false; configs.value = []; repoDirectories.value = [];
  }
  if (active) void load();
}, { immediate: true });
function endDrag() { draggingId.value = null; dragOverId.value = null; }
function cancelOrder() {
  orderGeneration++;
  ordering.value = false; orderSaving.value = false; orderError.value = ""; orderDraft.value = [];
  endDrag();
}
function collapse() {
  if (orderSaving.value) return;
  cancelOrder(); emit("close");
}
function startOrder() {
  if (loading.value || loadError.value || configs.value.length < 2 || editorOpen.value || saving.value || deleting.value || ordering.value) return;
  orderDraft.value = [...configs.value]; orderError.value = ""; ordering.value = true;
}
function moveOrder(from: number, to: number) {
  if (!ordering.value || orderSaving.value || from < 0 || to < 0 || from >= orderDraft.value.length || to >= orderDraft.value.length || from === to) return;
  const items = [...orderDraft.value], [item] = items.splice(from, 1);
  items.splice(to, 0, item); orderDraft.value = items;
}
function startDrag(event: DragEvent, id: string) {
  if (!ordering.value || orderSaving.value) { event.preventDefault(); return; }
  draggingId.value = id;
  if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); }
}
function dragOver(id: string) {
  if (ordering.value && !orderSaving.value && draggingId.value) dragOverId.value = draggingId.value === id ? null : id;
}
function dropAfter(index: number) { return orderDraft.value.findIndex((config) => config.id === draggingId.value) < index; }
function drop(index: number) {
  if (draggingId.value) moveOrder(orderDraft.value.findIndex((config) => config.id === draggingId.value), index);
  endDrag();
}
async function saveOrder() {
  if (!ordering.value || orderSaving.value) return;
  const draft = [...orderDraft.value], orderedIds = draft.map((config) => config.id);
  if (orderedIds.every((id, index) => id === configs.value[index]?.id)) { cancelOrder(); return; }
  const generation = ++orderGeneration, workspaceId = props.workspaceId;
  const isCurrent = () => !disposed && props.active && cacheActive.value && generation === orderGeneration && workspaceId === props.workspaceId;
  orderSaving.value = true; orderError.value = ""; endDrag();
  try {
    await reorderTerminalConfigs(workspaceId, { orderedIds });
    if (!isCurrent()) return;
    configs.value = draft; cancelOrder();
  } catch (error) { if (isCurrent()) orderError.value = errorText(error); }
  finally { if (isCurrent()) orderSaving.value = false; }
}
function openEditor(config?: TerminalConfigRecord) {
  if (ordering.value) return;
  editingId.value = config?.id ?? null;
  Object.assign(form, { name: config?.name ?? "", cwd: config?.cwd === "." ? "" : config?.cwd ?? "", command: config?.command ?? "" });
  saveError.value = ""; editorOpen.value = true;
}
function closeEditor() { if (!saving.value) editorOpen.value = false; }
async function save() {
  if (saving.value) return;
  try { await formRef.value?.validate(); } catch { return; }
  if (saving.value || disposed) return;
  const workspaceId = props.workspaceId, id = editingId.value;
  saving.value = true; saveError.value = "";
  try {
    const body = { name: form.name, cwd: form.cwd, command: form.command };
    const result = id ? await updateTerminalConfig(workspaceId, id, body) : await createTerminalConfig(workspaceId, body);
    if (disposed || workspaceId !== props.workspaceId) return;
    if (id) configs.value = configs.value.map((config) => config.id === id ? result : config);
    else configs.value = [...configs.value, result];
    editorOpen.value = false; message.success(t("terminal.config.saved"));
  } catch (error) { if (!disposed && workspaceId === props.workspaceId) saveError.value = errorText(error); }
  finally { saving.value = false; }
}
async function run(config: TerminalConfigRecord) {
  if (ordering.value || runningIds.has(config.id)) return;
  const workspaceId = props.workspaceId;
  runningIds.add(config.id);
  try {
    const terminal = await runTerminalConfig(workspaceId, config.id);
    // Even if the panel was collapsed meanwhile, let the existing terminal flow
    // display the newly created terminal. Parent checks its Workspace identity.
    emit("created", terminal);
  } catch (error) { if (!disposed && workspaceId === props.workspaceId) message.error(errorText(error)); }
  finally { runningIds.delete(config.id); }
}
function handleMenu(key: string, config: TerminalConfigRecord) {
  if (ordering.value) return;
  if (key === "edit") { openEditor(config); return; }
  if (key !== "delete") return;
  const workspaceId = props.workspaceId;
  deleting.value = true;
  Modal.confirm({
    title: t("terminal.config.confirmDelete"), content: config.name,
    okText: t("terminal.config.delete"), cancelText: t("terminal.config.cancel"), okType: "danger",
    onCancel() { deleting.value = false; },
    async onOk() {
      try {
        await deleteTerminalConfig(workspaceId, config.id);
        if (!disposed && workspaceId === props.workspaceId) configs.value = configs.value.filter((item) => item.id !== config.id);
        deleting.value = false;
      } catch (error) { message.error(errorText(error)); throw error; }
    }
  });
}
</script>

<style scoped>
.terminal-config-panel { width: 340px; flex: 0 0 340px; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--border-color-secondary); background: var(--panel-bg); }
.config-heading, .config-row { display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px; height: 40px; flex-shrink: 0; }
.config-heading { background: var(--panel-bg-elevated); border-bottom: 1px solid var(--border-color-secondary); }
.config-heading-title { font-size: 13px; }
.spacer { flex: 1; }
.config-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0; }
.config-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.config-row { border-radius: 0; }
.config-row:hover { background: var(--panel-bg-elevated); }
.config-icon { width: 28px; height: 28px; flex: 0 0 28px; padding: 0; }
.config-run { color: #fff; }
.config-drag { display: flex; align-items: center; justify-content: center; flex: 0 0 16px; padding: 0; border: 0; background: none; color: var(--text-tertiary); cursor: grab; }
.config-drag:active { cursor: grabbing; }
.config-drag:disabled { cursor: default; }
.config-drop-before { box-shadow: inset 0 2px var(--text-secondary); }
.config-drop-after { box-shadow: inset 0 -2px var(--text-secondary); }
.config-order-error { margin: 8px; }
.config-empty, .config-loading { display: block; padding: 24px 12px; text-align: center; color: var(--text-tertiary); }
.config-command { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.config-editor-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
