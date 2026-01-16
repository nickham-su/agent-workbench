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
      <div class="flex-1"></div>
      <a-input
        v-model:value="workspacesQuery"
        size="small"
        allow-clear
        class="w-[260px] max-w-[45vw]"
        :placeholder="t('workspaces.search.placeholder')"
        :aria-label="t('workspaces.search.placeholder')"
      />
    </div>

    <div class="px-3">
      <div v-if="!loading && workspaces.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("workspaces.empty") }}
      </div>
      <div v-else-if="!loading && hasWorkspaceQuery && filteredWorkspaces.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("workspaces.search.empty") }}
      </div>
      <div v-else class="divide-y divide-[var(--border-color-secondary)]">
        <div
            v-for="ws in filteredWorkspaces"
            :key="ws.id"
            class="group flex items-center justify-between gap-3 px-2 py-2 rounded hover:bg-[var(--panel-bg-elevated)] cursor-pointer"
            @click="openWorkspace(ws.id)"
        >
          <div class="min-w-0 flex-1 flex items-center gap-2">
            <div class="min-w-0 flex-1">
              <div class="min-w-0 flex items-center gap-2">
                <div class="min-w-0 text-xs font-semibold truncate" :title="ws.title">{{ ws.title }}</div>
                <a-tooltip
                  v-if="ws.terminalCount"
                  :title="t('workspaces.tooltip.activeTerminals', { n: ws.terminalCount })"
                >
                  <span class="ws-terminal-count-hit shrink-0" @click.stop="confirmCloseAllTerminals(ws)">
                    <a-tag class="!mr-0 !text-[10px] !leading-[16px] !px-1 !py-0" color="blue">
                      <span>{{ ws.terminalCount }}</span>
                    </a-tag>
                  </span>
                </a-tooltip>
              </div>
              <div class="min-w-0 text-[11px] text-[color:var(--text-tertiary)] truncate" :title="workspaceRepoSummary(ws)">
                {{ workspaceRepoSummary(ws) }}
              </div>
            </div>
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
          <a-checkbox v-model:checked="useTerminalCredential" @change="onTerminalCredentialChange">
            {{ t("workspaces.create.terminalCredentialHelp") }}
          </a-checkbox>
          <div v-if="useTerminalCredentialTouched && !useTerminalCredential" class="text-[11px] text-[color:var(--warning-color)] pt-1">
            {{ t("workspaces.create.terminalCredentialDisabledWarning") }}
          </div>
        </a-form-item>
        <div v-else-if="terminalCredentialState === 'unavailable'" class="text-[11px] text-[color:var(--warning-color)] pb-2">
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
        <div v-else-if="editTerminalCredentialState === 'unavailable'" class="text-[11px] text-[color:var(--warning-color)] pb-2">
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
import { createWorkspace, deleteTerminal, deleteWorkspace, listTerminals, listWorkspaces, updateWorkspace } from "../services/api";
import { useReposState } from "../state/repos";
import { useWorkbenchSearchState } from "../state/workbenchSearch";

const { t } = useI18n();

const { repos, refreshRepos } = useReposState();
const loading = ref(false);
const workspaces = ref<WorkspaceDetail[]>([]);
const { workspacesQuery } = useWorkbenchSearchState();

const createOpen = ref(false);
const creating = ref(false);
const selectedRepoIds = ref<string[]>([]);
const titleInput = ref("");
const titleTouched = ref(false);
const useTerminalCredential = ref(false);
const useTerminalCredentialTouched = ref(false);

const editOpen = ref(false);
const renaming = ref(false);
const editTitle = ref("");
const editingWorkspace = ref<WorkspaceDetail | null>(null);
const editUseTerminalCredential = ref(false);

const closingTerminals = ref<Record<string, boolean>>({});

const router = useRouter();

function tokenizeQuery(raw: string) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .split(/\s+/g)
    .filter(Boolean);
}

const workspaceTokens = computed(() => tokenizeQuery(workspacesQuery.value));
const hasWorkspaceQuery = computed(() => workspaceTokens.value.length > 0);

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

function workspaceSearchText(ws: WorkspaceDetail) {
  const repoUrls = ws.repos.map((r) => r.repo.url).join(" ");
  return `${ws.title} ${ws.id} ${repoUrls} ${workspaceRepoSummary(ws)}`.toLowerCase();
}

const filteredWorkspaces = computed(() => {
  const tokens = workspaceTokens.value;
  if (tokens.length === 0) return workspaces.value;
  return workspaces.value.filter((ws) => {
    const hay = workspaceSearchText(ws);
    return tokens.every((t) => hay.includes(t));
  });
});

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
  },
  { deep: true }
);

watch(
  () => terminalCredentialState.value,
  (state) => {
    if (state === "available") {
      // 默认选中；若用户手动改过则尊重用户选择
      if (!useTerminalCredentialTouched.value) useTerminalCredential.value = true;
      return;
    }
    // 不可用/无需提供时，强制关闭并清理 touched，避免后续默认逻辑失效
    useTerminalCredential.value = false;
    useTerminalCredentialTouched.value = false;
  }
);

function onTitleInput() {
  titleTouched.value = true;
}

function onTerminalCredentialChange(_e: any) {
  useTerminalCredentialTouched.value = true;
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
  useTerminalCredentialTouched.value = false;
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

function confirmCloseAllTerminals(ws: WorkspaceDetail) {
  if (closingTerminals.value[ws.id]) return;
  Modal.confirm({
    title: t("workspaces.closeTerminalsConfirm.title"),
    content: t("workspaces.closeTerminalsConfirm.content"),
    okText: t("workspaces.closeTerminalsConfirm.ok"),
    okType: "danger",
    cancelText: t("workspaces.closeTerminalsConfirm.cancel"),
    onOk: async () => {
      if (closingTerminals.value[ws.id]) return;
      closingTerminals.value = { ...closingTerminals.value, [ws.id]: true };
      try {
        const terms = await listTerminals(ws.id);
        const active = terms.filter((t) => t.status === "active");
        if (active.length === 0) return;

        const results = await Promise.allSettled(active.map((t) => deleteTerminal(t.id)));
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          message.warning(t("workspaces.closeTerminalsConfirm.partialFailed", { failed }));
        }
        await refresh();
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      } finally {
        const next = { ...closingTerminals.value };
        delete next[ws.id];
        closingTerminals.value = next;
      }
    }
  });
}

onMounted(refresh);
</script>

<style scoped>
/* 扩大“活跃终端数”标签的可点击区域，不改变现有视觉样式与布局 */
.ws-terminal-count-hit {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.ws-terminal-count-hit::before {
  content: "";
  position: absolute;
  top: -4px;
  right: -6px;
  bottom: -4px;
  left: -6px;
  background: rgba(0, 0, 0, 0);
}
</style>
