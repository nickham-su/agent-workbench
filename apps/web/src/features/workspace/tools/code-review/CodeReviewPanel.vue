<template>
  <div class="code-review-changes">
    <div v-if="noChanges" class="review-clean-state">{{ t("codeReview.status.noChanges") }}</div>
    <div v-else class="review-change-groups">
      <div class="flex-1 min-h-0 flex flex-col">
        <div
            class="review-change-heading flex items-center justify-between pl-3 pr-1 py-1.5 border-b border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
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
        <div class="review-file-list">
          <div v-if="unstagedLoaded && unstagedFiles.length === 0"
               class="p-3 text-xs text-[color:var(--text-tertiary)]">
            {{ t("codeReview.status.noUnstagedChanges") }}
          </div>
          <a-dropdown v-for="f in unstagedFiles" :key="`u:${f.path}`" :trigger="['contextmenu']" class="block">
            <div
                class="group w-full text-left pl-3 pr-1 py-1.5 hover:bg-[var(--hover-bg)] cursor-pointer"
                :class="isSelected('unstaged', f.path) ? 'bg-[var(--fill-secondary)] border-l-2 border-l-[var(--info-color)]' : 'border-l-2 border-l-transparent'"
                @click="selectFile('unstaged', f.path, f.oldPath)"
                @contextmenu.prevent="selectFile('unstaged', f.path, f.oldPath, false)"
            >
              <div class="flex items-center gap-2 min-w-0">
                <a-tooltip :title="fileKindLabel(f) || f.status" :mouseEnterDelay="0" :mouseLeaveDelay="0" placement="top">
                  <div
                      class="text-xs text-[color:var(--text-secondary)] shrink-0 text-center flex items-center justify-center"
                      :class="statusBadgeClass(f.status)"
                  >
                    <component :is="f.kind === 'directory' ? FolderOpenOutlined : f.kind === 'submodule' ? BranchesOutlined : statusIconComponent(f.status)"/>
                  </div>
                </a-tooltip>
                <div class="min-w-0 flex-1">
                  <div class="text-xs font-mono min-w-0 flex items-center">
                    <span class="text-[color:var(--text-secondary)] min-w-0 flex-initial truncate block">{{ fileDir(f.path) }}</span>
                    <span class="text-[color:var(--text-color)] shrink-0 whitespace-nowrap" :title="fileKindLabel(f) || undefined">{{ fileBase(f.path) }}</span>
                  </div>
                  <div v-if="f.oldPath" class="mt-0.5 text-[11px] font-mono truncate text-[color:var(--text-tertiary)]">
                    {{ t("codeReview.file.oldPath", {oldPath: f.oldPath}) }}
                  </div>
                </div>
                <div class="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100">
                  <a-tooltip :title="t('codeReview.actions.stage')" :mouseEnterDelay="0" :mouseLeaveDelay="0" placement="top">
                    <span class="inline-flex">
                      <a-button size="small" type="text" :disabled="gitBusy" @click.stop="stageOne(f)" :aria-label="t('codeReview.actions.stage')">
                        <template #icon><PlusOutlined/></template>
                      </a-button>
                    </span>
                  </a-tooltip>
                  <a-tooltip :title="discardOneLabel(f)" :mouseEnterDelay="0" :mouseLeaveDelay="0" placement="top">
                    <span class="inline-flex">
                      <a-button size="small" type="text" :disabled="gitBusy" @click.stop="discardOne(f)" :aria-label="discardOneLabel(f)">
                        <template #icon><RollbackOutlined/></template>
                      </a-button>
                    </span>
                  </a-tooltip>
                </div>
              </div>
            </div>
            <template #overlay>
              <a-menu @click="onUnstagedContextMenuClick(f, $event)">
                <a-menu-item key="openDiff">{{ t('codeReview.actions.openDiff') }}</a-menu-item>
                <a-menu-item key="openFile" :disabled="isOpenFileDisabled(f)">{{ t('codeReview.actions.openFile') }}</a-menu-item>
                <a-menu-divider/>
                <a-menu-item key="stage" :disabled="gitBusy">{{ t('codeReview.actions.stage') }}</a-menu-item>
                <a-menu-item key="discard" :disabled="gitBusy" danger>{{ discardOneLabel(f) }}</a-menu-item>
                <a-menu-divider/>
                <a-menu-item key="copyPath">{{ t('codeReview.actions.copyPath') }}</a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
        </div>
      </div>

      <div class="flex-1 min-h-0 flex flex-col border-t border-[var(--border-color-secondary)]">
        <div
            class="review-change-heading flex items-center justify-between pl-3 pr-1 py-1.5 border-b border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
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
        <div class="review-file-list">
          <div v-if="stagedLoaded && stagedFiles.length === 0" class="p-3 text-xs text-[color:var(--text-tertiary)]">
            {{ t("codeReview.status.noStagedChanges") }}
          </div>
          <a-dropdown v-for="f in stagedFiles" :key="`s:${f.path}`" :trigger="['contextmenu']" class="block">
            <div
                class="group w-full text-left pl-3 pr-1 py-1.5 hover:bg-[var(--hover-bg)] cursor-pointer"
                :class="isSelected('staged', f.path) ? 'bg-[var(--fill-secondary)] border-l-2 border-l-[var(--info-color)]' : 'border-l-2 border-l-transparent'"
                @click="selectFile('staged', f.path, f.oldPath)"
                @contextmenu.prevent="selectFile('staged', f.path, f.oldPath, false)"
            >
              <div class="flex items-center gap-2 min-w-0">
                <a-tooltip :title="fileKindLabel(f) || f.status" :mouseEnterDelay="0" :mouseLeaveDelay="0" placement="top">
                  <div
                      class="text-xs text-[color:var(--text-secondary)] shrink-0 text-center flex items-center justify-center"
                      :class="statusBadgeClass(f.status)"
                  >
                    <component :is="f.kind === 'directory' ? FolderOpenOutlined : f.kind === 'submodule' ? BranchesOutlined : statusIconComponent(f.status)"/>
                  </div>
                </a-tooltip>
                <div class="min-w-0 flex-1">
                  <div class="text-xs font-mono min-w-0 flex items-center">
                    <span class="text-[color:var(--text-secondary)] min-w-0 flex-initial truncate block">{{ fileDir(f.path) }}</span>
                    <span class="text-[color:var(--text-color)] shrink-0 whitespace-nowrap" :title="fileKindLabel(f) || undefined">{{ fileBase(f.path) }}</span>
                  </div>
                  <div v-if="f.oldPath" class="mt-0.5 text-[11px] font-mono truncate text-[color:var(--text-tertiary)]">
                    {{ t("codeReview.file.oldPath", {oldPath: f.oldPath}) }}
                  </div>
                </div>
                <div class="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100">
                  <a-tooltip :title="t('codeReview.actions.unstage')" :mouseEnterDelay="0" :mouseLeaveDelay="0" placement="top">
                    <span class="inline-flex">
                      <a-button size="small" type="text" :disabled="gitBusy" @click.stop="unstageOne(f)" :aria-label="t('codeReview.actions.unstage')">
                        <template #icon><MinusOutlined/></template>
                      </a-button>
                    </span>
                  </a-tooltip>
                </div>
              </div>
            </div>
            <template #overlay>
              <a-menu @click="onStagedContextMenuClick(f, $event)">
                <a-menu-item key="openDiff">{{ t('codeReview.actions.openDiff') }}</a-menu-item>
                <a-menu-item key="openFile" :disabled="isOpenFileDisabled(f)">{{ t('codeReview.actions.openFile') }}</a-menu-item>
                <a-menu-divider/>
                <a-menu-item key="unstage" :disabled="gitBusy">{{ t('codeReview.actions.unstage') }}</a-menu-item>
                <a-menu-divider/>
                <a-menu-item key="copyPath">{{ t('codeReview.actions.copyPath') }}</a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
        </div>
      </div>
    </div>
  </div>

  <a-modal v-model:open="commitOpen" :title="t('codeReview.commit.modalTitle')" :maskClosable="false">
    <a-form layout="vertical">
      <div class="mb-3 text-xs font-mono break-all" data-commit-target>{{ t("codeReview.commit.target", { repo: commitDialog?.target.dirName ?? "" }) }}</div>
      <a-form-item :label="t('codeReview.commit.messageLabel')" required>
        <a-textarea
            ref="commitMessageInputRef"
            v-model:value="commitMessage"
            :auto-size="{ minRows: 4, maxRows: 10 }"
            :placeholder="t('codeReview.commit.messagePlaceholder')"
            :disabled="gitBusy"
        />
      </a-form-item>
      <div class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("codeReview.commit.summary", {count: commitDialog?.stagedCount ?? 0}) }}
      </div>
      <div class="mt-1 text-xs text-[color:var(--text-tertiary)]">{{ t("codeReview.commit.scope") }}</div>
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
      :target="pendingCommitRequest?.target ?? null"
      :defaultScope="'repo'"
      :loading="identitySubmitting"
      @submit="onIdentitySubmit"
  />
</template>

<script setup lang="ts">
import {computed, nextTick, onUnmounted, ref, shallowRef, watch} from "vue";
import {Modal, message} from "ant-design-vue";
import {
  BranchesOutlined,
  CopyOutlined,
  FolderOpenOutlined,
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
import { inferLanguageFromPath } from "@/shared/monaco/languageUtils";
import GitIdentityModal from "@/shared/components/GitIdentityModal.vue";
import { useWorkspaceHost } from "@/features/workspace/host";

type Selected = { mode: ChangeMode; path: string; oldPath?: string } | null;

type PushParams = Omit<GitPushRequest, "target">;

const props = defineProps<{
  workspaceId: string;
  toolId: string;
  target: GitTarget | null;
  gitBusy: boolean;
  beginGitOp: () => () => void;
  push?: (target: GitTarget, params?: PushParams) => Promise<void>;
  refreshStatus?: () => Promise<void>;
}>();

const {t} = useI18n();
const host = useWorkspaceHost(props.toolId);

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
// 仅当用户点击列表项触发选中时才允许打开 diff 编辑器；用于避免 refresh/stage/unstage/轮询等路径触发自动打开
// 用 selectionKey 精确绑定一次打开请求，避免异步 refreshCompare() 过程中标记残留或错配
const openDiffRequestedByUserKey = ref<string | null>(null);
// 记录每个 mode 下,用户上次选中的(排序后)索引,用于刷新后回退到“原位置上的文件”
const lastSelectedIndexByMode = ref<Record<ChangeMode, number>>({unstaged: 0, staged: 0});

const compareLoading = ref(false);
const compareError = ref<string | null>(null);
const compare = ref<FileCompareResponse | null>(null);
const compareLanguage = computed(() => {
  const current = compare.value;
  if (!current) return undefined;
  return inferLanguageFromPath(current.path);
});
let compareReqSeq = 0;
let listReqSeq = 0;
let disposed = false;
const targetKey = (target: GitTarget | null) => target ? `${target.workspaceId}/${target.dirName}` : "";

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
const noChanges = computed(() => unstagedLoaded.value && stagedLoaded.value && unstagedFiles.value.length === 0 && stagedFiles.value.length === 0);

const commitOpen = ref(false);
const commitMessage = ref("");
const commitMessageInputRef = ref<{ focus?: () => void } | null>(null);
const commitLoading = ref<"commit" | "commitAndPush" | null>(null);
type CommitMode = "commit" | "commitAndPush";
type CommitDialog = { id: number; target: GitTarget; stagedCount: number };
type CommitRequest = CommitDialog & { message: string; mode: CommitMode };
let commitDialogSeq = 0;
const commitDialog = shallowRef<CommitDialog | null>(null);
const commitDrafts = new Map<string, string>();
const canCommit = computed(() => Boolean(commitDialog.value?.stagedCount) && commitMessage.value.trim().length > 0 && !props.gitBusy && !commitLoading.value);

const identityOpen = ref(false);
const pendingCommitRequest = shallowRef<CommitRequest | null>(null);
const identitySubmitting = ref(false);

watch(
  () => commitOpen.value,
  (open) => {
    if (!open) return;
    nextTick(() => {
      commitMessageInputRef.value?.focus?.();
    });
  }
);

async function openSelectedDiff() {
  if (!compare.value || !props.target || !selected.value) return;
  host.call("editor", {
    type: "editor.openDiff",
    payload: {
      original: compare.value.base.content || "",
      modified: compare.value.current.content || "",
      path: compare.value.path,
      language: compareLanguage.value,
      title: compare.value.path,
      tabKey: `codeReview:${targetKey(props.target)}:${selected.value.mode}:${selected.value.oldPath || selected.value.path}->${selected.value.path}`,
      source: "codeReview"
    }
  });
}

function isSelected(mode: ChangeMode, path: string) {
  return selected.value?.mode === mode && selected.value.path === path;
}

function selectFile(mode: ChangeMode, path: string, oldPath?: string, openDiffByUser = true) {
  selected.value = {mode, path, oldPath};
  // 仅用户明确触发“打开差异”时设置该 key，避免右键选中、刷新等路径自动打开 diff
  openDiffRequestedByUserKey.value = openDiffByUser ? `${mode}|${path}|${oldPath || ""}` : null;
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

  // 当原选中项在当前 mode 中已不存在时：不再自动选中“下一个/原位置”或切到另一列表匹配。
  // 直接清空选中，等待用户手动选择。
  selectedFingerprint.value = null;
  selected.value = null;
}

async function refreshAll() {
  if (disposed) return;
  const request = ++listReqSeq;
  const target = props.target ? { ...props.target } : null;
  if (!target) {
    unstagedLoading.value = false;
    stagedLoading.value = false;
    unstaged.value = [];
    staged.value = [];
    unstagedLoaded.value = true;
    stagedLoaded.value = true;
    selected.value = null;
    selectedFingerprint.value = null;
    compare.value = null;
    compareError.value = null;
    compareLoading.value = false;
    emit("changesSummary", { unstaged: 0, staged: 0 });
    return;
  }
  unstagedLoading.value = true;
  stagedLoading.value = true;
  try {
    const [nextUnstaged, nextStaged] = await Promise.all([
      listChanges(target, { mode: "unstaged" }),
      listChanges(target, { mode: "staged" })
    ]);
    if (disposed || request !== listReqSeq || targetKey(target) !== targetKey(props.target)) return;
    unstaged.value = nextUnstaged.files;
    staged.value = nextStaged.files;
    unstagedLoaded.value = true;
    stagedLoaded.value = true;
    emit("changesSummary", { unstaged: unstaged.value.length, staged: staged.value.length });
    await reconcileSelectedAfterRefresh();
  } finally {
    if (request === listReqSeq) {
      unstagedLoading.value = false;
      stagedLoading.value = false;
    }
  }
}

async function refreshAfterGitOperation(target: GitTarget) {
  if (disposed) return;
  // 旧仓库的操作结束后，不覆盖新仓库列表；后台摘要仍要更新。
  if (targetKey(target) === targetKey(props.target)) await refreshAll();
  await props.refreshStatus?.();
}

function normalizeStatusForAction(statusRaw: string) {
  if (!statusRaw) return "";
  if (statusRaw === "??" || statusRaw === "!!") return statusRaw;
  if (statusRaw.includes("U")) return "U";
  return statusRaw[0] || "";
}

function isDeletedChange(f: ChangeItem) {
  return normalizeStatusForAction(f.status) === "D";
}

function normalizeRelPath(rawInput: string) {
  let raw = String(rawInput || "").trim();
  if (!raw) return "";
  while (raw.startsWith("./")) raw = raw.slice(2);
  raw = raw.replace(/\\/g, "/");
  raw = raw.replace(/\/{2,}/g, "/");
  while (raw.endsWith("/")) raw = raw.slice(0, -1);
  if (!raw || raw.startsWith("/")) return "";
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) return "";
  return parts.join("/");
}

function fileKindLabel(f: ChangeItem) {
  return f.kind ? t(`codeReview.file.${f.kind}`) : "";
}

function isOpenFileDisabled(f: ChangeItem) {
  return Boolean(f.kind) || isDeletedChange(f) || !resolveOpenFilePath(f);
}

function resolveOpenFilePath(f: ChangeItem) {
  if (f.kind || isDeletedChange(f)) return "";
  const repoRel = normalizeRelPath(f.path);
  if (!repoRel) return "";

  const target = props.target;
  if (!target || target.kind !== "workspaceRepo") return repoRel;
  const repoDirName = normalizeRelPath(target.dirName);
  // codeReview 的变更 path 语义是“仓库内相对路径”，这里确定性转换为“工作区相对路径”
  // 禁止依赖字符串前缀启发式，避免合法路径误判（如 repo 名同名目录前缀）。
  if (!repoDirName) return repoRel;
  return `${repoDirName}/${repoRel}`;
}

async function openFileFromChange(f: ChangeItem) {
  const path = resolveOpenFilePath(f);
  if (!path) {
    message.warning(t(f.kind ? "codeReview.diff.notPreviewableTitle" : "codeReview.actions.openFileUnavailable"));
    return;
  }
  try {
    host.call("editor", {
      type: "editor.openFile",
      payload: {
        path,
        mode: "edit"
      }
    });
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

async function copyPath(path: string) {
  const content = String(path ?? "");
  if (!content) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      message.success(t("codeReview.actions.pathCopied"));
      return;
    }
  } catch {
    // fallback
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = content;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) {
      message.success(t("codeReview.actions.pathCopied"));
      return;
    }
  } catch {
    // ignore
  }
  message.error(t("codeReview.actions.copyFailed"));
}

function onContextMenuAction(mode: ChangeMode, f: ChangeItem, info: { key?: string | number }) {
  const key = String(info?.key || "");
  if (!key) return;
  selectFile(mode, f.path, f.oldPath, false);

  if (key === "openDiff") {
    selectFile(mode, f.path, f.oldPath, true);
    return;
  }
  if (key === "openFile") {
    void openFileFromChange(f);
    return;
  }
  if (key === "copyPath") {
    void copyPath(f.path);
    return;
  }
  if (key === "stage" && mode === "unstaged") {
    void stageOne(f);
    return;
  }
  if (key === "discard" && mode === "unstaged") {
    void discardOne(f);
    return;
  }
  if (key === "unstage" && mode === "staged") {
    void unstageOne(f);
  }
}

function onUnstagedContextMenuClick(f: ChangeItem, info: { key?: string | number }) {
  onContextMenuAction("unstaged", f, info);
}

function onStagedContextMenuClick(f: ChangeItem, info: { key?: string | number }) {
  onContextMenuAction("staged", f, info);
}

function openCommit() {
  if (props.gitBusy) return;
  if (stagedFiles.value.length === 0) return;
  if (!props.target) return;
  if (commitDialog.value) commitDrafts.set(targetKey(commitDialog.value.target), commitMessage.value);
  commitDialog.value = { id: ++commitDialogSeq, target: { ...props.target }, stagedCount: stagedFiles.value.length };
  commitMessage.value = commitDrafts.get(targetKey(props.target)) ?? "";
  commitOpen.value = true;
}

async function stageAll() {
  const target = props.target ? { ...props.target } : null;
  if (!target || props.gitBusy) return;
  const release = props.beginGitOp();
  try {
    await stageWorkspace({target, all: true});
    await refreshAfterGitOperation(target);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    release();
  }
}

async function stageOne(f: ChangeItem) {
  const target = props.target ? { ...props.target } : null;
  if (!target || props.gitBusy) return;
  const release = props.beginGitOp();
  try {
    await stageWorkspace({target, items: [{path: f.path, oldPath: f.oldPath}]});
    await refreshAfterGitOperation(target);
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
        await refreshAfterGitOperation(target);
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
        await refreshAfterGitOperation(target);
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
  const target = props.target ? { ...props.target } : null;
  if (!target || props.gitBusy) return;
  const release = props.beginGitOp();
  try {
    await unstageWorkspace({target, all: true});
    await refreshAfterGitOperation(target);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    release();
  }
}

async function unstageOne(f: ChangeItem) {
  const target = props.target ? { ...props.target } : null;
  if (!target || props.gitBusy) return;
  const release = props.beginGitOp();
  try {
    await unstageWorkspace({target, items: [{path: f.path, oldPath: f.oldPath}]});
    await refreshAfterGitOperation(target);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    release();
  }
}

async function submitCommit(mode: CommitMode) {
  const dialog = commitDialog.value;
  if (!dialog || !canCommit.value) return;
  const request: CommitRequest = { ...dialog, target: { ...dialog.target }, message: commitMessage.value.trim(), mode };
  await runCommit(request);
}

async function runCommit(request: CommitRequest, identity?: Parameters<typeof commitWorkspace>[0]["identity"]) {
  commitLoading.value = request.mode;
  identitySubmitting.value = Boolean(identity);
  const release = props.beginGitOp();
  let committed = false;
  try {
    const res = await commitWorkspace({ target: request.target, message: request.message, ...(identity ? { identity } : {}) });
    committed = true;
    message.success(t("codeReview.commit.committed", { sha: res.sha.slice(0, 8) }));
    if (commitDialog.value?.id === request.id && commitMessage.value.trim() === request.message) {
      commitOpen.value = false;
      commitMessage.value = "";
    }
    if (commitDrafts.get(targetKey(request.target))?.trim() === request.message) commitDrafts.delete(targetKey(request.target));
    if (pendingCommitRequest.value === request) {
      identityOpen.value = false;
      pendingCommitRequest.value = null;
    }
  } catch (err) {
    const error = err instanceof ApiError ? err : new ApiError({ message: err instanceof Error ? err.message : String(err) });
    if (error.code === "GIT_IDENTITY_REQUIRED" && !identity) {
      pendingCommitRequest.value = request;
      identityOpen.value = true;
    } else {
      message.error(error.message);
    }
  } finally {
    release();
    commitLoading.value = null;
    identitySubmitting.value = false;
  }
  if (!committed) return;
  if (request.mode === "commitAndPush") {
    try {
      // 同一调用栈内续接 push，让宿主先取得 busy；不要先 await 被动刷新，
      // 否则期间开始的其他 Git 操作可能使本次必需的 push 被 busy gate 跳过。
      await props.push?.(request.target);
    } catch {
      // 宿主负责 push 的提示/确认，不重复弹出。
    }
  }
  try {
    await refreshAfterGitOperation(request.target);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

async function onIdentitySubmit(identity: Parameters<typeof commitWorkspace>[0]["identity"]) {
  const request = pendingCommitRequest.value;
  if (!request || props.gitBusy || commitLoading.value) return;
  await runCommit(request, identity);
}

async function refreshCompare() {
  compareReqSeq += 1;
  const req = compareReqSeq;
  const target = props.target ? { ...props.target } : null;

  compareError.value = null;
  compare.value = null;
  if (!target) {
    compareLoading.value = false;
    return;
  }
  if (!selected.value) {
    compareLoading.value = false;
    return;
  }

  compareLoading.value = true;
  try {
    const next = await fileCompare(target, {
      mode: selected.value.mode,
      path: selected.value.path,
      oldPath: selected.value.oldPath
    });
    if (disposed || req !== compareReqSeq || targetKey(target) !== targetKey(props.target)) return;
    compare.value = next;
  } catch (err) {
    if (disposed || req !== compareReqSeq || targetKey(target) !== targetKey(props.target)) return;
    compareError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (req === compareReqSeq) compareLoading.value = false;
  }
}

watch([selected, openDiffRequestedByUserKey], async () => {
  const selectionKey = selected.value ? `${selected.value.mode}|${selected.value.path}|${selected.value.oldPath || ""}` : null;
  const selectedPath = selected.value?.path ?? "";

  // selected 为空时：不触发 refreshCompare（避免 compare 清空/多余请求）。
  // 同时让任何 in-flight compare 请求失效，避免在取消选中后写回 compare / 卡住 loading。
  if (!selectionKey) {
    openDiffRequestedByUserKey.value = null;
    compareReqSeq += 1;
    compareLoading.value = false;
    return;
  }

  // 只允许“用户点击触发的选中”打开 diff；其他路径（refresh/stage/unstage/轮询/重对齐）不打开编辑器
  const requestedKey = openDiffRequestedByUserKey.value;
  const shouldOpenDiff = !!selectionKey && !!requestedKey && requestedKey === selectionKey;
  // 立刻清空（一次性消费），避免 refreshCompare() 失败/不可预览等路径导致标记残留，从而下一次意外自动打开
  openDiffRequestedByUserKey.value = null;

  if (!shouldOpenDiff) return;

  const requestedTarget = targetKey(props.target);
  const requestedCompare = compareReqSeq + 1;
  await refreshCompare();
  if (requestedTarget !== targetKey(props.target) || requestedCompare !== compareReqSeq) return;
  const latestKey = selected.value ? `${selected.value.mode}|${selected.value.path}|${selected.value.oldPath || ""}` : null;
  if (latestKey !== selectionKey) return;

  if (compareError.value) {
    message.error(`${selectedPath}: ${compareError.value}`);
    return;
  }
  const c = compare.value;
  if (!c) return;
  if (!c.base.previewable || !c.current.previewable) {
    const reasons = [!c.base.previewable ? t("codeReview.diff.baseReason", {reason: explainSide(c.base)}) : null, !c.current.previewable ? t("codeReview.diff.currentReason", {reason: explainSide(c.current)}) : null].filter(Boolean).join("；");
    message.warning(`${t("codeReview.diff.notPreviewableTitle")}：${c.path}${reasons ? `（${reasons}）` : ""}`);
    return;
  }
  void openSelectedDiff();
});

watch(
  () => targetKey(props.target),
  () => {
    listReqSeq += 1;
    compareReqSeq += 1;
    unstaged.value = [];
    staged.value = [];
    unstagedLoaded.value = false;
    stagedLoaded.value = false;
    selectedFingerprint.value = null;
    selected.value = null;
    compare.value = null;
    compareError.value = null;
    compareLoading.value = false;
    void refreshAll().catch(() => {
      // 初始/切仓库加载失败不伪装为空列表；后台摘要负责限频提示。
    });
  },
  { immediate: true, flush: "sync" }
);

onUnmounted(() => {
  disposed = true;
  listReqSeq += 1;
  compareReqSeq += 1;
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
.code-review-changes { height: 100%; min-height: 0; min-width: 0; overflow: hidden; }
.review-change-groups { height: 100%; min-height: 0; min-width: 0; display: grid; grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
.review-change-heading { flex: none; }
.review-file-list { flex: 1; min-height: 0; min-width: 0; overflow: auto; }
.review-clean-state { height: 100%; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; color: var(--text-tertiary); font-size: 12px; }
</style>
