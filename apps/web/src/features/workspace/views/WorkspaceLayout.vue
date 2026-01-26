<template>
  <a-layout class="min-h-screen !bg-[var(--app-bg)]">
    <WorkspaceHeader
      :workspace="workspace"
      :current-repo-dir-name="currentRepoDirName"
      :current-repo-status="currentRepoStatus"
      :git-busy="gitBusy"
      :current-target="currentTarget"
      :header-action-groups="headerActionGroups"
      :filter-repo-option="filterRepoOption"
      :format-repo-display-name="formatRepoDisplayName"
      @update:current-repo-dir-name="(value) => (currentRepoDirName = value)"
      @checkout="openCheckout"
    />

    <a-layout-content class="p-0 h-[calc(100vh-64px)] border-t border-[var(--border-color-secondary)]">
      <WorkspaceDock
        :left-top-toolbar-tool-ids="leftTopToolbarToolIds"
        :left-bottom-toolbar-tool-ids="leftBottomToolbarToolIds"
        :right-toolbar-tool-ids="rightToolbarToolIds"
        :active-tool-id-by-area="activeToolIdByArea"
        :tool-minimized="toolMinimized"
        :tool-dots="toolDots"
        :visible-tool-id-by-area="visibleToolIdByArea"
        :keep-alive-include-by-area="keepAliveIncludeByArea"
        :tool-title="toolTitle"
        :tool-icon="toolIcon"
        :can-move-up="canMoveToolUp"
        :can-move-down="canMoveToolDown"
        :move-targets="moveTargets"
        :context-menu-hint="contextMenuHint"
        :on-tool-icon-click="onToolIconClick"
        :move-tool-up="moveToolUp"
        :move-tool-down="moveToolDown"
        :move-tool="moveTool"
        :is-keep-alive="isKeepAlive"
        :tool-view="toolView"
        :tool-view-props="toolViewProps"
        :tool-view-listeners="toolViewListeners"
        :show-top="showTop"
        :show-bottom="showBottom"
        :show-left-top="showLeftTop"
        :show-right-top="showRightTop"
        :center-style="centerStyle"
        :top-style="topStyle"
        :show-top-cols-splitter="showTopColsSplitter"
        :show-top-bottom-splitter="showTopBottomSplitter"
        :splitter-class-col="splitterClassCol"
        :splitter-class-row="splitterClassRow"
        :top-cols-splitter-style="topColsSplitterStyle"
        :top-bottom-splitter-style="topBottomSplitterStyle"
        :on-top-cols-splitter-pointer-down="onTopColsSplitterPointerDown"
        :on-top-bottom-splitter-pointer-down="onTopBottomSplitterPointerDown"
        :on-center-el="setCenterEl"
        :on-top-el="setTopEl"
      />
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

  <GitIdentityModal
    v-model:open="pushIdentityOpen"
    :target="currentTarget"
    :allowSession="false"
    :defaultScope="'repo'"
    :loading="pushIdentitySubmitting"
    @submit="onPushIdentitySubmit"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch, type ComponentPublicInstance } from "vue";
import { Modal, message } from "ant-design-vue";
import { CodeOutlined, FolderOpenOutlined, SearchOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import type { GitBranchesResponse, GitPushRequest, GitStatusResponse, WorkspaceDetail } from "@agent-workbench/shared";
import {
  ApiError,
  gitBranches,
  gitCheckout,
  getGitStatus,
  getWorkspace,
  getWorkspaceGitIdentity,
  listChanges,
  pullWorkspace,
  pushWorkspace,
  setWorkspaceGitIdentity,
  updateGitGlobalIdentity
} from "@/shared/api";
import { workspaceHostKey, type DockArea, type ToolCall, type ToolCallEnvelope, type WorkspaceHostApi, type WorkspaceToolCommandMap, type WorkspaceToolEvent } from "@/features/workspace/host";
import { workspaceContextKey } from "@/features/workspace/context";
import type { ToolRuntime, ToolRuntimeContext } from "@/features/workspace/runtime";
import WorkspaceHeader from "@/features/workspace/components/WorkspaceHeader.vue";
import WorkspaceDock from "@/features/workspace/components/WorkspaceDock.vue";
import type { HeaderAction, ToolId } from "@/features/workspace/types";
import CodeReviewIcon from "../icons/CodeReviewIcon.vue";
import CodeReviewToolView from "../tools/code-review/CodeReviewToolView.vue";
import { createSearchRuntime } from "../tools/search/runtime";
import FileExplorerToolView from "../tools/file-explorer/FileExplorerToolView.vue";
import SearchToolView from "../tools/search/SearchToolView.vue";
import TerminalToolView from "../tools/terminal/TerminalToolView.vue";
import GitIdentityModal from "@/shared/components/GitIdentityModal.vue";
import { createCodeReviewRuntime } from "@/features/workspace/tools/code-review/runtime";
import { createFileExplorerRuntime } from "@/features/workspace/tools/file-explorer/runtime";

const props = defineProps<{ workspaceId: string }>();
const { t } = useI18n();
type PushParams = Omit<GitPushRequest, "target">;

const TOOL_IDS: ToolId[] = ["files", "search", "codeReview", "terminal"];
const DOCK_AREAS: DockArea[] = ["leftTop", "leftBottom", "rightTop"];
type ToolDefinition = {
  toolId: ToolId;
  title: () => string;
  icon: any;
  view: any;
  defaultArea: DockArea;
  allowedAreas: DockArea[];
  keepAlive?: boolean;
  headerActions?: () => HeaderAction[];
  createRuntime?: (ctx: ToolRuntimeContext) => ToolRuntime;
};

const loading = ref(false);
const workspace = ref<WorkspaceDetail | null>(null);
const currentRepoDirName = ref<string>("");
const repoStatusByDirName = reactive<Record<string, GitStatusResponse | null>>({});
const repoDefaultBranch = ref<string | null>(null);

const workspaceRepos = computed(() => workspace.value?.repos ?? []);
const hasRepos = computed(() => workspaceRepos.value.length > 0);
const currentRepo = computed(() => workspaceRepos.value.find((r) => r.dirName === currentRepoDirName.value) ?? null);
const currentTarget = computed(() => {
  if (!currentRepo.value) return null;
  return { kind: "workspaceRepo", workspaceId: props.workspaceId, dirName: currentRepo.value.dirName } as const;
});
const currentRepoStatus = computed(() => {
  const repo = currentRepo.value;
  if (!repo) return null;
  return repoStatusByDirName[repo.dirName] ?? null;
});

const tools = computed<ToolDefinition[]>(() => [
  {
    toolId: "files",
    title: () => t("workspace.tools.files"),
    icon: FolderOpenOutlined,
    view: FileExplorerToolView,
    defaultArea: "leftTop",
    allowedAreas: ["leftTop", "rightTop", "leftBottom"],
    keepAlive: true,
    createRuntime: (ctx) => createFileExplorerRuntime(ctx)
  },
  {
    toolId: "search",
    title: () => t("workspace.tools.search"),
    icon: SearchOutlined,
    view: SearchToolView,
    defaultArea: "leftTop",
    allowedAreas: ["leftTop", "rightTop", "leftBottom"],
    keepAlive: true,
    createRuntime: (ctx) => createSearchRuntime(ctx)
  },
  {
    toolId: "codeReview",
    title: () => t("workspace.tools.codeReview"),
    icon: CodeReviewIcon,
    view: CodeReviewToolView,
    defaultArea: "leftTop",
    allowedAreas: ["leftTop", "rightTop", "leftBottom"],
    keepAlive: true,
    createRuntime: (ctx) => createCodeReviewRuntime(ctx),
    headerActions: () => [
      {
        id: "pull",
        label: t("workspace.actions.pull"),
        loading: pullLoading.value,
        disabled: gitBusy.value || !currentTarget.value,
        onClick: () => void pullWithUi()
      },
      {
        id: "push",
        label: t("workspace.actions.push"),
        loading: pushLoading.value,
        disabled: gitBusy.value || !currentTarget.value,
        onClick: () => void pushWithUi()
      }
    ]
  },
  {
    toolId: "terminal",
    title: () => t("workspace.tools.terminal"),
    icon: CodeOutlined,
    view: TerminalToolView,
    defaultArea: "leftTop",
    allowedAreas: ["leftTop", "rightTop", "leftBottom"],
    keepAlive: true
  }
]);

function isToolEnabled(toolId: ToolId) {
  // 无 repo 时隐藏 code review 以及其关联的 git header actions.
  if (toolId === "codeReview") return hasRepos.value;
  return true;
}

function pickFirstEnabledToolInArea(area: DockArea): ToolId | null {
  const list = toolOrderByArea[area] ?? [];
  for (const id of list) {
    if (!isToolEnabled(id)) continue;
    if (!toolById.value.has(id)) continue;
    if (toolCurrentArea(id) !== area) continue;
    return id;
  }
  return null;
}

function ensureActiveToolInArea(area: DockArea) {
  const cur = activeToolIdByArea[area];
  if (cur && isToolEnabled(cur) && toolById.value.has(cur) && toolCurrentArea(cur) === area) return;
  const next = pickFirstEnabledToolInArea(area);
  activeToolIdByArea[area] = next;
  if (next) toolMinimized[next] = false;
}

const toolById = computed(() => {
  const m = new Map<ToolId, ToolDefinition>();
  for (const tool of tools.value) m.set(tool.toolId, tool);
  return m;
});

const toolArea = reactive<Record<ToolId, DockArea>>({
  codeReview: "leftTop",
  terminal: "leftTop",
  files: "leftTop",
  search: "leftTop"
});

const activeToolIdByArea = reactive<Record<DockArea, ToolId | null>>({
  leftTop: "files",
  leftBottom: null,
  rightTop: null
});

const toolMinimized = reactive<Record<ToolId, boolean>>({
  codeReview: false,
  terminal: true,
  files: false,
  search: false
});
const toolDots = reactive<Record<ToolId, boolean>>({
  codeReview: false,
  terminal: false,
  files: false,
  search: false
});
const toolRuntimes = new Map<ToolId, ToolRuntime>();

function setToolDot(toolId: string, dot: boolean) {
  if (!toolById.value.has(toolId as ToolId)) return;
  const id = toolId as ToolId;
  toolDots[id] = dot;
}

function resetToolDots() {
  for (const id of TOOL_IDS) toolDots[id] = false;
}

function disposeToolRuntimes() {
  for (const runtime of toolRuntimes.values()) runtime.dispose();
  toolRuntimes.clear();
}

function createToolRuntimes() {
  disposeToolRuntimes();
  resetToolDots();
  if (!props.workspaceId) return;
  for (const def of tools.value) {
    if (!isToolEnabled(def.toolId)) continue;
    if (!def.createRuntime) continue;
    const runtime = def.createRuntime({
      workspaceId: props.workspaceId,
      toolId: def.toolId,
      host: { call: (toToolId, call) => callToolFrom(def.toolId, toToolId, call), setToolDot },
  getCurrentTarget: () => currentTarget.value,
  getVisible: () => isToolVisible(def.toolId),
  refreshView: () => toolCommands.get(def.toolId)?.refresh?.(),
  api: { getGitStatus }
});
    toolRuntimes.set(def.toolId, runtime);
    runtime.start();
  }
}

const toolOrderByArea = reactive<Record<DockArea, ToolId[]>>(defaultToolOrderByArea());

const DOCK_LAYOUT_STORAGE_KEY_PREFIX = "agent-workbench.workspace.dockLayout.v2";
const CURRENT_REPO_STORAGE_KEY_PREFIX = "agent-workbench.workspace.currentRepo.v1";

type DockLayoutV2 = {
  version: 2;
  updatedAt: number;
  ratios: { topBottom: number; topLeft: number };
  toolArea: Record<ToolId, DockArea>;
  toolMinimized: Record<ToolId, boolean>;
  activeToolIdByArea: Record<DockArea, ToolId | null>;
  toolOrderByArea: Record<DockArea, ToolId[]>;
};

function dockLayoutStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return DOCK_LAYOUT_STORAGE_KEY_PREFIX;
  return `${DOCK_LAYOUT_STORAGE_KEY_PREFIX}.${id}`;
}

function currentRepoStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return `${CURRENT_REPO_STORAGE_KEY_PREFIX}`;
  return `${CURRENT_REPO_STORAGE_KEY_PREFIX}.${id}`;
}

function isDockArea(v: unknown): v is DockArea {
  return typeof v === "string" && (DOCK_AREAS as string[]).includes(v);
}

function isToolId(v: unknown): v is ToolId {
  return typeof v === "string" && (TOOL_IDS as string[]).includes(v);
}

function clampRatio(n: number) {
  if (!Number.isFinite(n)) return 2 / 3;
  return clamp(n, 0.1, 0.9);
}

function defaultToolOrderByArea(): Record<DockArea, ToolId[]> {
  const res: Record<DockArea, ToolId[]> = { leftTop: [], leftBottom: [], rightTop: [] };
  for (const tool of tools.value) {
    res[tool.defaultArea].push(tool.toolId);
  }
  return res;
}

function normalizeToolOrderByArea(
  toolAreaMap: Record<ToolId, DockArea>,
  raw: Partial<Record<DockArea, unknown>> | null | undefined
) {
  const res: Record<DockArea, ToolId[]> = { leftTop: [], leftBottom: [], rightTop: [] };
  if (raw) {
    for (const area of DOCK_AREAS) {
      const list = (raw as any)[area];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!isToolId(item)) continue;
        if (toolAreaMap[item] !== area) continue;
        if (!res[area].includes(item)) res[area].push(item);
      }
    }
  }
  for (const tool of tools.value) {
    const area = toolAreaMap[tool.toolId] ?? tool.defaultArea;
    if (!res[area].includes(tool.toolId)) res[area].push(tool.toolId);
  }
  return res;
}

function setToolOrderByArea(next: Record<DockArea, ToolId[]>) {
  for (const area of DOCK_AREAS) {
    toolOrderByArea[area] = [...next[area]];
  }
}

function loadDockLayout(workspaceId: string): DockLayoutV2 | null {
  try {
    const raw = localStorage.getItem(dockLayoutStorageKey(workspaceId));
    if (!raw) return null;
    const json = JSON.parse(raw) as Partial<DockLayoutV2> | null;
    if (!json || json.version !== 2) return null;

    const ratios = (json.ratios ?? {}) as Partial<{ topBottom: unknown; topLeft: unknown }>;
    const toolAreaRaw = json.toolArea ?? ({} as any);
    const toolMinimizedRaw = json.toolMinimized ?? ({} as any);
    const activeRaw = json.activeToolIdByArea ?? ({} as any);
    const toolOrderRaw = json.toolOrderByArea ?? ({} as any);

    const toolAreaOut: Record<ToolId, DockArea> = { codeReview: "leftTop", terminal: "leftTop", files: "leftTop", search: "leftTop" };
    for (const toolId of TOOL_IDS) {
      const v = (toolAreaRaw as any)[toolId];
      if (isDockArea(v)) toolAreaOut[toolId] = v;
    }

    const toolMinimizedOut: Record<ToolId, boolean> = { codeReview: false, terminal: true, files: false, search: false };
    for (const toolId of TOOL_IDS) {
      const v = (toolMinimizedRaw as any)[toolId];
      if (typeof v === "boolean") toolMinimizedOut[toolId] = v;
    }

    const activeOut: Record<DockArea, ToolId | null> = { leftTop: "files", leftBottom: null, rightTop: null };
    for (const area of DOCK_AREAS) {
      const v = (activeRaw as any)[area];
      if (v === null) {
        activeOut[area] = null;
      } else if (isToolId(v)) {
        activeOut[area] = v;
      }
    }

    return {
      version: 2,
      updatedAt: typeof json.updatedAt === "number" ? json.updatedAt : Date.now(),
      ratios: {
        topBottom: clampRatio(typeof ratios.topBottom === "number" ? ratios.topBottom : 2 / 3),
        topLeft: clampRatio(typeof ratios.topLeft === "number" ? ratios.topLeft : 2 / 3)
      },
      toolArea: toolAreaOut,
      toolMinimized: toolMinimizedOut,
      activeToolIdByArea: activeOut,
      toolOrderByArea: normalizeToolOrderByArea(toolAreaOut, toolOrderRaw)
    };
  } catch {
    return null;
  }
}

function restoreCurrentRepo(ws: WorkspaceDetail | null) {
  const list = ws?.repos ?? [];
  if (list.length === 0) {
    currentRepoDirName.value = "";
    return;
  }

  let preferred = "";
  try {
    preferred = localStorage.getItem(currentRepoStorageKey(ws?.id ?? props.workspaceId)) || "";
  } catch {
    preferred = "";
  }

  const next = list.find((r) => r.dirName === preferred)?.dirName ?? list[0]!.dirName;
  currentRepoDirName.value = next;
}

function setCurrentRepo(dirName: string) {
  if (!dirName) return;
  currentRepoDirName.value = dirName;
}

function saveDockLayout(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return;
  try {
    const data: DockLayoutV2 = {
      version: 2,
      updatedAt: Date.now(),
      ratios: { topBottom: topBottomRatio.value, topLeft: topLeftRatio.value },
      toolArea: { codeReview: toolArea.codeReview, terminal: toolArea.terminal, files: toolArea.files, search: toolArea.search },
      toolMinimized: {
        codeReview: toolMinimized.codeReview,
        terminal: toolMinimized.terminal,
        files: toolMinimized.files,
        search: toolMinimized.search
      },
      activeToolIdByArea: {
        leftTop: activeToolIdByArea.leftTop,
        leftBottom: activeToolIdByArea.leftBottom,
        rightTop: activeToolIdByArea.rightTop
      },
      toolOrderByArea: {
        leftTop: [...toolOrderByArea.leftTop],
        leftBottom: [...toolOrderByArea.leftBottom],
        rightTop: [...toolOrderByArea.rightTop]
      }
    };
    localStorage.setItem(dockLayoutStorageKey(workspaceId), JSON.stringify(data));
  } catch {
    // ignore
  }
}

const restoringDockLayout = ref(false);
let saveDockLayoutTimer: number | null = null;

function scheduleSaveDockLayout() {
  if (restoringDockLayout.value) return;
  if (!props.workspaceId) return;
  if (saveDockLayoutTimer !== null) window.clearTimeout(saveDockLayoutTimer);
  saveDockLayoutTimer = window.setTimeout(() => {
    saveDockLayoutTimer = null;
    saveDockLayout(props.workspaceId);
  }, 120);
}

function resetDockLayoutDefaults() {
  toolArea.codeReview = "leftTop";
  toolArea.terminal = "leftTop";
  toolArea.files = "leftTop";
  toolArea.search = "leftTop";
  activeToolIdByArea.leftTop = "files";
  activeToolIdByArea.leftBottom = null;
  activeToolIdByArea.rightTop = null;
  toolMinimized.codeReview = false;
  toolMinimized.terminal = true;
  toolMinimized.files = false;
  toolMinimized.search = false;
  setToolOrderByArea(defaultToolOrderByArea());
  topBottomRatio.value = 2 / 3;
  topLeftRatio.value = 2 / 3;
}

function applyDockLayout(layout: DockLayoutV2) {
  topBottomRatio.value = clampRatio(layout.ratios.topBottom);
  topLeftRatio.value = clampRatio(layout.ratios.topLeft);

  for (const toolId of TOOL_IDS) {
    const def = toolById.value.get(toolId);
    const nextArea = layout.toolArea[toolId];
    if (def && def.allowedAreas.includes(nextArea)) {
      toolArea[toolId] = nextArea;
    } else if (def) {
      toolArea[toolId] = def.defaultArea;
    }
    toolMinimized[toolId] = Boolean(layout.toolMinimized[toolId]);
  }

  setToolOrderByArea(normalizeToolOrderByArea(toolArea, layout.toolOrderByArea));

  for (const area of DOCK_AREAS) {
    const next = layout.activeToolIdByArea[area];
    if (!next) {
      activeToolIdByArea[area] = null;
      continue;
    }
    if (!toolById.value.has(next)) {
      activeToolIdByArea[area] = null;
      continue;
    }
    if (!isToolEnabled(next)) {
      activeToolIdByArea[area] = null;
      continue;
    }
    if (toolCurrentArea(next) !== area) {
      activeToolIdByArea[area] = null;
      continue;
    }
    activeToolIdByArea[area] = next;
  }

  for (const area of DOCK_AREAS) ensureActiveToolInArea(area);
}

async function clampDockRatiosToContainer() {
  const center = centerEl.value;
  if (center) {
    const h = center.getBoundingClientRect().height;
    if (Number.isFinite(h) && h > 0) {
      topBottomRatio.value = clampRatioByContainer({ ratio: topBottomRatio.value, containerSize: h, minStartPx: MIN_TOP_PX, minEndPx: MIN_BOTTOM_PX });
    }
  }
  const top = topEl.value;
  if (top) {
    const w = top.getBoundingClientRect().width;
    if (Number.isFinite(w) && w > 0) {
      topLeftRatio.value = clampRatioByContainer({ ratio: topLeftRatio.value, containerSize: w, minStartPx: MIN_TOP_LEFT_PX, minEndPx: MIN_TOP_RIGHT_PX });
    }
  }
}

async function restoreDockLayout(workspaceId: string) {
  let hasSaved = false;
  restoringDockLayout.value = true;
  try {
    resetDockLayoutDefaults();
    const saved = loadDockLayout(workspaceId);
    if (saved) {
      hasSaved = true;
      applyDockLayout(saved);
    }
  } finally {
    restoringDockLayout.value = false;
  }
  await nextTick();
  await clampDockRatiosToContainer();
  if (hasSaved) saveDockLayout(workspaceId);
}

function toolCurrentArea(toolId: ToolId): DockArea {
  return toolArea[toolId] ?? toolById.value.get(toolId)?.defaultArea ?? "leftTop";
}

function isToolVisible(toolId: ToolId) {
  const area = toolCurrentArea(toolId);
  return activeToolIdByArea[area] === toolId && !toolMinimized[toolId];
}

function callToolFrom(fromToolId: string, toToolId: string, call: ToolCall) {
  const toId = toToolId as ToolId;
  if (!toolById.value.has(toId)) return;
  const toArea = toolCurrentArea(toId);
  const fromId = toolById.value.has(fromToolId as ToolId) ? (fromToolId as ToolId) : null;
  const fromArea = fromId ? toolCurrentArea(fromId) : null;
  const targetVisible = isToolVisible(toId);
  if (fromArea && fromArea === toArea) {
    activeToolIdByArea[toArea] = toId;
    toolMinimized[toId] = false;
  } else if (!targetVisible) {
    activeToolIdByArea[toArea] = toId;
    toolMinimized[toId] = false;
  }
  const envelope: ToolCallEnvelope = {
    type: call.type,
    payload: call.payload,
    fromToolId,
    toToolId,
    workspaceId: props.workspaceId,
    targetAtCall: currentTarget.value ?? null,
    ts: Date.now()
  };
  // 无条件延后到下一个 tick 再派发 call:
  // - 避免“首次展示”工具时 ToolView 尚未挂载完成，导致丢失调用(例如 files.openAt)
  // - 也能覆盖某些 UI/KeepAlive 的时序差异(先稳定再派发)
  void nextTick().then(() => {
    toolRuntimes.get(toId)?.onCall(envelope);
  });
}

function openTool(toolId: string) {
  if (!toolById.value.has(toolId as ToolId)) return;
  const id = toolId as ToolId;
  const area = toolCurrentArea(id);
  activeToolIdByArea[area] = id;
  toolMinimized[id] = false;
}

function minimizeTool(toolId: string) {
  if (!toolById.value.has(toolId as ToolId)) return;
  const id = toolId as ToolId;
  toolMinimized[id] = true;
}

function toggleMinimize(toolId: string) {
  if (!toolById.value.has(toolId as ToolId)) return;
  const id = toolId as ToolId;
  toolMinimized[id] = !toolMinimized[id];
}

const toolCommands = new Map<ToolId, WorkspaceToolCommandMap>();
const toolEventQueue = new Map<ToolId, WorkspaceToolEvent[]>();

function registerToolCommands(toolId: string, commands: WorkspaceToolCommandMap) {
  if (!toolById.value.has(toolId as ToolId)) return () => {};
  const id = toolId as ToolId;
  toolCommands.set(id, commands);
  return () => {
    const existing = toolCommands.get(id);
    if (existing === commands) toolCommands.delete(id);
  };
}

function emitToolEvent(toolId: string, event: WorkspaceToolEvent) {
  if (!toolById.value.has(toolId as ToolId)) return;
  const id = toolId as ToolId;
  const list = toolEventQueue.get(id) ?? [];
  list.push(event);
  toolEventQueue.set(id, list);
}

function drainToolEvents(toolId: string) {
  if (!toolById.value.has(toolId as ToolId)) return [];
  const id = toolId as ToolId;
  const list = toolEventQueue.get(id) ?? [];
  toolEventQueue.delete(id);
  return list;
}

const hostApi: WorkspaceHostApi = {
  openTool,
  minimizeTool,
  toggleMinimize,
  callFrom: callToolFrom,
  setToolDot,
  registerToolCommands,
  emitToolEvent,
  drainToolEvents
};

provide(workspaceHostKey, hostApi);
provide(workspaceContextKey, {
  repos: workspaceRepos,
  currentRepo,
  currentTarget,
  setCurrentRepo,
  statusByDirName: repoStatusByDirName
});

function onToolIconClick(toolId: ToolId) {
  if (!isToolEnabled(toolId)) return;
  const area = toolCurrentArea(toolId);
  if (activeToolIdByArea[area] === toolId) {
    toolMinimized[toolId] = !toolMinimized[toolId];
    return;
  }
  activeToolIdByArea[area] = toolId;
  toolMinimized[toolId] = false;
}

watch(
  () => hasRepos.value,
  () => {
    // repo 变更时,若当前激活工具不可用(例如 codeReview),回退到该区域的第一个可用工具.
    for (const area of DOCK_AREAS) ensureActiveToolInArea(area);
  },
  { immediate: true }
);

const visibleToolIdByArea = computed(() => {
  const res: Record<DockArea, ToolId | null> = { leftTop: null, leftBottom: null, rightTop: null };
  (Object.keys(res) as DockArea[]).forEach((area) => {
    const id = activeToolIdByArea[area];
    if (!id) return;
    if (!isToolEnabled(id)) return;
    if (toolCurrentArea(id) !== area) return;
    if (toolMinimized[id]) return;
    res[area] = id;
  });
  return res;
});

// KeepAlive 默认会长期缓存同一位置曾经渲染过的工具实例。
// 当工具从某个区域移动到另一个区域时,旧区域的 KeepAlive 必须及时剔除该工具缓存,
// 否则像终端这种"独占连接"的资源会出现两个实例同时连接并触发 occupied.
const keepAliveIncludeByArea = computed(() => {
  const res: Record<DockArea, string[]> = { leftTop: [], leftBottom: [], rightTop: [] };
  for (const id of TOOL_IDS) {
    if (!isToolEnabled(id)) continue;
    if (!isKeepAlive(id)) continue;
    const area = toolCurrentArea(id);
    res[area].push(id);
  }
  return res;
});

const toolVisibleById = computed(() => {
  const out: Record<ToolId, boolean> = { codeReview: false, terminal: false, files: false, search: false };
  for (const id of TOOL_IDS) out[id] = isToolEnabled(id) && isToolVisible(id);
  return out;
});

const leftTopToolbarToolIds = computed<ToolId[]>(() => toolOrderByArea.leftTop.filter((id) => isToolEnabled(id) && toolCurrentArea(id) === "leftTop"));
const leftBottomToolbarToolIds = computed<ToolId[]>(() => toolOrderByArea.leftBottom.filter((id) => isToolEnabled(id) && toolCurrentArea(id) === "leftBottom"));
const rightToolbarToolIds = computed<ToolId[]>(() => toolOrderByArea.rightTop.filter((id) => isToolEnabled(id) && toolCurrentArea(id) === "rightTop"));

function removeToolFromOrder(toolId: ToolId) {
  for (const area of DOCK_AREAS) {
    const list = toolOrderByArea[area];
    const index = list.indexOf(toolId);
    if (index >= 0) list.splice(index, 1);
  }
}

function moveToolToOrderEnd(toolId: ToolId, targetArea: DockArea) {
  removeToolFromOrder(toolId);
  toolOrderByArea[targetArea].push(toolId);
}

function moveToolOrderByStep(toolId: ToolId, step: number) {
  const area = toolCurrentArea(toolId);
  const list = toolOrderByArea[area];
  const index = list.indexOf(toolId);
  if (index < 0) return;
  const next = index + step;
  if (next < 0 || next >= list.length) return;
  list.splice(index, 1);
  list.splice(next, 0, toolId);
}

function canMoveToolUp(toolId: ToolId) {
  const area = toolCurrentArea(toolId);
  const list = toolOrderByArea[area];
  return list.indexOf(toolId) > 0;
}

function canMoveToolDown(toolId: ToolId) {
  const area = toolCurrentArea(toolId);
  const list = toolOrderByArea[area];
  const index = list.indexOf(toolId);
  return index >= 0 && index < list.length - 1;
}

function moveToolUp(toolId: ToolId) {
  if (!canMoveToolUp(toolId)) return;
  moveToolOrderByStep(toolId, -1);
}

function moveToolDown(toolId: ToolId) {
  if (!canMoveToolDown(toolId)) return;
  moveToolOrderByStep(toolId, 1);
}

function moveTool(toolId: ToolId, targetArea: DockArea) {
  const def = toolById.value.get(toolId);
  if (!def) return;
  if (!def.allowedAreas.includes(targetArea)) return;

  const fromArea = toolCurrentArea(toolId);
  if (fromArea === targetArea) return;

  const wasVisible = visibleToolIdByArea.value[fromArea] === toolId;
  const wasActive = activeToolIdByArea[fromArea] === toolId;
  const targetHasVisible = Boolean(visibleToolIdByArea.value[targetArea]);

  toolArea[toolId] = targetArea;
  moveToolToOrderEnd(toolId, targetArea);
  if (wasVisible || wasActive) ensureActiveToolInArea(fromArea);

  if (wasVisible && !targetHasVisible) {
    activeToolIdByArea[targetArea] = toolId;
    toolMinimized[toolId] = false;
    return;
  }

  if (!wasVisible && wasActive && !targetHasVisible && !activeToolIdByArea[targetArea]) {
    activeToolIdByArea[targetArea] = toolId;
  }
}

function areaLabel(area: DockArea) {
  if (area === "leftTop") return t("workspace.dock.areas.leftTop");
  if (area === "leftBottom") return t("workspace.dock.areas.leftBottom");
  return t("workspace.dock.areas.rightTop");
}

function toolTitle(toolId: ToolId) {
  return toolById.value.get(toolId)?.title() ?? toolId;
}

function toolIcon(toolId: ToolId) {
  return toolById.value.get(toolId)?.icon ?? CodeOutlined;
}

function moveTargets(toolId: ToolId) {
  const def = toolById.value.get(toolId);
  if (!def) return [] as { area: DockArea; label: string }[];
  const cur = toolCurrentArea(toolId);
  return def.allowedAreas
    .filter((a) => a !== cur)
    .map((area) => ({ area, label: t("workspace.dock.moveTo", { area: areaLabel(area) }) }));
}

function contextMenuHint(toolId: ToolId) {
  return t("workspace.dock.pinnedAt", { area: areaLabel(toolCurrentArea(toolId)) });
}

function toolView(toolId: ToolId) {
  return toolById.value.get(toolId)?.view ?? null;
}

function isKeepAlive(toolId: ToolId) {
  return Boolean(toolById.value.get(toolId)?.keepAlive);
}

function toolViewProps(toolId: ToolId) {
  if (toolId === "codeReview") {
    return {
      workspaceId: props.workspaceId,
      target: currentTarget.value,
      toolId,
      gitBusy: gitBusy.value,
      beginGitOp,
      push: (params?: PushParams) => pushWithUi(params)
    };
  }
  if (toolId === "files") {
    return {
      workspaceId: props.workspaceId,
      toolId,
      workspaceDirName: workspace.value?.dirName ?? "",
      workspaceRepos: workspace.value?.repos ?? []
    };
  }
  if (toolId === "search") {
    return {
      workspaceId: props.workspaceId,
      toolId,
      workspaceRepos: workspace.value?.repos ?? [],
      currentRepoDirName: currentRepoDirName.value
    };
  }
  return { workspaceId: props.workspaceId, toolId };
}

function toolViewListeners(toolId: ToolId) {
  if (toolId === "codeReview") return { changesSummary: onChangesSummary };
  return {};
}

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
const branches = ref<GitBranchesResponse["branches"]>([]);
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

const repoDisplayName = computed(() => (currentRepo.value ? formatRepoDisplayName(currentRepo.value.repo.url) : ""));

function filterRepoOption(input: string, option: any) {
  const hay = String(option?.label ?? option?.children ?? "").toLowerCase();
  return hay.includes(input.toLowerCase());
}

function buildPageTitle(ws: WorkspaceDetail | null) {
  const base = t("app.title");
  if (!ws) return `${t("workspace.title")} - ${base}`;

  const title = ws.title || t("workspace.title");
  const repoName = currentRepo.value ? formatRepoDisplayName(currentRepo.value.repo.url) : "";
  const status = currentRepoStatus.value;
  const branch = status?.head?.detached ? t("workspace.repoSelector.detached") : (status?.head?.branch ?? "");

  if (repoName && branch) return `${title} · ${repoName}@${branch} - ${base}`;
  if (repoName) return `${title} · ${repoName} - ${base}`;
  return `${title} - ${base}`;
}

function applyPageTitle() {
  document.title = buildPageTitle(workspace.value);
}

const pushLoading = ref(false);
const pullLoading = ref(false);

const pushIdentityOpen = ref(false);
const pendingPushParams = ref<PushParams>({});
const pushIdentitySubmitting = ref(false);

const headerActionGroups = computed(() => {
  const order: DockArea[] = ["leftTop", "leftBottom", "rightTop"];
  const res: { key: string; actions: HeaderAction[] }[] = [];
  for (const area of order) {
    const toolId = visibleToolIdByArea.value[area];
    if (!toolId) continue;
    const def = toolById.value.get(toolId);
    const actions = def?.headerActions?.() ?? [];
    if (actions.length === 0) continue;
    res.push({ key: `${area}:${toolId}`, actions });
  }
  return res;
});

const checkoutOpen = ref(false);
const checkoutLoading = ref(false);
const checkoutBranch = ref<string>("");
const canCheckout = computed(() => {
  if (!currentTarget.value) return false;
  if (gitBusy.value) return false;
  const next = checkoutBranch.value.trim();
  if (!next) return false;
  const currentBranch = currentRepoStatus.value?.head?.branch ?? "";
  return next !== currentBranch;
});

const SPLITTER_PX = 6;
const MIN_TOP_PX = 240;
const MIN_BOTTOM_PX = 120;
const MIN_TOP_LEFT_PX = 280;
const MIN_TOP_RIGHT_PX = 240;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function clampRatioByContainer(params: { ratio: number; containerSize: number; minStartPx: number; minEndPx: number }) {
  const { containerSize, minStartPx, minEndPx } = params;
  if (!Number.isFinite(containerSize) || containerSize <= 0) return clamp(params.ratio, 0.1, 0.9);
  const min = minStartPx / containerSize;
  const max = 1 - minEndPx / containerSize;
  if (min >= max) return clamp(params.ratio, 0.1, 0.9);
  return clamp(params.ratio, min, max);
}

const centerEl = ref<HTMLElement | null>(null);
const topEl = ref<HTMLElement | null>(null);

function setCenterEl(el: Element | ComponentPublicInstance | null) {
  centerEl.value = el as HTMLElement | null;
}

function setTopEl(el: Element | ComponentPublicInstance | null) {
  topEl.value = el as HTMLElement | null;
}

const topBottomRatio = ref(2 / 3);
const topLeftRatio = ref(2 / 3);

watch(
  () => props.workspaceId,
  (workspaceId) => {
    if (!workspaceId) return;
    void restoreDockLayout(workspaceId);
  },
  { immediate: true }
);

watch(
  () => props.workspaceId,
  () => {
    createToolRuntimes();
  },
  { immediate: true }
);

watch(
  () => hasRepos.value,
  () => {
    // repo 从有到无(或从无到有)时,重建 runtimes,避免 codeReview runtime 残留或缺失.
    createToolRuntimes();
  }
);

watch(toolArea, scheduleSaveDockLayout, { deep: true });
watch(toolMinimized, scheduleSaveDockLayout, { deep: true });
watch(activeToolIdByArea, scheduleSaveDockLayout, { deep: true });
watch(toolOrderByArea, scheduleSaveDockLayout, { deep: true });
watch(
  toolVisibleById,
  (next, prev) => {
    for (const id of TOOL_IDS) {
      const wasVisible = prev?.[id] ?? false;
      const isVisible = next[id];
      if (wasVisible === isVisible) continue;
      toolRuntimes.get(id)?.onVisibilityChange(isVisible);
    }
  },
  { deep: true, immediate: true }
);
watch(
  () => currentRepoDirName.value,
  (dirName) => {
    if (!dirName) return;
    try {
      localStorage.setItem(currentRepoStorageKey(props.workspaceId), dirName);
    } catch {
      // ignore
    }
  }
);
watch(
  () => currentTarget.value?.dirName,
  async () => {
    const nextTarget = currentTarget.value ?? null;
    for (const id of TOOL_IDS) toolRuntimes.get(id)?.onRepoChange(nextTarget);
    checkoutBranch.value = "";
    await refreshCurrentRepoStatus();
    await refreshBranches();
    applyPageTitle();
  }
);
watch(
  () => workspaceRepos.value.map((r) => r.dirName).join(","),
  () => {
    const list = workspaceRepos.value;
    if (list.length === 0) {
      currentRepoDirName.value = "";
      return;
    }
    if (!list.some((r) => r.dirName === currentRepoDirName.value)) {
      restoreCurrentRepo(workspace.value);
    }
  }
);

const showLeftTop = computed(() => Boolean(visibleToolIdByArea.value.leftTop));
const showRightTop = computed(() => Boolean(visibleToolIdByArea.value.rightTop));
const showBottom = computed(() => Boolean(visibleToolIdByArea.value.leftBottom));
const showTop = computed(() => showLeftTop.value || showRightTop.value);

const showTopColsSplitter = computed(() => showLeftTop.value && showRightTop.value);
const showTopBottomSplitter = computed(() => showTop.value && showBottom.value);

const centerStyle = computed(() => {
  if (showTop.value && showBottom.value) {
    return {
      gridTemplateRows: `${topBottomRatio.value}fr ${(1 - topBottomRatio.value).toFixed(6)}fr`,
      minHeight: 0,
      height: "100%"
    } as const;
  }
  return {
    gridTemplateRows: "1fr",
    minHeight: 0,
    height: "100%"
  } as const;
});

const topStyle = computed(() => {
  if (showLeftTop.value && showRightTop.value) {
    return {
      gridTemplateColumns: `${topLeftRatio.value}fr ${(1 - topLeftRatio.value).toFixed(6)}fr`,
      minWidth: 0,
      width: "100%"
    } as const;
  }
  return {
    gridTemplateColumns: "1fr",
    minWidth: 0,
    width: "100%"
  } as const;
});

const splitterClassBase =
  "bg-transparent hover:bg-[var(--border-color-secondary)] active:bg-[var(--border-color)] transition-colors duration-100 select-none";
const splitterClassRow = `${splitterClassBase} cursor-row-resize`;
const splitterClassCol = `${splitterClassBase} cursor-col-resize`;

const topBottomSplitterStyle = computed(() => {
  if (!showTopBottomSplitter.value) return {};
  const offset = `${-(SPLITTER_PX / 2)}px`;
  return {
    position: "absolute",
    top: `calc(${(topBottomRatio.value * 100).toFixed(4)}% + ${offset})`,
    left: "0",
    right: "0",
    height: `${SPLITTER_PX}px`,
    zIndex: 10,
    touchAction: "none"
  } as const;
});

const topColsSplitterStyle = computed(() => {
  if (!showTopColsSplitter.value) return {};
  const offset = `${-(SPLITTER_PX / 2)}px`;
  return {
    position: "absolute",
    left: `calc(${(topLeftRatio.value * 100).toFixed(4)}% + ${offset})`,
    top: "0",
    width: `${SPLITTER_PX}px`,
    height: "100%",
    zIndex: 10,
    touchAction: "none"
  } as const;
});

let draggingCleanup: (() => void) | null = null;

function onTopBottomSplitterPointerDown(evt: PointerEvent) {
  if (!showTopBottomSplitter.value) return;
  const el = centerEl.value;
  if (!el) return;

  evt.preventDefault();
  evt.stopPropagation();

  const rect = el.getBoundingClientRect();
  const containerSize = rect.height;
  if (!Number.isFinite(containerSize) || containerSize <= 0) return;

  const prevUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";

  const handleMove = (e: PointerEvent) => {
    const nextRaw = (e.clientY - rect.top) / rect.height;
    const next = clampRatioByContainer({ ratio: nextRaw, containerSize, minStartPx: MIN_TOP_PX, minEndPx: MIN_BOTTOM_PX });
    topBottomRatio.value = next;
  };

  const handleUp = () => {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    document.body.style.userSelect = prevUserSelect;
    draggingCleanup = null;
    saveDockLayout(props.workspaceId);
  };

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp);
  draggingCleanup = handleUp;
}

function onTopColsSplitterPointerDown(evt: PointerEvent) {
  if (!showTopColsSplitter.value) return;
  const el = topEl.value;
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
    const next = clampRatioByContainer({ ratio: nextRaw, containerSize, minStartPx: MIN_TOP_LEFT_PX, minEndPx: MIN_TOP_RIGHT_PX });
    topLeftRatio.value = next;
  };

  const handleUp = () => {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    document.body.style.userSelect = prevUserSelect;
    draggingCleanup = null;
    saveDockLayout(props.workspaceId);
  };

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp);
  draggingCleanup = handleUp;
}

async function refreshWorkspace() {
  workspace.value = await getWorkspace(props.workspaceId);
  applyPageTitle();
  restoreCurrentRepo(workspace.value);
}

async function refreshCurrentRepoStatus() {
  const target = currentTarget.value;
  if (!target) return;
  try {
    const res = await getGitStatus({ target });
    repoStatusByDirName[target.dirName] = res;
  } catch {
    repoStatusByDirName[target.dirName] = null;
  }
}

async function refreshChangesSummary() {
  try {
    const target = currentTarget.value;
    if (!target) {
      changesSummary.value = { unstaged: 0, staged: 0 };
      return changesSummary.value;
    }
    const [unstagedRes, stagedRes] = await Promise.all([
      listChanges(target, { mode: "unstaged" }),
      listChanges(target, { mode: "staged" })
    ]);
    changesSummary.value = { unstaged: unstagedRes.files.length, staged: stagedRes.files.length };
  } catch {
    // ignore
  }
  return changesSummary.value;
}

async function refreshBranches() {
  const target = currentTarget.value;
  if (!target) {
    branches.value = [];
    repoDefaultBranch.value = null;
    return;
  }
  branchesLoading.value = true;
  try {
    const res = await gitBranches({ target, fetch: false });
    branches.value = res.branches;
    repoDefaultBranch.value = res.defaultBranch ?? null;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    branchesLoading.value = false;
  }
}

function pickCheckoutBranch(params: { branches: GitBranchesResponse["branches"]; defaultBranch: string | null }) {
  const existing = checkoutBranch.value.trim();
  if (existing && params.branches.some((b) => b.name === existing)) return existing;

  const currentBranch = currentRepoStatus.value?.head?.branch ?? "";
  if (currentBranch && params.branches.some((b) => b.name === currentBranch)) return currentBranch;

  if (params.defaultBranch && params.branches.some((b) => b.name === params.defaultBranch)) return params.defaultBranch;
  return params.branches[0]?.name ?? "";
}

async function refreshBranchesWithSync() {
  const target = currentTarget.value;
  if (!target) return;
  if (gitBusy.value) return;
  if (refreshBranchesLoading.value) return;

  refreshBranchesLoading.value = true;
  try {
    const res = await gitBranches({ target, fetch: true });
    branches.value = res.branches;
    repoDefaultBranch.value = res.defaultBranch ?? null;
    checkoutBranch.value = pickCheckoutBranch({ branches: res.branches, defaultBranch: repoDefaultBranch.value });
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
    await refreshWorkspace();
    await refreshBranches();
    await refreshCurrentRepoStatus();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

async function openCheckout() {
  if (!currentTarget.value) return;
  if (gitBusy.value) return;
  await refreshBranches();
  checkoutBranch.value = pickCheckoutBranch({ branches: branches.value, defaultBranch: repoDefaultBranch.value });
  checkoutOpen.value = true;
}

async function submitCheckout() {
  if (!currentTarget.value) return;
  if (!canCheckout.value) return;
  const nextBranch = checkoutBranch.value.trim();

  const summary = await refreshChangesSummary();
  const hasChanges = summary.unstaged + summary.staged > 0;
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
  const target = currentTarget.value;
  if (!target) return;
  const release = beginGitOp();
  checkoutLoading.value = true;
  try {
    await gitCheckout({ target, branch: nextBranch });
    await refreshCurrentRepoStatus();
    await refreshBranches();
    await toolCommands.get("codeReview")?.refresh?.();
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
  const target = currentTarget.value;
  if (!target) return;
  if (gitBusy.value) return;

  const summary = await refreshChangesSummary();
  const hasChanges = summary.unstaged + summary.staged > 0;
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
  const target = currentTarget.value;
  if (!target) return;
  const release = beginGitOp();
  pullLoading.value = true;
  try {
    const res = await pullWorkspace({ target });
    if (res.updated) message.success(t("workspace.pull.updated"));
    else message.success(t("workspace.pull.upToDate"));
    await toolCommands.get("codeReview")?.refresh?.();
    await refreshCurrentRepoStatus();
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError({ message: err instanceof Error ? err.message : String(err) });
    message.error(e.message);
  } finally {
    release();
    pullLoading.value = false;
  }
}

async function pushWithUi(params: PushParams = {}) {
  const target = currentTarget.value;
  if (!target) return;
  if (gitBusy.value) return;

  // push 本身不依赖 user.name/email，但这里提前确保身份已配置，避免用户在“提交并推送/终端提交”时再次踩坑
  try {
    const st = await getWorkspaceGitIdentity({ target });
    if (st.effective.source === "none") {
      pendingPushParams.value = params;
      pushIdentityOpen.value = true;
      return;
    }
  } catch {
    // ignore
  }

  const release = beginGitOp();
  pushLoading.value = true;
  try {
    const res = await pushWorkspace({ target, ...params });
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

async function onPushIdentitySubmit(identity: any) {
  const target = currentTarget.value;
  if (!target) return;
  if (gitBusy.value) return;

  const release = beginGitOp();
  pushLoading.value = true;
  pushIdentitySubmitting.value = true;
  try {
    if (identity?.scope === "repo") {
      await setWorkspaceGitIdentity({ target, name: identity.name, email: identity.email });
    } else if (identity?.scope === "global") {
      await updateGitGlobalIdentity({ name: identity.name, email: identity.email });
    } else {
      return;
    }
    pushIdentityOpen.value = false;
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError({ message: err instanceof Error ? err.message : String(err) });
    message.error(e.message);
    return;
  } finally {
    release();
    pushLoading.value = false;
    pushIdentitySubmitting.value = false;
  }

  const params = pendingPushParams.value ?? {};
  pendingPushParams.value = {};
  await pushWithUi(params);
}

watch(
  () => currentRepo.value?.repo.id ?? "",
  async () => {
    branches.value = [];
    repoDefaultBranch.value = null;
    if (currentRepo.value) await refreshBranches();
  }
);

onMounted(() => {
  applyPageTitle();
  void refresh();
});

onBeforeUnmount(() => {
  document.title = t("app.title");
  draggingCleanup?.();
  if (saveDockLayoutTimer !== null) window.clearTimeout(saveDockLayoutTimer);
  saveDockLayoutTimer = null;
  disposeToolRuntimes();
});
</script>
