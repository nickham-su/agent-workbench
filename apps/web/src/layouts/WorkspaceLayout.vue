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
        </div>
      </div>

      <div class="flex items-center gap-2 shrink-0">
        <a-button v-if="workspace" size="small" :disabled="gitBusy" @click="openCheckout()">
          {{ t("workspace.actions.checkout") }}
        </a-button>

        <template v-for="group in headerActionGroups" :key="group.key">
          <div class="flex items-center gap-2">
            <a-button
              v-for="action in group.actions"
              :key="action.id"
              size="small"
              :disabled="action.disabled"
              :loading="action.loading"
              @click="action.onClick"
            >
              {{ action.label }}
            </a-button>
          </div>
        </template>
      </div>
    </a-layout-header>

    <a-layout-content class="p-0 h-[calc(100vh-64px)] border-t border-[var(--border-color-secondary)]">
      <div class="h-full flex min-h-0">
        <div class="w-12 h-full flex flex-col border-r border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
          <div class="flex flex-col items-center gap-1 py-1">
            <template v-for="toolId in leftTopToolbarToolIds" :key="toolId">
              <WorkspaceToolButton
                :title="toolTitle(toolId)"
                :icon="toolIcon(toolId)"
                :active="activeToolIdByArea.leftTop === toolId"
                :minimized="toolMinimized[toolId] ?? false"
                :moveTargets="moveTargets(toolId)"
                @click="onToolIconClick(toolId)"
                @moveTo="(area) => moveTool(toolId, area)"
              />
            </template>
          </div>
          <div class="h-px bg-[var(--border-color-secondary)] my-1"></div>
          <div class="mt-auto flex flex-col items-center gap-1 py-1">
            <template v-for="toolId in leftBottomToolbarToolIds" :key="toolId">
              <WorkspaceToolButton
                :title="toolTitle(toolId)"
                :icon="toolIcon(toolId)"
                :active="activeToolIdByArea.leftBottom === toolId"
                :minimized="toolMinimized[toolId] ?? false"
                :moveTargets="moveTargets(toolId)"
                @click="onToolIconClick(toolId)"
                @moveTo="(area) => moveTool(toolId, area)"
              />
            </template>
          </div>
        </div>

        <div ref="centerEl" class="flex-1 min-w-0 min-h-0 relative bg-[var(--panel-bg)]">
          <div class="h-full min-h-0 min-w-0 grid relative" :style="centerStyle">
            <div
              v-if="showTop"
              ref="topEl"
              class="min-h-0 min-w-0 grid relative"
              :class="showBottom ? 'border-b border-[var(--border-color-secondary)]' : ''"
              :style="topStyle"
            >
              <div v-if="showLeftTop" class="min-h-0 min-w-0 overflow-hidden" :class="showRightTop ? 'border-r border-[var(--border-color-secondary)]' : ''">
                <template v-if="visibleToolIdByArea.leftTop">
                  <KeepAlive v-if="isKeepAlive(visibleToolIdByArea.leftTop)">
                    <component
                      :is="toolView(visibleToolIdByArea.leftTop)"
                      :key="visibleToolIdByArea.leftTop"
                      v-bind="toolViewProps(visibleToolIdByArea.leftTop)"
                      v-on="toolViewListeners(visibleToolIdByArea.leftTop)"
                      class="h-full min-h-0 min-w-0"
                    />
                  </KeepAlive>
                  <component
                    v-else
                    :is="toolView(visibleToolIdByArea.leftTop)"
                    :key="visibleToolIdByArea.leftTop"
                    v-bind="toolViewProps(visibleToolIdByArea.leftTop)"
                    v-on="toolViewListeners(visibleToolIdByArea.leftTop)"
                    class="h-full min-h-0 min-w-0"
                  />
                </template>
              </div>
              <div v-if="showRightTop" class="min-h-0 min-w-0 overflow-hidden">
                <template v-if="visibleToolIdByArea.rightTop">
                  <KeepAlive v-if="isKeepAlive(visibleToolIdByArea.rightTop)">
                    <component
                      :is="toolView(visibleToolIdByArea.rightTop)"
                      :key="visibleToolIdByArea.rightTop"
                      v-bind="toolViewProps(visibleToolIdByArea.rightTop)"
                      v-on="toolViewListeners(visibleToolIdByArea.rightTop)"
                      class="h-full min-h-0 min-w-0"
                    />
                  </KeepAlive>
                  <component
                    v-else
                    :is="toolView(visibleToolIdByArea.rightTop)"
                    :key="visibleToolIdByArea.rightTop"
                    v-bind="toolViewProps(visibleToolIdByArea.rightTop)"
                    v-on="toolViewListeners(visibleToolIdByArea.rightTop)"
                    class="h-full min-h-0 min-w-0"
                  />
                </template>
              </div>

              <div
                v-if="showTopColsSplitter"
                class="absolute top-0 bottom-0"
                :class="splitterClassCol"
                :style="topColsSplitterStyle"
                role="separator"
                aria-orientation="vertical"
                :aria-label="t('workspace.dock.splitter.resizeTopLeftRight')"
                @pointerdown="onTopColsSplitterPointerDown"
              />
            </div>

            <div v-if="showBottom" class="min-h-0 min-w-0 overflow-hidden">
              <template v-if="visibleToolIdByArea.leftBottom">
                <KeepAlive v-if="isKeepAlive(visibleToolIdByArea.leftBottom)">
                  <component
                    :is="toolView(visibleToolIdByArea.leftBottom)"
                    :key="visibleToolIdByArea.leftBottom"
                    v-bind="toolViewProps(visibleToolIdByArea.leftBottom)"
                    v-on="toolViewListeners(visibleToolIdByArea.leftBottom)"
                    class="h-full min-h-0 min-w-0"
                  />
                </KeepAlive>
                <component
                  v-else
                  :is="toolView(visibleToolIdByArea.leftBottom)"
                  :key="visibleToolIdByArea.leftBottom"
                  v-bind="toolViewProps(visibleToolIdByArea.leftBottom)"
                  v-on="toolViewListeners(visibleToolIdByArea.leftBottom)"
                  class="h-full min-h-0 min-w-0"
                />
              </template>
            </div>

            <div
              v-if="showTopBottomSplitter"
              class="absolute left-0 right-0"
              :class="splitterClassRow"
              :style="topBottomSplitterStyle"
              role="separator"
              aria-orientation="horizontal"
              :aria-label="t('workspace.dock.splitter.resizeTopBottom')"
              @pointerdown="onTopBottomSplitterPointerDown"
            />
          </div>
        </div>

        <div class="w-12 h-full flex flex-col items-center gap-1 py-1 border-l border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
          <template v-for="toolId in rightToolbarToolIds" :key="toolId">
            <WorkspaceToolButton
              :title="toolTitle(toolId)"
              :icon="toolIcon(toolId)"
              :active="activeToolIdByArea.rightTop === toolId"
              :minimized="toolMinimized[toolId] ?? false"
              :moveTargets="moveTargets(toolId)"
              @click="onToolIconClick(toolId)"
              @moveTo="(area) => moveTool(toolId, area)"
            />
          </template>
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
import { computed, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { CodeOutlined, FormOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import type { RepoBranchesResponse, GitPushRequest, WorkspaceDetail } from "@agent-workbench/shared";
import {
  ApiError,
  checkoutWorkspace,
  getWorkspace,
  listChanges,
  pullWorkspace,
  pushWorkspace,
  repoBranches,
  syncRepo
} from "../services/api";
import { waitRepoReadyOrThrow } from "../services/repoSync";
import { workspaceHostKey, type DockArea, type WorkspaceHostApi, type WorkspaceToolCommandMap, type WorkspaceToolEvent } from "../workspace/host";
import WorkspaceToolButton from "../workspace/WorkspaceToolButton.vue";
import CodeReviewToolView from "../workspace/tools/CodeReviewToolView.vue";
import TerminalToolView from "../workspace/tools/TerminalToolView.vue";

const props = defineProps<{ workspaceId: string }>();
const { t } = useI18n();

type ToolId = "codeReview" | "terminal";
type HeaderAction = {
  id: string;
  label: string;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
};
type ToolDefinition = {
  toolId: ToolId;
  title: () => string;
  icon: any;
  view: any;
  defaultArea: DockArea;
  allowedAreas: DockArea[];
  keepAlive?: boolean;
  headerActions?: () => HeaderAction[];
};

const loading = ref(false);
const workspace = ref<WorkspaceDetail | null>(null);

const tools = computed<ToolDefinition[]>(() => [
  {
    toolId: "codeReview",
    title: () => t("workspace.tools.codeReview"),
    icon: FormOutlined,
    view: CodeReviewToolView,
    defaultArea: "leftTop",
    allowedAreas: ["leftTop"],
    keepAlive: true,
    headerActions: () => [
      {
        id: "pull",
        label: t("workspace.actions.pull"),
        loading: pullLoading.value,
        disabled: gitBusy.value || !workspace.value,
        onClick: () => void pullWithUi()
      },
      {
        id: "push",
        label: t("workspace.actions.push"),
        loading: pushLoading.value,
        disabled: gitBusy.value || !workspace.value,
        onClick: () => void pushWithUi()
      }
    ]
  },
  {
    toolId: "terminal",
    title: () => t("workspace.tools.terminal"),
    icon: CodeOutlined,
    view: TerminalToolView,
    defaultArea: "leftBottom",
    allowedAreas: ["leftBottom", "leftTop", "rightTop"],
    keepAlive: false
  }
]);

const toolById = computed(() => {
  const m = new Map<ToolId, ToolDefinition>();
  for (const tool of tools.value) m.set(tool.toolId, tool);
  return m;
});

const toolArea = reactive<Record<ToolId, DockArea>>({
  codeReview: "leftTop",
  terminal: "leftBottom"
});

const activeToolIdByArea = reactive<Record<DockArea, ToolId | null>>({
  leftTop: "codeReview",
  leftBottom: "terminal",
  rightTop: null
});

const toolMinimized = reactive<Record<ToolId, boolean>>({
  codeReview: false,
  terminal: true
});

function toolCurrentArea(toolId: ToolId): DockArea {
  return toolArea[toolId] ?? toolById.value.get(toolId)?.defaultArea ?? "leftTop";
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

const hostApi: WorkspaceHostApi = {
  openTool,
  minimizeTool,
  toggleMinimize,
  registerToolCommands,
  emitToolEvent
};

provide(workspaceHostKey, hostApi);

function onToolIconClick(toolId: ToolId) {
  const area = toolCurrentArea(toolId);
  if (activeToolIdByArea[area] === toolId) {
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

const leftTopToolbarToolIds = computed<ToolId[]>(() => tools.value.filter((t) => toolCurrentArea(t.toolId) === "leftTop").map((t) => t.toolId));
const leftBottomToolbarToolIds = computed<ToolId[]>(() =>
  tools.value.filter((t) => toolCurrentArea(t.toolId) === "leftBottom").map((t) => t.toolId)
);
const rightToolbarToolIds = computed<ToolId[]>(() => tools.value.filter((t) => toolCurrentArea(t.toolId) === "rightTop").map((t) => t.toolId));

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
  if (wasActive) activeToolIdByArea[fromArea] = null;

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
      toolId,
      gitBusy: gitBusy.value,
      beginGitOp,
      push: (params?: GitPushRequest) => pushWithUi(params)
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
  if (!workspace.value) return false;
  if (gitBusy.value) return false;
  const next = checkoutBranch.value.trim();
  if (!next) return false;
  return next !== workspace.value.checkout.branch;
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

const topBottomRatio = ref(2 / 3);
const topLeftRatio = ref(2 / 3);

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
  };

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp);
  draggingCleanup = handleUp;
}

async function refreshWorkspace() {
  workspace.value = await getWorkspace(props.workspaceId);
  applyPageTitle();
}

async function refreshChangesSummary() {
  try {
    const [unstagedRes, stagedRes] = await Promise.all([
      listChanges(props.workspaceId, { mode: "unstaged" }),
      listChanges(props.workspaceId, { mode: "staged" })
    ]);
    changesSummary.value = { unstaged: unstagedRes.files.length, staged: stagedRes.files.length };
  } catch {
    // ignore
  }
  return changesSummary.value;
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
    await refreshWorkspace();
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
  if (!workspace.value) return;
  const release = beginGitOp();
  checkoutLoading.value = true;
  try {
    await checkoutWorkspace(props.workspaceId, { branch: nextBranch });
    await refreshWorkspace();
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
  if (!workspace.value) return;
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
  const release = beginGitOp();
  pullLoading.value = true;
  try {
    const res = await pullWorkspace(props.workspaceId, {});
    if (res.updated) message.success(t("workspace.pull.updated"));
    else message.success(t("workspace.pull.upToDate"));
    await toolCommands.get("codeReview")?.refresh?.();
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
