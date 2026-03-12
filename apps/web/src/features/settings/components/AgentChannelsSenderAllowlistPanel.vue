<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0 flex-1 text-xs text-[color:var(--text-tertiary)]">
        {{ t("settings.agentChannelSenderAllowlist.description") }}
      </div>
      <a-button size="small" type="primary" :disabled="loading || !channelOptions.length" @click="openCreateModal">
        {{ t("settings.agentChannelSenderAllowlist.actions.add") }}
      </a-button>
    </div>

    <div v-if="loading" class="text-xs text-[color:var(--text-tertiary)]">{{ t("common.loading") }}</div>

    <template v-else>
      <div v-if="!channelOptions.length" class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("settings.agentChannelSenderAllowlist.emptyChannels") }}
      </div>

      <div class="rounded border border-[var(--border-color-secondary)] overflow-hidden">
        <table class="w-full text-xs">
          <thead class="bg-[var(--panel-bg-elevated)] border-b border-[var(--border-color-secondary)]">
            <tr>
              <th class="text-left font-semibold px-3 py-2 w-[180px]">{{ t("settings.agentChannelSenderAllowlist.fields.channel") }}</th>
              <th class="text-left font-semibold px-3 py-2">{{ t("settings.agentChannelSenderAllowlist.fields.senderId") }}</th>
              <th class="text-left font-semibold px-3 py-2">{{ t("settings.agentChannelSenderAllowlist.fields.remark") }}</th>
            </tr>
          </thead>
          <tbody v-if="items.length > 0">
            <tr v-for="(item, idx) in items" :key="`${item.channel}\u0000${item.senderId}\u0000${idx}`" class="border-t border-[var(--border-color-secondary)] align-top">
              <td class="px-3 py-2 font-mono">{{ item.channel }}</td>
              <td class="px-3 py-2 font-mono break-all">{{ item.senderId }}</td>
              <td class="px-3 py-2 break-all">
                <div class="flex items-start justify-between gap-2">
                  <span class="break-all">{{ item.remark || "-" }}</span>
                  <a-button type="text" danger size="small" :loading="submitting" @click="removeItem(idx)">
                    {{ t("settings.agentChannelSenderAllowlist.actions.remove") }}
                  </a-button>
                </div>
              </td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr>
              <td colspan="3" class="px-3 py-4 text-xs text-[color:var(--text-tertiary)]">{{ t("settings.agentChannelSenderAllowlist.empty") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <a-modal
      v-model:open="createModalOpen"
      :title="t('settings.agentChannelSenderAllowlist.modal.createTitle')"
      :confirm-loading="submitting"
      @ok="submitCreate"
      @cancel="closeCreateModal"
    >
      <a-form layout="vertical">
        <a-form-item :label="t('settings.agentChannelSenderAllowlist.fields.channel')" required>
          <a-select
            v-model:value="createForm.channel"
            :options="channelOptions"
            :placeholder="t('settings.agentChannelSenderAllowlist.fields.channel')"
          />
        </a-form-item>
        <a-form-item :label="t('settings.agentChannelSenderAllowlist.fields.senderId')" required>
          <a-input
            v-model:value="createForm.senderId"
            :placeholder="t('settings.agentChannelSenderAllowlist.fields.senderIdPlaceholder')"
          />
        </a-form-item>
        <a-form-item :label="t('settings.agentChannelSenderAllowlist.fields.remark')">
          <a-input
            v-model:value="createForm.remark"
            :placeholder="t('settings.agentChannelSenderAllowlist.fields.remarkPlaceholder')"
          />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import type { AgentChannelSenderAllowlistItem, PluginRuntimeSnapshot } from "@agent-workbench/shared";
import { message } from "ant-design-vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  getAgentChannelSenderAllowlistSettings,
  getAgentPluginRuntimeSnapshots,
  updateAgentChannelSenderAllowlistSettings
} from "@/shared/api";

const { t } = useI18n();

const loading = ref(false);
const submitting = ref(false);
const items = ref<AgentChannelSenderAllowlistItem[]>([]);
const runtimePlugins = ref<PluginRuntimeSnapshot[]>([]);

const createModalOpen = ref(false);
const createForm = ref({
  channel: "",
  senderId: "",
  remark: ""
});

const channelOptions = computed(() => {
  const options = runtimePlugins.value
    .filter((plugin) => Array.isArray(plugin.capabilities?.channels) && plugin.capabilities.channels.length > 0)
    .map((plugin) => {
      const name = plugin.manifest?.name?.trim();
      return {
        value: plugin.id,
        label: name ? `${name} (${plugin.id})` : plugin.id
      };
    })
    .sort((a, b) => String(a.value).localeCompare(String(b.value)));
  return options;
});

function resetCreateForm() {
  createForm.value = {
    channel: channelOptions.value[0]?.value ?? "",
    senderId: "",
    remark: ""
  };
}

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  try {
    const [settings, snapshots] = await Promise.all([getAgentChannelSenderAllowlistSettings(), getAgentPluginRuntimeSnapshots()]);
    items.value = settings.items ?? [];
    runtimePlugins.value = snapshots.plugins ?? [];
    if (!createForm.value.channel || !channelOptions.value.some((x) => x.value === createForm.value.channel)) resetCreateForm();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

function openCreateModal() {
  if (!createForm.value.channel) resetCreateForm();
  createModalOpen.value = true;
}

function closeCreateModal() {
  createModalOpen.value = false;
  resetCreateForm();
}

async function persistItems(nextItems: AgentChannelSenderAllowlistItem[], successMessageKey = "settings.agentChannelSenderAllowlist.saved") {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const payload = {
      items: nextItems.map((it) => ({
        channel: String(it.channel || "").trim(),
        senderId: String(it.senderId || "").trim(),
        ...(String(it.remark || "").trim() ? { remark: String(it.remark || "").trim() } : {})
      }))
    };
    const res = await updateAgentChannelSenderAllowlistSettings(payload);
    items.value = res.items ?? [];
    message.success(t(successMessageKey));
    return true;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    submitting.value = false;
  }
}

async function submitCreate() {
  const channel = String(createForm.value.channel || "").trim();
  const senderId = String(createForm.value.senderId || "").trim();
  const remarkRaw = String(createForm.value.remark || "").trim();
  const remark = remarkRaw ? remarkRaw : undefined;

  if (!channel) {
    message.warning(t("settings.agentChannelSenderAllowlist.errors.channelRequired"));
    return;
  }

  if (!senderId) {
    message.warning(t("settings.agentChannelSenderAllowlist.errors.senderIdRequired"));
    return;
  }

  if (items.value.some((it) => it.channel === channel && it.senderId === senderId)) {
    message.warning(t("settings.agentChannelSenderAllowlist.errors.duplicate"));
    return;
  }

  const nextItems = [...items.value, { channel, senderId, ...(remark ? { remark } : {}) }];
  const ok = await persistItems(nextItems, "settings.agentChannelSenderAllowlist.created");
  if (ok) {
    closeCreateModal();
  }
}

async function removeItem(index: number) {
  const nextItems = items.value.filter((_, idx) => idx !== index);
  await persistItems(nextItems, "settings.agentChannelSenderAllowlist.removed");
}

void refresh().then(() => {
  if (!createForm.value.channel) resetCreateForm();
});

defineExpose({ refresh });
</script>
