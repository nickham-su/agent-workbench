<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0 flex-1 text-xs text-[color:var(--text-tertiary)]">
        {{ t("settings.agentGlobalPrompts.description") }}
      </div>
      <div class="flex items-center gap-2">
        <div v-if="saving" class="text-xs text-[color:var(--text-tertiary)]">{{ t("settings.agentGlobalPrompts.saving") }}</div>
        <a-button size="small" type="primary" :disabled="loading || saving" @click="openCreate">
          {{ t("settings.agentGlobalPrompts.actions.add") }}
        </a-button>
      </div>
    </div>

    <div v-if="loading" class="text-xs text-[color:var(--text-tertiary)]">{{ t("common.loading") }}</div>

    <div v-else-if="items.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
      {{ t("settings.agentGlobalPrompts.empty") }}
    </div>

    <div v-else class="divide-y divide-[var(--border-color-secondary)] border border-[var(--border-color-secondary)] rounded">
      <div
        v-for="item in items"
        :key="item.id"
        class="group flex items-start justify-between gap-3 px-2 py-2 hover:bg-[var(--panel-bg-elevated)]"
      >
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex items-center gap-2 min-w-0">
            <div class="font-semibold text-xs truncate" :title="item.title">{{ item.title }}</div>
            <div class="text-xs text-[color:var(--text-tertiary)] truncate" :title="item.id">{{ item.id }}</div>
          </div>
          <div
            class="text-[11px] text-[color:var(--text-tertiary)] whitespace-pre-wrap break-words overflow-hidden"
            :style="{
              display: '-webkit-box',
              WebkitLineClamp: '3',
              WebkitBoxOrient: 'vertical'
            }"
          >
            {{ item.prompt || "-" }}
          </div>
        </div>

        <div class="shrink-0 flex items-center gap-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
          <a-button
            size="small"
            type="text"
            @click="openEdit(item.id)"
            :title="t('settings.agentGlobalPrompts.actions.edit')"
            :aria-label="t('settings.agentGlobalPrompts.actions.edit')"
          >
            <template #icon><EditOutlined /></template>
          </a-button>
          <template v-if="!isReservedItem(item.id)">
            <a-button
              size="small"
              type="text"
              danger
              @click="confirmDelete(item.id)"
              :title="t('settings.agentGlobalPrompts.actions.delete')"
              :aria-label="t('settings.agentGlobalPrompts.actions.delete')"
            >
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </template>
        </div>
      </div>
    </div>

    <a-modal
      v-model:open="modalOpen"
      :title="modalMode === 'create' ? t('settings.agentGlobalPrompts.modal.createTitle') : t('settings.agentGlobalPrompts.modal.editTitle')"
      :maskClosable="false"
      :okText="t('settings.agentGlobalPrompts.modal.ok')"
      :cancelText="t('settings.agentGlobalPrompts.modal.cancel')"
      @ok="submit"
      @cancel="closeModal"
    >
      <a-form layout="vertical">
        <a-form-item :label="t('settings.agentGlobalPrompts.form.idLabel')" :required="true">
          <a-input v-model:value="formId" disabled />
        </a-form-item>
        <a-form-item :label="t('settings.agentGlobalPrompts.form.titleLabel')" :required="true">
          <a-input v-model:value="formTitle" :maxlength="MAX_TITLE_LENGTH" :disabled="isReservedItem(formId)" />
        </a-form-item>
        <a-form-item :label="t('settings.agentGlobalPrompts.form.promptLabel')" :required="true">
          <a-textarea
            v-model:value="formPrompt"
            :auto-size="{ minRows: 6, maxRows: 16 }"
            :placeholder="t('settings.agentGlobalPrompts.form.promptPlaceholder')"
          />
          <div v-if="isReservedItem(formId)" class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            {{ t("settings.agentGlobalPrompts.form.systemPromptHint") }}
          </div>
          <div class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            {{ t("settings.agentGlobalPrompts.form.promptHelp", { maxKb: MAX_PROMPT_BYTES / 1024, bytes: promptBytes }) }}
          </div>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import type { AgentGlobalPromptItem, AgentGlobalPromptSettings } from "@agent-workbench/shared";
import { Modal, message } from "ant-design-vue";
import { computed, onMounted, ref } from "vue";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import { getAgentGlobalPromptSettings, updateAgentGlobalPromptSettings } from "@/shared/api";

const MAX_TITLE_LENGTH = 20;
const MAX_PROMPT_BYTES = 32 * 1024;
const RESERVED_GLOBAL_SYSTEM_PROMPT_ID = "global_system_prompt";
const RESERVED_GLOBAL_SYSTEM_PROMPT_TITLE = "Global System Prompt";

const { t } = useI18n();

const loading = ref(false);
const saving = ref(false);
const pendingSave = ref(false);
const items = ref<AgentGlobalPromptItem[]>([]);

const modalOpen = ref(false);
const modalMode = ref<"create" | "edit">("create");
const formId = ref("");
const formTitle = ref("");
const formPrompt = ref("");

const promptBytes = computed(() => new TextEncoder().encode(formPrompt.value).length);

function newLocalId(prefix: string) {
  const ts = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}${random}`;
}

function normalizeItems(raw: unknown): AgentGlobalPromptItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentGlobalPromptItem[] = [];
  const seen = new Set<string>();
  for (const itemRaw of raw) {
    const item = itemRaw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const prompt = typeof item.prompt === "string" ? item.prompt : "";
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title, prompt });
  }
  return out;
}

function mapFromSettings(settings: AgentGlobalPromptSettings) {
  const normalized = normalizeItems(settings.items);
  const reserved = normalized.find((item) => isReservedItem(item.id));
  const others = normalized.filter((item) => !isReservedItem(item.id));
  items.value = reserved ? [reserved, ...others] : others;
}

function isReservedItem(id: string) {
  return id.trim() === RESERVED_GLOBAL_SYSTEM_PROMPT_ID;
}

function toRequestBody() {
  return {
    items: items.value.map((item) => ({
      id: item.id,
      title: item.title.trim(),
      prompt: item.prompt
    }))
  };
}

function openCreate() {
  modalMode.value = "create";
  formId.value = newLocalId("gprompt");
  formTitle.value = "";
  formPrompt.value = "";
  modalOpen.value = true;
}

function openEdit(id: string) {
  const target = items.value.find((item) => item.id === id);
  if (!target) return;
  modalMode.value = "edit";
  formId.value = target.id;
  formTitle.value = isReservedItem(target.id) ? RESERVED_GLOBAL_SYSTEM_PROMPT_TITLE : target.title;
  formPrompt.value = target.prompt;
  modalOpen.value = true;
}

function closeModal() {
  modalOpen.value = false;
  modalMode.value = "create";
  formId.value = "";
  formTitle.value = "";
  formPrompt.value = "";
}

async function persist(params: { toast: boolean }) {
  if (saving.value) {
    pendingSave.value = true;
    return;
  }
  saving.value = true;
  try {
    const res = await updateAgentGlobalPromptSettings(toRequestBody());
    // 若保存期间又有新改动，优先继续提交本地草稿，避免先回填旧响应覆盖本地编辑。
    if (!pendingSave.value) {
      mapFromSettings(res);
      if (params.toast) message.success(t("settings.agentGlobalPrompts.saved"));
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
    if (pendingSave.value) {
      pendingSave.value = false;
      void persist({ toast: false });
    }
  }
}

function submit() {
  const id = formId.value.trim();
  const title = formTitle.value.trim();
  const prompt = formPrompt.value;
  if (!id || !title || !prompt.trim()) {
    message.error(t("settings.agentGlobalPrompts.errors.invalidForm"));
    return;
  }
  const normalizedTitle = isReservedItem(id) ? RESERVED_GLOBAL_SYSTEM_PROMPT_TITLE : title;
  if (title.length > MAX_TITLE_LENGTH) {
    message.error(t("settings.agentGlobalPrompts.errors.titleTooLong", { max: MAX_TITLE_LENGTH }));
    return;
  }
  if (promptBytes.value > MAX_PROMPT_BYTES) {
    message.error(t("settings.agentGlobalPrompts.errors.promptTooLong", { maxKb: MAX_PROMPT_BYTES / 1024 }));
    return;
  }

  const payload: AgentGlobalPromptItem = {
    id,
    title: normalizedTitle,
    prompt
  };

  if (modalMode.value === "create") {
    if (items.value.some((item) => item.id === id)) {
      message.error(t("settings.agentGlobalPrompts.errors.duplicateId"));
      return;
    }
    items.value.push(payload);
  } else {
    const idx = items.value.findIndex((item) => item.id === id);
    if (idx < 0) return;
    items.value[idx] = payload;
  }

  closeModal();
  void persist({ toast: true });
}

function confirmDelete(id: string) {
  if (isReservedItem(id)) {
    message.error(t("settings.agentGlobalPrompts.errors.reservedDelete"));
    return;
  }
  const target = items.value.find((item) => item.id === id);
  if (!target) return;
  Modal.confirm({
    title: t("settings.agentGlobalPrompts.deleteConfirm.title"),
    content: t("settings.agentGlobalPrompts.deleteConfirm.content", { title: target.title }),
    okText: t("settings.agentGlobalPrompts.deleteConfirm.ok"),
    cancelText: t("settings.agentGlobalPrompts.deleteConfirm.cancel"),
    okType: "danger",
    onOk: async () => {
      items.value = items.value.filter((item) => item.id !== id);
      await persist({ toast: true });
    }
  });
}

async function refreshDraft() {
  if (loading.value) return;
  loading.value = true;
  try {
    const res = await getAgentGlobalPromptSettings();
    mapFromSettings(res);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refreshDraft();
});

defineExpose({
  refresh: refreshDraft
});
</script>
