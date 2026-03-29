<template>
  <div class="h-full min-h-0 flex flex-col bg-[var(--panel-bg)]">
    <EditorTabs
      :tabs="tabItems"
      :active-tab-key="store.activeTabKey.value"
      :on-active-tab-update="onActiveTabUpdate"
      :request-close-tab="requestCloseTab"
      :request-close-other-tabs="requestCloseOtherTabs"
      :request-close-all-tabs="requestCloseAllTabs"
    />

    <div class="flex-1 min-h-0 relative">
      <div v-if="!activeTab" class="h-full flex items-center justify-center text-xs text-[color:var(--text-tertiary)]">
        {{ t("editor.placeholder.empty") }}
      </div>
      <div
        v-else-if="activeTab.kind === 'file' && activeTab.previewable === false"
        class="h-full flex items-center justify-center text-xs text-[color:var(--text-tertiary)]"
      >
        {{ notPreviewableLabel(activeTab) }}
      </div>
      <div ref="editorEl" class="absolute inset-0" v-show="activeTab?.kind === 'file' && activeTab.previewable !== false"></div>
      <div
        v-if="activeTab?.kind === 'file' && activeTab.saving"
        class="absolute right-2 top-2 text-[11px] text-[color:var(--text-tertiary)]"
      >
        {{ t("files.status.saving") }}
      </div>
      <div
        v-else-if="activeTab?.kind === 'file' && activeTab.error"
        class="absolute right-2 top-2 text-[11px] text-[color:var(--danger-color)]"
      >
        {{ activeTab.error }}
      </div>
      <div v-if="activeTab?.kind === 'preview'" class="h-full min-h-0 overflow-hidden">
        <MonacoCodeViewer class="h-full" :value="activeTab.text" :language="activeTab.language" :read-only="true" />
      </div>
      <div v-else-if="activeTab?.kind === 'diff'" class="h-full min-h-0 overflow-hidden">
        <MonacoDiffViewer
          ref="diffViewerRef"
          class="h-full"
          :original="activeTab.original"
          :modified="activeTab.modified"
          :language="activeTab.language"
          :compact-mode="true"
          :show-overview-ruler="true"
          :hide-vertical-scrollbar="true"
        />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default {
  name: "editor"
};
</script>

<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { useI18n } from "vue-i18n";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/min/vs/editor/editor.main.css";
import type { FileReadResponse } from "@agent-workbench/shared";
import { ApiError, readWorkspaceFileText, writeWorkspaceFileText } from "@/shared/api";
import { useWorkspaceHost } from "@/features/workspace/host";
import { ensureMonacoEnvironment } from "@/shared/monaco/monacoEnv";
import { applyMonacoPanelTheme } from "@/shared/monaco/monacoTheme";
import { ensureMonacoLanguage } from "@/shared/monaco/languageLoader";
import { inferLanguageFromPath, normalizeMonacoLanguage } from "@/shared/monaco/languageUtils";
import { editorFontSize } from "@/shared/settings/uiFontSizes";
import { getEditorStore } from "./store";
import type { EditorOpenAt, EditorOpenFileRequest, FileEditorTab, QueuedEditorOpenFileRequest } from "./types";
import EditorTabs from "./EditorTabs.vue";
import type { MonacoDiffViewerExposed } from "@/shared/components/MonacoDiffViewer.vue";
import MonacoCodeViewer from "@/shared/components/MonacoCodeViewer.vue";
import MonacoDiffViewer from "@/shared/components/MonacoDiffViewer.vue";

const props = defineProps<{ workspaceId: string; toolId: string }>();
const { t } = useI18n();
const emit = defineEmits<{
  (e: "diffTabActiveChange", active: boolean): void;
}>();

const host = useWorkspaceHost(props.toolId);
const store = getEditorStore(props.workspaceId);

const activeTab = computed(() => store.activeTab.value);
const tabItems = computed(() => store.tabs.map((tab) => ({
  key: tab.key,
  title: tab.title,
  path: "path" in tab ? tab.path : undefined,
  kind: tab.kind,
  dirty: tab.kind === "file" ? tab.dirty : false,
  saving: tab.kind === "file" ? tab.saving : false
})));

const editorEl = ref<HTMLDivElement | null>(null);
const diffViewerRef = ref<MonacoDiffViewerExposed | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let editorBlurDisposable: monaco.IDisposable | null = null;
let editorSaveCommandId: string | null = null;
let editorApplyScheduled = false;
let highlightDecorations: string[] = [];
const fileRequestSeqByPath = new Map<string, number>();
let unregisterToolCommands: (() => void) | null = null;
let latestOpenFileSeq = 0;
const openingFileTasks = ref(0);

function splitPath(p: string) {
  return p.split("/").filter(Boolean);
}

function baseName(p: string) {
  const parts = splitPath(p);
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}

function resolveOpenFilePath(req: EditorOpenFileRequest) {
  let raw = String(req.path || "").trim();
  if (!raw) return "";
  while (raw.startsWith("./")) raw = raw.slice(2);
  raw = raw.replace(/\\/g, "/");
  raw = raw.replace(/\/{2,}/g, "/");
  while (raw.endsWith("/")) raw = raw.slice(0, -1);
  if (!raw || raw.startsWith("/")) return "";
  const parts = splitPath(raw);
  if (parts.some((part) => part === "..")) return "";
  return raw;
}

function nextFileRequestId(path: string) {
  const next = (fileRequestSeqByPath.get(path) ?? 0) + 1;
  fileRequestSeqByPath.set(path, next);
  return next;
}

async function ensureAndApplyLanguage(model: monaco.editor.ITextModel, languageId?: string) {
  const normalized = normalizeMonacoLanguage(languageId);
  if (!normalized || normalized === "plaintext") return;
  try {
    await ensureMonacoLanguage(normalized);
    monaco.editor.setModelLanguage(model, normalized);
  } catch {
    // ignore
  }
}

function attachModelListener(tab: FileEditorTab) {
  if (!tab.model) return;
  tab.disposable?.dispose();
  tab.disposable = markRaw(
    tab.model.onDidChangeContent(() => {
      const current = tab.model?.getValue() ?? "";
      tab.dirty = current !== tab.savedContent;
    })
  );
}

function createTabFromRead(path: string, res: FileReadResponse, req?: EditorOpenFileRequest) {
  const language = res.language || inferLanguageFromPath(path);
  const tab: FileEditorTab = {
    key: `file:${path}`,
    kind: "file",
    title: req?.title || baseName(path),
    path,
    language,
    previewable: res.previewable,
    reason: res.reason,
    version: res.version,
    savedContent: res.content ?? "",
    dirty: false,
    saving: false,
    pendingSave: false,
    conflictOpen: false,
    error: undefined,
    openAt: req ? toOpenAt(req) : undefined,
    readOnly: req?.mode === "preview"
  };
  if (res.previewable) {
    ensureMonacoEnvironment();
    const uri = monaco.Uri.parse(`inmemory://editor/${encodeURIComponent(path)}`);
    const model = monaco.editor.createModel(res.content ?? "", "plaintext", uri);
    tab.model = markRaw(model);
    void ensureAndApplyLanguage(model, language);
    attachModelListener(tab);
  }
  return tab;
}

function toOpenAt(req: EditorOpenFileRequest): EditorOpenAt | undefined {
  const hasPosition = typeof req.line === "number" && Number.isFinite(req.line);
  if (!hasPosition && !req.highlight) return undefined;
  return {
    line: req.line,
    column: req.column,
    reveal: req.reveal,
    highlight: req.highlight
  };
}

function getFileTab(path: string) {
  const key = `file:${path}`;
  const tab = store.tabs.find((item) => item.key === key && item.kind === "file") ?? null;
  return tab && tab.kind === "file" ? tab : null;
}

function maybeMinimizeEditorWhenEmpty() {
  if (store.tabs.length > 0) return;
  if (store.pendingOpenFiles.value.length > 0) return;
  if (openingFileTasks.value > 0) return;
  if (editor) {
    editor.setModel(null);
    clearHighlightDecorations();
  }
  host.minimizeTool(props.toolId);
}

async function openFile(entry: QueuedEditorOpenFileRequest) {
  latestOpenFileSeq = Math.max(latestOpenFileSeq, entry.seq);
  const req = entry.req;
  const path = resolveOpenFilePath(req);
  if (!path) return;
  const existing = getFileTab(path);
  if (existing) {
    const stillActive = entry.seq === latestOpenFileSeq && entry.epoch === store.activationEpoch.value;
    if (!stillActive) return;
    existing.openAt = toOpenAt(req);
    if (req.mode === "edit") existing.readOnly = false;
    store.setActiveTabKey(existing.key);
    scheduleApplyEditor();
    return;
  }

  const requestId = nextFileRequestId(path);
  openingFileTasks.value += 1;
  try {
    const res = await readWorkspaceFileText({ workspaceId: props.workspaceId, path });
    if (fileRequestSeqByPath.get(path) !== requestId) return;
    const shouldActivate = entry.seq === latestOpenFileSeq && entry.epoch === store.activationEpoch.value;
    const existingAfter = getFileTab(path);
    if (!shouldActivate && existingAfter) return;
    if (existingAfter) {
      existingAfter.openAt = toOpenAt(req);
      if (req.mode === "edit") existingAfter.readOnly = false;
      store.setActiveTabKey(existingAfter.key);
      scheduleApplyEditor();
      return;
    }
    if (!shouldActivate) return;
    store.upsertTab(createTabFromRead(path, res, req), { activate: shouldActivate });
    if (shouldActivate) scheduleApplyEditor();
  } catch (err) {
    if (fileRequestSeqByPath.get(path) !== requestId) return;
    if (entry.seq !== latestOpenFileSeq) return;
    if (entry.epoch !== store.activationEpoch.value) return;
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    openingFileTasks.value = Math.max(0, openingFileTasks.value - 1);
    if (openingFileTasks.value === 0) {
      requestAnimationFrame(() => maybeMinimizeEditorWhenEmpty());
    }
  }
}

function clearHighlightDecorations() {
  if (!editor) return;
  highlightDecorations = editor.deltaDecorations(highlightDecorations, []);
}

function applyOpenAtHighlight(openAt?: EditorOpenAt) {
  if (!editor) return;
  const model = editor.getModel();
  if (!model || !openAt?.line) return;
  const highlight = openAt.highlight;
  const maxLine = model.getLineCount();
  const line = Math.min(Math.max(openAt.line, 1), maxLine);
  clearHighlightDecorations();
  if (!highlight || highlight.kind === "none") return;
  if (highlight.kind === "line") {
    const range = new monaco.Range(line, 1, line, model.getLineMaxColumn(line));
    highlightDecorations = editor.deltaDecorations(highlightDecorations, [
      { range, options: { isWholeLine: true, className: "editor-search-line" } }
    ]);
    return;
  }
  const startCol = Math.max(highlight.startCol, 1);
  const endCol = Math.max(highlight.endCol, startCol);
  const range = new monaco.Range(line, startCol, line, endCol);
  highlightDecorations = editor.deltaDecorations(highlightDecorations, [
    { range, options: { inlineClassName: "editor-search-hit" } }
  ]);
}

function revealOpenAt(openAt?: EditorOpenAt) {
  if (!editor) return;
  const model = editor.getModel();
  if (!model || !openAt?.line) return;
  const maxLine = model.getLineCount();
  const line = Math.min(Math.max(openAt.line, 1), maxLine);
  const requestedColumn = typeof openAt.column === "number" && Number.isFinite(openAt.column) ? openAt.column : 1;
  const column = Math.max(1, Math.min(requestedColumn, model.getLineMaxColumn(line)));
  const position = { lineNumber: line, column };
  editor.setPosition(position);
  editor.setSelection(new monaco.Range(line, column, line, column));
  const layout = editor.getLayoutInfo();
  const maxScrollTop = Math.max(0, editor.getScrollHeight() - layout.height);
  if (openAt.reveal === "top") {
    const targetScrollTop = Math.min(Math.max(editor.getTopForLineNumber(line), 0), maxScrollTop);
    editor.setScrollTop(targetScrollTop);
    return;
  }
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
  const centeredScrollTop = editor.getTopForLineNumber(line) - Math.max(0, (layout.height - lineHeight) / 2);
  editor.setScrollTop(Math.min(Math.max(centeredScrollTop, 0), maxScrollTop));
}

function applyOpenAtWhenReady(tabKey: string, model: monaco.editor.ITextModel, openAt?: EditorOpenAt, retries = 3) {
  if (!editor) return;
  const current = activeTab.value;
  if (!current || current.kind !== "file" || current.key !== tabKey || current.model !== model) return;

  editor.layout();
  const layout = editor.getLayoutInfo();
  const ready = layout.height > 0 && layout.contentWidth > 0;
  if (!ready && retries > 0) {
    requestAnimationFrame(() => applyOpenAtWhenReady(tabKey, model, openAt, retries - 1));
    return;
  }

  editor.focus();
  requestAnimationFrame(() => {
    const latest = activeTab.value;
    if (!editor || !latest || latest.kind !== "file" || latest.key !== tabKey || latest.model !== model) return;
    applyOpenAtHighlight(openAt);
    revealOpenAt(openAt);
    latest.openAt = undefined;
  });
}

function activeFileTabFromModel(model: monaco.editor.ITextModel | null) {
  if (!model) return null;
  const tab = store.tabs.find((item) => item.kind === "file" && item.model === model) ?? null;
  return tab && tab.kind === "file" ? tab : null;
}

function isConflictError(err: unknown) {
  return err instanceof ApiError && err.status === 409;
}

async function reloadTab(path: string) {
  const tab = getFileTab(path);
  if (!tab) return;
  try {
    const res = await readWorkspaceFileText({ workspaceId: props.workspaceId, path });
    tab.previewable = res.previewable;
    tab.reason = res.reason;
    tab.version = res.version;
    tab.language = res.language || inferLanguageFromPath(path);
    tab.error = undefined;
    if (res.previewable) {
      const current = tab.model?.getValue() ?? "";
      if (!tab.model) {
        const uri = monaco.Uri.parse(`inmemory://editor/${encodeURIComponent(path)}`);
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
      tab.disposable?.dispose();
      tab.disposable = undefined;
      tab.model?.dispose();
      tab.model = undefined;
      tab.savedContent = "";
      tab.dirty = false;
    }
    if (store.activeTabKey.value === tab.key) {
      scheduleApplyEditor();
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

async function refreshActiveFileTab() {
  const tab = activeTab.value;
  if (!tab || tab.kind !== "file") return;
  if (tab.dirty || tab.saving || tab.conflictOpen) return;
  await reloadTab(tab.path);
}

async function saveTab(tab: FileEditorTab, opts?: { force?: boolean }) {
  if (tab.readOnly) return;
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
    const latest = tab.model?.getValue() ?? content;
    tab.dirty = latest !== tab.savedContent;
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

async function saveActiveTabFromEditor() {
  const model = editor?.getModel() ?? null;
  const tab = activeFileTabFromModel(model);
  if (!tab || !tab.dirty) return;
  await saveTab(tab);
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
  const action = editor.getAction(evt.key.toLowerCase() === "h" ? "editor.action.startFindReplaceAction" : "actions.find");
  if (action) void action.run();
}

function attachEditorEvents() {
  if (!editor) return;
  editorBlurDisposable?.dispose();
  editorSaveCommandId = null;
  editorBlurDisposable = editor.onDidBlurEditorText(() => {
    void saveActiveTabFromEditor();
  });
  editorSaveCommandId = editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void saveActiveTabFromEditor();
  });
}

function initEditor() {
  if (editor || !editorEl.value) return;
  ensureMonacoEnvironment();
  applyMonacoPanelTheme();
  editor = monaco.editor.create(editorEl.value, {
    automaticLayout: true,
    readOnly: true,
    fontSize: editorFontSize.value,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: "off",
    glyphMargin: false,
    lineNumbersMinChars: 3,
    lineDecorationsWidth: 8,
    padding: { top: 4, bottom: 4 },
    renderWhitespace: "selection"
  });
  attachEditorEvents();
}

function scheduleApplyEditor() {
  if (editorApplyScheduled) return;
  editorApplyScheduled = true;
  void nextTick(() => {
    editorApplyScheduled = false;
    const tab = activeTab.value;
    const isFileTab = tab?.kind === "file";
    const shouldHaveEditor = isFileTab && tab.previewable !== false;

    if (!editor && shouldHaveEditor) initEditor();
    if (!editor) return;

    const previousModel = editor.getModel();
    const previousTab = activeFileTabFromModel(previousModel);
    if (previousTab) {
      const latestModel = editor.getModel();
      if (latestModel && previousTab.model === previousModel && latestModel === previousModel) {
        previousTab.viewState = editor.saveViewState();
      }
    }

    const model = shouldHaveEditor ? tab?.model ?? null : null;
    editor.setModel(model);
    editor.updateOptions({ readOnly: tab?.kind === "file" ? tab.readOnly : true });
    if (tab?.kind === "file" && model) {
      const openAt = tab.openAt;
      const tabKey = tab.key;
      const hasOpenAtLine = typeof openAt?.line === "number" && Number.isFinite(openAt.line) && openAt.line > 0;
      if (hasOpenAtLine) {
        requestAnimationFrame(() => applyOpenAtWhenReady(tabKey, model, openAt));
        return;
      }

      requestAnimationFrame(() => {
        const latest = activeTab.value;
        if (!editor || !latest || latest.kind !== "file" || latest.key !== tabKey || latest.model !== model) return;
        clearHighlightDecorations();
        if (latest.viewState) {
          try {
            editor.restoreViewState(latest.viewState);
          } catch {
            latest.viewState = null;
          }
        }
        editor.layout();
      });
      return;
    }

    clearHighlightDecorations();
    requestAnimationFrame(() => {
      editor?.layout();
    });
  });
}

function onActiveTabUpdate(key: string) {
  store.bumpActivationEpoch();
  store.setActiveTabKey(key);
}

function requestCloseTabs(keys: string[], mode: "single" | "others" | "all") {
  if (keys.length === 0) return;
  const uniqueKeys = Array.from(new Set(keys));
  const dirtyTabs = uniqueKeys
    .map((key) => store.tabs.find((item) => item.key === key) ?? null)
    .filter((tab): tab is Exclude<typeof tab, null> => tab !== null)
    .filter((tab) => tab.kind === "file" && tab.dirty);

  const close = () => {
    if (mode === "single") {
      store.closeTab(uniqueKeys[0]!);
      return;
    }
    store.closeTabs(uniqueKeys);
  };

  if (dirtyTabs.length === 0) {
    close();
    return;
  }

  const confirmKey = mode === "all" ? "files.closeAllConfirm" : mode === "others" ? "files.closeOthersConfirm" : "files.closeConfirm";
  Modal.confirm({
    title: t(`${confirmKey}.title`),
    content: t(`${confirmKey}.content`, { count: dirtyTabs.length }),
    okText: t(`${confirmKey}.ok`),
    cancelText: t(`${confirmKey}.cancel`),
    onOk: close
  });
}

function requestCloseTab(key: string) {
  requestCloseTabs([key], "single");
}

function requestCloseOtherTabs(key: string) {
  const keys = store.tabs.filter((tab) => tab.key !== key).map((tab) => tab.key);
  requestCloseTabs(keys, "others");
}

function requestCloseAllTabs() {
  requestCloseTabs(store.tabs.map((tab) => tab.key), "all");
}

function notPreviewableLabel(tab: FileEditorTab) {
  if (tab.reason === "too_large") return t("files.preview.tooLarge");
  if (tab.reason === "binary") return t("files.preview.binary");
  if (tab.reason === "decode_failed") return t("files.preview.decodeFailed");
  if (tab.reason === "unsafe_path") return t("files.preview.unsafePath");
  if (tab.reason === "missing") return t("files.preview.missing");
  return t("files.preview.unavailable");
}

watch(
  () => store.pendingOpenFiles.value.length,
  () => {
    const pending = store.drainPendingOpenFiles();
    if (pending.length === 0) return;
    for (const entry of pending) {
      void openFile(entry);
    }
  },
  { immediate: true }
);

watch(
  () => editorFontSize.value,
  (next) => {
    if (!editor) return;
    editor.updateOptions({ fontSize: next });
    requestAnimationFrame(() => editor?.layout());
  }
);

watch(
  () => store.activeTabKey.value,
  () => {
    scheduleApplyEditor();
  }
);

watch(
  () => (activeTab.value?.kind === "diff" ? activeTab.value.key : ""),
  (next) => {
    if (!next) return;
    requestAnimationFrame(() => {
      diffViewerRef.value?.goToFirstDiff();
    });
  }
);

watch(
  () => activeTab.value?.kind,
  (kind) => {
    emit("diffTabActiveChange", kind === "diff");
  },
  { immediate: true }
);

watch(
  () => store.tabs.length,
  (next, prev) => {
    if (next !== 0) return;
    if (prev === undefined || prev > 0) maybeMinimizeEditorWhenEmpty();
  },
  { immediate: false }
);

watch(() => openingFileTasks.value, (next) => {
  if (next === 0) maybeMinimizeEditorWhenEmpty();
});

function goToPreviousDiff() {
  if (activeTab.value?.kind !== "diff") return;
  diffViewerRef.value?.goToPreviousDiff();
}

function goToNextDiff() {
  if (activeTab.value?.kind !== "diff") return;
  diffViewerRef.value?.goToNextDiff();
}

onMounted(() => {
  unregisterToolCommands = host.registerToolCommands(props.toolId, {
    refresh: () => refreshActiveFileTab(),
    goToPreviousDiff,
    goToNextDiff
  });
  scheduleApplyEditor();
  requestAnimationFrame(() => maybeMinimizeEditorWhenEmpty());
  if (typeof window !== "undefined") window.addEventListener("keydown", handleEditorKeydown, true);
});

onBeforeUnmount(() => {
  if (typeof window !== "undefined") window.removeEventListener("keydown", handleEditorKeydown, true);
  clearHighlightDecorations();
  unregisterToolCommands?.();
  unregisterToolCommands = null;
  editorBlurDisposable?.dispose();
  editor?.dispose();
  editorSaveCommandId = null;
  editor = null;
});
</script>

<style scoped>
:deep(.editor-search-hit) {
  background: rgba(255, 214, 102, 0.45);
}

:deep(.editor-search-line) {
  background: rgba(255, 214, 102, 0.2);
}
</style>
