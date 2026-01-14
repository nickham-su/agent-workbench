<template>
  <div class="flex flex-col min-h-0">
    <div class="flex items-center gap-2 px-5 py-2">
      <div class="text-[13px] font-semibold">{{ t("workbench.tabs.repos") }}</div>
      <a-button size="small" type="text" @click="openCreate" :title="t('repos.actions.add')" :aria-label="t('repos.actions.add')">
        <template #icon><PlusOutlined /></template>
      </a-button>
    </div>

    <div class="px-3">
      <div v-if="!loading && repos.length === 0" class="text-xs text-[color:var(--text-tertiary)]">{{ t("repos.empty") }}</div>
      <div v-else class="divide-y divide-[var(--border-color-secondary)]">
        <div
          v-for="r in repos"
          :key="r.id"
          class="group flex items-center justify-between gap-3 px-2 py-2 rounded hover:bg-[var(--panel-bg-elevated)]"
        >
          <div class="min-w-0 flex-1">
            <div class="font-mono text-xs truncate" :title="r.url">{{ r.url }}</div>
          </div>
          <a-button
            size="small"
            type="text"
            danger
            class="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity"
            @click="confirmDelete(r.id)"
            :title="t('repos.actions.delete')"
            :aria-label="t('repos.actions.delete')"
          >
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </div>
      </div>
    </div>

    <a-modal v-model:open="createOpen" :title="t('repos.create.modalTitle')" :confirm-loading="creating" @ok="submitCreate">
      <a-form layout="vertical">
        <a-form-item :label="t('repos.create.gitUrlLabel')" required>
          <a-input v-model:value="createUrl" :placeholder="t('repos.create.gitUrlPlaceholder', { at: '@' })" />
        </a-form-item>
        <a-form-item
          :label="t('repos.create.credentialLabel')"
          :validate-status="credentialError ? 'error' : undefined"
          :help="credentialError ?? undefined"
        >
          <a-select
            v-model:value="selectedCredentialId"
            allow-clear
            :placeholder="t('repos.create.credentialPlaceholder')"
            show-search
            :filter-option="filterCredential"
          >
            <a-select-option v-for="c in credentialOptions" :key="c.id" :value="c.id">
              {{ c.host }} · {{ credentialKindLabel(c.kind) }}<span v-if="c.isDefault"> · {{ t("common.default") }}</span><span v-if="c.label"> · {{ c.label }}</span>
            </a-select-option>
          </a-select>
          <div class="pt-1 text-[11px] text-[color:var(--text-tertiary)]">
            {{ t("repos.create.credentialHelp") }}
          </div>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { Modal, message } from "ant-design-vue";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons-vue";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { CredentialRecord, RepoRecord } from "@agent-workbench/shared";
import { createRepo, deleteRepo, listCredentials, listRepos } from "../services/api";
import { extractGitHost, inferGitCredentialKindFromUrl } from "../utils/gitHost";

const { t } = useI18n();

const repos = ref<RepoRecord[]>([]);
const loading = ref(false);
const credentials = ref<CredentialRecord[]>([]);

const createOpen = ref(false);
const creating = ref(false);
const createUrl = ref("");
const selectedCredentialId = ref<string | undefined>(undefined);

function filterCredential(input: string, option: any) {
  return String(option?.children ?? "").toLowerCase().includes(input.toLowerCase());
}

function credentialKindLabel(kind: CredentialRecord["kind"]) {
  return kind === "ssh" ? t("settings.credentials.form.kindSsh") : t("settings.credentials.form.kindHttps");
}

const urlHost = computed(() => extractGitHost(createUrl.value));
const urlKind = computed(() => inferGitCredentialKindFromUrl(createUrl.value));
const selectedCredential = computed(() => {
  const id = selectedCredentialId.value;
  if (!id) return null;
  return credentials.value.find((c) => c.id === id) ?? null;
});
const credentialError = computed(() => {
  const cred = selectedCredential.value;
  if (!cred) return null;

  const host = urlHost.value;
  if (host && cred.host !== host) {
    return t("repos.create.credentialHostMismatch", { urlHost: host, credHost: cred.host });
  }

  const kind = urlKind.value;
  if (kind && cred.kind !== kind) {
    return t("repos.create.credentialKindMismatch", {
      urlKind: credentialKindLabel(kind),
      credKind: credentialKindLabel(cred.kind)
    });
  }

  return null;
});

const credentialOptions = computed(() => {
  const host = urlHost.value;
  const kind = urlKind.value;
  const list = credentials.value.slice();
  list.sort((a, b) => {
    const aScore = (host && a.host === host ? 100 : 0) + (kind && a.kind === kind ? 20 : 0) + (a.isDefault ? 10 : 0);
    const bScore = (host && b.host === host ? 100 : 0) + (kind && b.kind === kind ? 20 : 0) + (b.isDefault ? 10 : 0);
    return bScore - aScore;
  });
  return list;
});

async function refresh() {
  loading.value = true;
  try {
    repos.value = await listRepos();
    credentials.value = await listCredentials();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  createUrl.value = "";
  selectedCredentialId.value = undefined;
  createOpen.value = true;
}

async function submitCreate() {
  const url = createUrl.value.trim();
  if (!url) return;
  if (credentialError.value) {
    message.error(credentialError.value);
    return;
  }
  creating.value = true;
  try {
    let credentialId = selectedCredentialId.value ?? null;
    if (!credentialId) {
      const host = extractGitHost(url);
      const kind = inferGitCredentialKindFromUrl(url);
      const pick = host ? credentials.value.find((c) => c.host === host && c.isDefault && (!kind || c.kind === kind)) : undefined;
      credentialId = pick?.id ?? null;
    }
    await createRepo({ url, credentialId });
    createOpen.value = false;
    await refresh();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    creating.value = false;
  }
}

function confirmDelete(repoId: string) {
  Modal.confirm({
    title: t("repos.deleteConfirm.title"),
    content: t("repos.deleteConfirm.content"),
    okText: t("repos.deleteConfirm.ok"),
    okType: "danger",
    cancelText: t("repos.deleteConfirm.cancel"),
    onOk: async () => {
      await deleteRepo(repoId);
      await refresh();
    }
  });
}

onMounted(refresh);

watch(
  () => createUrl.value,
  () => {
    if (selectedCredentialId.value) return;
    const host = extractGitHost(createUrl.value);
    const kind = inferGitCredentialKindFromUrl(createUrl.value);
    const pick = host ? credentials.value.find((c) => c.host === host && c.isDefault && (!kind || c.kind === kind)) : undefined;
    selectedCredentialId.value = pick?.id ?? undefined;
  }
);
</script>
