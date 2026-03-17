<template>
  <div class="h-full min-h-0 flex flex-col">
    <div ref="containerEl" class="flex-1 min-h-0 flex flex-col">
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
        :refresh-root="refreshAll"
        :on-load-data="onLoadData"
        :on-expanded-keys-update="onExpandedKeysUpdate"
        :on-selected-keys-update="onSelectedKeysUpdate"
        :on-tree-select="onTreeSelect"
        :on-node-context-menu="onNodeContextMenu"
        :on-node-dbl-click="onNodeDblClick"
        :on-context-menu-click="onContextMenuClick"
      />
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
        <a-input ref="createNameInputRef" v-model:value="createModal.name" :placeholder="t('files.form.namePlaceholder')" />
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
        <a-input ref="renameNameInputRef" v-model:value="renameModal.name" :placeholder="t('files.form.renamePlaceholder')" />
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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { useI18n } from "vue-i18n";
import type { FileEntry } from "@agent-workbench/shared";
import FileExplorerTree from "./components/FileExplorerTree.vue";
import type { TreeNode } from "./types";
import {
  createWorkspaceFile,
  deleteWorkspacePath,
  downloadWorkspacePath,
  listWorkspaceFiles,
  mkdirWorkspacePath,
  renameWorkspacePath,
  uploadWorkspaceFiles
} from "@/shared/api";
import { useWorkspaceHost } from "@/features/workspace/host";

const props = defineProps<{
  workspaceId: string;
  toolId: string;
  workspaceDirName?: string;
  workspaceRepos?: Array<{ dirName: string }>;
}>();
const { t } = useI18n();
const host = useWorkspaceHost(props.toolId);

const ROOT_KEY = "__files_root__";

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
let scopeSeq = 0;
let unregisterRefresh: (() => void) | null = null;

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

type SimpleInputRef = { focus?: () => void; select?: () => void };

const createNameInputRef = ref<SimpleInputRef | null>(null);
const renameNameInputRef = ref<SimpleInputRef | null>(null);
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

watch(
  () => createModal.open,
  (open) => {
    if (!open) return;
    nextTick(() => {
      createNameInputRef.value?.focus?.();
    });
  }
);

watch(
  () => renameModal.open,
  (open) => {
    if (!open) return;
    nextTick(() => {
      const input = renameNameInputRef.value;
      if (input?.select) {
        input.select();
        return;
      }
      input?.focus?.();
    });
  }
);

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

function isDirExpanded(dir: string) {
  const key = dir ? dir : ROOT_KEY;
  return expandedKeys.value.includes(key);
}

function clearLoadedOnCollapse(key: string) {
  if (key === ROOT_KEY) {
    loadedDirs.clear();
    return;
  }
  const dir = toDirPath(key);
  removeLoadedDirsUnder(dir, true);
}

function markLoaded(dir: string) {
  if (!isDirExpanded(dir)) return;
  loadedDirs.add(dir);
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

async function loadDir(dir: string) {
  const scopeSnapshot = scopeSeq;
  const entries = await fetchDirEntries(dir, scopeSnapshot);
  if (!entries) return;
  updateChildren(dir, entries);
  markLoaded(dir);
}

function getRefreshDirs() {
  const unique = new Set<string>();
  unique.add("");
  for (const key of expandedKeys.value) unique.add(toDirPath(key));
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

async function refreshAll() {
  await refreshRoot();
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
      clearLoadedOnCollapse(ck);
      pruned = pruned.filter((k) => k === ROOT_KEY);
      continue;
    }
    clearLoadedOnCollapse(ck);
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

function openFileInEditor(path: string) {
  host.call("editor", {
    type: "editor.openFile",
    payload: {
      path,
      mode: "edit"
    }
  });
}

function onNodeContextMenu(node: TreeNode) {
  selectedNode.value = node;
  selectedKeys.value = [node.key];
}

function onNodeDblClick(node: TreeNode) {
  if (node.data.kind !== "dir") return;
  const key = node.key;
  const isExpanded = expandedKeys.value.includes(key);
  if (isExpanded) {
    if (key === ROOT_KEY) {
      clearLoadedOnCollapse(key);
      expandedKeys.value = [];
      return;
    }
    clearLoadedOnCollapse(key);
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
      message.success(successMessage);
      return;
    }
  } catch {
    // ignore
  }
  message.error(t("files.copy.failed"));
}

function copySelectedName() {
  return copyTextWithFeedback(selectedNode.value?.data.name ?? "", "name");
}

function copySelectedRepoPath() {
  return copyTextWithFeedback(resolveRepoRelPath(selectedNode.value?.data.path ?? ""), "repoPath");
}

function selectedNodeWorkspacePath() {
  const rel = selectedNode.value?.data.path ?? "";
  return rel || ".";
}

function copySelectedWorkspacePath() {
  return copyTextWithFeedback(selectedNodeWorkspacePath(), "workspacePath");
}

function downloadFallbackName(node: TreeNode) {
  if (node.data.kind === "dir") {
    if (!node.data.path) return `${workspaceRootName.value || "workspace"}.zip`;
    return `${baseName(node.data.path)}.zip`;
  }
  return baseName(node.data.path);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

async function pickUploadFiles(): Promise<File[]> {
  return await new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    const cleanup = () => input.remove();
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      cleanup();
      resolve(files);
    });
    document.body.appendChild(input);
    input.click();
  });
}

async function uploadSelectedFiles() {
  const node = selectedNode.value;
  if (!node || node.data.kind !== "dir") return;
  const files = await pickUploadFiles();
  if (files.length === 0) return;
  const dir = node.data.path ?? "";
  const msgKey = `files-upload-${Date.now()}`;
  const scopeSnapshot = scopeSeq;
  message.loading({ content: t("files.upload.uploading"), key: msgKey, duration: 0 });
  try {
    const res = await uploadWorkspaceFiles({ workspaceId: props.workspaceId, dir, files });
    if (scopeSnapshot !== scopeSeq) {
      message.destroy(msgKey);
      return;
    }
    await refreshDir(dir);
    if (scopeSnapshot !== scopeSeq) {
      message.destroy(msgKey);
      return;
    }
    const failed = res.results.filter((item) => !item.ok);
    if (failed.length > 0) {
      const names = failed.map((item) => item.name || item.path).filter(Boolean).join(", ");
      message.error({ content: t("files.upload.partialFailed", { names }), key: msgKey });
      return;
    }
    host.emitToolEvent("editor", { type: "editor.fsUploaded", payload: { paths: res.results.map((item) => item.path).filter(Boolean) }, sourceToolId: props.toolId });
    message.success({ content: t("files.upload.success"), key: msgKey });
  } catch (err) {
    message.error({ content: err instanceof Error ? err.message : String(err), key: msgKey });
  }
}

async function downloadSelected() {
  const node = selectedNode.value;
  if (!node) return;
  const path = node.data.path ?? "";
  try {
    const res = await downloadWorkspacePath({ workspaceId: props.workspaceId, path });
    const filename = res.filename || downloadFallbackName(node);
    triggerDownload(res.blob, filename);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

function onContextMenuClick(info: { key: string }) {
  const key = String((info as any)?.key ?? "");
  if (!key) return;
  if (key === "copyName") return void copySelectedName();
  if (key === "copyRepoPath" || key === "copyPath") return void copySelectedRepoPath();
  if (key === "copyWorkspacePath") return void copySelectedWorkspacePath();
  if (key === "upload") return void uploadSelectedFiles();
  if (key === "searchInFolder") {
    const node = selectedNode.value;
    if (!node || node.data.kind !== "dir") return;
    const path = selectedNodeWorkspacePath();
    host.openTool("search");
    host.emitToolEvent("search", { type: "search.prefillPath", payload: { path }, sourceToolId: props.toolId });
    return;
  }
  if (key === "download") return void downloadSelected();
  if (key === "newFile") return openCreateModal("file");
  if (key === "newFolder") return openCreateModal("dir");
  if (key === "rename") return openRenameModal();
  if (key === "delete") return confirmDeleteSelected();
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
  if (node?.data.kind === "file") openFileInEditor(key);
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
  const scopeSnapshot = scopeSeq;
  const path = joinRel(parent, name);
  try {
    if (createModal.kind === "file") {
      await createWorkspaceFile({ workspaceId: props.workspaceId, path, content: "" });
      if (scopeSnapshot !== scopeSeq) return;
      host.emitToolEvent("editor", { type: "editor.fsCreated", payload: { path }, sourceToolId: props.toolId });
      await refreshDir(parent);
      if (scopeSnapshot !== scopeSeq) return;
      openFileInEditor(path);
    } else {
      await mkdirWorkspacePath({ workspaceId: props.workspaceId, path });
      if (scopeSnapshot !== scopeSeq) return;
      await refreshDir(parent);
      if (scopeSnapshot !== scopeSeq) return;
      host.emitToolEvent("editor", { type: "editor.fsCreated", payload: { path, kind: "dir" }, sourceToolId: props.toolId });
    }
    if (scopeSnapshot !== scopeSeq) return;
    createModal.open = false;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    createModal.submitting = false;
  }
}

function openRenameModal() {
  const node = selectedNode.value;
  if (!node?.data.path) return;
  renameModal.path = node.data.path;
  renameModal.name = baseName(node.data.path);
  renameModal.open = true;
}

function replacePrefix(path: string, from: string, to: string) {
  if (path === from) return to;
  if (path.startsWith(from + "/")) return to + path.slice(from.length);
  return path;
}

function replaceKeysInList(keys: string[], from: string, to: string) {
  return keys.map((k) => replacePrefix(k, from, to));
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
  const scopeSnapshot = scopeSeq;
  try {
    await renameWorkspacePath({ workspaceId: props.workspaceId, from, to });
    if (scopeSnapshot !== scopeSeq) return;
    host.emitToolEvent("editor", { type: "editor.fsRenamed", payload: { from, to, kind: node.data.kind }, sourceToolId: props.toolId });
    renameModal.open = false;
    const parent = parentDir(from);
    await refreshDir(parent);
    if (scopeSnapshot !== scopeSeq) return;
    expandedKeys.value = replaceKeysInList(expandedKeys.value, from, to);
    if (node.data.kind === "dir") removeLoadedDirsUnder(from, true);
    selectedKeys.value = [to];
    if (scopeSnapshot !== scopeSeq) return;
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

function confirmDeleteSelected() {
  const node = selectedNode.value;
  if (!node?.data.path) return;
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
      const scopeSnapshot = scopeSeq;
      try {
        await deleteWorkspacePath({ workspaceId: props.workspaceId, path: node.data.path, recursive: true });
        if (scopeSnapshot !== scopeSeq) return;
        host.emitToolEvent("editor", { type: "editor.fsDeleted", payload: { path: node.data.path, kind: node.data.kind }, sourceToolId: props.toolId });
        removeLoadedDirsUnder(node.data.path, isDir);
        await refreshDir(parentDir(node.data.path));
        if (scopeSnapshot !== scopeSeq) return;
        selectedNode.value = null;
        selectedKeys.value = [];
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    }
  });
}

watch(
  () => props.workspaceId,
  async () => {
    scopeSeq += 1;
    dirRequestSeqByDir.clear();
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
  unregisterRefresh = host.registerToolCommands(props.toolId, { refresh: refreshAll });
});

onBeforeUnmount(() => {
  unregisterRefresh?.();
  unregisterRefresh = null;
});
</script>
