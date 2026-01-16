<template>
  <div class="flex flex-col min-h-0">
    <div class="flex items-center gap-2 px-5 py-2">
      <a-input
          v-model:value="reposQuery"
          size="small"
          allow-clear
          class="w-[250px] max-w-[45vw] !text-xs"
          :placeholder="t('repos.search.placeholder')"
          :aria-label="t('repos.search.placeholder')"
      >
        <template #prefix>
          <SearchOutlined/>
        </template>
      </a-input>
      <a-button size="small" type="text" @click="openCreate" :title="t('repos.actions.add')" :aria-label="t('repos.actions.add')">
        <template #icon><PlusOutlined /></template>
      </a-button>
      <div class="flex-1"></div>
    </div>

    <div class="px-3">
      <div v-if="!loading && repos.length === 0" class="text-xs text-[color:var(--text-tertiary)]">{{ t("repos.empty") }}</div>
      <div v-else-if="!loading && hasReposQuery && filteredRepos.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("repos.search.empty") }}
      </div>
      <div v-else class="divide-y divide-[var(--border-color-secondary)]">
        <div
          v-for="r in filteredRepos"
          :key="r.id"
          class="group flex items-center justify-between gap-3 px-2 py-2 rounded hover:bg-[var(--panel-bg-elevated)]"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 min-w-0">
              <div class="font-mono text-xs truncate min-w-0" :title="r.url">{{ r.url }}</div>
              <a-tooltip v-if="r.syncStatus === 'failed' && r.syncError" :title="r.syncError">
                <a-tag color="red" class="!text-[10px] !leading-[16px] !px-1 !py-0">{{ t("repos.syncStatus.failed") }}</a-tag>
              </a-tooltip>
              <a-tag
                v-else-if="r.syncStatus === 'syncing'"
                color="blue"
                class="!text-[10px] !leading-[16px] !px-1 !py-0"
              >{{ t("repos.syncStatus.syncing") }}</a-tag>
            </div>
          </div>
          <div class="flex items-center gap-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
            <a-button
              size="small"
              type="text"
              :loading="Boolean(syncingByRepoId[r.id])"
              :disabled="r.syncStatus === 'syncing'"
              @click="doSync(r.id)"
              :title="t('repos.actions.sync')"
              :aria-label="t('repos.actions.sync')"
            >
              <template #icon><SyncOutlined /></template>
            </a-button>
            <a-button
              size="small"
              type="text"
              :disabled="r.syncStatus === 'syncing'"
              @click="openEdit(r)"
              :title="t('repos.actions.edit')"
              :aria-label="t('repos.actions.edit')"
            >
              <template #icon><EditOutlined /></template>
            </a-button>
            <a-button
              size="small"
              type="text"
              danger
              @click="confirmDelete(r.id)"
              :title="t('repos.actions.delete')"
              :aria-label="t('repos.actions.delete')"
            >
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </div>
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
          :validate-status="createCredentialError ? 'error' : undefined"
          :help="createCredentialError ?? undefined"
        >
          <a-select
            v-model:value="selectedCredentialId"
            allow-clear
            :placeholder="t('repos.create.credentialPlaceholder')"
            show-search
            :filter-option="filterCredential"
          >
            <a-select-option v-for="c in createCredentialOptions" :key="c.id" :value="c.id">
              {{ c.host }} · {{ credentialKindLabel(c.kind) }}<span v-if="c.isDefault"> · {{ t("common.default") }}</span><span v-if="c.label"> · {{ c.label }}</span>
            </a-select-option>
          </a-select>
          <div class="pt-1 text-[11px] text-[color:var(--text-tertiary)]">
            {{ t("repos.create.credentialHelpPrefix") }}
            <a-button size="small" type="link" class="!text-[11px] !p-0" @click="openSettingsFromCreate('credentials')">
              {{ t("settings.tabs.credentials") }}
            </a-button>
            <span class="text-[color:var(--text-tertiary)]">/</span>
            <a-button size="small" type="link" class="!text-[11px] !p-0" @click="openSettingsFromCreate('network')">
              {{ t("settings.tabs.network") }}
            </a-button>
            {{ t("repos.create.credentialHelpSuffix") }}
          </div>
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal v-model:open="editOpen" :title="t('repos.edit.modalTitle')" :confirm-loading="editing" @ok="submitEdit">
      <div class="font-mono text-xs text-[color:var(--text-tertiary)] truncate pb-2" :title="editRepo?.url">{{ editRepo?.url }}</div>
      <a-form layout="vertical">
        <a-form-item
          :label="t('repos.edit.credentialLabel')"
          :validate-status="editCredentialError ? 'error' : undefined"
          :help="editCredentialError ?? undefined"
        >
          <a-select
            v-model:value="editCredentialId"
            allow-clear
            :placeholder="t('repos.edit.credentialPlaceholder')"
            show-search
            :filter-option="filterCredential"
          >
            <a-select-option v-for="c in editCredentialOptions" :key="c.id" :value="c.id">
              {{ c.host }} · {{ credentialKindLabel(c.kind) }}<span v-if="c.isDefault"> · {{ t("common.default") }}</span><span v-if="c.label"> · {{ c.label }}</span>
            </a-select-option>
          </a-select>
          <div class="pt-1 text-[11px] text-[color:var(--text-tertiary)]">
            {{ t("repos.edit.credentialHelp") }}
          </div>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { Modal, message } from "ant-design-vue";
import {DeleteOutlined, EditOutlined, PlusOutlined, SearchOutlined, SyncOutlined} from "@ant-design/icons-vue";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import type { CredentialRecord, RepoRecord } from "@agent-workbench/shared";
import { createRepo, deleteRepo, listCredentials, syncRepo, updateRepo } from "../services/api";
import { useReposState, waitRepoSettledOrThrow } from "../state/repos";
import { useWorkbenchSearchState } from "../state/workbenchSearch";
import { extractGitHost, inferGitCredentialKindFromUrl } from "../utils/gitHost";

const { t } = useI18n();
const router = useRouter();

const { repos, loading, refreshRepos } = useReposState();
const { reposQuery } = useWorkbenchSearchState();
const credentials = ref<CredentialRecord[]>([]);

const createOpen = ref(false);
const creating = ref(false);
const createUrl = ref("");
const selectedCredentialId = ref<string | undefined>(undefined);

const editOpen = ref(false);
const editing = ref(false);
const editRepo = ref<RepoRecord | null>(null);
const editCredentialId = ref<string | undefined>(undefined);

const syncingByRepoId = ref<Record<string, boolean>>({});

function tokenizeQuery(raw: string) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .split(/\s+/g)
    .filter(Boolean);
}

const repoTokens = computed(() => tokenizeQuery(reposQuery.value));
const hasReposQuery = computed(() => repoTokens.value.length > 0);

const filteredRepos = computed(() => {
  const tokens = repoTokens.value;
  if (tokens.length === 0) return repos.value;
  return repos.value.filter((r) => {
    const hay = String(r.url || "").toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
});

function filterCredential(input: string, option: any) {
  return String(option?.children ?? "").toLowerCase().includes(input.toLowerCase());
}

function credentialKindLabel(kind: CredentialRecord["kind"]) {
  return kind === "ssh" ? t("settings.credentials.form.kindSsh") : t("settings.credentials.form.kindHttps");
}

function sortCredentials(params: { host: string | null; kind: "https" | "ssh" | null }) {
  const { host, kind } = params;
  const list = credentials.value.slice();
  list.sort((a, b) => {
    const aScore = (host && a.host === host ? 100 : 0) + (kind && a.kind === kind ? 20 : 0) + (a.isDefault ? 10 : 0);
    const bScore = (host && b.host === host ? 100 : 0) + (kind && b.kind === kind ? 20 : 0) + (b.isDefault ? 10 : 0);
    return bScore - aScore;
  });
  return list;
}

const urlHost = computed(() => extractGitHost(createUrl.value));
const urlKind = computed(() => inferGitCredentialKindFromUrl(createUrl.value));
const selectedCredential = computed(() => {
  const id = selectedCredentialId.value;
  if (!id) return null;
  return credentials.value.find((c) => c.id === id) ?? null;
});
const createCredentialError = computed(() => {
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

const createCredentialOptions = computed(() => sortCredentials({ host: urlHost.value, kind: urlKind.value }));

const editUrlHost = computed(() => extractGitHost(editRepo.value?.url || ""));
const editUrlKind = computed(() => inferGitCredentialKindFromUrl(editRepo.value?.url || ""));
const editSelectedCredential = computed(() => {
  const id = editCredentialId.value;
  if (!id) return null;
  return credentials.value.find((c) => c.id === id) ?? null;
});
const editCredentialError = computed(() => {
  const repo = editRepo.value;
  if (!repo) return null;

  const cred = editSelectedCredential.value;
  if (!cred) return null;

  const host = editUrlHost.value;
  if (host && cred.host !== host) {
    return t("repos.edit.credentialHostMismatch", { urlHost: host, credHost: cred.host });
  }

  const kind = editUrlKind.value;
  if (kind && cred.kind !== kind) {
    return t("repos.edit.credentialKindMismatch", {
      urlKind: credentialKindLabel(kind),
      credKind: credentialKindLabel(cred.kind)
    });
  }

  return null;
});
const editCredentialOptions = computed(() => sortCredentials({ host: editUrlHost.value, kind: editUrlKind.value }));

async function refresh() {
  try {
    const [, creds] = await Promise.all([refreshRepos(), listCredentials()]);
    credentials.value = creds;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

function openCreate() {
  createUrl.value = "";
  selectedCredentialId.value = undefined;
  createOpen.value = true;
}

function openSettingsFromCreate(tab: "credentials" | "network") {
  createOpen.value = false;
  void router.push(`/settings/${tab}`);
}

function openEdit(repo: RepoRecord) {
  editRepo.value = repo;
  editCredentialId.value = repo.credentialId ?? undefined;
  editOpen.value = true;
}

async function submitEdit() {
  const repo = editRepo.value;
  if (!repo) return;
  if (editCredentialError.value) {
    message.error(editCredentialError.value);
    return;
  }

  editing.value = true;
  try {
    await updateRepo(repo.id, { credentialId: editCredentialId.value ?? null });
    message.success(t("repos.edit.updated"));
    editOpen.value = false;
    editRepo.value = null;
    await refresh();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    editing.value = false;
  }
}

async function doSync(repoId: string) {
  if (syncingByRepoId.value[repoId]) return;
  syncingByRepoId.value = { ...syncingByRepoId.value, [repoId]: true };
  try {
    const res = await syncRepo(repoId);
    if (!res.started) {
      message.info(t("repos.sync.alreadySyncing"));
      await refreshRepos({ silent: true, showLoading: false });
      return;
    }
    message.success(t("repos.sync.started"));
    await refreshRepos({ silent: true, showLoading: false });
    await waitRepoSettledOrThrow(repoId, { t });
    message.success(t("repos.sync.success"));
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
    await refreshRepos({ silent: true, showLoading: false });
  } finally {
    const { [repoId]: _, ...rest } = syncingByRepoId.value;
    syncingByRepoId.value = rest;
  }
}

async function submitCreate() {
  const url = createUrl.value.trim();
  if (!url) return;
  if (createCredentialError.value) {
    message.error(createCredentialError.value);
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
