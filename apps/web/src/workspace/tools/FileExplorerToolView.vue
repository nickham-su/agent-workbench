<template>
  <div class="h-full min-h-0 flex flex-col">
    <div class="flex items-center justify-between px-2 py-1 border-b border-[var(--border-color-secondary)]">
      <div class="text-xs font-semibold">{{ t("files.title") }}</div>
      <div class="flex items-center gap-1">
        <a-tooltip :title="t('files.actions.refresh')" :mouseEnterDelay="0" :mouseLeaveDelay="0">
          <span class="inline-flex">
            <a-button size="small" type="text" :disabled="!target" @click="refreshRoot">
              <template #icon><ReloadOutlined /></template>
            </a-button>
          </span>
        </a-tooltip>
      </div>
    </div>

    <div v-if="!target" class="flex-1 min-h-0 flex items-center justify-center text-xs text-[color:var(--text-tertiary)]">
      {{ t("files.placeholder.selectRepo") }}
    </div>

    <div v-else class="flex-1 min-h-0 flex">
      <div class="w-64 min-w-[240px] max-w-[360px] flex flex-col border-r border-[var(--border-color-secondary)]">
        <div class="flex-1 min-h-0 overflow-auto">
          <a-tree
            :key="treeKey"
            :tree-data="treeData"
            :load-data="onLoadData"
            :expandedKeys="expandedKeys"
            :selectedKeys="selectedKeys"
            blockNode
            showLine
            @update:expandedKeys="onExpandedKeysUpdate"
            @update:selectedKeys="onSelectedKeysUpdate"
            @select="onTreeSelect"
          >
            <template #title="{ title, dataRef }">
              <a-dropdown :trigger="['contextmenu']" class="block">
                <span
                  class="block w-full select-none pr-2"
                  @contextmenu.prevent="onNodeContextMenu(dataRef as TreeNode)"
                  @dblclick.stop.prevent="onNodeDblClick(dataRef as TreeNode)"
                >
                  {{ title }}
                </span>
                <template #overlay>
                  <a-menu @click="onContextMenuClick">
                    <a-menu-item v-if="selectedNode?.data.kind === 'dir'" key="newFile">
                      {{ t("files.actions.newFile") }}
                    </a-menu-item>
                    <a-menu-item v-if="selectedNode?.data.kind === 'dir'" key="newFolder">
                      {{ t("files.actions.newFolder") }}
                    </a-menu-item>
                    <a-menu-divider v-if="selectedNode?.data.kind === 'dir' && canRenameDelete" />
                    <a-menu-item v-if="canRenameDelete" key="rename">{{ t("files.actions.rename") }}</a-menu-item>
                    <a-menu-item v-if="canRenameDelete" key="delete" danger>{{ t("files.actions.delete") }}</a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </template>
          </a-tree>
          <div v-if="treeLoading" class="p-2 text-xs text-[color:var(--text-tertiary)]">
            {{ t("common.loading") }}
          </div>
          <div v-else-if="isTreeEmpty" class="p-2 text-xs text-[color:var(--text-tertiary)]">
            {{ t("files.placeholder.empty") }}
          </div>
        </div>
      </div>

      <div class="flex-1 min-w-0 min-h-0 flex flex-col">
        <a-tabs
          v-if="tabs.length > 0"
          :activeKey="activeTabKey"
          size="small"
          :animated="false"
          class="files-tabs"
          @update:activeKey="onActiveTabUpdate"
        >
          <a-tab-pane v-for="tab in tabs" :key="tab.path">
            <template #tab>
                <span class="files-tab-label">
                  <span class="truncate max-w-[180px]">{{ tab.title }}</span>
                  <span v-if="tab.dirty && !tab.saving" class="ml-1 text-[10px] text-[color:var(--warning-color)]">●</span>
                  <a-tooltip :title="t('files.actions.close')" :mouseEnterDelay="0" :mouseLeaveDelay="0">
                    <CloseOutlined
                      class="cursor-pointer text-[color:var(--text-tertiary)] hover:text-[color:var(--text-secondary)] !ml-2 text-xs"
                      @mousedown.stop.prevent
                    @click.stop.prevent="requestCloseTab(tab.path)"
                  />
                </a-tooltip>
              </span>
            </template>
          </a-tab-pane>
        </a-tabs>

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

<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { useI18n } from "vue-i18n";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/min/vs/editor/editor.main.css";
import { CloseOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import type { FileEntry, FileReadResponse, FileVersion, GitTarget } from "@agent-workbench/shared";
import {
  ApiError,
  createFile,
  deletePath,
  listFiles,
  mkdirPath,
  readFileText,
  renamePath,
  writeFileText
} from "../../services/api";
import { ensureMonacoEnvironment } from "../../monaco/monacoEnv";
import { ensureMonacoLanguage } from "../../monaco/languageLoader";
import { diffFontSize } from "../../settings/uiFontSizes";

type TreeNode = {
  key: string;
  title: string;
  isLeaf: boolean;
  children?: TreeNode[];
  selectable?: boolean;
  data: FileEntry;
};

type FileTab = {
  path: string;
  title: string;
  previewable: boolean;
  reason?: FileReadResponse["reason"];
  version?: FileVersion;
  model?: monaco.editor.ITextModel;
  savedContent: string;
  dirty: boolean;
  saving: boolean;
  pendingSave: boolean;
  conflictOpen?: boolean;
  error?: string;
  language?: string;
  disposable?: monaco.IDisposable;
};

const props = defineProps<{ workspaceId: string; target: GitTarget | null; toolId: string }>();
const { t } = useI18n();

const ROOT_KEY = "__files_root__";

const treeKey = ref(0);
const treeData = ref<TreeNode[]>([]);
const expandedKeys = ref<string[]>([]);
const selectedKeys = ref<string[]>([]);
const treeLoading = ref(false);
const loadedDirs = new Set<string>();
const nodeByPath = new Map<string, TreeNode>();
const dirRequestSeqByDir = new Map<string, number>();
const fileRequestSeqByPath = new Map<string, number>();
let targetSeq = 0;

const tabs = reactive<FileTab[]>([]);
const activeTabKey = ref<string>("");

const editorEl = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let editorBlurDisposable: monaco.IDisposable | null = null;
let editorSaveCommandId: string | null = null;
let editorApplyScheduled = false;

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
const canRenameDelete = computed(() => !!selectedNode.value && selectedNode.value.data.path !== "");
const rootNode = computed(() => treeData.value.find((node) => node.key === ROOT_KEY) ?? null);
const isTreeEmpty = computed(() => {
  const root = rootNode.value;
  if (!root) return true;
  if (!root.children) return false;
  return root.children.length === 0;
});

const activeTab = ref<FileTab | null>(null);

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

function createRootNode(target: GitTarget): TreeNode {
  return {
    key: ROOT_KEY,
    title: target.dirName,
    isLeaf: false,
    data: { name: target.dirName, path: "", kind: "dir", mtimeMs: 0 }
  };
}

function ensureRootNode() {
  if (!props.target) return null;
  let root = treeData.value.find((node) => node.key === ROOT_KEY) ?? null;
  if (!root) {
    root = createRootNode(props.target);
    treeData.value = [root];
  } else {
    root.title = props.target.dirName;
    root.data.name = props.target.dirName;
  }
  return root;
}

function initRootTree() {
  if (!props.target) return;
  treeData.value = [createRootNode(props.target)];
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
  if (!props.target) return;
  const targetSnapshot = targetSeq;
  const requestId = nextDirRequestId(dir);
  try {
    const res = await listFiles({ target: props.target, dir });
    if (targetSnapshot !== targetSeq) return;
    if (dirRequestSeqByDir.get(dir) !== requestId) return;
    updateChildren(dir, res.entries);
    markLoaded(dir);
  } catch (err) {
    if (targetSnapshot !== targetSeq) return;
    if (dirRequestSeqByDir.get(dir) !== requestId) return;
    throw err;
  }
}

async function refreshRoot() {
  if (!props.target) return;
  const targetSnapshot = targetSeq;
  treeLoading.value = true;
  try {
    await loadDir("");
  } catch (err) {
    if (targetSnapshot === targetSeq) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  } finally {
    if (targetSnapshot === targetSeq) treeLoading.value = false;
  }
}

async function refreshDir(dir: string) {
  if (!props.target) return;
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

function onContextMenuClick(info: { key: string }) {
  const key = String((info as any)?.key ?? "");
  if (!key) return;
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
  for (const tab of tabs) disposeTab(tab);
  tabs.splice(0, tabs.length);
  activeTabKey.value = "";
  activeTab.value = null;
}

function getTab(path: string) {
  return tabs.find((t) => t.path === path) ?? null;
}

function setActiveTabByPath(path: string) {
  activeTabKey.value = path;
  const tab = getTab(path);
  activeTab.value = tab;
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
  if (!props.target) return;
  const targetSnapshot = targetSeq;
  const requestId = nextFileRequestId(path);
  try {
    const res = await readFileText({ target: props.target, path });
    if (targetSnapshot !== targetSeq) return;
    if (fileRequestSeqByPath.get(path) !== requestId) return;
    const existingAfter = getTab(path);
    if (existingAfter) {
      setActiveTabByPath(path);
      return;
    }
    const tab = createTabFromRead(path, res);
    setActiveTabByPath(tab.path);
  } catch (err) {
    if (targetSnapshot !== targetSeq) return;
    if (fileRequestSeqByPath.get(path) !== requestId) return;
    message.error(err instanceof Error ? err.message : String(err));
  }
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
      activeTab.value = null;
      if (editor) editor.setModel(null);
    }
  }
}

function isConflictError(err: unknown) {
  return err instanceof ApiError && err.status === 409;
}

async function saveTab(tab: FileTab, opts?: { force?: boolean }) {
  if (tab.conflictOpen && !opts?.force) return;
  if (!props.target || !tab.model || tab.saving) {
    if (tab.saving && !tab.conflictOpen) tab.pendingSave = true;
    return;
  }
  if (opts?.force) tab.conflictOpen = false;
  tab.saving = true;
  tab.error = undefined;
  tab.pendingSave = false;
  const content = tab.model.getValue();
  try {
    const res = await writeFileText({
      target: props.target,
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
  if (!props.target) return;
  const tab = getTab(path);
  if (!tab) return;
  try {
    const res = await readFileText({ target: props.target, path });
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
  if (!props.target) return;
  createModal.submitting = true;
  const parent = createModal.parentDir;
  const path = joinRel(parent, name);
  try {
    if (createModal.kind === "file") {
      const res = await createFile({ target: props.target, path, content: "" });
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
      await mkdirPath({ target: props.target, path });
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
  if (!props.target) return;
  renameModal.submitting = true;
  try {
    await renamePath({ target: props.target, from, to });
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
      if (!props.target) return;
      try {
        await deletePath({ target: props.target, path: node.data.path, recursive: true });
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
  monaco.editor.setTheme("vs-dark");
  editor = monaco.editor.create(editorEl.value, {
    automaticLayout: true,
    readOnly: false,
    fontSize: diffFontSize.value,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: "off",
    renderWhitespace: "selection"
  });
  attachEditorEvents();
}

watch(
  () => activeTabKey.value,
  (key) => {
    if (!key) {
      activeTab.value = null;
      scheduleApplyEditor();
      return;
    }
    setActiveTabByPath(key);
  }
);

watch(
  () => (props.target ? `${props.target.workspaceId}:${props.target.dirName}` : ""),
  async () => {
    targetSeq += 1;
    dirRequestSeqByDir.clear();
    fileRequestSeqByPath.clear();
    resetTabs();
    resetTree();
    if (props.target) {
      initRootTree();
      await refreshRoot();
    }
  },
  { immediate: true }
);

onMounted(() => {
  scheduleApplyEditor();
});

onBeforeUnmount(() => {
  editorBlurDisposable?.dispose();
  editorSaveCommandId = null;
  editor?.dispose();
  editor = null;
  resetTabs();
});
</script>

<style scoped>
.files-tabs :deep(.ant-tabs-content-holder) {
  display: none;
}
</style>
