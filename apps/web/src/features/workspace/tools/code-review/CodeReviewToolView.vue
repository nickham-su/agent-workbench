<template>
  <div ref="containerEl" class="code-review-tool" :class="{ 'review-wide': wide && repos.length > 0 }" :style="{ '--review-repo-width': `${repoWidth}px` }">
    <div v-if="!wide || !repos.length" class="review-tool-heading">{{ t("codeReview.repositories.title") }}</div>
    <div v-if="repos.length" class="review-body">
      <div v-if="wide" class="review-tool-heading">{{ t("codeReview.repositories.title") }}</div>
      <section class="review-repositories" :aria-label="t('codeReview.repositories.select')" @scroll="closeMenu()">
        <div
          v-for="(repo, index) in repos"
          :key="repo.repo.id"
          class="review-repository w-full text-left pl-3 pr-1 py-1.5"
          :class="[
            { selected: repo.dirName === selectedRepoDirName },
            repo.dirName === selectedRepoDirName ? 'bg-[color-mix(in_srgb,var(--info-color)_20%,var(--panel-bg))] border-l-2 border-l-[var(--info-color)]' : 'hover:bg-[var(--hover-bg)] border-l-2 border-l-transparent'
          ]"
          :data-repo="repo.dirName"
        >
          <button
            type="button"
            class="review-repo-select"
            :aria-pressed="repo.dirName === selectedRepoDirName"
            @click="selectRepo?.(repo.dirName)"
          >
            <span class="review-repo-name">
              <span class="review-repo-name-text" :title="repo.dirName">{{ repo.dirName }}</span>
              <span v-if="statusFor(repo)?.hasChanges" class="review-repo-dot" role="img" :aria-label="t('codeReview.repositories.hasChanges')" />
            </span>
          </button>
          <button
            type="button"
            class="review-repo-branch"
            :title="branchLabel(repo)"
            :aria-label="t('codeReview.repositories.switchBranch', { repo: repo.dirName, branch: branchLabel(repo) })"
            aria-haspopup="dialog"
            :disabled="gitBusy || !checkout"
            @click="onRepoAction(repo, { key: 'checkout' }, false)"
          >{{ branchLabel(repo) }}</button>
          <a-dropdown
            :trigger="['click']"
            :open="menuRepoDirName === repo.dirName"
            :getPopupContainer="popupContainer"
            :destroyPopupOnHide="true"
            @openChange="(open: boolean) => setMenuOpen(repo.dirName, index, open)"
          >
            <button
              type="button"
              class="review-repo-more"
              :data-repo-menu="repo.dirName"
              :aria-label="t('codeReview.repositories.actions', { repo: repo.dirName })"
              aria-haspopup="menu"
              :aria-expanded="menuRepoDirName === repo.dirName"
              :aria-controls="menuRepoDirName === repo.dirName ? menuId(index) : undefined"
              :disabled="gitBusy"
              @click="rememberMenuTrigger"
              @keydown.down.prevent="openMenuFromKeyboard(repo.dirName, index, $event)"
              @keydown.esc.stop.prevent="closeMenu(true)"
            ><EllipsisOutlined /></button>
            <template #overlay>
              <a-menu :id="menuId(index)" :selectable="false" :tabindex="0" @click="onRepoAction(repo, $event)" @keydown="onMenuKeydown" @keydown.esc.stop.prevent="closeMenu(true)" @keydown.tab="closeMenu()">
                <a-menu-item key="checkout" :disabled="gitBusy || !checkout">{{ t("workspace.actions.checkout") }}</a-menu-item>
                <a-menu-item key="pull" :disabled="gitBusy || !pull">{{ t("workspace.actions.pull") }}</a-menu-item>
                <a-menu-item key="push" :disabled="gitBusy || !push">{{ t("workspace.actions.push") }}</a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
        </div>
      </section>
      <div
        v-if="wide"
        class="review-repo-divider"
        :class="{ dragging: draggingRepoWidth !== null }"
        role="separator"
        tabindex="0"
        :aria-label="t('codeReview.repositories.resize')"
        aria-orientation="vertical"
        :aria-valuemin="MIN_COLUMN_WIDTH"
        :aria-valuemax="maxRepoWidth"
        :aria-valuenow="repoWidth"
        @pointerdown="startRepoResize"
        @lostpointercapture="cancelRepoResize"
        @keydown="onRepoResizeKeydown"
      />
      <div class="review-changes-region">
        <CodeReviewPanel
          v-if="target"
          ref="panelRef"
          :workspaceId="workspaceId"
          :toolId="toolId"
          :target="target"
          :gitBusy="gitBusy"
          :beginGitOp="beginGitOp"
          :push="push"
          :refreshStatus="refreshStatus"
          @changesSummary="(s) => emit('changesSummary', s)"
        />
        <div v-else class="review-empty">{{ t("codeReview.placeholder.selectRepo") }}</div>
      </div>
    </div>
    <div v-else class="review-empty">{{ t("codeReview.placeholder.noRepos") }}</div>
  </div>
</template>

<script lang="ts">
export default { name: "codeReview" };
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, ref, useId, watch } from "vue";
import { message } from "ant-design-vue";
import { EllipsisOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import type { GitPushRequest, GitTarget, WorkspaceDetail, WorkspaceGitStatusResponse } from "@agent-workbench/shared";
import CodeReviewPanel from "./CodeReviewPanel.vue";
import { useWorkspaceHost } from "@/features/workspace/host";

const props = withDefaults(defineProps<{
  workspaceId: string;
  target: GitTarget | null;
  toolId: string;
  gitBusy: boolean;
  beginGitOp: () => () => void;
  push?: (target: GitTarget, params?: Omit<GitPushRequest, "target">) => Promise<void>;
  refreshStatus?: () => Promise<void>;
  repos?: WorkspaceDetail["repos"];
  repoStatuses?: WorkspaceGitStatusResponse["repos"];
  selectedRepoDirName?: string;
  selectRepo?: (dirName: string) => void;
  checkout?: (target: GitTarget) => Promise<void>;
  pull?: (target: GitTarget) => Promise<void>;
}>(), { repos: () => [], repoStatuses: () => [], selectedRepoDirName: "" });

const emit = defineEmits<{
  changesSummary: [summary: { unstaged: number; staged: number }];
}>();

const host = useWorkspaceHost(props.toolId);
const { t } = useI18n();
const panelRef = ref<InstanceType<typeof CodeReviewPanel> | null>(null);
const containerEl = ref<HTMLElement | null>(null);
const wide = ref(false);
const DEFAULT_REPO_WIDTH = 264;
const MIN_COLUMN_WIDTH = 200;
const toolWidth = ref(0);
const preferredRepoWidth = ref(readRepoWidth(props.workspaceId));
const draggingRepoWidth = ref<number | null>(null);
const maxRepoWidth = computed(() => Math.max(MIN_COLUMN_WIDTH, Math.floor(toolWidth.value) - MIN_COLUMN_WIDTH));
const repoWidth = computed(() => clampRepoWidth(draggingRepoWidth.value ?? preferredRepoWidth.value));
let repoDrag: {
  pointerId: number;
  startX: number;
  startWidth: number;
  element: HTMLElement;
  userSelect: string;
  cursor: string;
} | null = null;

function repoWidthStorageKey(workspaceId: string) {
  return `agent-workbench.workspace.codeReview.repoWidth.v1.${workspaceId}`;
}

function readRepoWidth(workspaceId: string) {
  try {
    const raw = localStorage.getItem(repoWidthStorageKey(workspaceId));
    const width = raw?.trim() ? Number(raw) : NaN;
    if (Number.isFinite(width) && width >= MIN_COLUMN_WIDTH) return width;
  } catch { /* Storage is optional; keep the default when unavailable. */ }
  return DEFAULT_REPO_WIDTH;
}

function saveRepoWidth() {
  try {
    localStorage.setItem(repoWidthStorageKey(props.workspaceId), String(preferredRepoWidth.value));
  } catch { /* A denied/full cache must not block resizing. */ }
}

function clampRepoWidth(width: number) {
  return Math.min(maxRepoWidth.value, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

function updateToolWidth(width: number) {
  toolWidth.value = Number.isFinite(width) ? Math.max(0, width) : 0;
  wide.value = toolWidth.value >= 480;
  if (!wide.value) cancelRepoResize();
}

function startRepoResize(event: PointerEvent) {
  if (!wide.value || repoDrag || event.button !== 0 || event.isPrimary === false) return;
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
  const element = event.currentTarget as HTMLElement;
  repoDrag = {
    pointerId: event.pointerId, startX: event.clientX, startWidth: repoWidth.value, element,
    userSelect: document.body.style.userSelect, cursor: document.body.style.cursor
  };
  draggingRepoWidth.value = repoWidth.value;
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
  window.addEventListener("pointermove", moveRepoResize);
  window.addEventListener("pointerup", commitRepoResize);
  window.addEventListener("pointercancel", cancelRepoResize);
  window.addEventListener("blur", cancelRepoResize);
  try { element.setPointerCapture(event.pointerId); } catch { /* Window listeners cover missing capture support. */ }
}

function moveRepoResize(event: PointerEvent) {
  if (!repoDrag || event.pointerId !== repoDrag.pointerId) return;
  event.preventDefault();
  draggingRepoWidth.value = clampRepoWidth(repoDrag.startWidth + event.clientX - repoDrag.startX);
}

function commitRepoResize(event: PointerEvent) {
  if (repoDrag && event.pointerId === repoDrag.pointerId) finishRepoResize(true);
}

function cancelRepoResize(event?: Event) {
  if (event && "pointerId" in event && event.pointerId !== repoDrag?.pointerId) return;
  finishRepoResize(false);
}

function finishRepoResize(commit: boolean) {
  const drag = repoDrag;
  if (!drag) return;
  // Clear first: releasing capture may synchronously dispatch lostpointercapture.
  repoDrag = null;
  const width = draggingRepoWidth.value;
  draggingRepoWidth.value = null;
  window.removeEventListener("pointermove", moveRepoResize);
  window.removeEventListener("pointerup", commitRepoResize);
  window.removeEventListener("pointercancel", cancelRepoResize);
  window.removeEventListener("blur", cancelRepoResize);
  document.body.style.userSelect = drag.userSelect;
  document.body.style.cursor = drag.cursor;
  try {
    if (drag.element.hasPointerCapture?.(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
  } catch { /* The browser may already have released capture. */ }
  // A click or cancellation must not persist a width only clamped by the container.
  if (commit && width !== null && width !== drag.startWidth) {
    preferredRepoWidth.value = width;
    saveRepoWidth();
  }
}

function onRepoResizeKeydown(event: KeyboardEvent) {
  if (!wide.value || repoDrag || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const next = clampRepoWidth(repoWidth.value + (event.key === "ArrowRight" ? 10 : -10));
  if (next === repoWidth.value) return;
  preferredRepoWidth.value = next;
  saveRepoWidth();
}

watch(() => props.workspaceId, (workspaceId) => {
  cancelRepoResize();
  preferredRepoWidth.value = readRepoWidth(workspaceId);
});
watch(() => props.repos.length, (count) => { if (!count) cancelRepoResize(); });
const menuRepoDirName = ref<string | null>(null);
const popupContainer = () => document.body;
const menuPrefix = `review-repo-menu-${useId()}`;
const menuId = (index: number) => `${menuPrefix}-${index}`;
let menuTrigger: HTMLElement | null = null;
let resizeObserver: ResizeObserver | null = null;
let unregister: (() => void) | null = null;
const statuses = computed(() => new Map(props.repoStatuses.map((status) => [status.dirName, status])));
type Repo = WorkspaceDetail["repos"][number];

function statusFor(repo: Repo) {
  const status = statuses.value.get(repo.dirName);
  return status?.repoId === repo.repo.id ? status : undefined;
}

function branchLabel(repo: Repo) {
  const head = statusFor(repo)?.head;
  if (!head) return "—";
  if (head.detached) return head.sha ? `${t("workspace.repoSelector.detached")} · ${head.sha.slice(0, 7)}` : t("workspace.repoSelector.detached");
  return head.branch || "—";
}

function rememberMenuTrigger(event: Event) {
  menuTrigger = event.currentTarget as HTMLElement;
}

function setMenuOpen(dirName: string, index: number, open: boolean) {
  menuRepoDirName.value = open ? dirName : menuRepoDirName.value === dirName ? null : menuRepoDirName.value;
  if (open) {
    void nextTick(() => {
      if (menuRepoDirName.value !== dirName) return;
      const menu = document.getElementById(menuId(index));
      const first = menu?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
      (first ?? menu)?.focus();
    });
  }
}

function openMenuFromKeyboard(dirName: string, index: number, event: Event) {
  rememberMenuTrigger(event);
  setMenuOpen(dirName, index, true);
}

function closeMenu(restoreFocus = false) {
  menuRepoDirName.value = null;
  if (restoreFocus && menuTrigger?.isConnected) menuTrigger.focus();
}

// Ant Menu handles Enter, but its flat dropdown does not move focus on arrows.
function onMenuKeydown(event: KeyboardEvent) {
  const menu = event.currentTarget as HTMLElement;
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'));
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (event.key === "ArrowDown") next = (current + 1) % items.length;
  else if (event.key === "ArrowUp") next = current <= 0 ? items.length - 1 : current - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (event.key === " " && current >= 0) {
    event.preventDefault();
    items[current]?.click();
    return;
  } else return;
  event.preventDefault();
  items[next]?.focus();
}

function onRepoAction(repo: Repo, info: { key?: string | number }, restoreMenuFocus = true) {
  const action = info.key === "checkout" ? props.checkout : info.key === "pull" ? props.pull : info.key === "push" ? props.push : undefined;
  closeMenu(restoreMenuFocus);
  if (props.gitBusy || !action) return;
  const target: GitTarget = { kind: "workspaceRepo", workspaceId: props.workspaceId, dirName: repo.dirName };
  void action(target).catch((error: unknown) => message.error(error instanceof Error ? error.message : String(error)));
}

function refresh() {
  return panelRef.value?.refreshAll();
}

onMounted(() => {
  unregister = host.registerToolCommands(props.toolId, { refresh });
  if (containerEl.value) {
    updateToolWidth(containerEl.value.getBoundingClientRect().width);
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries.find((item) => item.target === containerEl.value);
      if (entry) updateToolWidth(entry.contentRect.width);
    });
    resizeObserver.observe(containerEl.value);
  }
});

onDeactivated(() => { closeMenu(); cancelRepoResize(); });
onBeforeUnmount(() => {
  closeMenu();
  cancelRepoResize();
  resizeObserver?.disconnect();
  unregister?.();
});
</script>

<style scoped>
/* Match the change heading: 24px small buttons + 12px vertical padding + 1px border. */
.code-review-tool { height: 100%; min-width: 0; min-height: 0; display: grid; grid-template-rows: 37px minmax(0, 1fr); overflow: hidden; background: var(--panel-bg); }
.review-tool-heading { display: flex; align-items: center; box-sizing: border-box; padding: 0 12px; border-bottom: 1px solid var(--border-color-secondary); background: var(--panel-bg-elevated); font-size: 12px; font-weight: 600; }
/* The definite heading-free grid track is the percentage cap's containing block. */
.review-body { position: relative; height: 100%; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.review-repositories { flex: 0 1 auto; max-height: calc(100% / 3); box-sizing: border-box; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; scrollbar-width: thin; padding: 0; border-bottom: 1px solid var(--border-color-secondary); }
/* Match file rows' spacing and 24px action controls without card gutters. */
.review-repository { display: flex; align-items: center; min-width: 0; gap: 8px; box-sizing: border-box; }
.review-repo-select, .review-repo-branch, .review-repo-more { border: 0; background: transparent; color: var(--text-color); font: inherit; cursor: pointer; }
.review-repo-select { flex: 1; display: flex; align-items: center; min-width: 0; height: 24px; padding: 0; text-align: left; font-size: 12px; }
.review-repo-name { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.review-repo-name-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-repo-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--danger-color); }
.review-repo-branch { flex: 0 1 auto; height: 24px; padding: 0; min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: var(--text-secondary); font: 11px ui-monospace, monospace; }
.review-repo-branch:hover:not(:disabled) { color: var(--text-color); text-decoration: underline; text-underline-offset: 2px; }
.review-repo-more { flex: none; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border-radius: 3px; }
.review-repo-more:hover { background: var(--hover-bg); }
.review-repo-branch:disabled, .review-repo-more:disabled { cursor: not-allowed; opacity: .4; }
.review-repo-select:focus-visible, .review-repo-branch:focus-visible, .review-repo-more:focus-visible { outline: 2px solid var(--info-color); outline-offset: -2px; }
.review-changes-region { flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.review-empty { display: flex; align-items: center; justify-content: center; min-height: 0; padding: 16px; color: var(--text-tertiary); font-size: 12px; }
/* Only the repository column owns a heading in side-by-side mode. */
.code-review-tool.review-wide { grid-template-rows: minmax(0, 1fr); }
.review-wide .review-body { display: grid; grid-template-columns: var(--review-repo-width, 264px) minmax(0, 1fr); grid-template-rows: 37px minmax(0, 1fr); }
.review-wide .review-tool-heading { grid-column: 1; grid-row: 1; border-right: 1px solid var(--border-color-secondary); }
.review-wide .review-repositories { grid-column: 1; grid-row: 2; max-height: none; border-bottom: 0; border-right: 1px solid var(--border-color-secondary); }
.review-wide .review-changes-region { grid-column: 2; grid-row: 1 / 3; }
.review-repo-divider { position: absolute; z-index: 10; left: calc(var(--review-repo-width, 264px) - 3px); top: 0; bottom: 0; width: 6px; cursor: col-resize; touch-action: none; }
.review-repo-divider:hover, .review-repo-divider.dragging { background: var(--info-color); opacity: .45; }
.review-repo-divider:focus-visible { outline: 2px solid var(--info-color); outline-offset: -2px; }
.review-repo-divider.dragging { opacity: .65; }
</style>
