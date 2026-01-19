<template>
  <div ref="containerEl" class="h-full min-h-0 grid gap-0" :style="containerStyle">
    <div class="min-h-0 min-w-0 flex flex-col border-r border-[var(--border-color-secondary)]">
      <div class="flex-1 min-h-0 flex flex-col">
        <div
            class="flex items-center justify-between pl-3 pr-1 py-1.5 border-b border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
          <div class="text-xs font-semibold">{{ t("codeReview.unstaged") }}</div>
          <div class="flex items-center gap-1">
            <a-tooltip :title="t('codeReview.actions.refresh')" :mouseEnterDelay="0" :mouseLeaveDelay="0"
                       placement="top">
              <span class="inline-flex">
                <a-button size="small" type="text" :disabled="gitBusy" @click="refreshAll"
                          :aria-label="t('codeReview.actions.refresh')">
                  <template #icon><ReloadOutlined/></template>
                </a-button>
              </span>
            </a-tooltip>
            <a-tooltip :title="t('codeReview.actions.stageAll')" :mouseEnterDelay="0" :mouseLeaveDelay="0"
                       placement="top">
              <span class="inline-flex">
                <a-button
                    size="small"
                    type="text"
                    :disabled="gitBusy || unstagedFiles.length === 0"
                    @click="stageAll"
                    :aria-label="t('codeReview.actions.stageAll')"
                >
                  <template #icon><PlusOutlined/></template>
                </a-button>
              </span>
            </a-tooltip>
            <a-tooltip :title="t('codeReview.actions.discardAll')" :mouseEnterDelay="0" :mouseLeaveDelay="0"
                       placement="top">
              <span class="inline-flex">
                <a-button
                    size="small"
                    type="text"
                    :disabled="gitBusy || unstagedFiles.length === 0"
                    @click="discardAll"
                    :aria-label="t('codeReview.actions.discardAll')"
                >
                  <template #icon><RollbackOutlined/></template>
                </a-button>
              </span>
            </a-tooltip>
          </div>
        </div>
        <div class="flex-1 min-h-0 overflow-auto">
          <div v-if="unstagedLoaded && unstagedFiles.length === 0"
               class="p-3 text-xs text-[color:var(--text-tertiary)]">
            {{ t("codeReview.status.noChanges") }}
          </div>
          <div
              v-for="f in unstagedFiles"
              :key="`u:${f.path}`"
              class="group w-full text-left pl-3 pr-1 py-1.5 hover:bg-[var(--hover-bg)] cursor-pointer"
              :class="isSelected('unstaged', f.path) ? 'bg-[var(--fill-secondary)] border-l-2 border-l-[var(--info-color)]' : 'border-l-2 border-l-transparent'"
              @click="selectFile('unstaged', f.path, f.oldPath)"
          >
            <div class="flex items-center gap-2 min-w-0">
              <a-tooltip :title="f.status" :mouseEnterDelay="0" :mouseLeaveDelay="0" placement="top">
                <div
                    class="text-xs text-[color:var(--text-secondary)] shrink-0 text-center flex items-center justify-center"
                    :class="statusBadgeClass(f.status)"
                >
                  <component :is="statusIconComponent(f.status)"/>
                </div>
              </a-tooltip>
              <div class="min-w-0 flex-1">
                <div class="text-xs font-mono min-w-0 flex items-center">
                  <span class="text-[color:var(--text-secondary)] min-w-0 flex-initial truncate block">{{
                      fileDir(f.path)
                    }}</span>
                  <span class="text-[color:var(--text-color)] shrink-0 whitespace-nowrap">{{ fileBase(f.path) }}</span>
                </div>
                <div v-if="f.oldPath" class="mt-0.5 text-[11px] font-mono truncate text-[color:var(--text-tertiary)]">
                  {{ t("codeReview.file.oldPath", {oldPath: f.oldPath}) }}
                </div>
              </div>
              <div class="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100">
                <a-tooltip :title="t('codeReview.actions.stage')" :mouseEnterDelay="0" :mouseLeaveDelay="0"
                           placement="top">
                  <span class="inline-flex">
                    <a-button size="small" type="text" :disabled="gitBusy" @click.stop="stageOne(f)"
                              :aria-label="t('codeReview.actions.stage')">
                      <template #icon><PlusOutlined/></template>
                    </a-button>
                  </span>
                </a-tooltip>
                <a-tooltip :title="discardOneLabel(f)" :mouseEnterDelay="0" :mouseLeaveDelay="0" placement="top">
                  <span class="inline-flex">
                    <a-button
                        size="small"
                        type="text"
                        :disabled="gitBusy"
                        @click.stop="discardOne(f)"
                        :aria-label="discardOneLabel(f)"
                    >
                      <template #icon><RollbackOutlined/></template>
                    </a-button>
                  </span>
                </a-tooltip>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex-1 min-h-0 flex flex-col border-t border-[var(--border-color-secondary)]">
        <div
            class="flex items-center justify-between pl-3 pr-1 py-1.5 border-b border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
          <div class="text-xs font-semibold">{{ t("codeReview.staged") }}</div>
          <div class="flex items-center gap-1">
            <a-button
                size="small"
                type="text"
                :disabled="gitBusy || stagedFiles.length === 0"
                @click="openCommit"
                :title="t('codeReview.actions.commit')"
                :aria-label="t('codeReview.actions.commit')"
            >
              {{ t("codeReview.actions.commitEllipsis") }}
            </a-button>
            <a-tooltip :title="t('codeReview.actions.unstageAll')" :mouseEnterDelay="0" :mouseLeaveDelay="0"
                       placement="top">
              <span class="inline-flex">
                <a-button
                    size="small"
                    type="text"
                    :disabled="gitBusy || stagedFiles.length === 0"
                    @click="unstageAll"
                    :aria-label="t('codeReview.actions.unstageAll')"
                >
                  <template #icon><MinusOutlined/></template>
                </a-button>
              </span>
            </a-tooltip>
          </div>
        </div>
        <div class="flex-1 min-h-0 overflow-auto">
          <div v-if="stagedLoaded && stagedFiles.length === 0" class="p-3 text-xs text-[color:var(--text-tertiary)]">
            {{ t("codeReview.status.noChanges") }}
          </div>
          <div
              v-for="f in stagedFiles"
              :key="`s:${f.path}`"
              class="group w-full text-left pl-3 pr-1 py-1.5 hover:bg-[var(--hover-bg)] cursor-pointer"
              :class="isSelected('staged', f.path) ? 'bg-[var(--fill-secondary)] border-l-2 border-l-[var(--info-color)]' : 'border-l-2 border-l-transparent'"
              @click="selectFile('staged', f.path, f.oldPath)"
          >
            <div class="flex items-center gap-2 min-w-0">
              <a-tooltip :title="f.status" :mouseEnterDelay="0" :mouseLeaveDelay="0" placement="top">
                <div
                    class="text-xs text-[color:var(--text-secondary)] shrink-0 text-center flex items-center justify-center"
                    :class="statusBadgeClass(f.status)"
                >
                  <component :is="statusIconComponent(f.status)"/>
                </div>
              </a-tooltip>
              <div class="min-w-0 flex-1">
                <div class="text-xs font-mono min-w-0 flex items-center">
                  <span class="text-[color:var(--text-secondary)] min-w-0 flex-initial truncate block">{{
                      fileDir(f.path)
                    }}</span>
                  <span class="text-[color:var(--text-color)] shrink-0 whitespace-nowrap">{{ fileBase(f.path) }}</span>
                </div>
                <div v-if="f.oldPath" class="mt-0.5 text-[11px] font-mono truncate text-[color:var(--text-tertiary)]">
                  {{ t("codeReview.file.oldPath", {oldPath: f.oldPath}) }}
                </div>
              </div>
              <div class="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100">
                <a-tooltip :title="t('codeReview.actions.unstage')" :mouseEnterDelay="0" :mouseLeaveDelay="0"
                           placement="top">
                  <span class="inline-flex">
                    <a-button size="small" type="text" :disabled="gitBusy" @click.stop="unstageOne(f)"
                              :aria-label="t('codeReview.actions.unstage')">
                      <template #icon><MinusOutlined/></template>
                    </a-button>
                  </span>
                </a-tooltip>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="min-h-0 min-w-0 overflow-visible flex flex-col relative">
      <div
          :class="splitterClass"
          :style="splitterStyle"
          role="separator"
          aria-orientation="vertical"
          :aria-label="t('codeReview.diff.resizeFileList')"
          @pointerdown="onSplitterPointerDown"
      />
      <div class="h-full overflow-hidden flex flex-col">
        <div class="diff-header grid border-b border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]"
             :style="diffHeaderVars">
          <div class="px-3 py-2.5 text-xs font-semibold min-w-0 whitespace-nowrap overflow-hidden">
            <div class="flex items-center gap-2 min-w-0">
              <span class="shrink-0">{{ t("codeReview.diff.base") }}</span>
              <span v-if="compare" class="min-w-0 truncate text-[11px] font-normal text-[color:var(--text-tertiary)]">{{
                  compare.base.label
                }}</span>
            </div>
          </div>
          <div aria-hidden="true"></div>
          <div
              class="pl-3 py-2 text-xs font-semibold border-l border-[var(--border-color-secondary)] min-w-0 whitespace-nowrap overflow-hidden">
            <div class="flex items-center gap-2 min-w-0">
              <span class="shrink-0">{{ t("codeReview.diff.current") }}</span>
              <span v-if="compare" class="min-w-0 truncate text-[11px] font-normal text-[color:var(--text-tertiary)]">{{
                  compare.current.label
                }}</span>
              <div class="h-5 ml-auto flex items-center gap-0.5">
                <a-tooltip :title="t('codeReview.diff.prevChange')" :mouseEnterDelay="0" :mouseLeaveDelay="0"
                           placement="top">
                  <span class="inline-flex">
                    <a-button
                        size="small"
                        type="text"
                        :disabled="diffNavDisabled"
                        @click="goToPreviousDiff"
                        :aria-label="t('codeReview.diff.prevChange')"
                    >
                      <template #icon><UpOutlined/></template>
                    </a-button>
                  </span>
                </a-tooltip>
                <a-tooltip :title="t('codeReview.diff.nextChange')" :mouseEnterDelay="0" :mouseLeaveDelay="0"
                           placement="top">
                  <span class="inline-flex">
                    <a-button
                        size="small"
                        type="text"
                        :disabled="diffNavDisabled"
                        @click="goToNextDiff"
                        :aria-label="t('codeReview.diff.nextChange')"
                    >
                      <template #icon><DownOutlined/></template>
                    </a-button>
                  </span>
                </a-tooltip>
              </div>
            </div>
          </div>
        </div>

        <div v-if="!selected" class="p-3 text-xs text-[color:var(--text-tertiary)]">
          {{ t("codeReview.diff.selectToCompare") }}
        </div>
        <div v-else-if="compare && (!compare.base.previewable || !compare.current.previewable)"
             class="p-3 text-xs text-[color:var(--text-tertiary)]">
          <div class="font-semibold text-[color:var(--text-secondary)]">{{
              t("codeReview.diff.notPreviewableTitle")
            }}
          </div>
          <div class="mt-1">
            <span class="font-mono">{{ compare.path }}</span>
          </div>
          <div class="mt-2 text-[color:var(--text-secondary)]">
            <div v-if="!compare.base.previewable">
              {{ t("codeReview.diff.baseReason", {reason: explainSide(compare.base)}) }}
            </div>
            <div v-if="!compare.current.previewable">
              {{ t("codeReview.diff.currentReason", {reason: explainSide(compare.current)}) }}
            </div>
          </div>
        </div>
        <div v-else class="flex-1 min-h-0 relative">
          <MonacoDiffViewer
              class="h-full"
              ref="diffViewerRef"
              :original="compare?.base.content || ''"
              :modified="compare?.current.content || ''"
              :language="compare?.language"
              @layout="onDiffLayout"
          />
          <div v-if="compareLoading"
               class="absolute inset-0 p-3 text-xs text-[color:var(--text-tertiary)] bg-[var(--panel-bg)]">
            {{ t("codeReview.diff.loading") }}
          </div>
          <div v-else-if="compareError"
               class="absolute inset-0 p-3 text-xs text-[color:var(--danger-color)] bg-[var(--panel-bg)]">
            {{ compareError }}
          </div>
        </div>
      </div>
    </div>
  </div>

  <a-modal v-model:open="commitOpen" :title="t('codeReview.commit.modalTitle')" :maskClosable="false">
    <a-form layout="vertical">
      <a-form-item :label="t('codeReview.commit.messageLabel')" required>
        <a-textarea
            v-model:value="commitMessage"
            :auto-size="{ minRows: 4, maxRows: 10 }"
            :placeholder="t('codeReview.commit.messagePlaceholder')"
            :disabled="gitBusy"
        />
      </a-form-item>
      <div class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("codeReview.commit.summary", {count: stagedFiles.length}) }}
      </div>
    </a-form>
    <template #footer>
      <a-space>
        <a-button @click="commitOpen = false" :disabled="gitBusy">{{ t("codeReview.actions.cancel") }}</a-button>
        <a-button :disabled="!canCommit" :loading="commitLoading === 'commit'" @click="submitCommit('commit')">
          {{ t("codeReview.actions.commit") }}
        </a-button>
        <a-button type="primary" :disabled="!canCommit" :loading="commitLoading === 'commitAndPush'"
                  @click="submitCommit('commitAndPush')">
          {{ t("codeReview.actions.commitAndPush") }}
        </a-button>
      </a-space>
    </template>
  </a-modal>

  <GitIdentityModal
      v-model:open="identityOpen"
      :target="target"
      :defaultScope="'repo'"
      :loading="identitySubmitting"
      @submit="onIdentitySubmit"
  />
</template>

<script setup lang="ts">
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from "vue";
import {Modal, message} from "ant-design-vue";
import {
  CopyOutlined,
  DownOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  EyeInvisibleOutlined,
  FileAddOutlined,
  FileUnknownOutlined,
  FormOutlined,
  MinusOutlined,
  PlusOutlined,
  ReloadOutlined,
  RetweetOutlined,
  RollbackOutlined,
  UpOutlined
} from "@ant-design/icons-vue";
import {useI18n} from "vue-i18n";
import type {ChangeItem, ChangeMode, FileCompareResponse, GitPushRequest, GitTarget} from "@agent-workbench/shared";
import {
  ApiError,
  commitWorkspace,
  discardWorkspace,
  fileCompare,
  listChanges,
  stageWorkspace,
  unstageWorkspace
} from "@/shared/api";
import MonacoDiffViewer from "@/shared/components/MonacoDiffViewer.vue";
import GitIdentityModal from "@/shared/components/GitIdentityModal.vue";

type Selected = { mode: ChangeMode; path: string; oldPath?: string } | null;

type PushParams = Omit<GitPushRequest, "target">;

const props = defineProps<{
  workspaceId: string;
  target: GitTarget | null;
  gitBusy: boolean;
  beginGitOp: () => () => void;
  push?: (params?: PushParams) => Promise<void>;
  pollingEnabled?: boolean;
}>();

const {t} = useI18n();

const containerEl = ref<HTMLElement | null>(null);

const FILE_LIST_SPLIT_RATIO_KEY_PREFIX = "agent-workbench.workspace.fileListSplitRatio";
const DEFAULT_FILE_LIST_SPLIT_RATIO = 0.22;
const SPLITTER_PX = 6;
const MIN_LIST_RATIO = 0.15;
const MAX_LIST_RATIO = 0.55;
const MIN_LIST_PX = 220;
const MIN_DIFF_PX = 360;

function fileListSplitRatioStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return FILE_LIST_SPLIT_RATIO_KEY_PREFIX;
  return `${FILE_LIST_SPLIT_RATIO_KEY_PREFIX}.${id}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function clampSplitRatioByContainer(params: { ratio: number; containerSize: number }) {
  const {containerSize} = params;
  if (!Number.isFinite(containerSize) || containerSize <= 0) return clamp(params.ratio, MIN_LIST_RATIO, MAX_LIST_RATIO);

  const minByPx = MIN_LIST_PX / containerSize;
  const maxByPx = 1 - MIN_DIFF_PX / containerSize;

  const min = Math.max(MIN_LIST_RATIO, minByPx);
  const max = Math.min(MAX_LIST_RATIO, maxByPx);
  if (min >= max) return clamp(params.ratio, MIN_LIST_RATIO, MAX_LIST_RATIO);
  return clamp(params.ratio, min, max);
}

function loadFileListSplitRatio(workspaceId: string) {
  try {
    const raw = localStorage.getItem(fileListSplitRatioStorageKey(workspaceId));
    if (!raw) return DEFAULT_FILE_LIST_SPLIT_RATIO;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_FILE_LIST_SPLIT_RATIO;
    return clamp(n, MIN_LIST_RATIO, MAX_LIST_RATIO);
  } catch {
    return DEFAULT_FILE_LIST_SPLIT_RATIO;
  }
}

const fileListSplitRatio = ref<number>(loadFileListSplitRatio(props.workspaceId));

watch(
    () => props.workspaceId,
    (workspaceId) => {
      fileListSplitRatio.value = loadFileListSplitRatio(workspaceId);
    }
);

watch(
    () => fileListSplitRatio.value,
    () => {
      try {
        localStorage.setItem(fileListSplitRatioStorageKey(props.workspaceId), String(fileListSplitRatio.value));
      } catch {
        // ignore
      }
    }
);

const containerStyle = computed(() => {
  return {
    gridTemplateColumns: `${fileListSplitRatio.value}fr ${(1 - fileListSplitRatio.value).toFixed(6)}fr`,
    minHeight: 0,
    height: "100%"
  } as const;
});

const splitterStyle = computed(() => {
  const offset = `${-(SPLITTER_PX / 2)}px`;
  return {
    position: "absolute",
    left: offset,
    top: "0",
    width: `${SPLITTER_PX}px`,
    height: "100%",
    zIndex: 10,
    touchAction: "none"
  } as const;
});

const splitterClass = computed(() => {
  return "bg-transparent hover:bg-[var(--border-color-secondary)] active:bg-[var(--border-color)] transition-colors duration-100 select-none cursor-col-resize";
});

let draggingCleanup: (() => void) | null = null;

function onSplitterPointerDown(evt: PointerEvent) {
  const el = containerEl.value;
  if (!el) return;

  evt.preventDefault();
  evt.stopPropagation();

  const rect = el.getBoundingClientRect();
  const containerSize = rect.width;
  if (!Number.isFinite(containerSize) || containerSize <= 0) return;

  const prevUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";

  const handleMove = (e: PointerEvent) => {
    const nextRaw = (e.clientX - rect.left) / rect.width;
    const next = clampSplitRatioByContainer({ratio: nextRaw, containerSize});
    fileListSplitRatio.value = next;
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

const emit = defineEmits<{
  changesSummary: [summary: { unstaged: number; staged: number }];
}>();

const unstagedLoading = ref(false);
const stagedLoading = ref(false);
const unstagedLoaded = ref(false);
const stagedLoaded = ref(false);
const unstaged = ref<ChangeItem[]>([]);
const staged = ref<ChangeItem[]>([]);
const selected = ref<Selected>(null);
const selectedFingerprint = ref<string | null>(null);
// 记录每个 mode 下,用户上次选中的(排序后)索引,用于刷新后回退到“原位置上的文件”
const lastSelectedIndexByMode = ref<Record<ChangeMode, number>>({unstaged: 0, staged: 0});

const compareLoading = ref(false);
const compareError = ref<string | null>(null);
const compare = ref<FileCompareResponse | null>(null);
const diffHeaderVars = ref<Record<string, string>>({});
const diffViewerRef = ref<{ goToFirstDiff: () => void; goToPreviousDiff: () => void; goToNextDiff: () => void } | null>(null);
let compareReqSeq = 0;

function comparePathText(a: string, b: string) {
  // 使用纯字符串比较,避免受 locale 影响导致不同环境下排序不一致
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function stableSort<T>(arr: readonly T[], cmp: (a: T, b: T) => number): T[] {
  return arr
    .map((v, i) => ({v, i}))
    .sort((a, b) => {
      const r = cmp(a.v, b.v);
      return r !== 0 ? r : a.i - b.i;
    })
    .map((x) => x.v);
}

function compareChangeItemForList(a: ChangeItem, b: ChangeItem) {
  const r = comparePathText(a.path, b.path);
  if (r !== 0) return r;
  return comparePathText(a.oldPath || "", b.oldPath || "");
}

// UI 层按 path 做稳定排序,避免轮询时列表顺序抖动影响“按索引回退选中”
const unstagedFiles = computed(() => stableSort(unstaged.value, compareChangeItemForList));
const stagedFiles = computed(() => stableSort(staged.value, compareChangeItemForList));

const commitOpen = ref(false);
const commitMessage = ref("");
const commitLoading = ref<"commit" | "commitAndPush" | null>(null);
const canCommit = computed(() => stagedFiles.value.length > 0 && commitMessage.value.trim().length > 0 && !props.gitBusy);

const identityOpen = ref(false);
const pendingCommitMode = ref<"commit" | "commitAndPush" | null>(null);
const identitySubmitting = ref(false);

function onDiffLayout(layout: { originalWidth: number; modifiedWidth: number; splitterWidth: number }) {
  diffHeaderVars.value = {
    "--diff-original-width": `${layout.originalWidth}px`,
    "--diff-splitter-width": `${layout.splitterWidth}px`,
    "--diff-modified-width": `${layout.modifiedWidth}px`
  };
}

const diffNavDisabled = computed(() => {
  const c = compare.value;
  if (!c) return true;
  if (compareLoading.value) return true;
  if (!c.base.previewable || !c.current.previewable) return true;
  return false;
});

function goToPreviousDiff() {
  diffViewerRef.value?.goToPreviousDiff();
}

function goToNextDiff() {
  diffViewerRef.value?.goToNextDiff();
}

function isSelected(mode: ChangeMode, path: string) {
  return selected.value?.mode === mode && selected.value.path === path;
}

function selectFile(mode: ChangeMode, path: string, oldPath?: string) {
  selected.value = {mode, path, oldPath};
  const list = mode === "unstaged" ? unstagedFiles.value : stagedFiles.value;
  const match =
      list.find((f) => f.path === path && (f.oldPath || "") === (oldPath || "")) ||
      list.find((f) => f.path === path) ||
      null;
  selectedFingerprint.value = match ? fingerprintFor(mode, match) : null;
  if (match) {
    const idx = list.indexOf(match);
    if (idx >= 0) lastSelectedIndexByMode.value[mode] = idx;
  }
}

function fileBase(p: string) {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function fileDir(p: string) {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx + 1) : "";
}

function statusBadgeClass(statusRaw: string) {
  if (statusRaw === "!!") return "text-[color:var(--text-tertiary)]";
  if (statusRaw.includes("U")) return "text-[color:var(--danger-color)]";
  const status = statusRaw === "??" ? "?" : statusRaw[0] || "";
  if (status === "D") return "text-[color:var(--danger-color)]";
  if (status === "A" || status === "?") return "text-[color:var(--success-color)]";
  if (status === "M") return "text-[color:var(--warning-color)]";
  if (status === "R" || status === "C") return "text-[color:var(--info-color)]";
  return "";
}

function normalizeStatusForIcon(statusRaw: string) {
  if (statusRaw === "??") return "??";
  if (statusRaw === "!!") return "!!";
  if (statusRaw.includes("U")) return "U";
  return statusRaw[0] || "";
}

function statusIconComponent(statusRaw: string) {
  const key = normalizeStatusForIcon(statusRaw);
  if (key === "A") return FileAddOutlined;
  if (key === "M") return FormOutlined;
  if (key === "D") return DeleteOutlined;
  if (key === "R") return RetweetOutlined;
  if (key === "C") return CopyOutlined;
  if (key === "U") return ExclamationCircleOutlined;
  if (key === "??") return FileUnknownOutlined;
  if (key === "!!") return EyeInvisibleOutlined;
  return ExclamationCircleOutlined;
}

function fingerprintFor(mode: ChangeMode, f: ChangeItem) {
  if (mode === "staged") return `${f.status}|${f.oldPath || ""}|${f.path}|${f.indexSha || ""}`;
  return `${f.status}|${f.oldPath || ""}|${f.path}|${f.indexSha || ""}|${f.worktreeMtimeMs ?? ""}|${f.worktreeSize ?? ""}`;
}

function findBestMatch(list: ChangeItem[], sel: NonNullable<Selected>) {
  const byPath = list.filter((f) => f.path === sel.path);
  if (byPath.length > 0) {
    const exact = byPath.find((f) => (f.oldPath || "") === (sel.oldPath || ""));
    return exact || byPath[0] || null;
  }

  const renamedFromSelectedPath = list.find((f) => f.oldPath && f.oldPath === sel.path);
  if (renamedFromSelectedPath) return renamedFromSelectedPath;

  if (sel.oldPath) {
    const bySelectedOldPath = list.filter((f) => f.path === sel.oldPath || (f.oldPath && f.oldPath === sel.oldPath));
    if (bySelectedOldPath.length > 0) return bySelectedOldPath[0] || null;
  }

  return null;
}

async function reconcileSelectedAfterRefresh() {
  const sel = selected.value;
  if (!sel) {
    selectedFingerprint.value = null;
    return;
  }

  const primaryMode = sel.mode;
  const primaryList = primaryMode === "unstaged" ? unstagedFiles.value : stagedFiles.value;
  const otherMode: ChangeMode = primaryMode === "unstaged" ? "staged" : "unstaged";
  const otherList = primaryMode === "unstaged" ? stagedFiles.value : unstagedFiles.value;

  const primaryMatch = findBestMatch(primaryList, sel);
  if (primaryMatch) {
    const fp = fingerprintFor(primaryMode, primaryMatch);
    const idx = primaryList.indexOf(primaryMatch);
    if (idx >= 0) lastSelectedIndexByMode.value[primaryMode] = idx;

    const selectionChanged =
        primaryMatch.path !== sel.path ||
        (primaryMatch.oldPath || "") !== (sel.oldPath || "");
    if (selectionChanged) {
      selectedFingerprint.value = fp;
      // rename 也视为“仍存在”,因此需要把选中项迁移到新 path
      selected.value = {mode: primaryMode, path: primaryMatch.path, oldPath: primaryMatch.oldPath};
      return;
    }
    if (selectedFingerprint.value !== fp) {
      selectedFingerprint.value = fp;
      await refreshCompare();
    }
    return;
  }

  // “留在当前 mode 优先”: 当前 mode 中不存在原选中项时,优先选中原位置上的文件
  if (primaryList.length > 0) {
    const rawIdx = lastSelectedIndexByMode.value[primaryMode] ?? 0;
    const idx = Math.max(0, Math.min(primaryList.length - 1, rawIdx));
    const next = primaryList[idx]!;
    selectedFingerprint.value = fingerprintFor(primaryMode, next);
    selected.value = {mode: primaryMode, path: next.path, oldPath: next.oldPath};
    lastSelectedIndexByMode.value[primaryMode] = idx;
    return;
  }

  // 当前 mode 为空时,才允许切到另一个 mode 继续选中原文件
  const otherMatch = findBestMatch(otherList, sel);
  if (otherMatch) {
    const idx = otherList.indexOf(otherMatch);
    if (idx >= 0) lastSelectedIndexByMode.value[otherMode] = idx;
    selectedFingerprint.value = fingerprintFor(otherMode, otherMatch);
    selected.value = {mode: otherMode, path: otherMatch.path, oldPath: otherMatch.oldPath};
    return;
  }

  selectedFingerprint.value = null;
  selected.value = null;
}

async function refreshChanges(mode: ChangeMode) {
  if (!props.target) return;
  const loadingRef = mode === "unstaged" ? unstagedLoading : stagedLoading;
  const loadedRef = mode === "unstaged" ? unstagedLoaded : stagedLoaded;
  loadingRef.value = true;
  try {
    const res = await listChanges(props.target, {mode});
    if (mode === "unstaged") unstaged.value = res.files;
    else staged.value = res.files;
    loadedRef.value = true;
  } finally {
    loadingRef.value = false;
  }
}

async function refreshAll() {
  if (!props.target) {
    unstaged.value = [];
    staged.value = [];
    unstagedLoaded.value = true;
    stagedLoaded.value = true;
    selected.value = null;
    selectedFingerprint.value = null;
    compare.value = null;
    compareError.value = null;
    compareLoading.value = false;
    emit("changesSummary", {unstaged: 0, staged: 0});
    return;
  }
  await Promise.all([refreshChanges("unstaged"), refreshChanges("staged")]);
  emit("changesSummary", {unstaged: unstaged.value.length, staged: staged.value.length});
  await reconcileSelectedAfterRefresh();
}

function openCommit() {
  if (props.gitBusy) return;
  if (stagedFiles.value.length === 0) return;
  commitOpen.value = true;
}

async function stageAll() {
  if (!props.target) return;
  if (props.gitBusy) return;
  const release = props.beginGitOp();
  try {
    await stageWorkspace({target: props.target, all: true});
    await refreshAll();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    release();
  }
}

async function stageOne(f: ChangeItem) {
  if (!props.target) return;
  if (props.gitBusy) return;
  const release = props.beginGitOp();
  try {
    await stageWorkspace({target: props.target, items: [{path: f.path, oldPath: f.oldPath}]});
    await refreshAll();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    release();
  }
}

function discardConfirmText(f: ChangeItem) {
  if (f.status === "??") return t("codeReview.discard.preview.untracked", {path: f.path});
  if (f.status === "R" && f.oldPath) return t("codeReview.discard.preview.rename", {oldPath: f.oldPath, path: f.path});
  return t("codeReview.discard.preview.changes", {path: f.path});
}

function discardOneLabel(f: ChangeItem) {
  return f.status === "??" ? t("codeReview.discard.deleteUntracked") : t("codeReview.discard.discardChanges");
}

async function discardOne(f: ChangeItem) {
  const target = props.target;
  if (!target) return;
  if (props.gitBusy) return;

  Modal.confirm({
    title: f.status === "??" ? t("codeReview.discard.confirmDeleteTitle") : t("codeReview.discard.confirmDiscardTitle"),
    content: discardConfirmText(f),
    okText: f.status === "??" ? t("codeReview.discard.okDelete") : t("codeReview.discard.okDiscard"),
    cancelText: t("codeReview.discard.cancel"),
    okButtonProps: {danger: true},
    onOk: async () => {
      const release = props.beginGitOp();
      try {
        await discardWorkspace({target, items: [{path: f.path, oldPath: f.oldPath}]});
        await refreshAll();
        message.success(f.status === "??" ? t("codeReview.discard.deleted") : t("codeReview.discard.discarded"));
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      } finally {
        release();
      }
    }
  });
}

async function discardAll() {
  const target = props.target;
  if (!target) return;
  if (props.gitBusy) return;
  if (unstagedFiles.value.length === 0) return;

  Modal.confirm({
    title: t("codeReview.discard.confirmAllTitle"),
    content: t("codeReview.discard.confirmAllContent"),
    okText: t("codeReview.discard.okDiscardAll"),
    cancelText: t("codeReview.discard.cancel"),
    okButtonProps: {danger: true},
    onOk: async () => {
      const release = props.beginGitOp();
      try {
        await discardWorkspace({target, all: true, includeUntracked: true});
        await refreshAll();
        message.success(t("codeReview.discard.discardedAll"));
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      } finally {
        release();
      }
    }
  });
}

async function unstageAll() {
  if (!props.target) return;
  if (props.gitBusy) return;
  const release = props.beginGitOp();
  try {
    await unstageWorkspace({target: props.target, all: true});
    await refreshAll();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    release();
  }
}

async function unstageOne(f: ChangeItem) {
  if (!props.target) return;
  if (props.gitBusy) return;
  const release = props.beginGitOp();
  try {
    await unstageWorkspace({target: props.target, items: [{path: f.path, oldPath: f.oldPath}]});
    await refreshAll();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    release();
  }
}

async function submitCommit(mode: "commit" | "commitAndPush") {
  if (!props.target) return;
  if (!canCommit.value) return;
  const msg = commitMessage.value.trim();
  commitLoading.value = mode;
  const release = props.beginGitOp();
  try {
    const res = await commitWorkspace({target: props.target, message: msg});
    message.success(t("codeReview.commit.committed", {sha: res.sha.slice(0, 8)}));
    commitOpen.value = false;
    commitMessage.value = "";
    await refreshAll();
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError({message: err instanceof Error ? err.message : String(err)});
    if (e.code === "GIT_IDENTITY_REQUIRED") {
      pendingCommitMode.value = mode;
      identityOpen.value = true;
      return;
    }
    message.error(e.message);
    return;
  } finally {
    release();
    commitLoading.value = null;
  }

  if (mode === "commitAndPush") {
    try {
      await props.push?.();
    } catch {
      // push 内部自行 toast/弹窗；这里不重复提示
    }
  }
}

async function onIdentitySubmit(identity: any) {
  if (!props.target) return;
  const mode = pendingCommitMode.value ?? "commit";
  const msg = commitMessage.value.trim();
  if (!msg) return;

  commitLoading.value = mode;
  const release = props.beginGitOp();
  identitySubmitting.value = true;
  try {
    const res = await commitWorkspace({target: props.target, message: msg, identity});
    message.success(t("codeReview.commit.committed", {sha: res.sha.slice(0, 8)}));
    commitOpen.value = false;
    commitMessage.value = "";
    identityOpen.value = false;
    pendingCommitMode.value = null;
    await refreshAll();
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError({message: err instanceof Error ? err.message : String(err)});
    message.error(e.message);
    return;
  } finally {
    release();
    commitLoading.value = null;
    identitySubmitting.value = false;
  }

  if (mode === "commitAndPush") {
    try {
      await props.push?.();
    } catch {
      // push 内部自行 toast/弹窗；这里不重复提示
    }
  }
}

async function refreshCompare() {
  compareReqSeq += 1;
  const req = compareReqSeq;

  compareError.value = null;
  compare.value = null;
  if (!props.target) {
    compareLoading.value = false;
    return;
  }
  if (!selected.value) {
    compareLoading.value = false;
    return;
  }

  compareLoading.value = true;
  try {
    const next = await fileCompare(props.target, {
      mode: selected.value.mode,
      path: selected.value.path,
      oldPath: selected.value.oldPath
    });
    if (req !== compareReqSeq) return;
    compare.value = next;
  } catch (err) {
    if (req !== compareReqSeq) return;
    compareError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (req === compareReqSeq) compareLoading.value = false;
  }
}

watch(selected, async () => {
  const selectionKey = selected.value ? `${selected.value.mode}|${selected.value.path}|${selected.value.oldPath || ""}` : null;
  await refreshCompare();
  if (!selectionKey) return;
  const latestKey = selected.value ? `${selected.value.mode}|${selected.value.path}|${selected.value.oldPath || ""}` : null;
  if (latestKey !== selectionKey) return;
  const c = compare.value;
  if (!c || !c.base.previewable || !c.current.previewable) return;
  await nextTick();
  diffViewerRef.value?.goToFirstDiff();
});

const pollIntervalMs = 5000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const pollInFlight = ref(false);

async function pollTick() {
  if (!props.target) return;
  if (props.gitBusy) return;
  if (pollInFlight.value) return;
  pollInFlight.value = true;
  try {
    await refreshAll();
  } catch {
    // 轮询失败时不打断 UI
  } finally {
    pollInFlight.value = false;
  }
}

function startPolling() {
  if (!props.pollingEnabled) return;
  if (pollTimer) return;
  pollTimer = setInterval(pollTick, pollIntervalMs);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function handleVisibilityChange() {
  if (!props.pollingEnabled) return;
  if (typeof document === "undefined") return;
  if (document.visibilityState === "hidden") {
    stopPolling();
    return;
  }
  startPolling();
  void pollTick();
}

watch(
    () => props.target?.kind === "workspaceRepo" ? props.target.dirName : "",
    async () => {
      selectedFingerprint.value = null;
      selected.value = null;
      await refreshAll();
    }
);

onMounted(async () => {
  await refreshAll();
  if (props.pollingEnabled) {
    startPolling();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange, {passive: true});
    }
  }
});

onUnmounted(() => {
  if (props.pollingEnabled) {
    stopPolling();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  }
  draggingCleanup?.();
});

defineExpose({refreshAll});

function explainSide(side: FileCompareResponse["base"]) {
  if (side.previewable) return t("codeReview.preview.previewable");
  const bytesSuffix = side.bytes ? t("common.format.parensSuffix", {text: formatBytes(side.bytes)}) : "";
  if (side.reason === "too_large") return t("codeReview.preview.tooLarge", {bytesSuffix});
  if (side.reason === "binary") return t("codeReview.preview.binary", {bytesSuffix});
  if (side.reason === "decode_failed") return t("codeReview.preview.decodeFailed", {bytesSuffix});
  if (side.reason === "unsafe_path") return t("codeReview.preview.unsafePath", {bytesSuffix});
  return t("codeReview.preview.notPreviewable", {bytesSuffix});
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
</script>

<style scoped>
.diff-header {
  grid-template-columns: var(--diff-original-width, 1fr) var(--diff-splitter-width, 0px) var(--diff-modified-width, 1fr);
}
</style>
