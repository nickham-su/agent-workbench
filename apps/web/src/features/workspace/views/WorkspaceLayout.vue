<template>
  <a-layout class="min-h-screen !bg-[var(--app-bg)]">
    <WorkspaceHeader :workspace="workspace" :header-action-groups="headerActionGroups" />

    <a-layout-content class="p-0 h-[calc(100vh-64px)] border-t border-[var(--border-color-secondary)]">
      <WorkspaceDock
        :left-top-toolbar-tool-ids="leftTopToolbarToolIds"
        :left-bottom-toolbar-tool-ids="leftBottomToolbarToolIds"
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
    :target="pendingPush?.target ?? null"
    :allowSession="false"
    :defaultScope="'repo'"
    :loading="pushIdentitySubmitting"
    @submit="onPushIdentitySubmit"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch, type ComponentPublicInstance } from "vue";
import { Modal, message } from "ant-design-vue";
import { ClockCircleOutlined, CodeOutlined, DownOutlined, EditOutlined, FolderOpenOutlined, RobotOutlined, SearchOutlined, UpOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import type { GitBranchesResponse, GitPushRequest, GitStatusResponse, GitTarget, WorkspaceDetail, WorkspaceGitStatusResponse } from "@agent-workbench/shared";
import {
  ApiError,
  gitBranches,
  gitCheckout,
  getWorkspaceGitStatus,
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
import { allowedToolAreas, DOCK_AREAS, globalToolLayout, moveGlobalTool, moveGlobalToolByStep, TOOL_IDS, toolLayoutArea } from "@/features/workspace/toolLayout";
import CodeReviewIcon from "../icons/CodeReviewIcon.vue";
import EnvironmentVariablesIcon from "../icons/EnvironmentVariablesIcon.vue";
import CodeReviewToolView from "../tools/code-review/CodeReviewToolView.vue";
import { createSearchRuntime } from "../tools/search/runtime";
import FileExplorerToolView from "../tools/file-explorer/FileExplorerToolView.vue";
import SearchToolView from "../tools/search/SearchToolView.vue";
import TerminalToolView from "../tools/terminal/TerminalToolView.vue";
import AgentToolView from "../tools/agent/AgentToolView.vue";
import ScheduledTasksToolView from "../tools/scheduled-tasks/ScheduledTasksToolView.vue";
import EnvironmentVariablesToolView from "../tools/environment-variables/EnvironmentVariablesToolView.vue";
import EditorToolView from "../tools/editor/EditorToolView.vue";
import GitIdentityModal from "@/shared/components/GitIdentityModal.vue";
import { createCodeReviewRuntime } from "@/features/workspace/tools/code-review/runtime";
import { createFileExplorerRuntime } from "@/features/workspace/tools/file-explorer/runtime";
import { createEditorRuntime } from "@/features/workspace/tools/editor/runtime";

const props = defineProps<{ workspaceId: string; previewEnabled: boolean }>();
const { t } = useI18n();
type PushParams = Omit<GitPushRequest, "target">;

const toolOrderByArea = globalToolLayout;
type ToolDefinition = {
  toolId: ToolId;
  title: () => string;
  icon: any;
  view: any;
  keepAlive?: boolean;
  headerActions?: () => HeaderAction[];
  createRuntime?: (ctx: ToolRuntimeContext) => ToolRuntime;
};

const loading = ref(false);
const workspace = ref<WorkspaceDetail | null>(null);
const currentRepoDirName = ref<string>("");
const repoStatusByDirName = reactive<Record<string, GitStatusResponse | null>>({});
const repoDefaultBranch = ref<string | null>(null);
const workspaceGitStatus = ref<WorkspaceGitStatusResponse>({ repos: [] });

const workspaceRepos = computed(() => workspace.value?.repos ?? []);
const currentRepo = computed(() => workspaceRepos.value.find((r) => r.dirName === currentRepoDirName.value) ?? null);
const currentTarget = computed(() => {
  if (!currentRepo.value) return null;
  return { kind: "workspaceRepo", workspaceId: props.workspaceId, dirName: currentRepo.value.dirName } as const;
});
const editorDiffTabActive = ref(false);

const tools = computed<ToolDefinition[]>(() => [
  {
    toolId: "files",
    title: () => t("workspace.tools.files"),
    icon: FolderOpenOutlined,
    view: FileExplorerToolView,
    keepAlive: true,
    createRuntime: (ctx) => createFileExplorerRuntime(ctx)
  },
  {
    toolId: "search",
    title: () => t("workspace.tools.search"),
    icon: SearchOutlined,
    view: SearchToolView,
    keepAlive: true,
    createRuntime: (ctx) => createSearchRuntime(ctx)
  },
  {
    toolId: "codeReview",
    title: () => t("workspace.tools.codeReview"),
    icon: CodeReviewIcon,
    view: CodeReviewToolView,
    keepAlive: true,
    createRuntime: (ctx) => createCodeReviewRuntime(ctx)
  },
  {
    toolId: "terminal",
    title: () => t("workspace.tools.terminal"),
    icon: CodeOutlined,
    view: TerminalToolView,
    keepAlive: true
  },
  {
    toolId: "scheduledTasks",
    title: () => t("workspace.tools.scheduledTasks"),
    icon: ClockCircleOutlined,
    view: ScheduledTasksToolView,
    keepAlive: true
  },
  {
    toolId: "environmentVariables",
    title: () => t("workspace.tools.environmentVariables"),
    icon: EnvironmentVariablesIcon,
    view: EnvironmentVariablesToolView,
    // Release plaintext and in-flight UI state when leaving this tool.
    keepAlive: false
  },
  {
    toolId: "agent",
    title: () => t("workspace.tools.agent"),
    icon: RobotOutlined,
    view: AgentToolView,
    keepAlive: true
  },
  {
    toolId: "editor",
    title: () => t("workspace.tools.editor"),
    icon: EditOutlined,
    view: EditorToolView,
    createRuntime: (ctx) => createEditorRuntime(ctx),
    headerActions: () => [
      ...(editorDiffTabActive.value ? [
      {
        id: "editor.prevDiff",
        tooltip: t("workspace.actions.previousChange"),
        groupKey: "editor.diffNav",
        icon: UpOutlined,
        onClick: () => {
          void toolCommands.get("editor")?.goToPreviousDiff?.();
        }
      },
      {
        id: "editor.nextDiff",
        tooltip: t("workspace.actions.nextChange"),
        groupKey: "editor.diffNav",
        icon: DownOutlined,
        onClick: () => {
          void toolCommands.get("editor")?.goToNextDiff?.();
        }
      }
      ] : [])
    ],
    keepAlive: true
  }
]);

function pickFirstToolInArea(area: DockArea): ToolId | null {
  const list = toolOrderByArea.value[area] ?? [];
  for (const id of list) {
    if (!toolById.value.has(id)) continue;
    if (toolCurrentArea(id) !== area) continue;
    return id;
  }
  return null;
}

function ensureActiveToolInArea(area: DockArea) {
  const cur = activeToolIdByArea[area];
  if (cur && toolById.value.has(cur) && toolCurrentArea(cur) === area) return;
  const next = pickFirstToolInArea(area);
  activeToolIdByArea[area] = next;
  if (next) toolMinimized[next] = false;
}

const toolById = computed(() => {
  const m = new Map<ToolId, ToolDefinition>();
  for (const tool of tools.value) m.set(tool.toolId, tool);
  return m;
});

const activeToolIdByArea = reactive<Record<DockArea, ToolId | null>>({
  leftTop: "files",
  leftBottom: "terminal",
  rightTop: null
});

const toolMinimized = reactive<Record<ToolId, boolean>>({
  codeReview: false,
  terminal: true,
  files: false,
  search: true,
  agent: false,
  scheduledTasks: false,
  environmentVariables: false,
  editor: true
});
const toolDots = reactive<Record<ToolId, boolean>>({
  codeReview: false,
  terminal: false,
  files: false,
  search: false,
  agent: false,
  scheduledTasks: false,
  environmentVariables: false,
  editor: false
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
    if (!def.createRuntime) continue;
    const runtime = def.createRuntime({
      workspaceId: props.workspaceId,
      toolId: def.toolId,
      host: { call: (toToolId, call) => callToolFrom(def.toolId, toToolId, call), setToolDot },
      getCurrentTarget: () => currentTarget.value,
      getVisible: () => isToolVisible(def.toolId),
      refreshView: () => toolCommands.get(def.toolId)?.refresh?.(),
      api: { getWorkspaceGitStatus },
      onWorkspaceGitStatus(status) {
        workspaceGitStatus.value = status;
        for (const repo of status.repos) {
          repoStatusByDirName[repo.dirName] = { ...repoStatusByDirName[repo.dirName], head: repo.head };
        }
      },
      onBackgroundError(error) {
        message.error(error instanceof Error ? error.message : String(error));
      }
    });
    toolRuntimes.set(def.toolId, runtime);
    runtime.start();
    const queued = toolEventQueue.get(def.toolId) ?? [];
    if (queued.length > 0 && runtime.onEvent) {
      toolEventQueue.delete(def.toolId);
      queued.forEach((event) => runtime.onEvent?.(event));
    }
  }
}

const DOCK_LAYOUT_STORAGE_KEY_PREFIX = "agent-workbench.workspace.dockLayout.v4";
const CURRENT_REPO_STORAGE_KEY_PREFIX = "agent-workbench.workspace.currentRepo.v1";

type DockLayoutV4 = {
  version: 4;
  updatedAt: number;
  ratios: { topBottom: number; topLeft: number };
  toolMinimized: Record<ToolId, boolean>;
  activeToolIdByArea: Record<DockArea, ToolId | null>;
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

function isToolId(v: unknown): v is ToolId {
  return typeof v === "string" && (TOOL_IDS as string[]).includes(v);
}

function clampRatio(n: number) {
  if (!Number.isFinite(n)) return 2 / 3;
  return clamp(n, 0.1, 0.9);
}

function loadDockLayout(workspaceId: string): DockLayoutV4 | null {
  try {
    const raw = localStorage.getItem(dockLayoutStorageKey(workspaceId));
    if (!raw) return null;
    const json = JSON.parse(raw) as Partial<DockLayoutV4> | null;
    if (!json || json.version !== 4) return null;

    const ratios = (json.ratios ?? {}) as Partial<{ topBottom: unknown; topLeft: unknown }>;
    const toolMinimizedRaw = json.toolMinimized ?? ({} as any);
    const activeRaw = json.activeToolIdByArea ?? ({} as any);

    const toolMinimizedOut: Record<ToolId, boolean> = {
      codeReview: false,
      terminal: true,
      files: false,
      search: true,
      agent: false,
      scheduledTasks: false,
      environmentVariables: false,
      editor: true
    };
    for (const toolId of TOOL_IDS) {
      const v = (toolMinimizedRaw as any)[toolId];
      if (typeof v === "boolean") toolMinimizedOut[toolId] = v;
    }

    const activeOut: Record<DockArea, ToolId | null> = { leftTop: "files", leftBottom: "terminal", rightTop: null };
    for (const area of DOCK_AREAS) {
      const v = (activeRaw as any)[area];
      if (v === null) {
        activeOut[area] = null;
      } else if (area !== "rightTop" && isToolId(v)) {
        activeOut[area] = v;
      }
    }

    return {
      version: 4,
      updatedAt: typeof json.updatedAt === "number" ? json.updatedAt : Date.now(),
      ratios: {
        topBottom: clampRatio(typeof ratios.topBottom === "number" ? ratios.topBottom : 2 / 3),
        topLeft: clampRatio(typeof ratios.topLeft === "number" ? ratios.topLeft : 1 / 3)
      },
      toolMinimized: { ...toolMinimizedOut, editor: true },
      activeToolIdByArea: { ...activeOut, rightTop: null }
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
    const data: DockLayoutV4 = {
      version: 4,
      updatedAt: Date.now(),
      ratios: { topBottom: topBottomRatio.value, topLeft: topLeftRatio.value },
      toolMinimized: {
        codeReview: toolMinimized.codeReview,
        terminal: toolMinimized.terminal,
        files: toolMinimized.files,
        search: toolMinimized.search,
        agent: toolMinimized.agent,
        scheduledTasks: toolMinimized.scheduledTasks,
        environmentVariables: toolMinimized.environmentVariables,
        editor: toolMinimized.editor
      },
      activeToolIdByArea: {
        leftTop: activeToolIdByArea.leftTop,
        leftBottom: activeToolIdByArea.leftBottom,
        rightTop: activeToolIdByArea.rightTop
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
  activeToolIdByArea.leftTop = "files";
  activeToolIdByArea.leftBottom = "terminal";
  activeToolIdByArea.rightTop = null;
  toolMinimized.codeReview = false;
  toolMinimized.terminal = true;
  toolMinimized.files = false;
  toolMinimized.search = true;
  toolMinimized.agent = false;
  toolMinimized.scheduledTasks = false;
  toolMinimized.environmentVariables = false;
  toolMinimized.editor = true;
  topBottomRatio.value = 2 / 3;
  topLeftRatio.value = 1 / 3;
}

function applyDockLayout(layout: DockLayoutV4) {
  topBottomRatio.value = clampRatio(layout.ratios.topBottom);
  topLeftRatio.value = clampRatio(layout.ratios.topLeft);

  for (const toolId of TOOL_IDS) {
    toolMinimized[toolId] = Boolean(layout.toolMinimized[toolId]);
  }

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
    } else {
      for (const area of DOCK_AREAS) ensureActiveToolInArea(area);
    }
  } finally {
    restoringDockLayout.value = false;
  }
  await nextTick();
  await clampDockRatiosToContainer();
  if (hasSaved) saveDockLayout(workspaceId);
}

function toolCurrentArea(toolId: ToolId): DockArea {
  return toolLayoutArea(toolId);
}

function isToolVisible(toolId: ToolId) {
  const area = toolCurrentArea(toolId);
  return activeToolIdByArea[area] === toolId && !toolMinimized[toolId];
}

const agentOpenSessionRequest = ref<{ sessionId: string; sequence: number } | null>(null);
watch(() => props.workspaceId, () => {
  // 打开 Session 的意图只属于发起调用时的 Workspace。
  agentOpenSessionRequest.value = null;
});
function callToolFrom(fromToolId: string, toToolId: string, call: ToolCall) {
  const toId = toToolId as ToolId;
  if (!toolById.value.has(toId)) return;
  if (toId === "agent" && call.type === "openSession" && typeof call.payload?.sessionId === "string") {
    agentOpenSessionRequest.value = { sessionId: call.payload.sessionId, sequence: Date.now() + Math.random() };
  }
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
  // - 避免“首次展示”工具时 ToolView 尚未挂载完成，导致丢失调用
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
  const runtime = toolRuntimes.get(id);
  if (runtime?.onEvent) {
    runtime.onEvent(event);
    return;
  }
  const list = toolEventQueue.get(id) ?? [];
  list.push(event);
  toolEventQueue.set(id, list);
}

const hostApi: WorkspaceHostApi = {
  openTool,
  minimizeTool,
  toggleMinimize,
  callFrom: callToolFrom,
  setToolDot,
  registerToolCommands,
  emitToolEvent
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
  const area = toolCurrentArea(toolId);
  if (activeToolIdByArea[area] === toolId) {
    if (area === "leftTop") {
      return;
    }
    toolMinimized[toolId] = !toolMinimized[toolId];
    return;
  }
  activeToolIdByArea[area] = toolId;
  toolMinimized[toolId] = false;
}

const visibleToolIdByArea = computed(() => {
  const res: Record<DockArea, ToolId | null> = { leftTop: null, leftBottom: null, rightTop: null };
  (Object.keys(res) as DockArea[]).forEach((area) => {
    const id = activeToolIdByArea[area];
    if (!id) return;
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
    if (!isKeepAlive(id)) continue;
    const area = toolCurrentArea(id);
    res[area].push(id);
  }
  return res;
});

const toolVisibleById = computed(() => {
  const out: Record<ToolId, boolean> = { codeReview: false, terminal: false, files: false, search: false, agent: false, scheduledTasks: false, environmentVariables: false, editor: false };
  for (const id of TOOL_IDS) out[id] = isToolVisible(id);
  return out;
});

const leftTopToolbarToolIds = computed<ToolId[]>(() => toolOrderByArea.value.leftTop.filter((id) => toolCurrentArea(id) === "leftTop"));
const leftBottomToolbarToolIds = computed<ToolId[]>(() => toolOrderByArea.value.leftBottom.filter((id) => toolCurrentArea(id) === "leftBottom"));

function canMoveToolUp(toolId: ToolId) {
  const area = toolCurrentArea(toolId);
  const list = toolOrderByArea.value[area];
  return list.indexOf(toolId) > 0;
}

function canMoveToolDown(toolId: ToolId) {
  const area = toolCurrentArea(toolId);
  const list = toolOrderByArea.value[area];
  const index = list.indexOf(toolId);
  return index >= 0 && index < list.length - 1;
}

function moveToolUp(toolId: ToolId) {
  if (!canMoveToolUp(toolId)) return;
  moveGlobalToolByStep(toolId, -1);
}

function moveToolDown(toolId: ToolId) {
  if (!canMoveToolDown(toolId)) return;
  moveGlobalToolByStep(toolId, 1);
}

function moveTool(toolId: ToolId, targetArea: DockArea) {
  moveGlobalTool(toolId, targetArea);
}

// Region changes (including another tab) affect only invalid active selections.
// Pure reordering must not change visibility or recreate any tool sessions.
watch(globalToolLayout, (next, previous) => {
  const departed: { toolId: ToolId; target: DockArea; visible: boolean }[] = [];
  const sourceAreas: DockArea[] = [];
  for (const area of DOCK_AREAS) {
    const toolId = activeToolIdByArea[area];
    if (!toolId || toolLayoutArea(toolId, previous) !== area || toolLayoutArea(toolId, next) === area) continue;
    departed.push({ toolId, target: toolLayoutArea(toolId, next), visible: !toolMinimized[toolId] });
    sourceAreas.push(area);
    activeToolIdByArea[area] = null;
  }
  for (const { toolId, target, visible } of departed) {
    const active = activeToolIdByArea[target];
    const targetVisible = active && !toolMinimized[active];
    if ((visible && !targetVisible) || (!visible && !active)) activeToolIdByArea[target] = toolId;
  }
  for (const area of sourceAreas) ensureActiveToolInArea(area);
}, { flush: "sync" });

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
  return allowedToolAreas(toolId)
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
  if (toolId === "agent") {
    return { workspaceId: props.workspaceId, toolId, openSessionRequest: agentOpenSessionRequest.value };
  }
  if (toolId === "codeReview") {
    return {
      workspaceId: props.workspaceId,
      target: currentTarget.value,
      toolId,
      gitBusy: gitBusy.value,
      beginGitOp,
      push: pushWithUi,
      refreshStatus: refreshCodeReviewStatus,
      repos: workspaceRepos.value,
      repoStatuses: workspaceGitStatus.value.repos,
      selectedRepoDirName: currentRepoDirName.value,
      selectRepo: setCurrentRepo,
      checkout: openCheckout,
      pull: pullWithUi
    };
  }
  if (toolId === "files") {
    return {
      workspaceId: props.workspaceId,
      toolId,
      workspaceDirName: workspace.value?.dirName ?? "",
      previewEnabled: props.previewEnabled,
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
  if (toolId === "editor") {
    return {
      workspaceId: props.workspaceId,
      toolId,
      previewEnabled: props.previewEnabled
    };
  }
  return { workspaceId: props.workspaceId, toolId };
}

function toolViewListeners(toolId: ToolId) {
  if (toolId === "editor") {
    return { diffTabActiveChange: (active: boolean) => { editorDiffTabActive.value = Boolean(active); } };
  }
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


const branchesLoading = ref(false);
const refreshBranchesLoading = ref(false);
const branches = ref<GitBranchesResponse["branches"]>([]);
const branchOptions = computed(() => branches.value.map((b) => ({ label: b.name, value: b.name })));

function buildPageTitle(ws: WorkspaceDetail | null) {
  return `${ws?.title || t("workspace.title")} - ${t("app.title")}`;
}

function applyPageTitle() {
  document.title = buildPageTitle(workspace.value);
}


const pushIdentityOpen = ref(false);
const pendingPush = ref<{ target: GitTarget; params: PushParams } | null>(null);
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
const checkoutTarget = ref<GitTarget | null>(null);
let branchesRequestSeq = 0;
const canCheckout = computed(() => {
  if (!checkoutTarget.value) return false;
  if (gitBusy.value) return false;
  const next = checkoutBranch.value.trim();
  if (!next) return false;
  const currentBranch = repoStatusByDirName[checkoutTarget.value.dirName]?.head?.branch ?? "";
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
const topLeftRatio = ref(1 / 3);

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

watch(toolMinimized, scheduleSaveDockLayout, { deep: true });
watch(activeToolIdByArea, scheduleSaveDockLayout, { deep: true });
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

async function refreshCodeReviewStatus() {
  await toolRuntimes.get("codeReview")?.refresh?.();
}

async function refreshAfterGitOperation() {
  await refreshCodeReviewStatus();
  if (isToolVisible("codeReview")) await toolCommands.get("codeReview")?.refresh?.();
}

async function refreshChangesSummary(target: GitTarget) {
  const [unstagedRes, stagedRes] = await Promise.all([
    listChanges(target, { mode: "unstaged" }),
    listChanges(target, { mode: "staged" })
  ]);
  return { unstaged: unstagedRes.files.length, staged: stagedRes.files.length };
}

async function refreshBranches(target: GitTarget, fetch = false) {
  const request = ++branchesRequestSeq;
  branchesLoading.value = true;
  try {
    const res = await gitBranches({ target, fetch });
    if (request !== branchesRequestSeq || checkoutTarget.value !== target) return;
    branches.value = res.branches;
    repoDefaultBranch.value = res.defaultBranch ?? null;
  } finally {
    if (request === branchesRequestSeq) branchesLoading.value = false;
  }
}

function pickCheckoutBranch(params: { branches: GitBranchesResponse["branches"]; defaultBranch: string | null }) {
  const existing = checkoutBranch.value.trim();
  if (existing && params.branches.some((b) => b.name === existing)) return existing;

  const currentBranch = checkoutTarget.value ? repoStatusByDirName[checkoutTarget.value.dirName]?.head?.branch ?? "" : "";
  if (currentBranch && params.branches.some((b) => b.name === currentBranch)) return currentBranch;

  if (params.defaultBranch && params.branches.some((b) => b.name === params.defaultBranch)) return params.defaultBranch;
  return params.branches[0]?.name ?? "";
}

async function refreshBranchesWithSync() {
  const target = checkoutTarget.value;
  if (!target || gitBusy.value || refreshBranchesLoading.value) return;
  refreshBranchesLoading.value = true;
  try {
    await refreshBranches(target, true);
    if (checkoutTarget.value === target) {
      checkoutBranch.value = pickCheckoutBranch({ branches: branches.value, defaultBranch: repoDefaultBranch.value });
    }
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
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

async function openCheckout(target: GitTarget | null = currentTarget.value) {
  if (!target || gitBusy.value) return;
  checkoutTarget.value = { ...target };
  const frozenTarget = checkoutTarget.value;
  branches.value = [];
  repoDefaultBranch.value = null;
  checkoutBranch.value = "";
  checkoutOpen.value = true;
  try {
    await refreshBranches(frozenTarget);
    if (checkoutTarget.value !== frozenTarget) return;
    checkoutBranch.value = pickCheckoutBranch({ branches: branches.value, defaultBranch: repoDefaultBranch.value });
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

async function submitCheckout() {
  const target = checkoutTarget.value;
  if (!target || !canCheckout.value) return;
  const nextBranch = checkoutBranch.value.trim();
  try {
    const summary = await refreshChangesSummary(target);
    if (summary.unstaged + summary.staged > 0) {
      Modal.confirm({
        title: t("workspace.checkout.confirmTitle"),
        content: t("workspace.checkout.confirmContent"),
        okText: t("workspace.checkout.ok"),
        cancelText: t("workspace.checkout.cancel"),
        onOk: () => doCheckout(target, nextBranch)
      });
      return;
    }
    await doCheckout(target, nextBranch);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

async function doCheckout(target: GitTarget, nextBranch: string) {
  const release = beginGitOp();
  checkoutLoading.value = true;
  try {
    await gitCheckout({ target, branch: nextBranch });
    await refreshAfterGitOperation();
    message.success(t("workspace.checkout.switchedTo", { branch: nextBranch }));
    if (checkoutTarget.value === target) checkoutOpen.value = false;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    release();
    checkoutLoading.value = false;
  }
}

async function pullWithUi(target: GitTarget | null = currentTarget.value) {
  if (!target || gitBusy.value) return;
  const frozenTarget = { ...target };
  try {
    const summary = await refreshChangesSummary(frozenTarget);
    if (summary.unstaged + summary.staged > 0) {
      Modal.confirm({
        title: t("workspace.pull.confirmTitle"),
        content: t("workspace.pull.confirmContent"),
        okText: t("workspace.pull.okContinue"),
        cancelText: t("workspace.pull.cancel"),
        onOk: () => doPull(frozenTarget)
      });
      return;
    }
    await doPull(frozenTarget);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

async function doPull(target: GitTarget) {
  const release = beginGitOp();
  try {
    const res = await pullWorkspace({ target });
    message.success(t(res.updated ? "workspace.pull.updated" : "workspace.pull.upToDate"));
    await refreshAfterGitOperation();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    release();
  }
}

async function pushWithUi(target: GitTarget | null = currentTarget.value, params: PushParams = {}) {
  if (!target || gitBusy.value) return;
  const frozenTarget = { ...target };
  const frozenParams = { ...params };
  const release = beginGitOp();
  try {
    // 提前补配身份的既有流程保留，弹窗与后续重试均绑定本次目标。
    try {
      const status = await getWorkspaceGitIdentity({ target: frozenTarget });
      if (status.effective.source === "none") {
        pendingPush.value = { target: frozenTarget, params: frozenParams };
        pushIdentitySubmitting.value = false;
        pushIdentityOpen.value = true;
        return;
      }
    } catch {
      // 身份预检查失败仍交由实际 push 给出权威错误。
    }
    const res = await pushWorkspace({ target: frozenTarget, ...frozenParams });
    message.success(t("workspace.push.pushedTo", { remote: res.remote, branch: res.branch }));
    await refreshCodeReviewStatus();
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError({ message: err instanceof Error ? err.message : String(err) });
    if (e.code === "GIT_NO_UPSTREAM" && !frozenParams.setUpstream) {
      Modal.confirm({
        title: t("workspace.push.noUpstreamTitle"),
        content: t("workspace.push.noUpstreamContent"),
        okText: t("workspace.push.okSetUpstreamAndPush"),
        cancelText: t("workspace.push.cancel"),
        onOk: () => pushWithUi(frozenTarget, { ...frozenParams, setUpstream: true })
      });
    } else if (e.code === "GIT_NON_FAST_FORWARD" && !frozenParams.forceWithLease) {
      Modal.confirm({
        title: t("workspace.push.nonFastForwardTitle"),
        content: t("workspace.push.nonFastForwardContent"),
        okText: t("workspace.push.okForceWithLease"),
        cancelText: t("workspace.push.cancel"),
        onOk: () => pushWithUi(frozenTarget, { ...frozenParams, forceWithLease: true })
      });
    } else {
      message.error(e.message);
    }
  } finally {
    release();
  }
}

async function onPushIdentitySubmit(identity: any) {
  const pending = pendingPush.value;
  if (!pending || gitBusy.value) return;
  const release = beginGitOp();
  let continuePush = false;
  pushIdentitySubmitting.value = true;
  try {
    if (identity?.scope === "repo") {
      await setWorkspaceGitIdentity({ target: pending.target, name: identity.name, email: identity.email });
    } else if (identity?.scope === "global") {
      await updateGitGlobalIdentity({ name: identity.name, email: identity.email });
    } else {
      return;
    }
    // 保存本身已经作用于冻结目标；弹窗关闭或被另一操作替换后不再续接旧 push。
    if (pendingPush.value !== pending || !pushIdentityOpen.value) return;
    pushIdentityOpen.value = false;
    pendingPush.value = null;
    continuePush = true;
  } catch (err) {
    if (pendingPush.value === pending && pushIdentityOpen.value) {
      message.error(err instanceof Error ? err.message : String(err));
    }
    return;
  } finally {
    release();
    if (pendingPush.value === pending || continuePush) pushIdentitySubmitting.value = false;
  }
  if (continuePush) await pushWithUi(pending.target, pending.params);
}

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
