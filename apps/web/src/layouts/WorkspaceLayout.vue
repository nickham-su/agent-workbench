<template>
  <a-layout class="min-h-screen !bg-[var(--app-bg)]">
    <a-layout-header class="flex items-center justify-between !h-12 !px-3 !bg-[var(--panel-bg-elevated)]">
      <div class="flex items-center gap-3 min-w-0">
        <div class="text-[color:var(--text-color)] font-semibold text-sm shrink-0">{{ t("workspace.title") }}</div>
        <div v-if="workspace" class="flex items-center gap-2 min-w-0">
          <div class="text-[color:var(--text-secondary)] text-xs min-w-0 truncate flex items-center">
            <a-tooltip :mouseEnterDelay="0" :mouseLeaveDelay="0" placement="top">
              <template #title>
                <span class="font-mono break-all">{{ workspace.repo.url }}</span>
              </template>
              <span class="font-mono">{{ repoDisplayName }}</span>
            </a-tooltip>
            <span class="shrink-0"> · </span>
            <span class="font-mono shrink-0">{{ workspace.checkout.branch }}</span>
          </div>
          <div class="flex items-center gap-2 shrink-0 ml-1">
            <a-button size="small" :disabled="gitBusy" @click="openCheckout()">{{ t("workspace.actions.checkout") }}</a-button>
            <a-button size="small" :disabled="gitBusy" :loading="pullLoading" @click="pullWithUi()">{{ t("workspace.actions.pull") }}</a-button>
            <a-button size="small" :disabled="gitBusy" :loading="pushLoading" @click="pushWithUi()">{{ t("workspace.actions.push") }}</a-button>
          </div>
        </div>
      </div>
    </a-layout-header>

    <a-layout-content class="p-0 h-[calc(100vh-64px)] border-t border-[var(--border-color-secondary)]">
      <div ref="containerEl" class="h-full grid gap-0 min-h-0" :style="containerStyle">
        <div :style="reviewStyle" :class="reviewContainerClass">
          <CodeReviewPanel
            ref="reviewRef"
            :workspaceId="workspaceId"
            :gitBusy="gitBusy"
            :beginGitOp="beginGitOp"
            :push="pushWithUi"
            @changesSummary="onChangesSummary"
          />
        </div>
        <div :class="terminalContainerClass">
          <div
            v-if="showTerminalPanel"
            :class="splitterClass"
            :style="splitterStyle"
            role="separator"
            :aria-orientation="layoutMode === 'horizontal' ? 'vertical' : 'horizontal'"
            :aria-label="t('workspace.splitter.resizeTerminalPanel')"
            @pointerdown="onSplitterPointerDown"
          />
          <div :class="showTerminalPanel ? 'h-full min-h-0 overflow-hidden' : 'min-h-0 overflow-hidden'">
            <div v-if="hasTerminals && terminalCollapsed" class="p-1">
              <a-tooltip :title="t('terminal.empty.create')">
                <a-button
                  class="!p-0"
                  size="small"
                  type="text"
                  @click="terminalCollapsed = false"
                  :aria-label="t('terminal.empty.create')"
                >
                  <CodeOutlined class="text-xl" />
                </a-button>
              </a-tooltip>
            </div>

            <TerminalTabs
              v-else
              :workspaceId="workspaceId"
              v-model:layoutMode="layoutMode"
              v-model:collapsed="terminalCollapsed"
              :terminals="terminals"
              @created="refreshTerminals"
              @deleted="refreshTerminals"
            />
          </div>
        </div>
      </div>
    </a-layout-content>
  </a-layout>

  <a-modal
    v-model:open="checkoutOpen"
    :title="t('workspace.checkout.modalTitle')"
    :maskClosable="false"
    :confirm-loading="checkoutLoading"
    :ok-button-props="{ disabled: !canCheckout }"
    :okText="t('workspace.checkout.ok')"
    :cancelText="t('workspace.checkout.cancel')"
    @ok="submitCheckout"
  >
    <a-form layout="vertical">
      <a-form-item :label="t('workspace.checkout.targetBranch')" required>
        <a-select
          v-if="workspace"
          v-model:value="checkoutBranch"
          show-search
          :loading="branchesLoading"
          :disabled="gitBusy"
          :options="branchOptions"
          :placeholder="t('workspace.checkout.branchPlaceholder')"
        />
        <div class="pt-2">
          <a-button
            size="small"
            type="link"
            class="!text-xs"
            :disabled="gitBusy || !workspace"
            :loading="refreshBranchesLoading"
            @click="refreshBranchesWithSync"
          >
            {{ t("workspace.checkout.refreshBranches") }}
          </a-button>
        </div>
      </a-form-item>
      <div class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("workspace.checkout.tip") }}
      </div>
    </a-form>
  </a-modal>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { CodeOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import type { RepoBranchesResponse, TerminalRecord, WorkspaceDetail } from "@agent-workbench/shared";
import {
  ApiError,
  checkoutWorkspace,
  getRepo,
  getWorkspace,
  listTerminals,
  pullWorkspace,
  pushWorkspace,
  repoBranches,
  syncRepo
} from "../services/api";
import { waitRepoReadyOrThrow } from "../services/repoSync";
import CodeReviewPanel from "../sections/CodeReviewPanel.vue";
import TerminalTabs from "../sections/TerminalTabs.vue";

const props = defineProps<{ workspaceId: string }>();
const { t } = useI18n();

type LayoutMode = "vertical" | "horizontal";

const loading = ref(false);
const workspace = ref<WorkspaceDetail | null>(null);
const terminals = ref<TerminalRecord[]>([]);

const TERMINAL_COLLAPSED_KEY_PREFIX = "agent-workbench.workspace.terminalCollapsed";
function terminalCollapsedStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return TERMINAL_COLLAPSED_KEY_PREFIX;
  return `${TERMINAL_COLLAPSED_KEY_PREFIX}.${id}`;
}
function loadTerminalCollapsed(workspaceId: string) {
  try {
    const raw = localStorage.getItem(terminalCollapsedStorageKey(workspaceId));
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
  } catch {
    // ignore
  }
  return false;
}

const TERMINAL_LAYOUT_MODE_KEY_PREFIX = "agent-workbench.workspace.terminalLayoutMode";
function layoutModeStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return TERMINAL_LAYOUT_MODE_KEY_PREFIX;
  return `${TERMINAL_LAYOUT_MODE_KEY_PREFIX}.${id}`;
}
function loadLayoutMode(workspaceId: string): LayoutMode {
  try {
    const raw = localStorage.getItem(layoutModeStorageKey(workspaceId));
    if (raw === "horizontal" || raw === "vertical") return raw;
  } catch {
    // ignore
  }
  return "vertical";
}

const layoutMode = ref<LayoutMode>(loadLayoutMode(props.workspaceId));
const terminalCollapsed = ref<boolean>(loadTerminalCollapsed(props.workspaceId));

const reviewRef = ref<any>(null);
const containerEl = ref<HTMLElement | null>(null);

const TERMINAL_SPLIT_RATIO_KEY_PREFIX = "agent-workbench.workspace.terminalSplitRatio";
const DEFAULT_TERMINAL_SPLIT_RATIO = 1 / 3;
const SPLITTER_PX = 6;
const MIN_TERMINAL_RATIO = 0.15;
const MAX_TERMINAL_RATIO = 0.65;
const MIN_TERMINAL_PX = 120;
const MIN_REVIEW_PX = 240;

function terminalSplitRatioStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return TERMINAL_SPLIT_RATIO_KEY_PREFIX;
  return `${TERMINAL_SPLIT_RATIO_KEY_PREFIX}.${id}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function clampSplitRatioByContainer(params: { ratio: number; containerSize: number }) {
  const { containerSize } = params;
  if (!Number.isFinite(containerSize) || containerSize <= 0) return clamp(params.ratio, MIN_TERMINAL_RATIO, MAX_TERMINAL_RATIO);

  const minByPx = MIN_TERMINAL_PX / containerSize;
  const maxByPx = 1 - MIN_REVIEW_PX / containerSize;

  const min = Math.max(MIN_TERMINAL_RATIO, minByPx);
  const max = Math.min(MAX_TERMINAL_RATIO, maxByPx);
  if (min >= max) return clamp(params.ratio, MIN_TERMINAL_RATIO, MAX_TERMINAL_RATIO);
  return clamp(params.ratio, min, max);
}

function loadSplitRatio(workspaceId: string) {
  try {
    const raw = localStorage.getItem(terminalSplitRatioStorageKey(workspaceId));
    if (!raw) return DEFAULT_TERMINAL_SPLIT_RATIO;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_TERMINAL_SPLIT_RATIO;
    return clamp(n, MIN_TERMINAL_RATIO, MAX_TERMINAL_RATIO);
  } catch {
    return DEFAULT_TERMINAL_SPLIT_RATIO;
  }
}

const terminalSplitRatio = ref<number>(loadSplitRatio(props.workspaceId));

watch(
  () => props.workspaceId,
  (workspaceId) => {
    layoutMode.value = loadLayoutMode(workspaceId);
    terminalSplitRatio.value = loadSplitRatio(workspaceId);
    terminalCollapsed.value = loadTerminalCollapsed(workspaceId);
  }
);

watch(
  () => layoutMode.value,
  () => {
    try {
      localStorage.setItem(layoutModeStorageKey(props.workspaceId), layoutMode.value);
    } catch {
      // ignore
    }
  }
);

watch(
  () => terminalCollapsed.value,
  () => {
    try {
      localStorage.setItem(terminalCollapsedStorageKey(props.workspaceId), terminalCollapsed.value ? "1" : "0");
    } catch {
      // ignore
    }
  }
);

const gitBusyCount = ref(0);
const gitBusy = computed(() => gitBusyCount.value > 0);
function beginGitOp() {
  gitBusyCount.value += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gitBusyCount.value = Math.max(0, gitBusyCount.value - 1);
  };
}

const changesSummary = ref<{ unstaged: number; staged: number }>({ unstaged: 0, staged: 0 });
function onChangesSummary(summary: { unstaged: number; staged: number }) {
  changesSummary.value = summary;
}

const branchesLoading = ref(false);
const refreshBranchesLoading = ref(false);
const branches = ref<RepoBranchesResponse["branches"]>([]);
const branchOptions = computed(() => branches.value.map((b) => ({ label: b.name, value: b.name })));

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

const repoDisplayName = computed(() => (workspace.value ? formatRepoDisplayName(workspace.value.repo.url) : ""));

function buildPageTitle(ws: WorkspaceDetail | null) {
  const base = t("app.title");
  if (!ws) return `${t("workspace.title")} - ${base}`;

  const repoName = formatRepoDisplayName(ws.repo.url);
  const branch = String(ws.checkout.branch || "").trim();
  if (repoName && branch) return `${repoName}@${branch} - ${base}`;
  if (repoName) return `${repoName} - ${base}`;
  if (branch) return `${branch} - ${base}`;
  return `${t("workspace.title")} - ${base}`;
}

function applyPageTitle() {
  document.title = buildPageTitle(workspace.value);
}

const pushLoading = ref(false);
const pullLoading = ref(false);

const checkoutOpen = ref(false);
const checkoutLoading = ref(false);
const checkoutBranch = ref<string>("");
const canCheckout = computed(() => {
  if (!workspace.value) return false;
  if (gitBusy.value) return false;
  const next = checkoutBranch.value.trim();
  if (!next) return false;
  return next !== workspace.value.checkout.branch;
});

const hasTerminals = computed(() => terminals.value.length > 0);
const showTerminalPanel = computed(() => hasTerminals.value && !terminalCollapsed.value);

const containerStyle = computed(() => {
  if (layoutMode.value === "horizontal") {
    return {
      gridTemplateColumns: showTerminalPanel.value ? `${1 - terminalSplitRatio.value}fr ${terminalSplitRatio.value}fr` : "1fr auto",
      minHeight: 0,
      height: "100%"
    } as const;
  }
  return {
    gridTemplateRows: showTerminalPanel.value ? `${1 - terminalSplitRatio.value}fr ${terminalSplitRatio.value}fr` : "1fr auto",
    minHeight: 0,
    height: "100%"
  } as const;
});

const reviewStyle = computed(() => ({ minHeight: 0, overflow: "hidden", padding: "0" }) as const);
const reviewContainerClass = computed(() => {
  const base = "min-h-0 overflow-hidden bg-[var(--panel-bg)]";
  return layoutMode.value === "horizontal"
    ? `${base} border-r border-[var(--border-color-secondary)]`
    : `${base} border-b border-[var(--border-color-secondary)]`;
});

const terminalContainerClass = computed(() => "min-h-0 overflow-visible bg-[var(--panel-bg)] relative");

const splitterStyle = computed(() => {
  if (!showTerminalPanel.value) return {};
  const offset = `${-(SPLITTER_PX / 2)}px`;
  return layoutMode.value === "horizontal"
    ? ({
        position: "absolute",
        left: offset,
        top: "0",
        width: `${SPLITTER_PX}px`,
        height: "100%",
        zIndex: 10,
        touchAction: "none"
      } as const)
    : ({
        position: "absolute",
        top: offset,
        left: "0",
        width: "100%",
        height: `${SPLITTER_PX}px`,
        zIndex: 10,
        touchAction: "none"
      } as const);
});

const splitterClass = computed(() => {
  const base =
    "bg-transparent hover:bg-[var(--border-color-secondary)] active:bg-[var(--border-color)] transition-colors duration-100 select-none";
  return layoutMode.value === "horizontal"
    ? `${base} cursor-col-resize`
    : `${base} cursor-row-resize`;
});

function persistSplitRatio() {
  try {
    localStorage.setItem(terminalSplitRatioStorageKey(props.workspaceId), String(terminalSplitRatio.value));
  } catch {
    // ignore
  }
}

watch(
  () => terminalSplitRatio.value,
  () => {
    persistSplitRatio();
  }
);

let draggingCleanup: (() => void) | null = null;
function onSplitterPointerDown(evt: PointerEvent) {
  if (!showTerminalPanel.value) return;
  const el = containerEl.value;
  if (!el) return;

  evt.preventDefault();
  evt.stopPropagation();

  const rect = el.getBoundingClientRect();
  const containerSize = layoutMode.value === "horizontal" ? rect.width : rect.height;
  if (!Number.isFinite(containerSize) || containerSize <= 0) return;

  const prevUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";

  const handleMove = (e: PointerEvent) => {
    const nextRaw =
      layoutMode.value === "horizontal"
        ? (rect.right - e.clientX) / rect.width
        : (rect.bottom - e.clientY) / rect.height;

    const next = clampSplitRatioByContainer({ ratio: nextRaw, containerSize });
    terminalSplitRatio.value = next;
  };

  const handleUp = () => {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    document.body.style.userSelect = prevUserSelect;
    draggingCleanup = null;
  };

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp);
  draggingCleanup = handleUp;
}

async function refreshWorkspace() {
  workspace.value = await getWorkspace(props.workspaceId);
  applyPageTitle();
}

async function refreshTerminals() {
  terminals.value = await listTerminals(props.workspaceId);
}

async function refreshBranches() {
  const ws = workspace.value;
  if (!ws) return;
  branchesLoading.value = true;
  try {
    const res = await repoBranches(ws.repo.id);
    branches.value = res.branches;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    branchesLoading.value = false;
  }
}

function pickCheckoutBranch(params: { branches: RepoBranchesResponse["branches"]; defaultBranch: string | null }) {
  const existing = checkoutBranch.value.trim();
  if (existing && params.branches.some((b) => b.name === existing)) return existing;

  const currentBranch = workspace.value?.checkout.branch;
  if (currentBranch && params.branches.some((b) => b.name === currentBranch)) return currentBranch;

  if (params.defaultBranch && params.branches.some((b) => b.name === params.defaultBranch)) return params.defaultBranch;
  return params.branches[0]?.name ?? "";
}

async function refreshBranchesWithSync() {
  const ws = workspace.value;
  if (!ws) return;
  if (gitBusy.value) return;
  if (refreshBranchesLoading.value) return;

  refreshBranchesLoading.value = true;
  try {
    await syncRepo(ws.repo.id);
    await waitRepoReadyOrThrow(ws.repo.id, { t });
    const res = await repoBranches(ws.repo.id);
    branches.value = res.branches;
    checkoutBranch.value = pickCheckoutBranch({ branches: res.branches, defaultBranch: res.defaultBranch });
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    refreshBranchesLoading.value = false;
  }
}

async function refresh() {
  if (!props.workspaceId) return;
  loading.value = true;
  try {
    await Promise.all([refreshWorkspace(), refreshTerminals()]);
    await refreshBranches();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

async function openCheckout() {
  if (!workspace.value) return;
  if (gitBusy.value) return;
  checkoutBranch.value = workspace.value.checkout.branch;
  checkoutOpen.value = true;
  await refreshBranches();
}

async function submitCheckout() {
  if (!workspace.value) return;
  if (!canCheckout.value) return;
  const nextBranch = checkoutBranch.value.trim();

  const hasChanges = changesSummary.value.unstaged + changesSummary.value.staged > 0;
  if (hasChanges) {
    Modal.confirm({
      title: t("workspace.checkout.confirmTitle"),
      content: t("workspace.checkout.confirmContent"),
      okText: t("workspace.checkout.ok"),
      cancelText: t("workspace.checkout.cancel"),
      onOk: async () => {
        await doCheckout(nextBranch);
      }
    });
    return;
  }
  await doCheckout(nextBranch);
}

async function doCheckout(nextBranch: string) {
  if (!workspace.value) return;
  const release = beginGitOp();
  checkoutLoading.value = true;
  try {
    await checkoutWorkspace(props.workspaceId, { branch: nextBranch });
    await refreshWorkspace();
    await refreshBranches();
    await reviewRef.value?.refreshAll?.();
    message.success(t("workspace.checkout.switchedTo", { branch: nextBranch }));
    checkoutOpen.value = false;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    release();
    checkoutLoading.value = false;
  }
}

async function pullWithUi() {
  if (!workspace.value) return;
  if (gitBusy.value) return;

  const hasChanges = changesSummary.value.unstaged + changesSummary.value.staged > 0;
  if (hasChanges) {
    Modal.confirm({
      title: t("workspace.pull.confirmTitle"),
      content: t("workspace.pull.confirmContent"),
      okText: t("workspace.pull.okContinue"),
      cancelText: t("workspace.pull.cancel"),
      onOk: async () => {
        await doPull();
      }
    });
    return;
  }
  await doPull();
}

async function doPull() {
  const release = beginGitOp();
  pullLoading.value = true;
  try {
    const res = await pullWorkspace(props.workspaceId, {});
    if (res.updated) message.success(t("workspace.pull.updated"));
    else message.success(t("workspace.pull.upToDate"));
    await reviewRef.value?.refreshAll?.();
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError({ message: err instanceof Error ? err.message : String(err) });
    message.error(e.message);
  } finally {
    release();
    pullLoading.value = false;
  }
}

async function pushWithUi(params: Parameters<typeof pushWorkspace>[1] = {}) {
  if (!workspace.value) return;
  if (gitBusy.value) return;

  const release = beginGitOp();
  pushLoading.value = true;
  try {
    const res = await pushWorkspace(props.workspaceId, params);
    message.success(t("workspace.push.pushedTo", { remote: res.remote, branch: res.branch }));
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError({ message: err instanceof Error ? err.message : String(err) });
    if (e.code === "GIT_NO_UPSTREAM" && !params.setUpstream) {
      Modal.confirm({
        title: t("workspace.push.noUpstreamTitle"),
        content: t("workspace.push.noUpstreamContent"),
        okText: t("workspace.push.okSetUpstreamAndPush"),
        cancelText: t("workspace.push.cancel"),
        onOk: async () => {
          await pushWithUi({ ...params, setUpstream: true });
        }
      });
      return;
    }
    if (e.code === "GIT_NON_FAST_FORWARD" && !params.forceWithLease) {
      Modal.confirm({
        title: t("workspace.push.nonFastForwardTitle"),
        content: t("workspace.push.nonFastForwardContent"),
        okText: t("workspace.push.okForceWithLease"),
        cancelText: t("workspace.push.cancel"),
        onOk: async () => {
          await pushWithUi({ ...params, forceWithLease: true });
        }
      });
      return;
    }
    message.error(e.message);
  } finally {
    release();
    pushLoading.value = false;
  }
}

watch(
  () => workspace.value?.repo.id,
  async () => {
    branches.value = [];
    if (workspace.value) await refreshBranches();
  }
);

onMounted(() => {
  applyPageTitle();
  void refresh();
});

onBeforeUnmount(() => {
  document.title = t("app.title");
  draggingCleanup?.();
});
</script>
