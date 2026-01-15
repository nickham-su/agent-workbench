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
            <div class="min-w-0 flex-1">
              <div class="min-w-0 text-xs font-semibold truncate" :title="ws.title">{{ ws.title }}</div>
              <div class="min-w-0 text-[11px] text-[color:var(--text-tertiary)] truncate" :title="workspaceRepoSummary(ws)">
                {{ workspaceRepoSummary(ws) }}
              </div>
            </div>
            <a-tag
              v-if="ws.terminalCount"
              class="!mr-0 !text-[10px] !leading-[16px] !px-1 !py-0"
              color="blue"
            >
              <a-tooltip :title="t('workspaces.tooltip.activeTerminals')">
                <span>{{ ws.terminalCount }}</span>
              </a-tooltip>
            </a-tag>
          </div>
          <div class="flex items-center gap-1">
            <a-button
              size="small"
              type="text"
              class="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity"
              @click.stop="openEdit(ws)"
              :title="t('workspaces.actions.rename')"
              :aria-label="t('workspaces.actions.rename')"
            >
              <template #icon>
                <EditOutlined />
              </template>
            </a-button>
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
    </div>

    <a-modal v-model:open="createOpen" :title="t('workspaces.create.modalTitle')" :confirm-loading="creating" @ok="submitCreate">
      <a-form layout="vertical">
        <a-form-item :label="t('workspaces.create.repoLabel')" required>
          <a-select
            v-model:value="selectedRepoIds"
            mode="multiple"
            :placeholder="t('workspaces.create.repoPlaceholder')"
            show-search
            :filter-option="filterRepo"
          >
            <a-select-option
              v-for="r in repos"
              :key="r.id"
              :value="r.id"
              :label="r.url"
              :disabled="r.syncStatus !== 'idle' || !r.defaultBranch"
            >
              {{ r.url }}
              <span v-if="r.syncStatus !== 'idle'" class="text-[color:var(--text-tertiary)]">
                {{ t("common.format.parensSuffix", { text: repoSyncStatusLabel(r.syncStatus) }) }}
              </span>
              <span v-else-if="!r.defaultBranch" class="text-[color:var(--text-tertiary)]">
                {{ t("common.format.parensSuffix", { text: t('workspaces.create.defaultBranchUnknown') }) }}
              </span>
            </a-select-option>
          </a-select>
        </a-form-item>

        <a-form-item :label="t('workspaces.create.titleLabel')">
          <a-input
            v-model:value="titleInput"
            :placeholder="t('workspaces.create.titlePlaceholder')"
            @input="onTitleInput"
          />
        </a-form-item>

        <a-form-item v-if="terminalCredentialState === 'available'" :label="t('workspaces.create.terminalCredentialLabel')">
          <a-checkbox v-model:checked="useTerminalCredential">
            {{ t("workspaces.create.terminalCredentialHelp") }}
          </a-checkbox>
        </a-form-item>
        <div v-else-if="terminalCredentialState === 'unavailable'" class="text-[11px] text-[color:var(--text-tertiary)] pb-2">
          {{ t("workspaces.create.terminalCredentialUnavailable") }}
        </div>
      </a-form>
    </a-modal>

    <a-modal v-model:open="editOpen" :title="t('workspaces.rename.modalTitle')" :confirm-loading="renaming" @ok="submitRename">
      <a-form layout="vertical">
        <a-form-item :label="t('workspaces.rename.titleLabel')" required>
          <a-input v-model:value="editTitle" :placeholder="t('workspaces.rename.titlePlaceholder')" />
        </a-form-item>

        <a-form-item v-if="editTerminalCredentialState === 'available'" :label="t('workspaces.create.terminalCredentialLabel')">
          <a-checkbox v-model:checked="editUseTerminalCredential">
            {{ t("workspaces.create.terminalCredentialHelp") }}
          </a-checkbox>
          <div class="text-[11px] text-[color:var(--text-tertiary)] pt-1">
            {{ t("workspaces.rename.terminalCredentialAffectsNewOnly") }}
          </div>
        </a-form-item>
        <div v-else-if="editTerminalCredentialState === 'unavailable'" class="text-[11px] text-[color:var(--text-tertiary)] pb-2">
          {{ t("workspaces.create.terminalCredentialUnavailable") }}
        </div>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { Modal, message } from "ant-design-vue";
import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons-vue";
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import type { RepoRecord, UpdateWorkspaceRequest, WorkspaceDetail } from "@agent-workbench/shared";
import { createWorkspace, deleteWorkspace, listWorkspaces, updateWorkspace } from "../services/api";
import { useReposState } from "../state/repos";

const { t } = useI18n();

const { repos, refreshRepos } = useReposState();
const loading = ref(false);
const workspaces = ref<WorkspaceDetail[]>([]);

const createOpen = ref(false);
const creating = ref(false);
const selectedRepoIds = ref<string[]>([]);
const titleInput = ref("");
const titleTouched = ref(false);
const useTerminalCredential = ref(false);

const editOpen = ref(false);
const renaming = ref(false);
const editTitle = ref("");
const editingWorkspace = ref<WorkspaceDetail | null>(null);
const editUseTerminalCredential = ref(false);

const router = useRouter();

function formatRepoDisplayName(rawUrl: string) {
  let s = String(rawUrl || "").trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  if (s.toLowerCase().endsWith(".git")) s = s.slice(0, -4);

  let pathPart = "";
  try {
    if (s.includes("://")) {
      const u = new URL(s);
      pathPart = u.pathname || "";
    }
  } catch {
    // ignore
  }
  if (!pathPart) {
    const colonIdx = s.lastIndexOf(":");
    if (colonIdx > 0 && s.includes("@") && !s.includes("://")) {
      pathPart = s.slice(colonIdx + 1);
    } else {
      pathPart = s;
    }
  }

  pathPart = pathPart.replace(/\\/g, "/").replace(/^\/+/, "");
  const segs = pathPart.split("/").filter(Boolean);
  if (segs.length >= 1) return segs[segs.length - 1]!;
  return s;
}

function workspaceRepoSummary(ws: WorkspaceDetail) {
  const names = ws.repos.map((r) => formatRepoDisplayName(r.repo.url)).filter(Boolean);
  return names.join(" · ");
}

function filterRepo(input: string, option: any) {
  const hay = String(option?.label ?? option?.children ?? "").toLowerCase();
  return hay.includes(input.toLowerCase());
}

function repoSyncStatusLabel(status: RepoRecord["syncStatus"]) {
  if (status === "syncing") return t("repos.syncStatus.syncing");
  if (status === "failed") return t("repos.syncStatus.failed");
  return status;
}

const selectedRepos = computed(() => repos.value.filter((r) => selectedRepoIds.value.includes(r.id)));
const defaultTitle = computed(() => selectedRepos.value.map((r) => formatRepoDisplayName(r.url)).filter(Boolean).join(" + "));
const terminalCredentialState = computed<"none" | "available" | "unavailable">(() => {
  if (selectedRepos.value.length === 0) return "none";
  const ids = selectedRepos.value.map((r) => r.credentialId ?? "").filter(Boolean);
  // 选中的仓库都未绑定凭证：终端无需提供凭证开关与提示
  if (ids.length === 0) return "none";
  const uniq = new Set(ids);
  if (uniq.size !== 1) return "unavailable";
  return "available";
});

const editingRepos = computed(() => {
  const ws = editingWorkspace.value;
  if (!ws) return [] as RepoRecord[];
  return ws.repos
    .map((r) => repos.value.find((x) => x.id === r.repo.id))
    .filter((x): x is RepoRecord => Boolean(x));
});

const editTerminalCredentialState = computed<"none" | "available" | "unavailable">(() => {
  const ids = editingRepos.value.map((r) => r.credentialId ?? "").filter(Boolean);
  if (ids.length === 0) return "none";
  const uniq = new Set(ids);
  if (uniq.size !== 1) return "unavailable";
  return "available";
});

watch(
  () => selectedRepoIds.value,
  () => {
    if (!titleTouched.value) titleInput.value = defaultTitle.value;
    if (terminalCredentialState.value !== "available") useTerminalCredential.value = false;
  },
  { deep: true }
);

function onTitleInput() {
  titleTouched.value = true;
}

async function refresh() {
  loading.value = true;
  try {
    const [wsRes] = await Promise.all([listWorkspaces(), refreshRepos()]);
    workspaces.value = wsRes;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  selectedRepoIds.value = [];
  titleInput.value = "";
  titleTouched.value = false;
  useTerminalCredential.value = false;
  createOpen.value = true;
}

async function submitCreate() {
  creating.value = true;
  try {
    if (selectedRepoIds.value.length === 0) return;
    const invalid = selectedRepos.value.find((r) => r.syncStatus !== "idle" || !r.defaultBranch);
    if (invalid) {
      message.error(t("workspaces.create.defaultBranchUnknown"));
      return;
    }

    const title = titleInput.value.trim();
    await createWorkspace({
      repoIds: selectedRepoIds.value,
      title: title ? title : undefined,
      useTerminalCredential: useTerminalCredential.value || undefined
    });

    createOpen.value = false;
    await refresh();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    creating.value = false;
  }
}

function openWorkspace(workspaceId: string) {
  const href = router.resolve({ name: "workspace", params: { workspaceId } }).href;
  window.open(href, `workspace_${workspaceId}`);
}

function openEdit(ws: WorkspaceDetail) {
  editingWorkspace.value = ws;
  editTitle.value = ws.title || "";
  editUseTerminalCredential.value = Boolean(ws.useTerminalCredential);
  editOpen.value = true;
}

async function submitRename() {
  if (!editingWorkspace.value) return;
  const title = editTitle.value.trim();
  if (!title) return;
  renaming.value = true;
  try {
    const body: UpdateWorkspaceRequest = { title };
    if (editTerminalCredentialState.value === "available") {
      body.useTerminalCredential = editUseTerminalCredential.value;
    }
    await updateWorkspace(editingWorkspace.value.id, body);
    editOpen.value = false;
    editingWorkspace.value = null;
    await refresh();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    renaming.value = false;
  }
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
</script>
