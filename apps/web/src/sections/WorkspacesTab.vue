<template>
  <div class="flex flex-col min-h-0">
    <div class="flex items-center gap-2 px-5 py-2">
      <div class="text-[13px] font-semibold">{{ t("workbench.tabs.workspaces") }}</div>
      <a-button
        size="small"
        type="text"
        @click="openCreate"
        :title="t('workspaces.actions.create')"
        :aria-label="t('workspaces.actions.create')"
      >
        <template #icon>
          <PlusOutlined/>
        </template>
      </a-button>
    </div>

    <div class="px-3">
      <div v-if="!loading && workspaces.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("workspaces.empty") }}
      </div>
      <div v-else class="divide-y divide-[var(--border-color-secondary)]">
        <div
            v-for="ws in workspaces"
            :key="ws.id"
            class="group flex items-center justify-between gap-3 px-2 py-2 rounded hover:bg-[var(--panel-bg-elevated)] cursor-pointer"
            @click="openWorkspace(ws.id)"
        >
          <div class="min-w-0 flex-1 flex items-center gap-2">
            <div class="min-w-0 font-mono text-xs truncate" :title="ws.repo.url">{{ ws.repo.url }}</div>
            <div class="shrink-0 text-xs text-[color:var(--text-tertiary)]">·</div>
            <div class="shrink-0 font-mono text-xs" :title="ws.checkout.branch">
              <span>{{ ws.checkout.branch }}</span>
              <a-tag
                v-if="ws.terminalCount"
                class="ml-1 !mr-0 !text-[10px] !leading-[16px] !px-1 !py-0"
                color="blue"
              >
                <a-tooltip :title="t('workspaces.tooltip.activeTerminals')">
                  <span>{{ ws.terminalCount }}</span>
                </a-tooltip>
              </a-tag>
            </div>
          </div>
          <a-button
            size="small"
            type="text"
              danger
              class="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity"
              @click.stop="confirmDelete(ws.id)"
              :title="t('workspaces.actions.delete')"
              :aria-label="t('workspaces.actions.delete')"
          >
            <template #icon>
              <DeleteOutlined/>
            </template>
          </a-button>
        </div>
      </div>
    </div>

    <a-modal v-model:open="createOpen" :title="t('workspaces.create.modalTitle')" :confirm-loading="creating" @ok="submitCreate">
      <a-form layout="vertical">
        <a-form-item :label="t('workspaces.create.modeLabel')" required>
          <a-radio-group v-model:value="createMode" button-style="solid" @change="onCreateModeChange">
            <a-radio-button value="existing">{{ t("workspaces.create.modeExisting") }}</a-radio-button>
            <a-radio-button value="url">{{ t("workspaces.create.modeUrl") }}</a-radio-button>
          </a-radio-group>
        </a-form-item>

        <a-form-item v-if="createMode === 'url'" :label="t('workspaces.create.repoUrlLabel')" required>
          <a-input v-model:value="repoUrl"
                   :placeholder="t('workspaces.create.repoUrlPlaceholder', { at: '@' })"/>
        </a-form-item>

        <a-form-item
          v-if="createMode === 'url'"
          :label="t('workspaces.create.credentialLabel')"
          :validate-status="credentialError ? 'error' : undefined"
          :help="credentialError ?? undefined"
        >
          <a-select
            v-model:value="selectedCredentialId"
            allow-clear
            :placeholder="t('workspaces.create.credentialPlaceholder')"
            show-search
            :filter-option="filterCredential"
          >
            <a-select-option v-for="c in credentialOptions" :key="c.id" :value="c.id">
              {{ c.host }} · {{ credentialKindLabel(c.kind) }}<span v-if="c.isDefault"> · {{ t("common.default") }}</span><span v-if="c.label"> · {{ c.label }}</span>
            </a-select-option>
          </a-select>
          <div class="pt-1 text-[11px] text-[color:var(--text-tertiary)]">
            {{ t("workspaces.create.credentialHelp") }}
          </div>
        </a-form-item>

        <a-form-item v-else :label="t('workspaces.create.repoLabel')" required>
          <a-select
              v-model:value="selectedRepoId"
              :placeholder="t('workspaces.create.repoPlaceholder')"
              show-search
              :filter-option="filterRepo"
              @change="onRepoChange"
          >
            <a-select-option v-for="r in repos" :key="r.id" :value="r.id" :disabled="r.syncStatus !== 'idle'">
              {{ r.url }}
              <span v-if="r.syncStatus !== 'idle'" class="text-[color:var(--text-tertiary)]">
                {{ t("common.format.parensSuffix", { text: repoSyncStatusLabel(r.syncStatus) }) }}
              </span>
            </a-select-option>
          </a-select>
        </a-form-item>

        <a-form-item v-if="createMode === 'existing'" :label="t('workspaces.create.branchLabel')" required>
          <a-select
              v-model:value="selectedBranch"
              :placeholder="t('workspaces.create.branchPlaceholder')"
              :loading="branchesLoading"
              :disabled="!selectedRepoId"
              show-search
          >
            <a-select-option v-for="b in branches" :key="b.name" :value="b.name">
              {{ b.name }}
            </a-select-option>
          </a-select>
          <div class="pt-2">
            <a-button
                size="small"
                type="link"
                class="!text-xs"
                :disabled="!selectedRepoId"
                :loading="refreshBranchesLoading"
                @click="refreshBranches"
            >
              {{ t("workspaces.create.refreshBranches") }}
            </a-button>
          </div>
        </a-form-item>
      </a-form>
      <div class="text-xs text-[color:var(--text-tertiary)] px-3 pb-3">
        {{ t("workspaces.create.urlTip") }}
      </div>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import {Modal, message} from "ant-design-vue";
import {DeleteOutlined, PlusOutlined} from "@ant-design/icons-vue";
import {computed, onMounted, ref, watch} from "vue";
import {useRouter} from "vue-router";
import { useI18n } from "vue-i18n";
import type {CredentialRecord, RepoBranchesResponse, RepoRecord, WorkspaceDetail} from "@agent-workbench/shared";
import { waitRepoReadyOrThrow } from "../services/repoSync";
import { normalizeRepoUrl } from "../utils/repoUrl";
import { extractGitHost, inferGitCredentialKindFromUrl } from "../utils/gitHost";
import {
  createRepo,
  createWorkspace,
  deleteWorkspace,
  listCredentials,
  listRepos,
  listWorkspaces,
  repoBranches,
  syncRepo,
  updateRepo
} from "../services/api";

const { t } = useI18n();

const loading = ref(false);
const repos = ref<RepoRecord[]>([]);
const workspaces = ref<WorkspaceDetail[]>([]);
const credentials = ref<CredentialRecord[]>([]);

const createOpen = ref(false);
const creating = ref(false);
const createMode = ref<"existing" | "url">("existing");
const repoUrl = ref("");
const selectedRepoId = ref<string | undefined>(undefined);
const selectedBranch = ref<string | undefined>(undefined);
const selectedCredentialId = ref<string | undefined>(undefined);
const branchesLoading = ref(false);
const refreshBranchesLoading = ref(false);
const branches = ref<RepoBranchesResponse["branches"]>([]);
const router = useRouter();

function filterRepo(input: string, option: any) {
  return String(option?.children ?? "").toLowerCase().includes(input.toLowerCase());
}

function filterCredential(input: string, option: any) {
  return String(option?.children ?? "").toLowerCase().includes(input.toLowerCase());
}

function repoSyncStatusLabel(status: RepoRecord["syncStatus"]) {
  if (status === "syncing") return t("repos.syncStatus.syncing");
  if (status === "failed") return t("repos.syncStatus.failed");
  return status;
}

function credentialKindLabel(kind: CredentialRecord["kind"]) {
  return kind === "ssh" ? t("settings.credentials.form.kindSsh") : t("settings.credentials.form.kindHttps");
}

const urlHost = computed(() => extractGitHost(repoUrl.value));
const urlKind = computed(() => inferGitCredentialKindFromUrl(repoUrl.value));
const selectedCredential = computed(() => {
  const id = selectedCredentialId.value;
  if (!id) return null;
  return credentials.value.find((c) => c.id === id) ?? null;
});
const credentialError = computed(() => {
  if (createMode.value !== "url") return null;
  const cred = selectedCredential.value;
  if (!cred) return null;

  const host = urlHost.value;
  if (host && cred.host !== host) {
    return t("workspaces.create.credentialHostMismatch", { urlHost: host, credHost: cred.host });
  }

  const kind = urlKind.value;
  if (kind && cred.kind !== kind) {
    return t("workspaces.create.credentialKindMismatch", {
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
    const [reposRes, wsRes, credRes] = await Promise.all([listRepos(), listWorkspaces(), listCredentials()]);
    repos.value = reposRes;
    workspaces.value = wsRes;
    credentials.value = credRes;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  createMode.value = "existing";
  repoUrl.value = "";
  selectedRepoId.value = undefined;
  selectedBranch.value = undefined;
  branches.value = [];
  selectedCredentialId.value = undefined;
  createOpen.value = true;
}

function onCreateModeChange() {
  repoUrl.value = "";
  selectedRepoId.value = undefined;
  selectedBranch.value = undefined;
  branches.value = [];
  selectedCredentialId.value = undefined;
}

async function onRepoChange(repoId: string) {
  selectedBranch.value = undefined;
  branches.value = [];
  branchesLoading.value = true;
  try {
    const res = await repoBranches(repoId);
    branches.value = res.branches;
    const pick =
        (res.defaultBranch && branches.value.some((b) => b.name === res.defaultBranch) ? res.defaultBranch : undefined) ??
        (branches.value[0]?.name ?? undefined);
    selectedBranch.value = pick;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    branchesLoading.value = false;
  }
}

async function refreshBranches() {
  const repoId = selectedRepoId.value;
  if (!repoId) return;
  if (refreshBranchesLoading.value) return;
  refreshBranchesLoading.value = true;
  try {
    await syncRepo(repoId);
    await waitRepoReadyOrThrow(repoId, { t });
    const res = await repoBranches(repoId);
    branches.value = res.branches;

    const current = selectedBranch.value;
    if (current && branches.value.some((b) => b.name === current)) return;
    const pick =
        (res.defaultBranch && branches.value.some((b) => b.name === res.defaultBranch) ? res.defaultBranch : undefined) ??
        (branches.value[0]?.name ?? undefined);
    selectedBranch.value = pick;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    refreshBranchesLoading.value = false;
  }
}

async function submitCreate() {
  creating.value = true;
  try {
    if (createMode.value === "existing") {
      const repoId = selectedRepoId.value;
      const branch = selectedBranch.value;
      if (!repoId || !branch) return;
      await createWorkspace({repoId, branch});
    } else {
      const url = repoUrl.value.trim();
      if (!url) return;
      if (credentialError.value) {
        message.error(credentialError.value);
        return;
      }

      let credentialId = selectedCredentialId.value ?? null;
      if (!credentialId) {
        const host = extractGitHost(url);
        const kind = inferGitCredentialKindFromUrl(url);
        const pick = host ? credentials.value.find((c) => c.host === host && c.isDefault && (!kind || c.kind === kind)) : undefined;
        credentialId = pick?.id ?? null;
      }

      const normalized = normalizeRepoUrl(url);
      const reposNow = await listRepos();
      const exists = reposNow.find((r) => normalizeRepoUrl(r.url) === normalized);

      let repoId = exists?.id;
      if (!repoId) {
        try {
          const created = await createRepo({url, credentialId});
          repoId = created.id;
        } catch (err) {
          const latest = await listRepos();
          const fallback = latest.find((r) => normalizeRepoUrl(r.url) === normalized);
          if (fallback) {
            repoId = fallback.id;
          } else {
            throw err;
          }
        }
      } else if (credentialId && exists && exists.credentialId !== credentialId) {
        await updateRepo(repoId, { credentialId });
      }

      await syncRepo(repoId);
      await waitRepoReadyOrThrow(repoId, { t });
      const branchRes = await repoBranches(repoId);
      const branch =
          (branchRes.defaultBranch && branchRes.branches.some((b) => b.name === branchRes.defaultBranch)
              ? branchRes.defaultBranch
              : undefined) ??
          (branchRes.branches.some((b) => b.name === "main") ? "main" : undefined) ??
          (branchRes.branches.some((b) => b.name === "master") ? "master" : undefined) ??
          branchRes.branches[0]?.name;

      if (!branch) throw new Error(t("workspaces.create.defaultBranchUnknown"));
      await createWorkspace({repoId, branch});
    }

    createOpen.value = false;
    await refresh();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    creating.value = false;
  }
}

function openWorkspace(workspaceId: string) {
  const href = router.resolve({name: "workspace", params: {workspaceId}}).href;
  window.open(href, `workspace_${workspaceId}`);
}

function confirmDelete(workspaceId: string) {
  Modal.confirm({
    title: t("workspaces.deleteConfirm.title"),
    content: t("workspaces.deleteConfirm.content"),
    okText: t("workspaces.deleteConfirm.ok"),
    okType: "danger",
    cancelText: t("workspaces.deleteConfirm.cancel"),
    onOk: async () => {
      await deleteWorkspace(workspaceId);
      await refresh();
    }
  });
}

onMounted(refresh);

watch(
  () => repoUrl.value,
  () => {
    if (createMode.value !== "url") return;
    if (selectedCredentialId.value) return;
    const host = extractGitHost(repoUrl.value);
    const kind = inferGitCredentialKindFromUrl(repoUrl.value);
    const pick = host ? credentials.value.find((c) => c.host === host && c.isDefault && (!kind || c.kind === kind)) : undefined;
    selectedCredentialId.value = pick?.id ?? undefined;
  }
);
</script>
