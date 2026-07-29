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
          <div v-if="item.command" class="text-[11px] text-[color:var(--text-tertiary)] font-mono" :title="'/' + item.command">
            /{{ item.command }}
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

        <a-form-item :label="t('settings.agentGlobalPrompts.form.commandLabel')">
          <a-input
            v-model:value="formCommand"
            :disabled="isReservedItem(formId)"
            :maxlength="MAX_COMMAND_LENGTH"
            :placeholder="t('settings.agentGlobalPrompts.form.commandPlaceholder')"
          />
          <div v-if="isReservedItem(formId)" class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            {{ t("settings.agentGlobalPrompts.form.commandDisabledHint") }}
          </div>
          <div v-else class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            {{ t("settings.agentGlobalPrompts.form.commandHelp") }}
          </div>
        </a-form-item>

        <a-form-item
          v-if="!isReservedItem(formId)"
          :label="t('settings.agentGlobalPrompts.form.expandOnSelectLabel')"
        >
          <a-switch v-model:checked="formExpandOnSelect" :disabled="!formCommand.trim()" />
          <div class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            {{ t("settings.agentGlobalPrompts.form.expandOnSelectHelp") }}
          </div>
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
import { computed, onMounted, ref, watch } from "vue";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import { getAgentGlobalPromptSettings, updateAgentGlobalPromptSettings } from "@/shared/api";
import {
  isReservedAgentGlobalPromptItem,
  normalizeAgentGlobalPromptItems,
  toAgentGlobalPromptsRequest
} from "./agentGlobalPrompts";

const MAX_TITLE_LENGTH = 20;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_COMMAND_LENGTH = 64;
const RESERVED_GLOBAL_SYSTEM_PROMPT_TITLE = "Global System Prompt";
const GLOBAL_PROMPT_COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const { t } = useI18n();

const loading = ref(false);
const saving = ref(false);
const pendingSave = ref(false);
const items = ref<AgentGlobalPromptItem[]>([]);

const modalOpen = ref(false);
const modalMode = ref<"create" | "edit">("create");
const formId = ref("");
const formTitle = ref("");
const formCommand = ref("");
const formPrompt = ref("");
const formExpandOnSelect = ref(false);

const promptBytes = computed(() => new TextEncoder().encode(formPrompt.value).length);

function newLocalId(prefix: string) {
  const ts = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}${random}`;
}

function normalizeItems(raw: unknown): AgentGlobalPromptItem[] {
  return normalizeAgentGlobalPromptItems(raw);
}

function mapFromSettings(settings: AgentGlobalPromptSettings) {
  const normalized = normalizeItems(settings.items);
  const reserved = normalized.find((item) => isReservedItem(item.id));
  const others = normalized.filter((item) => !isReservedItem(item.id));
  items.value = reserved ? [reserved, ...others] : others;
}

function isReservedItem(id: string) {
  return isReservedAgentGlobalPromptItem(id);
}

function toRequestBody() {
  return toAgentGlobalPromptsRequest(items.value);
}

function openCreate() {
  modalMode.value = "create";
  formId.value = newLocalId("gprompt");
  formTitle.value = "";
  formCommand.value = "";
  formPrompt.value = "";
  formExpandOnSelect.value = false;
  modalOpen.value = true;
}

function openEdit(id: string) {
  const target = items.value.find((item) => item.id === id);
  if (!target) return;
  modalMode.value = "edit";
  formId.value = target.id;
  formTitle.value = isReservedItem(target.id) ? RESERVED_GLOBAL_SYSTEM_PROMPT_TITLE : target.title;
  formCommand.value = target.command || "";
  formPrompt.value = target.prompt;
  formExpandOnSelect.value = target.expandOnSelect === true;
  modalOpen.value = true;
}

function closeModal() {
  modalOpen.value = false;
  modalMode.value = "create";
  formId.value = "";
  formTitle.value = "";
  formCommand.value = "";
  formPrompt.value = "";
  formExpandOnSelect.value = false;
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
  const commandRaw = formCommand.value.trim();
  if (!id || !title || !prompt.trim()) {
    message.error(t("settings.agentGlobalPrompts.errors.invalidForm"));
    return;
  }

  let command: string | undefined;
  if (isReservedItem(id)) {
    if (commandRaw) {
      message.error(t("settings.agentGlobalPrompts.errors.commandReserved"));
      return;
    }
  } else if (commandRaw) {
    if (commandRaw.length > MAX_COMMAND_LENGTH) {
      message.error(t("settings.agentGlobalPrompts.errors.commandTooLong", { max: MAX_COMMAND_LENGTH }));
      return;
    }
    if (!GLOBAL_PROMPT_COMMAND_PATTERN.test(commandRaw)) {
      message.error(t("settings.agentGlobalPrompts.errors.commandInvalid"));
      return;
    }
    const normalized = commandRaw.toLowerCase();
    if (normalized === "clear" || normalized === "compact") {
      message.error(t("settings.agentGlobalPrompts.errors.commandConflictsBuiltin"));
      return;
    }
    const dup = items.value.some((it) => {
      if (it.id === id) return false;
      const other = typeof it.command === "string" ? it.command.trim().toLowerCase() : "";
      return other && other === normalized;
    });
    if (dup) {
      message.error(t("settings.agentGlobalPrompts.errors.commandDuplicate"));
      return;
    }
    command = normalized;
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
    prompt,
    ...(command ? { command } : {}),
    ...(command && formExpandOnSelect.value ? { expandOnSelect: true } : {})
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

watch(formCommand, (command) => {
  if (!command.trim()) {
    formExpandOnSelect.value = false;
  }
});

onMounted(() => {
  void refreshDraft();
});

defineExpose({
  refresh: refreshDraft
});
</script>
