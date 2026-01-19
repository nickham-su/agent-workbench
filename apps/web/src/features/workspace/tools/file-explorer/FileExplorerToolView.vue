<template>
  <div class="h-full min-h-0 flex flex-col">


    <div ref="containerEl" class="flex-1 min-h-0 grid gap-0" :style="containerStyle">
      <div class="min-h-0 min-w-0 flex flex-col border-r border-[var(--border-color-secondary)]">
        <FileExplorerTree
          :tree-key="treeKey"
          :tree-data="treeData"
          :expanded-keys="expandedKeys"
          :selected-keys="selectedKeys"
          :tree-loading="treeLoading"
          :is-tree-empty="isTreeEmpty"
          :selected-node="selectedNode"
          :can-rename-delete="canRenameDelete"
          :show-repo-path-action="showRepoPathAction"
          :show-workspace-path-action="showWorkspacePathAction"
          :refresh-root="refreshRoot"
          :on-load-data="onLoadData"
          :on-expanded-keys-update="onExpandedKeysUpdate"
          :on-selected-keys-update="onSelectedKeysUpdate"
          :on-tree-select="onTreeSelect"
          :on-node-context-menu="onNodeContextMenu"
          :on-node-dbl-click="onNodeDblClick"
          :on-context-menu-click="onContextMenuClick"
        />
      </div>

      <div class="min-h-0 min-w-0 overflow-visible flex flex-col relative">
        <div
          :class="splitterClass"
          :style="splitterStyle"
          role="separator"
          aria-orientation="vertical"
          :aria-label="t('files.resizeFileList')"
          @pointerdown="onSplitterPointerDown"
        />
        <div class="flex-1 min-w-0 min-h-0 flex flex-col">
          <FileExplorerTabs
            :tabs="tabs"
            :active-tab-key="activeTabKey"
            :on-active-tab-update="onActiveTabUpdate"
            :request-close-tab="requestCloseTab"
          />

          <div class="flex-1 min-h-0 relative">
            <div v-if="!activeTab" class="h-full flex items-center justify-center text-xs text-[color:var(--text-tertiary)]">
              {{ t("files.placeholder.openFile") }}
            </div>
            <div
              v-else-if="activeTab.previewable === false"
              class="h-full flex items-center justify-center text-xs text-[color:var(--text-tertiary)]"
            >
              {{ notPreviewableLabel(activeTab) }}
            </div>
            <div
              ref="editorEl"
              class="absolute inset-0"
              v-show="activeTab && activeTab.previewable !== false"
            ></div>
            <div
              v-if="activeTab?.saving"
              class="absolute right-2 top-2 text-[11px] text-[color:var(--text-tertiary)]"
            >
              {{ t("files.status.saving") }}
            </div>
            <div
              v-else-if="activeTab?.error"
              class="absolute right-2 top-2 text-[11px] text-[color:var(--danger-color)]"
            >
              {{ activeTab.error }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <a-modal
    v-model:open="createModal.open"
    :title="createModal.kind === 'file' ? t('files.createFile.title') : t('files.createFolder.title')"
    :confirm-loading="createModal.submitting"
    @ok="submitCreate"
  >
    <a-form layout="vertical">
      <a-form-item :label="t('files.form.nameLabel')" required>
        <a-input v-model:value="createModal.name" :placeholder="t('files.form.namePlaceholder')" />
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal
    v-model:open="renameModal.open"
    :title="t('files.rename.title')"
    :confirm-loading="renameModal.submitting"
    @ok="submitRename"
  >
    <a-form layout="vertical">
      <a-form-item :label="t('files.form.nameLabel')" required>
        <a-input v-model:value="renameModal.name" :placeholder="t('files.form.renamePlaceholder')" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<script lang="ts">
export default {
  name: "files"
};
</script>

<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { useI18n } from "vue-i18n";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/min/vs/editor/editor.main.css";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController.js";
import type { FileEntry, FileReadResponse } from "@agent-workbench/shared";
import FileExplorerTree from "./components/FileExplorerTree.vue";
import FileExplorerTabs from "./components/FileExplorerTabs.vue";
import type { FileTab, TreeNode } from "./types";
import { getFileExplorerStore, type FileOpenAtRequest } from "./store";
import {
  ApiError,
  createWorkspaceFile,
  deleteWorkspacePath,
  listWorkspaceFiles,
  mkdirWorkspacePath,
  readWorkspaceFileText,
  renameWorkspacePath,
  writeWorkspaceFileText
} from "@/shared/api";
import { ensureMonacoEnvironment } from "@/shared/monaco/monacoEnv";
import { applyMonacoPanelTheme } from "@/shared/monaco/monacoTheme";
import { ensureMonacoLanguage } from "@/shared/monaco/languageLoader";
import { editorFontSize } from "@/shared/settings/uiFontSizes";


const props = defineProps<{
  workspaceId: string;
  toolId: string;
  workspaceDirName?: string;
  workspaceRepos?: Array<{ dirName: string }>;
}>();
const { t } = useI18n();

const ROOT_KEY = "__files_root__";
const FILE_TREE_SPLIT_RATIO_KEY_PREFIX = "agent-workbench.workspace.fileTreeSplitRatio";
const DEFAULT_FILE_TREE_SPLIT_RATIO = 0.22;
const SPLITTER_PX = 6;
const MIN_TREE_RATIO = 0.15;
const MAX_TREE_RATIO = 0.55;
const MIN_TREE_PX = 220;
const MIN_EDITOR_PX = 360;

const workspaceRootName = computed(() => {
  const name = String(props.workspaceDirName || "").trim();
  if (name) return name;
  const fallback = String(props.workspaceId || "").trim();
  return fallback || "workspace";
});
const repoDirNameSet = computed(() => {
  const names = (props.workspaceRepos ?? []).map((item) => String(item.dirName || "").trim()).filter(Boolean);
  return new Set(names);
});

const containerEl = ref<HTMLElement | null>(null);
const treeKey = ref(0);
const treeData = ref<TreeNode[]>([]);
const expandedKeys = ref<string[]>([]);
const selectedKeys = ref<string[]>([]);
const treeLoading = ref(false);
const loadedDirs = new Set<string>();
const nodeByPath = new Map<string, TreeNode>();
const dirRequestSeqByDir = new Map<string, number>();
const fileRequestSeqByPath = new Map<string, number>();
let scopeSeq = 0;

const store = getFileExplorerStore(props.workspaceId);
const tabs = store.tabs;
const activeTabKey = store.activeTabKey;
const pendingOpenAt = store.pendingOpenAt;

const editorEl = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let editorBlurDisposable: monaco.IDisposable | null = null;
let editorSaveCommandId: string | null = null;
let editorApplyScheduled = false;
let highlightDecorations: string[] = [];

const createModal = reactive({
  open: false,
  kind: "file" as "file" | "dir",
  parentDir: "",
  name: "",
  submitting: false
});

const renameModal = reactive({
  open: false,
  path: "",
  name: "",
  submitting: false
});

const selectedNode = ref<TreeNode | null>(null);
const canRenameDelete = computed(() => {
  const rel = selectedNode.value?.data.path ?? "";
  if (!rel) return false;
  return !isProtectedRootPath(rel);
});
const showRepoPathAction = computed(() => {
  const rel = selectedNode.value?.data.path ?? "";
  return Boolean(resolveRepoRelPath(rel));
});
const showWorkspacePathAction = computed(() => !!selectedNode.value);
const rootNode = computed(() => treeData.value.find((node) => node.key === ROOT_KEY) ?? null);
const isTreeEmpty = computed(() => {
  const root = rootNode.value;
  if (!root) return true;
  if (!root.children) return false;
  return root.children.length === 0;
});

const activeTab = store.activeTab;
const fileTreeSplitRatio = ref<number>(loadFileTreeSplitRatio(props.workspaceId));

watch(
  () => props.workspaceId,
  (workspaceId) => {
    fileTreeSplitRatio.value = loadFileTreeSplitRatio(workspaceId);
  }
);

watch(
  () => fileTreeSplitRatio.value,
  () => {
    try {
      localStorage.setItem(fileTreeSplitRatioStorageKey(props.workspaceId), String(fileTreeSplitRatio.value));
    } catch {
      // 忽略
    }
  }
);

const containerStyle = computed(() => {
  return {
    gridTemplateColumns: `${fileTreeSplitRatio.value}fr ${(1 - fileTreeSplitRatio.value).toFixed(6)}fr`,
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

function fileTreeSplitRatioStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return FILE_TREE_SPLIT_RATIO_KEY_PREFIX;
  return `${FILE_TREE_SPLIT_RATIO_KEY_PREFIX}.${id}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function clampSplitRatioByContainer(params: { ratio: number; containerSize: number }) {
  const { containerSize } = params;
  if (!Number.isFinite(containerSize) || containerSize <= 0) return clamp(params.ratio, MIN_TREE_RATIO, MAX_TREE_RATIO);

  const minByPx = MIN_TREE_PX / containerSize;
  const maxByPx = 1 - MIN_EDITOR_PX / containerSize;

  const min = Math.max(MIN_TREE_RATIO, minByPx);
  const max = Math.min(MAX_TREE_RATIO, maxByPx);
  if (min >= max) return clamp(params.ratio, MIN_TREE_RATIO, MAX_TREE_RATIO);
  return clamp(params.ratio, min, max);
}

function loadFileTreeSplitRatio(workspaceId: string) {
  try {
    const raw = localStorage.getItem(fileTreeSplitRatioStorageKey(workspaceId));
    if (!raw) return DEFAULT_FILE_TREE_SPLIT_RATIO;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_FILE_TREE_SPLIT_RATIO;
    return clamp(n, MIN_TREE_RATIO, MAX_TREE_RATIO);
  } catch {
    return DEFAULT_FILE_TREE_SPLIT_RATIO;
  }
}

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
    const next = clampSplitRatioByContainer({ ratio: nextRaw, containerSize });
    fileTreeSplitRatio.value = next;
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

function isFindShortcut(evt: KeyboardEvent) {
  if (!evt.metaKey && !evt.ctrlKey) return false;
  if (evt.altKey) return false;
  const key = evt.key.toLowerCase();
  return key === "f" || key === "h";
}

function isEditorFocused(evt: KeyboardEvent) {
  if (editor?.hasTextFocus?.()) return true;
  const dom = editor?.getDomNode();
  if (!dom) return false;
  const target = evt.target instanceof Node ? evt.target : null;
  if (target && dom.contains(target)) return true;
  const active = document.activeElement;
  return active instanceof Node && dom.contains(active);
}

function handleEditorKeydown(evt: KeyboardEvent) {
  if (!editor) return;
  if (!isFindShortcut(evt)) return;
  if (!isEditorFocused(evt)) return;

  evt.preventDefault();
  evt.stopPropagation();

  const actionId = evt.key.toLowerCase() === "h" ? "editor.action.startFindReplaceAction" : "actions.find";
  const action = editor.getAction(actionId);
  if (action) void action.run();
}

function normalizeLanguage(lang?: string) {
  if (!lang) return undefined;
  if (lang === "vue") return "html";
  if (lang === "c") return "cpp";
  return lang;
}

function inferLanguageFromPath(filePath: string) {
  const base = baseName(filePath);
  if (base === "Dockerfile") return "dockerfile";
  if (base.startsWith("Dockerfile.")) return "dockerfile";

  const dotIdx = filePath.lastIndexOf(".");
  const ext = dotIdx >= 0 ? filePath.slice(dotIdx).toLowerCase() : "";
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".vue":
      return "vue";
    case ".py":
      return "python";
    case ".java":
      return "java";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".php":
      return "php";
    case ".rb":
      return "ruby";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".cs":
      return "csharp";
    case ".c":
    case ".h":
      return "cpp";
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hh":
    case ".hpp":
    case ".hxx":
      return "cpp";
    case ".json":
    case ".jsonc":
      return "json";
    case ".md":
      return "markdown";
    case ".css":
    case ".scss":
    case ".less":
      return "css";
    case ".html":
    case ".htm":
      return "html";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".sql":
      return "sql";
    case ".sh":
    case ".bash":
      return "shell";
    case ".ps1":
      return "powershell";
    case ".xml":
      return "xml";
    case ".swift":
      return "swift";
    default:
      return undefined;
  }
}

async function ensureAndApplyLanguage(model: monaco.editor.ITextModel, languageId?: string) {
  const normalized = normalizeLanguage(languageId);
  if (!normalized || normalized === "plaintext") return;
  try {
    await ensureMonacoLanguage(normalized);
    // language contribution 可能是异步才加载完成,这里强制 set 一次触发重新高亮
    monaco.editor.setModelLanguage(model, normalized);
  } catch {
    // 忽略加载失败,回退为 plaintext
  }
}

function splitPath(p: string) {
  return p.split("/").filter(Boolean);
}

function baseName(p: string) {
  const parts = splitPath(p);
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}

function parentDir(p: string) {
  const parts = splitPath(p);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function joinRel(parent: string, name: string) {
  return parent ? `${parent}/${name}` : name;
}

function resolveRepoRelPath(rel: string) {
  const parts = splitPath(rel);
  if (parts.length <= 1) return "";
  const head = parts[0] ?? "";
  if (!head || !repoDirNameSet.value.has(head)) return "";
  return parts.slice(1).join("/");
}

function isProtectedRootPath(rel: string) {
  const parts = splitPath(rel);
  if (parts.length !== 1) return false;
  const head = parts[0] ?? "";
  return head ? repoDirNameSet.value.has(head) : false;
}

function createRootNode(name: string): TreeNode {
  return {
    key: ROOT_KEY,
    title: name,
    isLeaf: false,
    data: { name, path: "", kind: "dir", mtimeMs: 0 }
  };
}

function ensureRootNode() {
  const name = workspaceRootName.value;
  let root = treeData.value.find((node) => node.key === ROOT_KEY) ?? null;
  if (!root) {
    root = createRootNode(name);
    treeData.value = [root];
  } else {
    root.title = name;
    root.data.name = name;
  }
  return root;
}

function initRootTree() {
  treeData.value = [createRootNode(workspaceRootName.value)];
  expandedKeys.value = [ROOT_KEY];
  selectedKeys.value = [];
  loadedDirs.clear();
  nodeByPath.clear();
  selectedNode.value = null;
  rebuildNodeMap();
}

function toDirPath(key: string) {
  return key === ROOT_KEY ? "" : key;
}

function nextDirRequestId(dir: string) {
  const next = (dirRequestSeqByDir.get(dir) ?? 0) + 1;
  dirRequestSeqByDir.set(dir, next);
  return next;
}

function nextFileRequestId(filePath: string) {
  const next = (fileRequestSeqByPath.get(filePath) ?? 0) + 1;
  fileRequestSeqByPath.set(filePath, next);
  return next;
}

function rebuildNodeMap() {
  nodeByPath.clear();
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      nodeByPath.set(node.key, node);
      if (node.children && node.children.length > 0) walk(node.children);
    }
  };
  walk(treeData.value);
  if (selectedNode.value) {
    selectedNode.value = nodeByPath.get(selectedNode.value.key) ?? nodeByPath.get(selectedNode.value.data.path) ?? null;
  }
}

function updateChildren(dir: string, entries: FileEntry[]) {
  const nodes = entries.map((entry) => ({
    key: entry.path,
    title: entry.name,
    isLeaf: entry.kind === "file",
    data: entry
  }));
  if (!dir) {
    const root = ensureRootNode();
    if (root) root.children = nodes;
  } else {
    const parentNode = nodeByPath.get(dir);
    if (parentNode) parentNode.children = nodes;
  }
  rebuildNodeMap();
}

function markLoaded(dir: string) {
  loadedDirs.add(dir);
}

async function loadDir(dir: string) {
  const scopeSnapshot = scopeSeq;
  const entries = await fetchDirEntries(dir, scopeSnapshot);
  if (!entries) return;
  updateChildren(dir, entries);
  markLoaded(dir);
}

async function fetchDirEntries(dir: string, scopeSnapshot: number) {
  const requestId = nextDirRequestId(dir);
  try {
    const res = await listWorkspaceFiles({ workspaceId: props.workspaceId, dir });
    if (scopeSnapshot !== scopeSeq) return null;
    if (dirRequestSeqByDir.get(dir) !== requestId) return null;
    return res.entries;
  } catch (err) {
    if (scopeSnapshot !== scopeSeq) return null;
    if (dirRequestSeqByDir.get(dir) !== requestId) return null;
    throw err;
  }
}

function getRefreshDirs() {
  const unique = new Set<string>();
  unique.add("");
  for (const key of expandedKeys.value) {
    unique.add(toDirPath(key));
  }
  return Array.from(unique).sort((a, b) => splitPath(a).length - splitPath(b).length);
}

async function refreshRoot() {
  const scopeSnapshot = scopeSeq;
  treeLoading.value = true;
  try {
    const dirs = getRefreshDirs();
    const results: Array<{ dir: string; entries: FileEntry[] }> = [];
    for (const dir of dirs) {
      if (scopeSnapshot !== scopeSeq) return;
      if (dir && !nodeByPath.has(dir)) continue;
      try {
        const entries = await fetchDirEntries(dir, scopeSnapshot);
        if (!entries) continue;
        results.push({ dir, entries });
      } catch (err) {
        if (scopeSnapshot !== scopeSeq) return;
        message.error(err instanceof Error ? err.message : String(err));
        if (!dir) break;
      }
    }
    if (scopeSnapshot !== scopeSeq) return;
    for (const { dir, entries } of results) {
      updateChildren(dir, entries);
      markLoaded(dir);
    }
  } finally {
    if (scopeSnapshot === scopeSeq) treeLoading.value = false;
  }
}

async function refreshDir(dir: string) {
  try {
    await loadDir(dir);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

function onExpandedKeysUpdate(keys: (string | number)[]) {
  const next = keys.map((k) => String(k));
  const prev = expandedKeys.value;
  const collapsed = prev.filter((k) => !next.includes(k));

  let pruned = next;
  for (const ck of collapsed) {
    if (ck === ROOT_KEY) {
      // 根节点收起时,递归收起全部后代目录
      pruned = pruned.filter((k) => k === ROOT_KEY);
      continue;
    }
    pruned = pruned.filter((k) => k !== ck && !k.startsWith(ck + "/"));
  }
  expandedKeys.value = pruned;
}

function onSelectedKeysUpdate(keys: (string | number)[]) {
  selectedKeys.value = keys.map((k) => String(k));
}

async function onLoadData(node: any) {
  const key = String(node?.key || "");
  if (!key) return;
  const dir = toDirPath(key);
  if (loadedDirs.has(dir)) return;
  try {
    await loadDir(dir);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

function onNodeContextMenu(node: TreeNode) {
  // 右键时先选中,保证菜单操作对象明确
  selectedNode.value = node;
  selectedKeys.value = [node.key];
}

function onNodeDblClick(node: TreeNode) {
  if (node.data.kind !== "dir") return;
  const key = node.key;
  const isExpanded = expandedKeys.value.includes(key);
  if (isExpanded) {
    if (key === ROOT_KEY) {
      expandedKeys.value = [];
      return;
    }
    expandedKeys.value = expandedKeys.value.filter((k) => k !== key && !k.startsWith(key + "/"));
    return;
  }
  expandedKeys.value = [...expandedKeys.value, key];
  const dir = toDirPath(key);
  if (loadedDirs.has(dir)) return;
  void loadDir(dir).catch((err) => {
    message.error(err instanceof Error ? err.message : String(err));
  });
}

async function copyTextWithFeedback(text: string, kind: "name" | "repoPath" | "workspacePath") {
  const content = String(text ?? "");
  if (!content) return;
  const successMessage =
    kind === "name"
      ? t("files.copy.nameCopied")
      : kind === "workspacePath"
        ? t("files.copy.workspacePathCopied")
        : t("files.copy.repoPathCopied");
  try {
    await navigator.clipboard.writeText(content);
    message.success(successMessage);
    return;
  } catch {
    // 回退使用旧式复制 API
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
      message.success(successMessage);
      return;
    }
  } catch {
    // 忽略
  }
  message.error(t("files.copy.failed"));
}

function copySelectedName() {
  const name = selectedNode.value?.data.name ?? "";
  return copyTextWithFeedback(name, "name");
}

function copySelectedRepoPath() {
  const rel = selectedNode.value?.data.path ?? "";
  const repoRel = resolveRepoRelPath(rel);
  return copyTextWithFeedback(repoRel, "repoPath");
}

function selectedNodeWorkspacePath() {
  const rel = selectedNode.value?.data.path ?? "";
  return rel || ".";
}

function copySelectedWorkspacePath() {
  const path = selectedNodeWorkspacePath();
  return copyTextWithFeedback(path, "workspacePath");
}

function onContextMenuClick(info: { key: string }) {
  const key = String((info as any)?.key ?? "");
  if (!key) return;
  if (key === "copyName") {
    void copySelectedName();
    return;
  }
  if (key === "copyRepoPath" || key === "copyPath") {
    void copySelectedRepoPath();
    return;
  }
  if (key === "copyWorkspacePath") {
    void copySelectedWorkspacePath();
    return;
  }
  if (key === "newFile") {
    openCreateModal("file");
    return;
  }
  if (key === "newFolder") {
    openCreateModal("dir");
    return;
  }
  if (key === "rename") {
    openRenameModal();
    return;
  }
  if (key === "delete") {
    confirmDeleteSelected();
  }
}

function onTreeSelect(keys: (string | number)[]) {
  const key = typeof keys[0] === "string" || typeof keys[0] === "number" ? String(keys[0]) : "";
  if (!key) {
    selectedNode.value = null;
    return;
  }
  const node = nodeByPath.get(key) ?? null;
  selectedNode.value = node;
  if (key === ROOT_KEY) return;
  if (node?.data.kind === "file") void openFile(key);
}

function resetTree() {
  treeData.value = [];
  expandedKeys.value = [];
  selectedKeys.value = [];
  loadedDirs.clear();
  nodeByPath.clear();
  selectedNode.value = null;
  treeKey.value += 1;
}

function disposeTab(tab: FileTab) {
  tab.disposable?.dispose();
  tab.disposable = undefined;
  tab.model?.dispose();
  tab.model = undefined;
}

function resetTabs() {
  store.resetTabs();
}

function getTab(path: string) {
  return tabs.find((t) => t.path === path) ?? null;
}

function setActiveTabByPath(path: string) {
  activeTabKey.value = path;
  scheduleApplyEditor();
}

function attachModelListener(tab: FileTab) {
  if (!tab.model) return;
  tab.disposable?.dispose();
  tab.disposable = markRaw(
    tab.model.onDidChangeContent(() => {
      const current = tab.model?.getValue() ?? "";
      tab.dirty = current !== tab.savedContent;
    })
  );
}

function createTabFromRead(path: string, res: FileReadResponse) {
  const title = baseName(path);
  const language = res.language ?? inferLanguageFromPath(path);
  const tab: FileTab = {
    path,
    title,
    previewable: res.previewable,
    reason: res.reason,
    version: res.version,
    savedContent: res.content ?? "",
    dirty: false,
    saving: false,
    pendingSave: false,
    conflictOpen: false,
    error: undefined,
    language
  };
  if (res.previewable) {
    ensureMonacoEnvironment();
    const uri = monaco.Uri.parse(`inmemory://model/${encodeURIComponent(path)}`);
    const model = monaco.editor.createModel(res.content ?? "", "plaintext", uri);
    // Monaco 的 model 对象图很大,放进 Vue 响应式会导致卡死/崩溃,这里强制标记为非响应式
    tab.model = markRaw(model);
    void ensureAndApplyLanguage(model, language);
    attachModelListener(tab);
  }
  tabs.push(tab);
  return tab;
}

async function openFile(path: string) {
  const existing = getTab(path);
  if (existing) {
    setActiveTabByPath(path);
    return;
  }
  const scopeSnapshot = scopeSeq;
  const requestId = nextFileRequestId(path);
  try {
    const res = await readWorkspaceFileText({ workspaceId: props.workspaceId, path });
    if (scopeSnapshot !== scopeSeq) return;
    if (fileRequestSeqByPath.get(path) !== requestId) return;
    const existingAfter = getTab(path);
    if (existingAfter) {
      setActiveTabByPath(path);
      return;
    }
    const tab = createTabFromRead(path, res);
    setActiveTabByPath(tab.path);
  } catch (err) {
    if (scopeSnapshot !== scopeSeq) return;
    if (fileRequestSeqByPath.get(path) !== requestId) return;
    message.error(err instanceof Error ? err.message : String(err));
  }
}

function clearHighlightDecorations() {
  if (!editor) return;
  highlightDecorations = editor.deltaDecorations(highlightDecorations, []);
}

function applyOpenAtHighlight(req: FileOpenAtRequest) {
  if (!editor) return;
  const model = editor.getModel();
  if (!model) return;
  const maxLine = model.getLineCount();
  const line = Math.min(Math.max(req.line, 1), maxLine);
  clearHighlightDecorations();
  if (req.highlight.kind === "line") {
    const range = new monaco.Range(line, 1, line, model.getLineMaxColumn(line));
    highlightDecorations = editor.deltaDecorations(highlightDecorations, [
      { range, options: { isWholeLine: true, className: "files-search-line" } }
    ]);
  } else {
    const startCol = Math.max(req.highlight.startCol, 1);
    const endCol = Math.max(req.highlight.endCol, startCol);
    const range = new monaco.Range(line, startCol, line, endCol);
    highlightDecorations = editor.deltaDecorations(highlightDecorations, [
      { range, options: { inlineClassName: "files-search-hit" } }
    ]);
  }
  editor.revealLineInCenter(line);
}

function resolveOpenAtPath(req: FileOpenAtRequest) {
  let raw = String(req.path || "").trim();
  if (!raw) return "";
  while (raw.startsWith("./")) raw = raw.slice(2);
  raw = raw.replace(/\\/g, "/");
  raw = raw.replace(/\/{2,}/g, "/");
  while (raw.endsWith("/")) raw = raw.slice(0, -1);
  if (!raw || raw.startsWith("/")) return "";
  const parts = splitPath(raw);
  if (parts.some((part) => part === "..")) return "";
  const head = parts[0] ?? "";
  if (head && repoDirNameSet.value.has(head)) return raw;
  return raw;
}

async function openFileAt(req: FileOpenAtRequest) {
  const resolved = resolveOpenAtPath(req);
  if (!resolved) return;
  await openFile(resolved);
  await nextTick();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (!editor) return;
  applyOpenAtHighlight(req);
}

function onActiveTabUpdate(key: string | number) {
  const k = String(key);
  setActiveTabByPath(k);
}

function requestCloseTab(path: string) {
  const tab = getTab(path);
  if (!tab) return;
  if (tab.dirty) {
    Modal.confirm({
      title: t("files.closeConfirm.title"),
      content: t("files.closeConfirm.content"),
      okText: t("files.closeConfirm.ok"),
      cancelText: t("files.closeConfirm.cancel"),
      onOk: () => closeTab(path)
    });
    return;
  }
  closeTab(path);
}

function closeTab(path: string) {
  const idx = tabs.findIndex((t) => t.path === path);
  if (idx < 0) return;
  const tab = tabs[idx]!;
  disposeTab(tab);
  tabs.splice(idx, 1);
  if (activeTabKey.value === path) {
    const next = tabs[idx] ?? tabs[idx - 1] ?? null;
    if (next) setActiveTabByPath(next.path);
    else {
      activeTabKey.value = "";
      if (editor) editor.setModel(null);
    }
  }
}

function isConflictError(err: unknown) {
  return err instanceof ApiError && err.status === 409;
}

async function saveTab(tab: FileTab, opts?: { force?: boolean }) {
  if (tab.conflictOpen && !opts?.force) return;
  if (!tab.model || tab.saving) {
    if (tab.saving && !tab.conflictOpen) tab.pendingSave = true;
    return;
  }
  if (opts?.force) tab.conflictOpen = false;
  tab.saving = true;
  tab.error = undefined;
  tab.pendingSave = false;
  const content = tab.model.getValue();
  try {
    const res = await writeWorkspaceFileText({
      workspaceId: props.workspaceId,
      path: tab.path,
      content,
      expected: tab.version,
      force: opts?.force
    });
    tab.version = res.version;
    tab.savedContent = content;
    tab.dirty = false;
  } catch (err) {
    tab.error = err instanceof Error ? err.message : String(err);
    if (isConflictError(err) && !opts?.force) {
      tab.pendingSave = false;
      if (tab.conflictOpen) return;
      tab.conflictOpen = true;
      Modal.confirm({
        title: t("files.conflict.title"),
        content: t("files.conflict.content"),
        okText: t("files.conflict.reload"),
        cancelText: t("files.conflict.force"),
        maskClosable: false,
        closable: false,
        cancelButtonProps: { danger: true },
        onOk: async () => {
          tab.conflictOpen = false;
          await reloadTab(tab.path);
        },
        onCancel: async () => {
          tab.conflictOpen = false;
          await saveTab(tab, { force: true });
        }
      });
    }
  } finally {
    tab.saving = false;
    if (tab.pendingSave && tab.dirty && !tab.conflictOpen) {
      tab.pendingSave = false;
      void saveTab(tab);
    }
  }
}

async function saveTabFromEditor(opts?: { force?: boolean }) {
  const model = editor?.getModel() ?? null;
  if (!model) return;
  const tab = tabs.find((item) => item.model === model) ?? null;
  if (!tab || !tab.dirty) return;
  await saveTab(tab, opts);
}

async function reloadTab(path: string) {
  const tab = getTab(path);
  if (!tab) return;
  try {
    const res = await readWorkspaceFileText({ workspaceId: props.workspaceId, path });
    tab.previewable = res.previewable;
    tab.reason = res.reason;
    tab.version = res.version;
    tab.language = res.language ?? inferLanguageFromPath(path);
    tab.error = undefined;
    if (res.previewable) {
      const current = tab.model?.getValue() ?? "";
      if (!tab.model) {
        const uri = monaco.Uri.parse(`inmemory://model/${encodeURIComponent(path)}`);
        const model = monaco.editor.createModel(res.content ?? "", "plaintext", uri);
        tab.model = markRaw(model);
        void ensureAndApplyLanguage(model, tab.language);
        attachModelListener(tab);
      } else if (current !== (res.content ?? "")) {
        tab.model.setValue(res.content ?? "");
      }
      if (tab.model) void ensureAndApplyLanguage(tab.model, tab.language);
      tab.savedContent = res.content ?? "";
      tab.dirty = false;
    } else {
      tab.model?.dispose();
      tab.model = undefined;
      tab.savedContent = "";
      tab.dirty = false;
    }
    if (activeTabKey.value === tab.path) setActiveTabByPath(tab.path);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

function notPreviewableLabel(tab: FileTab) {
  if (tab.reason === "too_large") return t("files.preview.tooLarge");
  if (tab.reason === "binary") return t("files.preview.binary");
  if (tab.reason === "decode_failed") return t("files.preview.decodeFailed");
  if (tab.reason === "unsafe_path") return t("files.preview.unsafePath");
  if (tab.reason === "missing") return t("files.preview.missing");
  return t("files.preview.unavailable");
}

function openCreateModal(kind: "file" | "dir") {
  createModal.kind = kind;
  createModal.name = "";
  createModal.parentDir = selectedNode.value
    ? selectedNode.value.data.kind === "dir"
      ? selectedNode.value.data.path
      : parentDir(selectedNode.value.data.path)
    : "";
  createModal.open = true;
}

async function submitCreate() {
  const name = createModal.name.trim();
  if (!name) {
    message.error(t("files.form.nameRequired"));
    return;
  }
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    message.error(t("files.form.nameInvalid"));
    return;
  }
  createModal.submitting = true;
  const parent = createModal.parentDir;
  const path = joinRel(parent, name);
  try {
    if (createModal.kind === "file") {
      const res = await createWorkspaceFile({ workspaceId: props.workspaceId, path, content: "" });
      await refreshDir(parent);
      const tab = createTabFromRead(path, {
        path,
        previewable: true,
        content: "",
        version: res.version,
        language: inferLanguageFromPath(path)
      });
      tab.savedContent = "";
      tab.dirty = false;
      setActiveTabByPath(tab.path);
    } else {
      await mkdirWorkspacePath({ workspaceId: props.workspaceId, path });
      await refreshDir(parent);
    }
    createModal.open = false;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    createModal.submitting = false;
  }
}

function openRenameModal() {
  const node = selectedNode.value;
  if (!node) return;
  if (!node.data.path) return;
  renameModal.path = node.data.path;
  renameModal.name = baseName(node.data.path);
  renameModal.open = true;
}

function replacePrefix(path: string, from: string, to: string) {
  if (path === from) return to;
  if (path.startsWith(from + "/")) return to + path.slice(from.length);
  return path;
}

function updateTabsForRename(from: string, to: string, isDir: boolean) {
  for (const tab of tabs) {
    if (isDir) {
      if (tab.path === from || tab.path.startsWith(from + "/")) {
        const nextPath = replacePrefix(tab.path, from, to);
        const nextTitle = baseName(nextPath);
        const nextLanguage = inferLanguageFromPath(nextPath);
        tab.path = nextPath;
        tab.title = nextTitle;
        tab.language = nextLanguage;
        if (tab.model) {
          const uri = monaco.Uri.parse(`inmemory://model/${encodeURIComponent(nextPath)}`);
          const value = tab.model.getValue();
          tab.model.dispose();
          const model = monaco.editor.createModel(value, "plaintext", uri);
          tab.model = markRaw(model);
          void ensureAndApplyLanguage(model, nextLanguage);
          attachModelListener(tab);
        }
      }
    } else if (tab.path === from) {
      const nextPath = to;
      const nextLanguage = inferLanguageFromPath(nextPath);
      tab.path = nextPath;
      tab.title = baseName(nextPath);
      tab.language = nextLanguage;
      if (tab.model) {
        const uri = monaco.Uri.parse(`inmemory://model/${encodeURIComponent(nextPath)}`);
        const value = tab.model.getValue();
        tab.model.dispose();
        const model = monaco.editor.createModel(value, "plaintext", uri);
        tab.model = markRaw(model);
        void ensureAndApplyLanguage(model, nextLanguage);
        attachModelListener(tab);
      }
    }
  }
  if (activeTabKey.value === from) {
    setActiveTabByPath(to);
  } else if (isDir && activeTabKey.value.startsWith(from + "/")) {
    setActiveTabByPath(replacePrefix(activeTabKey.value, from, to));
  }
}

function replaceKeysInList(keys: string[], from: string, to: string) {
  return keys.map((k) => replacePrefix(k, from, to));
}


async function submitRename() {
  const node = selectedNode.value;
  if (!node) return;
  const name = renameModal.name.trim();
  if (!name) {
    message.error(t("files.form.nameRequired"));
    return;
  }
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    message.error(t("files.form.nameInvalid"));
    return;
  }
  const from = renameModal.path;
  const to = joinRel(parentDir(from), name);
  renameModal.submitting = true;
  try {
    await renameWorkspacePath({ workspaceId: props.workspaceId, from, to });
    renameModal.open = false;
    const parent = parentDir(from);
    await refreshDir(parent);
    updateTabsForRename(from, to, node.data.kind === "dir");
    expandedKeys.value = replaceKeysInList(expandedKeys.value, from, to);
    if (node.data.kind === "dir") removeLoadedDirsUnder(from, true);
    selectedKeys.value = [to];
    selectedNode.value = nodeByPath.get(to) ?? null;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    renameModal.submitting = false;
  }
}

function countLoadedDescendants(node: TreeNode | null): number {
  if (!node || !node.children || node.children.length === 0) return 0;
  let count = 0;
  for (const child of node.children) {
    count += 1;
    count += countLoadedDescendants(child);
  }
  return count;
}

function closeTabsUnder(path: string, isDir: boolean) {
  const toClose = tabs.filter((tab) => (isDir ? tab.path === path || tab.path.startsWith(path + "/") : tab.path === path));
  for (const tab of toClose) {
    closeTab(tab.path);
  }
}

function removeLoadedDirsUnder(path: string, isDir: boolean) {
  if (!isDir) return;
  const next = new Set<string>();
  for (const dir of loadedDirs) {
    if (dir === path || dir.startsWith(path + "/")) continue;
    next.add(dir);
  }
  loadedDirs.clear();
  for (const dir of next) loadedDirs.add(dir);
}

function confirmDeleteSelected() {
  const node = selectedNode.value;
  if (!node) return;
  if (!node.data.path) return;
  const isDir = node.data.kind === "dir";
  const loadedCount = isDir ? countLoadedDescendants(node) : 0;
  const hint = isDir && loadedCount > 0 ? t("files.deleteConfirm.loadedHint", { count: loadedCount }) : "";
  Modal.confirm({
    title: t("files.deleteConfirm.title"),
    content: hint ? `${t("files.deleteConfirm.content")}\n${hint}` : t("files.deleteConfirm.content"),
    okText: t("files.deleteConfirm.ok"),
    okType: "danger",
    cancelText: t("files.deleteConfirm.cancel"),
    onOk: async () => {
      try {
        await deleteWorkspacePath({ workspaceId: props.workspaceId, path: node.data.path, recursive: true });
        closeTabsUnder(node.data.path, isDir);
        removeLoadedDirsUnder(node.data.path, isDir);
        await refreshDir(parentDir(node.data.path));
        selectedNode.value = null;
        selectedKeys.value = [];
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    }
  });
}

function attachEditorEvents() {
  if (!editor) return;
  editorBlurDisposable?.dispose();
  editorSaveCommandId = null;
  editorBlurDisposable = editor.onDidBlurEditorText(() => {
    void saveTabFromEditor();
  });
  editorSaveCommandId = editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void saveTabFromEditor();
  });
}

function scheduleApplyEditor() {
  if (editorApplyScheduled) return;
  editorApplyScheduled = true;
  void nextTick(() => {
    editorApplyScheduled = false;
    const tab = activeTab.value;
    const shouldHaveEditor = !!tab && tab.previewable !== false;

    if (!editor && shouldHaveEditor && editorEl.value) {
      initEditor();
    }
    if (!editor) return;

    const model = shouldHaveEditor ? tab?.model ?? null : null;
    editor.setModel(model);
    if (model) editor.focus();
    requestAnimationFrame(() => editor?.layout());
  });
}

function initEditor() {
  if (editor) return;
  if (!editorEl.value) return;
  ensureMonacoEnvironment();
  applyMonacoPanelTheme();
  editor = monaco.editor.create(editorEl.value, {
    automaticLayout: true,
    readOnly: false,
    fontSize: editorFontSize.value,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: "off",
    renderWhitespace: "selection"
  });
  attachEditorEvents();
}

// 设置-常规里的"编辑器字号"需要对已打开的编辑器实时生效
watch(
  () => editorFontSize.value,
  (next) => {
    if (!editor) return;
    editor.updateOptions({ fontSize: next });
    requestAnimationFrame(() => editor?.layout());
  }
);

watch(
  () => pendingOpenAt.value,
  (req) => {
    if (!req) return;
    store.setPendingOpenAt(null);
    void openFileAt(req);
  },
  { immediate: true }
);

watch(
  () => activeTabKey.value,
  () => {
    scheduleApplyEditor();
  }
);

watch(
  () => props.workspaceId,
  async () => {
    scopeSeq += 1;
    dirRequestSeqByDir.clear();
    fileRequestSeqByPath.clear();
    resetTabs();
    resetTree();
    initRootTree();
    await refreshRoot();
  },
  { immediate: true }
);

watch(
  () => workspaceRootName.value,
  () => {
    ensureRootNode();
  }
);

watch(
  () => (props.workspaceRepos ?? []).map((item) => item.dirName).join("|"),
  async () => {
    if (!treeData.value.length) return;
    await refreshRoot();
  }
);

onMounted(() => {
  scheduleApplyEditor();
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", handleEditorKeydown, true);
  }
});

onBeforeUnmount(() => {
  if (typeof window !== "undefined") {
    window.removeEventListener("keydown", handleEditorKeydown, true);
  }
  draggingCleanup?.();
  editorBlurDisposable?.dispose();
  editorSaveCommandId = null;
  editor?.dispose();
  editor = null;
});
</script>

<style scoped>
.files-tabs :deep(.ant-tabs-content-holder) {
  display: none;
}

.files-tabs :deep(.ant-tabs-nav) {
  margin-bottom: 0 !important;
  background: var(--panel-bg-elevated);
}

.files-tabs :deep(.ant-tabs-tab) {
  margin-left: 0 !important;
}

:deep(.files-search-hit) {
  background: rgba(255, 214, 102, 0.45);
}

:deep(.files-search-line) {
  background: rgba(255, 214, 102, 0.2);
}
</style>
