<template>
  <div class="workspace-environment">
    <div class="environment-tool-heading">{{ t("workspace.tools.environmentVariables") }}</div>
    <div class="environment-body">
      <main class="environment-main">
        <div class="environment-filters">
          <a-input v-model:value="search" type="search" :placeholder="t('workspace.environmentVariables.search')" :aria-label="t('workspace.environmentVariables.search')" data-testid="search">
            <template #prefix><SearchOutlined /></template>
          </a-input>
          <a-select v-model:value="statusFilter" :options="statusOptions" :aria-label="t('workspace.environmentVariables.filter')" data-testid="status-filter" />
          <span class="environment-count" aria-live="polite">{{ t("workspace.environmentVariables.count", { shown: filteredRows.length, total: rows.length, enabled: enabledCount }) }}</span>
          <a-button type="primary" data-testid="add-variable" :disabled="writesDisabled" @click="openEditor(null, $event)">
            <template #icon><PlusOutlined /></template>{{ t("workspace.environmentVariables.add") }}
          </a-button>
        </div>
        <p v-if="notice" class="environment-notice" role="status" data-testid="notice">{{ notice }}</p>
        <div v-if="uncertain" class="environment-error" role="alert" data-testid="unconfirmed">{{ t("workspace.environmentVariables.unconfirmed") }}</div>
        <div v-if="listError" class="environment-error" role="alert" data-testid="list-error">{{ listError }}</div>
        <div v-if="listError || uncertain" class="environment-error-actions">
          <a-button data-testid="refresh" :disabled="loading || writeBusy" @click="refresh">{{ t("common.refresh") }}</a-button>
        </div>
        <div class="environment-table-panel" :aria-busy="loading">
          <table :aria-label="t('workspace.environmentVariables.list')">
            <colgroup><col class="enabled-column" /><col class="name-column" /><col /><col class="remark-column" /><col class="actions-column" /></colgroup>
            <thead><tr>
              <th scope="col">{{ t("workspace.environmentVariables.enabled") }}</th>
              <th scope="col">{{ t("workspace.environmentVariables.name") }}</th>
              <th scope="col">{{ t("workspace.environmentVariables.value") }}</th>
              <th scope="col">{{ t("workspace.environmentVariables.remark") }}</th>
              <th scope="col">{{ t("workspace.environmentVariables.actions") }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="row in filteredRows" :key="row.id" :class="{ 'is-disabled': !row.enabled }" :data-variable-id="row.id">
                <td><a-switch :checked="row.enabled" size="small" :disabled="writesDisabled || editorOpen" :aria-label="t('workspace.environmentVariables.toggle', { name: row.name })" @change="toggle(row)" /></td>
                <td class="environment-name">{{ row.name }}</td>
                <td><span v-if="row.value === ''" class="environment-empty-value">{{ t("workspace.environmentVariables.emptyString") }}</span><pre v-else class="environment-value">{{ row.value }}</pre></td>
                <td class="environment-remark">{{ row.remark || '—' }}</td>
                <td><div class="environment-row-actions">
                  <a-button type="text" size="small" :disabled="writesDisabled" :aria-label="t('workspace.environmentVariables.editVariable', { name: row.name })" data-action="edit" @click="openEditor(row, $event)"><EditOutlined /></a-button>
                  <a-button type="text" size="small" danger :disabled="writesDisabled || editorOpen" :aria-label="t('workspace.environmentVariables.deleteVariable', { name: row.name })" data-action="delete" @click="askDelete(row, $event)"><DeleteOutlined /></a-button>
                </div></td>
              </tr>
            </tbody>
          </table>
          <div v-if="loading" class="environment-empty" role="status">{{ t("common.loading") }}</div>
          <div v-else-if="!listError && !filteredRows.length" class="environment-empty" data-testid="empty">
            <p>{{ t(rows.length ? "workspace.environmentVariables.noMatches" : "workspace.environmentVariables.empty") }}</p>
            <a-button v-if="rows.length" @click="clearFilters">{{ t("workspace.environmentVariables.clearFilters") }}</a-button>
            <a-button v-else :disabled="writesDisabled" @click="openEditor(null, $event)">{{ t("workspace.environmentVariables.add") }}</a-button>
          </div>
        </div>
      </main>
      <aside class="environment-side" :aria-label="t('workspace.environmentVariables.rulesLabel')">
        <h2>{{ t("workspace.environmentVariables.scope") }}</h2>
        <div class="environment-effect"><CodeOutlined /><div><h3>bash {{ t("workspace.environmentVariables.tool") }}</h3><p>{{ t("workspace.environmentVariables.bashScope") }}</p></div></div>
        <div class="environment-effect"><CodeOutlined /><div><h3>{{ t("workspace.tools.terminal") }}</h3><p>{{ t("workspace.environmentVariables.terminalScope") }}</p></div></div>
        <hr />
        <h2>{{ t("workspace.environmentVariables.rules") }}</h2>
        <ul>
          <li>{{ t("workspace.environmentVariables.sharedRule") }}</li>
          <li>{{ t("workspace.environmentVariables.priorityRule") }}</li>
          <li>{{ t("workspace.environmentVariables.emptyRule") }}</li>
          <li>{{ t("workspace.environmentVariables.inheritRule") }}</li>
          <li>{{ t("workspace.environmentVariables.literalRule") }}</li>
          <li>{{ t("workspace.environmentVariables.reservedRule") }}</li>
        </ul>
        <hr />
        <h2><SafetyOutlined /> {{ t("workspace.environmentVariables.security") }}</h2>
        <p class="environment-security">{{ t("workspace.environmentVariables.securityNote") }}</p>
      </aside>
    </div>
    <a-drawer :open="editorOpen" :title="t(editing ? 'workspace.environmentVariables.edit' : 'workspace.environmentVariables.add')" width="min(100vw, 560px)" :closable="!writeBusy" :mask-closable="!writeBusy" :keyboard="!writeBusy" :destroy-on-close="true" @close="closeEditor">
      <form :id="formId" class="environment-form" autocomplete="off" @submit.prevent="save">
        <p class="environment-field-help">{{ t("workspace.environmentVariables.saveHelp") }}</p>
        <label :for="`${formId}-name`">{{ t("workspace.environmentVariables.name") }} <span aria-hidden="true">*</span></label>
        <input :id="`${formId}-name`" ref="nameInput" v-model="form.name" name="name" class="environment-input environment-name" autocomplete="off" spellcheck="false" :maxlength="limits.nameLength" :disabled="writeBusy" :aria-describedby="`${formId}-name-help`" />
        <p :id="`${formId}-name-help`" class="environment-field-help">{{ t("workspace.environmentVariables.nameHelp") }}</p>
        <label :for="`${formId}-value`">{{ t("workspace.environmentVariables.value") }}</label>
        <textarea :id="`${formId}-value`" :value="form.value" name="value" class="environment-input environment-value-input" autocomplete="off" spellcheck="false" :disabled="writeBusy" :placeholder="t('workspace.environmentVariables.valuePlaceholder')" @input="onValueInput" />
        <p class="environment-field-help">{{ t("workspace.environmentVariables.valueHelp") }}</p>
        <label :for="`${formId}-remark`">{{ t("workspace.environmentVariables.remark") }} <span class="environment-field-help">{{ t("workspace.environmentVariables.optional") }}</span></label>
        <input :id="`${formId}-remark`" v-model="form.remark" name="remark" class="environment-input" autocomplete="off" :maxlength="limits.remarkLength" :disabled="writeBusy" />
        <label class="environment-enabled-field"><a-switch v-model:checked="form.enabled" :disabled="writeBusy" />{{ t("workspace.environmentVariables.enableVariable") }}</label>
        <p v-if="formError" class="environment-error" role="alert" data-testid="form-error">{{ formError }}</p>
        <p v-if="formUnconfirmed" class="environment-error" role="alert">{{ t("workspace.environmentVariables.formUnconfirmed") }}</p>
        <p class="environment-field-help">{{ t("workspace.environmentVariables.reservedRule") }}</p>
      </form>
      <template #footer><div class="environment-drawer-actions">
        <a-button :disabled="writeBusy" data-testid="cancel-editor" @click="closeEditor">{{ t("common.cancel") }}</a-button>
        <a-button type="primary" html-type="submit" :form="formId" :loading="writeBusy" :disabled="writesDisabled || formUnconfirmed" data-testid="save-variable" @click="save">{{ t("common.save") }}</a-button>
      </div></template>
    </a-drawer>
    <a-modal :open="!!deleting" :title="t('workspace.environmentVariables.deleteTitle')" :ok-text="t('common.delete')" :cancel-text="t('common.cancel')" :confirm-loading="writeBusy" :closable="!writeBusy" :mask-closable="!writeBusy" :keyboard="!writeBusy" :cancel-button-props="{ disabled: writeBusy }" :ok-button-props="{ danger: true, disabled: writesDisabled }" @ok="confirmDelete" @cancel="cancelDelete">
      <p>{{ t("workspace.environmentVariables.deleteContent", { name: deleting?.name ?? '' }) }}</p>
      <p v-if="notice || uncertain" class="environment-error" role="alert">{{ notice || t("workspace.environmentVariables.unconfirmed") }}</p>
      <p v-if="listError" class="environment-error" role="alert">{{ listError }}</p>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, reactive, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CodeOutlined, DeleteOutlined, EditOutlined, PlusOutlined, SafetyOutlined, SearchOutlined } from "@ant-design/icons-vue";
import {
  WORKSPACE_ENVIRONMENT_LIMITS, validateWorkspaceEnvironmentCollection,
  type WorkspaceEnvironmentInput, type WorkspaceEnvironmentVariable, type UpdateWorkspaceEnvironmentVariableRequest,
  type WorkspaceEnvironmentPolicyIssue
} from "@agent-workbench/shared";
import { ApiError, listWorkspaceEnvironmentVariables, createWorkspaceEnvironmentVariable, updateWorkspaceEnvironmentVariable, setWorkspaceEnvironmentVariableEnabled, deleteWorkspaceEnvironmentVariable } from "@/shared/api";

const props = defineProps<{ workspaceId: string }>();
const { t } = useI18n();
const limits = WORKSPACE_ENVIRONMENT_LIMITS;
const formId = `workspace-environment-${useId()}`;
const rows = ref<WorkspaceEnvironmentVariable[]>([]);
const search = ref("");
const statusFilter = ref("all");
const loading = ref(false);
const loaded = ref(false);
const listError = ref("");
const notice = ref("");
const uncertain = ref(false);
const writeBusy = ref(false);
const editorOpen = ref(false);
const editing = ref<WorkspaceEnvironmentVariable | null>(null);
const deleting = ref<WorkspaceEnvironmentVariable | null>(null);
const form = reactive<WorkspaceEnvironmentInput>({ name: "", value: "", remark: "", enabled: true });
const valueEdited = ref(false);
const formError = ref("");
const formUnconfirmed = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);
let opener: HTMLElement | null = null;
let generation = 0;
let disposed = false;
let parked = false;
const requests = new Set<AbortController>();
const writesDisabled = computed(() => loading.value || writeBusy.value || !loaded.value || !!listError.value || uncertain.value);
const enabledCount = computed(() => rows.value.filter((row) => row.enabled).length);
const statusOptions = computed(() => [
  { value: "all", label: t("workspace.environmentVariables.all") },
  { value: "enabled", label: t("workspace.environmentVariables.enabledState") },
  { value: "disabled", label: t("workspace.environmentVariables.disabledState") }
]);
const filteredRows = computed(() => {
  const query = search.value.toLowerCase();
  return rows.value.filter((row) =>
    (statusFilter.value === "all" || row.enabled === (statusFilter.value === "enabled")) &&
    (!query || row.name.toLowerCase().includes(query) || row.remark.toLowerCase().includes(query)));
});

function current(id: number, workspaceId: string) {
  return !disposed && !parked && id === generation && workspaceId === props.workspaceId;
}
function resetForm() {
  editing.value = null;
  Object.assign(form, { name: "", value: "", remark: "", enabled: true });
  valueEdited.value = false;
  formError.value = "";
  formUnconfirmed.value = false;
}
function release() {
  generation++;
  for (const request of requests) request.abort();
  requests.clear();
  rows.value = [];
  loading.value = loaded.value = writeBusy.value = uncertain.value = false;
  listError.value = notice.value = search.value = "";
  statusFilter.value = "all";
  editorOpen.value = false;
  deleting.value = null;
  opener = null;
  resetForm();
}
function safeError(error: unknown) {
  const code = error instanceof ApiError ? error.code : undefined;
  switch (code) {
    case "WORKSPACE_ENV_NAME_CONFLICT": return t("workspace.environmentVariables.errors.duplicate");
    case "WORKSPACE_ENV_RESERVED_NAME": return t("workspace.environmentVariables.errors.reserved");
    case "WORKSPACE_ENV_LIMIT_EXCEEDED": return t("workspace.environmentVariables.errors.limits");
    case "WORKSPACE_ENV_INVALID_INPUT": return t("workspace.environmentVariables.errors.invalid");
    case "WORKSPACE_DELETING": return t("workspace.environmentVariables.errors.deleting");
    case "WORKSPACE_NOT_FOUND": case "WORKSPACE_ENV_VARIABLE_NOT_FOUND": return t("workspace.environmentVariables.errors.notFound");
    default: return t("workspace.environmentVariables.errors.request");
  }
}
async function load(id = generation, workspaceId = props.workspaceId) {
  if (!current(id, workspaceId)) return;
  const controller = new AbortController();
  requests.add(controller);
  loading.value = true;
  listError.value = "";
  try {
    const result = await listWorkspaceEnvironmentVariables(workspaceId, { signal: controller.signal });
    if (!current(id, workspaceId)) return;
    rows.value = result;
    loaded.value = true;
    if (uncertain.value) notice.value = t("workspace.environmentVariables.reloadedUnconfirmed");
    uncertain.value = false;
  } catch (error) {
    if (current(id, workspaceId)) listError.value = safeError(error);
  } finally {
    requests.delete(controller);
    if (current(id, workspaceId)) loading.value = false;
  }
}
function refresh() {
  if (loading.value || writeBusy.value) return;
  void load();
}
function clearFilters() { search.value = ""; statusFilter.value = "all"; }
function rememberOpener(event?: Event) { opener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null; }
function restoreFocus() {
  const target = opener;
  opener = null;
  void nextTick(() => { if (!disposed && !parked && target?.isConnected) target.focus(); });
}
function openEditor(row: WorkspaceEnvironmentVariable | null, event?: Event) {
  if (writesDisabled.value || deleting.value) return;
  rememberOpener(event);
  resetForm();
  editing.value = row ? { ...row } : null;
  if (row) Object.assign(form, { name: row.name, value: row.value, remark: row.remark, enabled: row.enabled });
  editorOpen.value = true;
  void nextTick(() => nameInput.value?.focus());
}
function closeEditor() {
  if (writeBusy.value) return;
  editorOpen.value = false;
  resetForm();
  restoreFocus();
}
function onValueInput(event: Event) {
  valueEdited.value = true;
  form.value = (event.target as HTMLTextAreaElement).value;
}
function policyError(issue: WorkspaceEnvironmentPolicyIssue) {
  if (issue.code === "WORKSPACE_ENV_RESERVED_NAME") return t("workspace.environmentVariables.errors.reserved");
  if (issue.code === "WORKSPACE_ENV_LIMIT_EXCEEDED") return t("workspace.environmentVariables.errors.limits");
  return t(`workspace.environmentVariables.errors.${issue.field === 'name' ? 'name' : 'text'}`);
}
function replaceRow(row: WorkspaceEnvironmentVariable) {
  rows.value = [...rows.value.filter((existing) => existing.id !== row.id), row].sort((a, b) =>
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** Serialize writes; a transport failure is never interpreted as a rollback. */
async function mutate(operation: (signal: AbortSignal) => Promise<void>, editor = false) {
  if (writesDisabled.value) return;
  const id = generation, workspaceId = props.workspaceId;
  const controller = new AbortController();
  requests.add(controller);
  writeBusy.value = true;
  notice.value = "";
  try {
    await operation(controller.signal);
    if (!current(id, workspaceId)) return;
    notice.value = t("workspace.environmentVariables.saved");
  } catch (error) {
    if (!current(id, workspaceId)) return;
    const status = error instanceof ApiError ? error.status : undefined;
    const unconfirmed = status === undefined || status >= 500;
    if (unconfirmed) {
      uncertain.value = true;
      if (editor) formUnconfirmed.value = true;
      // No POST retry: only read the server's authoritative current state.
      await load(id, workspaceId);
    } else {
      if (editor) formError.value = safeError(error);
      else notice.value = safeError(error);
      if (status === 404) await load(id, workspaceId);
    }
  } finally {
    requests.delete(controller);
    if (current(id, workspaceId)) {
      writeBusy.value = false;
      if (!editorOpen.value && !deleting.value) restoreFocus();
    }
  }
}
async function save() {
  if (!editorOpen.value || writesDisabled.value || formUnconfirmed.value) return;
  formError.value = "";
  const original = editing.value;
  // A textarea normalizes CR/CRLF on display; untouched values must not be rewritten.
  const candidate = { ...form, value: original && !valueEdited.value ? original.value : form.value };
  const remaining = rows.value.filter((row) => row.id !== original?.id);
  const issue = validateWorkspaceEnvironmentCollection([...remaining, candidate]);
  if (issue) { formError.value = policyError(issue); return; }
  if (remaining.some((row) => row.name === candidate.name)) {
    formError.value = t("workspace.environmentVariables.errors.duplicate"); return;
  }
  const patch: UpdateWorkspaceEnvironmentVariableRequest = {};
  if (original) {
    for (const field of ["name", "value", "remark", "enabled"] as const) {
      if (candidate[field] !== original[field]) Object.assign(patch, { [field]: candidate[field] });
    }
    if (!Object.keys(patch).length) {
      closeEditor();
      notice.value = t("workspace.environmentVariables.noChanges");
      return;
    }
  }
  const id = generation, workspaceId = props.workspaceId;
  await mutate(async (signal) => {
    const row = original
      ? await updateWorkspaceEnvironmentVariable(workspaceId, original.id, patch, { signal })
      : await createWorkspaceEnvironmentVariable(workspaceId, candidate, { signal });
    if (!current(id, workspaceId)) return;
    replaceRow(row);
    editorOpen.value = false;
    resetForm();
  }, true);
}
async function toggle(row: WorkspaceEnvironmentVariable) {
  if (editorOpen.value) return;
  const id = generation, workspaceId = props.workspaceId;
  await mutate(async (signal) => {
    const updated = await setWorkspaceEnvironmentVariableEnabled(workspaceId, row.id, !row.enabled, { signal });
    if (current(id, workspaceId)) replaceRow(updated);
  });
}
function askDelete(row: WorkspaceEnvironmentVariable, event?: Event) {
  if (writesDisabled.value || editorOpen.value) return;
  rememberOpener(event);
  deleting.value = row;
}
function cancelDelete() {
  if (writeBusy.value) return;
  deleting.value = null;
  restoreFocus();
}
async function confirmDelete() {
  const row = deleting.value;
  if (!row) return;
  const id = generation, workspaceId = props.workspaceId;
  await mutate(async (signal) => {
    await deleteWorkspaceEnvironmentVariable(workspaceId, row.id, { signal });
    if (!current(id, workspaceId)) return;
    rows.value = rows.value.filter((existing) => existing.id !== row.id);
    deleting.value = null;
  });
}
watch(() => props.workspaceId, () => { release(); if (!parked && props.workspaceId) void load(); }, { immediate: true, flush: "sync" });
onDeactivated(() => { parked = true; release(); });
onActivated(() => { if (parked) { parked = false; if (props.workspaceId) void load(); } });
onBeforeUnmount(() => { disposed = true; release(); });
</script>

<style scoped>
.workspace-environment { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--text-primary); background: var(--panel-bg); font-size: 13px; }
.environment-tool-heading { display: flex; flex: none; height: 37px; box-sizing: border-box; align-items: center; padding: 0 12px; border-bottom: 1px solid var(--border-color-secondary); background: var(--panel-bg-elevated); color: var(--text-color); font-size: 12px; font-weight: 600; }
.environment-body { display: flex; flex: 1; min-width: 0; min-height: 0; }
.environment-main { flex: 1; min-width: 0; overflow: auto; padding: 12px; }
.environment-filters { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.environment-filters :deep(.ant-input-affix-wrapper) { width: 250px; max-width: 100%; }
.environment-filters :deep(.ant-select) { width: 114px; }
.environment-count { flex: 1; text-align: right; color: var(--text-tertiary); font-size: 12px; white-space: nowrap; }
.environment-table-panel { border: 1px solid var(--border-color-secondary); border-radius: 4px; overflow: auto; }
.environment-table-panel table { border-collapse: collapse; width: 100%; table-layout: fixed; min-width: 480px; }
.enabled-column { width: 64px; } .name-column { width: 24%; } .remark-column { width: 19%; } .actions-column { width: 84px; }
.environment-table-panel th { padding: 8px 12px; background: var(--panel-bg-elevated); color: var(--text-secondary); text-align: left; font-weight: 500; }
.environment-table-panel td { padding: 8px 12px; border-top: 1px solid var(--border-color-secondary); vertical-align: top; overflow-wrap: anywhere; }
.environment-name, .environment-value, .environment-value-input { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.environment-name { font-weight: 500; }
.environment-value { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.environment-empty-value { color: var(--text-tertiary); font-size: 12px; border: 1px dashed var(--border-color); padding: 1px 5px; border-radius: 3px; }
.environment-remark { color: var(--text-secondary); white-space: pre-wrap; }
.environment-row-actions { display: flex; gap: 2px; }
.is-disabled .environment-name, .is-disabled .environment-value, .is-disabled .environment-remark { color: var(--text-tertiary); }
.environment-empty { padding: 20px 12px; text-align: center; color: var(--text-secondary); }
.environment-side { flex: none; width: 270px; padding: 12px; border-left: 1px solid var(--border-color-secondary); overflow: auto; background: var(--panel-bg-soft, var(--panel-bg)); }
.environment-side h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.environment-effect { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 12px; }
.environment-effect > :first-child { color: var(--primary-color); padding-top: 4px; }
.environment-effect h3 { margin: 0 0 4px; font-size: 13px; font-weight: 400; }
.environment-effect p, .environment-security { margin: 0; color: var(--text-tertiary); font-size: 12px; line-height: 1.7; }
.environment-side hr { border: 0; border-top: 1px solid var(--border-color-secondary); margin: 12px 0; }
.environment-side ul { margin: 0; padding-left: 16px; color: var(--text-secondary); font-size: 12px; line-height: 1.7; }
.environment-side li { margin-bottom: 8px; }
.environment-notice { color: var(--text-secondary); font-size: 12px; }
.environment-error { color: var(--danger-color, #ff7875); margin: 10px 0; font-size: 12px; }
.environment-error-actions { margin-bottom: 8px; }
.environment-form label { display: block; margin: 20px 0 8px; }
.environment-input { width: 100%; color: var(--text-primary); background: var(--panel-bg); border: 1px solid var(--border-color); border-radius: 4px; padding: 6px 10px; font-size: 13px; }
.environment-input:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
.environment-value-input { min-height: 136px; resize: vertical; font-weight: 400; }
.environment-field-help { color: var(--text-tertiary); font-size: 12px; line-height: 1.7; margin: 6px 0 16px; }
.environment-form .environment-enabled-field { display: flex; align-items: center; gap: 10px; }
.environment-drawer-actions { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 1023.98px) { .environment-body { flex-direction: column; overflow: auto; } .environment-main { flex: none; overflow: visible; } .environment-side { width: auto; overflow: visible; border-left: 0; border-top: 1px solid var(--border-color-secondary); } }
</style>
