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
      <div v-else-if="activeTab.kind === 'file' && activeTab.image" class="h-full min-h-0 flex items-center justify-center overflow-auto p-4">
        <img
          v-if="activeTab.image.status === 'ready' && activeTab.image.url"
          :key="activeTab.image.url"
          :src="activeTab.image.url"
          :alt="activeTab.title"
          class="max-w-full max-h-full object-contain"
          @error="onImageError(activeTab, $event)"
        />
        <span v-else class="text-xs text-[color:var(--text-tertiary)]" role="status">
          {{ activeTab.image.status === 'loading' ? t('editor.image.loading') : imageFailureLabel(activeTab) }}
        </span>
      </div>
      <div
        v-else-if="activeTab.kind === 'file' && activeTab.previewable === false"
        class="h-full flex items-center justify-center text-xs text-[color:var(--text-tertiary)]"
      >
        {{ notPreviewableLabel(activeTab) }}
      </div>
      <div ref="editorEl" data-editor-source class="absolute inset-0" v-show="activeTab?.kind === 'file' && !activeTab.image && activeTab.previewable !== false && !showDocumentPreview"></div>
      <EditorMarkdownPreview
        v-if="documentTab && showDocumentPreview && documentPresentation === 'markdown'"
        :key="`${props.workspaceId}:${documentTab.path}`"
        :workspace-id="props.workspaceId"
        :path="documentTab.path"
        :text="documentText"
        :scroll-top="documentTab.previewScrollTop ?? 0"
        @scroll-position="documentTab.previewScrollTop = $event"
        @open-file="openMarkdownFile"
      />
      <EditorMermaidPreview
        ref="mermaidPreviewRef"
        v-if="documentTab && showDocumentPreview && documentPresentation === 'mermaid'"
        :key="`${props.workspaceId}:${documentTab.path}`"
        :text="documentText"
        :viewport="documentTab.mermaidViewport"
        :content-revision="documentTab.contentRevision ?? 0"
        @viewport-change="onMermaidViewportChange"
      />
      <div class="absolute right-2 top-2 z-10 flex items-center gap-2 max-w-[calc(100%-1rem)]">
        <span v-if="activeTab?.kind === 'file' && activeTab.saving" class="text-[11px] text-[color:var(--text-tertiary)]">
          {{ t("files.status.saving") }}
        </span>
        <span v-else-if="activeTab?.kind === 'file' && activeTab.error" class="text-[11px] text-[color:var(--danger-color)] truncate">
          {{ activeTab.error }}
        </span>
      </div>
      <div v-if="htmlPreviewTab || documentTab || activeTab?.kind === 'diff'" data-editor-floating-actions class="absolute right-8 top-20 z-10 flex flex-col gap-1" :class="{ 'editor-mermaid-actions': showDocumentPreview && documentPresentation === 'mermaid' }">
        <Tooltip
          v-if="htmlPreviewTab"
          placement="left"
          :title="htmlPreviewBlocked ? t('editor.htmlPreview.saveFirst') : t('editor.htmlPreview.open')"
        >
          <span class="inline-flex w-7 h-7">
            <button
              type="button"
              data-editor-html-preview
              :aria-label="t('editor.htmlPreview.open')"
              :disabled="htmlPreviewBlocked"
              :class="floatingActionClass"
              @click="openHtmlPreview"
            >
              <GlobalOutlined />
            </button>
          </span>
        </Tooltip>
        <template v-else-if="documentTab">
          <Tooltip placement="left" :title="t('editor.preview.toggle')">
            <button
              type="button"
              data-editor-preview-toggle
              :aria-label="t('editor.preview.toggle')"
              :aria-pressed="showDocumentPreview"
              :class="floatingActionClass"
              @click="toggleDocumentPreview"
            ><SwapOutlined /></button>
          </Tooltip>
          <template v-if="showDocumentPreview && documentPresentation === 'mermaid'">
            <Tooltip placement="left" :title="t('editor.mermaid.zoomIn')">
              <span class="inline-flex w-7 h-7 shrink-0">
                <button type="button" data-editor-mermaid-zoom-in :aria-label="t('editor.mermaid.zoomIn')"
                  :disabled="!mermaidPreviewRef?.canZoomIn" :class="floatingActionClass" @mousedown.prevent @click="mermaidPreviewRef?.zoomIn()"><ZoomInOutlined /></button>
              </span>
            </Tooltip>
            <Tooltip placement="left" :title="t('editor.mermaid.zoomOut')">
              <span class="inline-flex w-7 h-7 shrink-0">
                <button type="button" data-editor-mermaid-zoom-out :aria-label="t('editor.mermaid.zoomOut')"
                  :disabled="!mermaidPreviewRef?.canZoomOut" :class="floatingActionClass" @mousedown.prevent @click="mermaidPreviewRef?.zoomOut()"><ZoomOutOutlined /></button>
              </span>
            </Tooltip>
            <Tooltip placement="left" :title="t('editor.mermaid.fit')">
              <span class="inline-flex w-7 h-7 shrink-0">
                <button type="button" data-editor-mermaid-fit :aria-label="t('editor.mermaid.fit')"
                  :disabled="!mermaidPreviewRef?.ready" :class="floatingActionClass" @mousedown.prevent @click="mermaidPreviewRef?.fitToViewport()"><ExpandOutlined /></button>
              </span>
            </Tooltip>
          </template>
        </template>
        <template v-else-if="activeTab?.kind === 'diff'">
          <Tooltip placement="left" :title="t('workspace.actions.previousChange')">
            <button
              type="button"
              data-editor-diff-previous
              :aria-label="t('workspace.actions.previousChange')"
              :class="floatingActionClass"
              @mousedown.prevent
              @click="goToPreviousDiff"
            >
              <UpOutlined />
            </button>
          </Tooltip>
          <Tooltip placement="left" :title="t('workspace.actions.nextChange')">
            <button
              type="button"
              data-editor-diff-next
              :aria-label="t('workspace.actions.nextChange')"
              :class="floatingActionClass"
              @mousedown.prevent
              @click="goToNextDiff"
            >
              <DownOutlined />
            </button>
          </Tooltip>
        </template>
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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Modal, Tooltip, message } from "ant-design-vue";
import { DownOutlined, ExpandOutlined, GlobalOutlined, SwapOutlined, UpOutlined, ZoomInOutlined, ZoomOutOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController.js";
import "monaco-editor/min/vs/editor/editor.main.css";
import type { FileReadResponse } from "@agent-workbench/shared";
import { ApiError, downloadWorkspacePath, readWorkspaceFileText, statWorkspaceFile, writeWorkspaceFileText } from "@/shared/api";
import { useWorkspaceHost } from "@/features/workspace/host";
import { ensureMonacoEnvironment } from "@/shared/monaco/monacoEnv";
import { applyMonacoPanelTheme } from "@/shared/monaco/monacoTheme";
import { ensureMonacoLanguage } from "@/shared/monaco/languageLoader";
import { inferLanguageFromPath, normalizeMonacoLanguage } from "@/shared/monaco/languageUtils";
import { editorFontSize } from "@/shared/settings/uiFontSizes";
import { getEditorStore, releaseEditorImage } from "./store";
import { loadEditorImage } from "./editorImages";
import { disposeFileModel, replaceFileModel } from "./editorModels";
import { getEditorFilePresentation } from "./editorPresentation";
import { openWorkspacePreview, type PreviewDocument } from "../file-explorer/preview";
import type { EditorOpenAt, EditorOpenFileRequest, FileEditorTab, QueuedEditorOpenFileRequest } from "./types";
import EditorTabs from "./EditorTabs.vue";
import EditorMarkdownPreview from "./EditorMarkdownPreview.vue";
import EditorMermaidPreview, { type MermaidPreviewExposed } from "./EditorMermaidPreview.vue";
import type { MermaidViewportState } from "./mermaidViewport";
import type { MonacoDiffViewerExposed } from "@/shared/components/MonacoDiffViewer.vue";
import MonacoCodeViewer from "@/shared/components/MonacoCodeViewer.vue";
import MonacoDiffViewer from "@/shared/components/MonacoDiffViewer.vue";

const props = defineProps<{ workspaceId: string; toolId: string; previewEnabled?: boolean }>();
const { t } = useI18n();
const floatingActionClass = "w-7 h-7 flex items-center justify-center rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

const host = useWorkspaceHost(props.toolId);
const store = computed(() => getEditorStore(props.workspaceId));

const activeTab = computed(() => store.value.activeTab.value);
const documentTab = computed(() => {
  const tab = activeTab.value;
  return tab?.kind === "file" && !tab.image && tab.previewable !== false && tab.model &&
    ["markdown", "mermaid"].includes(getEditorFilePresentation(tab.path)) ? tab : null;
});
const documentPresentation = computed(() => documentTab.value ? getEditorFilePresentation(documentTab.value.path) : null);
function isDocumentPreview(tab: FileEditorTab) {
  return !tab.image && tab.previewable !== false && ["markdown", "mermaid"].includes(getEditorFilePresentation(tab.path)) && tab.presentationMode !== "source";
}
const showDocumentPreview = computed(() => !!documentTab.value && isDocumentPreview(documentTab.value));
const documentText = computed(() => {
  const tab = documentTab.value;
  void tab?.contentRevision;
  return tab?.model?.getValue() ?? "";
});
// Capture the original session: an outgoing view can emit its final position
// after the active Tab has already changed. Never attribute that to the new Tab.
const onMermaidViewportChange = computed(() => {
  const tab = documentTab.value;
  const model = tab?.model;
  const revision = tab?.contentRevision ?? 0;
  return (state: MermaidViewportState) => {
    if (tab && tab.model === model && (tab.contentRevision ?? 0) === revision &&
        state.contentRevision === revision && store.value.tabs.includes(tab)) tab.mermaidViewport = state;
  };
});
function openMarkdownFile(path: string) {
  host.call("editor", { type: "editor.openFile", payload: { path, mode: "preview" } });
}
function toggleDocumentPreview() {
  const tab = documentTab.value;
  if (!tab) return;
  if (showDocumentPreview.value) {
    tab.presentationMode = "source";
    scheduleApplyEditor();
    const model = tab.model;
    requestAnimationFrame(() => {
      if (!disposed && activeTab.value === tab && !isDocumentPreview(tab) && editor && editor.getModel() === model) editor.focus();
    });
  } else {
    if (editor && editor.getModel() === tab.model) tab.viewState = editor.saveViewState();
    tab.presentationMode = "preview";
    sourceViewVisible = false;
  }
}
function applyRequestedPresentation(tab: FileEditorTab, req?: EditorOpenFileRequest) {
  if (typeof req?.line === "number" && Number.isFinite(req.line) && req.line > 0) tab.presentationMode = "source";
}

const htmlPreviewTab = computed(() => {
  const tab = activeTab.value;
  return props.previewEnabled && tab?.kind === "file" && !tab.image && tab.previewable && getEditorFilePresentation(tab.path) === "html" ? tab : null;
});
const htmlPreviewBlocked = computed(() => !!htmlPreviewTab.value && (htmlPreviewTab.value.dirty || htmlPreviewTab.value.saving || htmlPreviewTab.value.conflictOpen));
const tabItems = computed(() => store.value.tabs.map((tab) => ({
  key: tab.key,
  title: tab.title,
  path: "path" in tab ? tab.path : undefined,
  kind: tab.kind,
  dirty: tab.kind === "file" ? tab.dirty : false,
  saving: tab.kind === "file" ? tab.saving : false
})));

const editorEl = ref<HTMLDivElement | null>(null);
const diffViewerRef = ref<MonacoDiffViewerExposed | null>(null);
const mermaidPreviewRef = ref<MermaidPreviewExposed | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
// Track the last applied source visibility: hidden layout must not overwrite its saved view state.
let sourceViewVisible = false;
let editorBlurDisposable: monaco.IDisposable | null = null;
let editorSaveCommandId: string | null = null;
let editorApplyScheduled = false;
let highlightDecorations: string[] = [];
const fileRequestSeqByPath = new Map<string, number>();
let unregisterToolCommands: (() => void) | null = null;
let latestOpenFileSeq = 0;
const openingFileTasks = ref(0);
let disposed = false;
let workspaceRequestVersion = 0;

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

function createTabFromRead(path: string, res: FileReadResponse, req?: EditorOpenFileRequest) {
  const language = res.language || inferLanguageFromPath(path);
  const tab = reactive<FileEditorTab>({
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
  });
  applyRequestedPresentation(tab, req);
  if (res.previewable) {
    ensureMonacoEnvironment();
    const model = replaceFileModel(tab, res.content ?? "");
    void ensureAndApplyLanguage(model, language);
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
  const tab = store.value.tabs.find((item) => item.key === key && item.kind === "file") ?? null;
  return tab && tab.kind === "file" ? tab : null;
}

function maybeMinimizeEditorWhenEmpty() {
  if (disposed) return;
  if (store.value.tabs.length > 0) return;
  if (store.value.pendingOpenFiles.value.length > 0) return;
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
    const stillActive = entry.seq === latestOpenFileSeq && entry.epoch === store.value.activationEpoch.value;
    if (!stillActive) return;
    existing.openAt = existing.image ? undefined : toOpenAt(req);
    applyRequestedPresentation(existing, req);
    if (req.mode === "edit" && !existing.image) existing.readOnly = false;
    store.value.setActiveTabKey(existing.key);
    scheduleApplyEditor();
    return;
  }

  if (getEditorFilePresentation(path) === "image") {
    if (entry.seq !== latestOpenFileSeq || entry.epoch !== store.value.activationEpoch.value) return;
    store.value.upsertTab({
      key: `file:${path}`, kind: "file", title: req.title || baseName(path), path,
      previewable: true, savedContent: "", dirty: false, saving: false, pendingSave: false,
      readOnly: true, image: { status: "loading" }
    });
    await reloadTab(path);
    return;
  }

  const workspaceId = props.workspaceId;
  const workspaceVersion = workspaceRequestVersion;
  const requestStore = store.value;
  const requestId = nextFileRequestId(path);
  const isCurrent = () => !disposed && workspaceVersion === workspaceRequestVersion && store.value === requestStore && fileRequestSeqByPath.get(path) === requestId;
  openingFileTasks.value += 1;
  try {
    const res = await readWorkspaceFileText({ workspaceId, path });
    if (!isCurrent()) return;
    const shouldActivate = entry.seq === latestOpenFileSeq && entry.epoch === requestStore.activationEpoch.value;
    const existingAfter = getFileTab(path);
    if (!shouldActivate && existingAfter) return;
    if (existingAfter) {
      existingAfter.openAt = existingAfter.image ? undefined : toOpenAt(req);
      applyRequestedPresentation(existingAfter, req);
      if (req.mode === "edit" && !existingAfter.image) existingAfter.readOnly = false;
      requestStore.setActiveTabKey(existingAfter.key);
      scheduleApplyEditor();
      return;
    }
    if (!shouldActivate) return;
    requestStore.upsertTab(createTabFromRead(path, res, req), { activate: shouldActivate });
    scheduleApplyEditor();
  } catch (err) {
    if (!isCurrent()) return;
    if (entry.seq !== latestOpenFileSeq || entry.epoch !== requestStore.activationEpoch.value) return;
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    openingFileTasks.value = Math.max(0, openingFileTasks.value - 1);
    if (openingFileTasks.value === 0 && !disposed) {
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
  if (!current || current.kind !== "file" || current.key !== tabKey || current.model !== model || isDocumentPreview(current) || current.openAt !== openAt) return;

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
    if (!editor || !latest || latest.kind !== "file" || latest.key !== tabKey || latest.model !== model || isDocumentPreview(latest) || latest.openAt !== openAt) return;
    applyOpenAtHighlight(openAt);
    revealOpenAt(openAt);
    latest.openAt = undefined;
  });
}

function activeFileTabFromModel(model: monaco.editor.ITextModel | null) {
  if (!model) return null;
  const tab = store.value.tabs.find((item) => item.kind === "file" && item.model === model) ?? null;
  return tab && tab.kind === "file" ? tab : null;
}

function isConflictError(err: unknown) {
  return err instanceof ApiError && err.status === 409;
}

async function reloadTab(path: string) {
  const tab = getFileTab(path);
  if (!tab) return;
  const workspaceId = props.workspaceId;
  const workspaceVersion = workspaceRequestVersion;
  const requestStore = store.value;
  const requestId = nextFileRequestId(path);
  const loadVersion = tab.loadVersion = (tab.loadVersion ?? 0) + 1;
  tab.needsReload = false;
  const initialText = tab.model?.getValue();
  const isCurrent = () => !disposed && workspaceVersion === workspaceRequestVersion && store.value === requestStore &&
    fileRequestSeqByPath.get(path) === requestId && tab.loadVersion === loadVersion && tab.path === path && requestStore.tabs.includes(tab);

  if (getEditorFilePresentation(path) === "image") {
    releaseEditorImage(tab);
    disposeFileModel(tab);
    tab.image = { status: "loading" };
    tab.readOnly = true;
    tab.openAt = undefined;
    tab.savedContent = "";
    tab.dirty = false;
    tab.error = undefined;
    scheduleApplyEditor();
    const result = await loadEditorImage({
      path,
      stat: () => statWorkspaceFile({ workspaceId, path }),
      download: async () => {
        if (!isCurrent()) throw new Error("Image read superseded");
        return (await downloadWorkspacePath({ workspaceId, path })).blob;
      }
    });
    if (!isCurrent()) return;
    tab.previewable = result.ok;
    tab.reason = undefined;
    if (result.ok) {
      // Create only after accepting the result: stale reads never allocate a URL.
      try {
        tab.image = { status: "ready", url: URL.createObjectURL(result.blob) };
      } catch {
        tab.image = { status: "error", reason: "load_failed" };
        tab.previewable = false;
      }
      tab.version = result.version;
    } else {
      tab.image = { status: "error", reason: result.reason };
    }
    return;
  }

  try {
    const res = await readWorkspaceFileText({ workspaceId, path });
    if (!isCurrent()) return;
    if (tab.dirty && tab.model?.getValue() !== initialText) return;
    releaseEditorImage(tab);
    tab.image = undefined;
    tab.previewable = res.previewable;
    tab.reason = res.reason;
    tab.version = res.version;
    tab.language = res.language || inferLanguageFromPath(path);
    tab.error = undefined;
    if (res.previewable) {
      const current = tab.model?.getValue() ?? "";
      if (!tab.model) {
        replaceFileModel(tab, res.content ?? "");
      } else if (current !== (res.content ?? "")) {
        tab.model.setValue(res.content ?? "");
      }
      if (tab.model) void ensureAndApplyLanguage(tab.model, tab.language);
      tab.savedContent = res.content ?? "";
      tab.dirty = false;
    } else {
      disposeFileModel(tab);
      tab.savedContent = "";
      tab.dirty = false;
    }
    if (requestStore.activeTabKey.value === tab.key) scheduleApplyEditor();
  } catch (err) {
    if (!isCurrent()) return;
    if (tab.image) tab.image = { status: "error", reason: "load_failed" };
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
  if (disposed || tab.readOnly || !store.value.tabs.includes(tab)) return;
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
  const workspaceId = props.workspaceId;
  const workspaceVersion = workspaceRequestVersion;
  const path = tab.path;
  const requestStore = store.value;
  const loadVersion = tab.loadVersion ?? 0;
  const isCurrent = () => !disposed && workspaceId === props.workspaceId && workspaceVersion === workspaceRequestVersion &&
    store.value === requestStore && tab.path === path && (tab.loadVersion ?? 0) === loadVersion && requestStore.tabs.includes(tab);
  try {
    const res = await writeWorkspaceFileText({
      workspaceId,
      path,
      content,
      expected: tab.version,
      force: opts?.force
    });
    if (!isCurrent()) return;
    tab.version = res.version;
    tab.savedContent = content;
    const latest = tab.model?.getValue() ?? content;
    tab.dirty = latest !== tab.savedContent;
  } catch (err) {
    if (!isCurrent()) return;
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
          if (!isCurrent()) return;
          tab.conflictOpen = false;
          await reloadTab(path);
        },
        onCancel: async () => {
          if (!isCurrent()) return;
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
  const tab = activeTab.value;
  if (!editor || tab?.kind !== "file" || tab.image || !tab.model || isDocumentPreview(tab) || editor.getModel() !== tab.model) return;
  if (!isFindShortcut(evt)) return;
  if (!isEditorFocused(evt)) return;
  const action = editor.getAction(evt.key.toLowerCase() === "h" ? "editor.action.startFindReplaceAction" : "actions.find");
  if (!action) return;

  evt.preventDefault();
  evt.stopPropagation();
  void action.run();
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
  if (disposed) return;
  if (editorApplyScheduled) return;
  editorApplyScheduled = true;
  void nextTick(() => {
    editorApplyScheduled = false;
    if (disposed) return;
    const tab = activeTab.value;
    const isFileTab = tab?.kind === "file";
    const shouldHaveEditor = isFileTab && !tab.image && tab.previewable !== false;

    if (!editor && shouldHaveEditor) initEditor();
    if (!editor) return;

    const previousModel = editor.getModel();
    const previousTab = activeFileTabFromModel(previousModel);
    if (previousTab && sourceViewVisible) {
      const latestModel = editor.getModel();
      if (latestModel && previousTab.model === previousModel && latestModel === previousModel) {
        previousTab.viewState = editor.saveViewState();
      }
    }

    const model = shouldHaveEditor ? tab?.model ?? null : null;
    sourceViewVisible = !!model && tab?.kind === "file" && !isDocumentPreview(tab);
    editor.setModel(model);
    editor.updateOptions({ readOnly: tab?.kind === "file" ? tab.readOnly : true });
    if (tab?.kind === "file" && model) {
      if (isDocumentPreview(tab)) {
        clearHighlightDecorations();
        return;
      }
      const openAt = tab.openAt;
      const tabKey = tab.key;
      const hasOpenAtLine = typeof openAt?.line === "number" && Number.isFinite(openAt.line) && openAt.line > 0;
      if (hasOpenAtLine) {
        requestAnimationFrame(() => applyOpenAtWhenReady(tabKey, model, openAt));
        return;
      }

      requestAnimationFrame(() => {
        const latest = activeTab.value;
        if (!editor || !latest || latest.kind !== "file" || latest.key !== tabKey || latest.model !== model || isDocumentPreview(latest)) return;
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
  store.value.bumpActivationEpoch();
  store.value.setActiveTabKey(key);
}

function requestCloseTabs(keys: string[], mode: "single" | "others" | "all") {
  if (keys.length === 0) return;
  const workspaceId = props.workspaceId;
  const workspaceVersion = workspaceRequestVersion;
  const requestStore = store.value;
  const uniqueKeys = Array.from(new Set(keys));
  const targets = uniqueKeys
    .map((key) => requestStore.tabs.find((item) => item.key === key) ?? null)
    .filter((tab): tab is Exclude<typeof tab, null> => tab !== null)
    .map((tab) => ({ tab, key: tab.key, path: tab.path, loadVersion: tab.kind === "file" ? tab.loadVersion ?? 0 : 0 }));
  if (targets.length === 0) return;
  const dirtyTabs = targets.filter(({ tab }) => tab.kind === "file" && tab.dirty);

  const close = () => {
    // A delayed confirmation belongs to these exact Tabs, never current keys.
    if (disposed || workspaceId !== props.workspaceId || workspaceVersion !== workspaceRequestVersion || store.value !== requestStore) return;
    if (targets.some(({ tab, key, path, loadVersion }) =>
      !requestStore.tabs.includes(tab) || tab.key !== key || tab.path !== path ||
      (tab.kind === "file" && (tab.loadVersion ?? 0) !== loadVersion)
    )) return;
    const targetKeys = targets.map(({ key }) => key);
    if (mode === "single") {
      requestStore.closeTab(targetKeys[0]!);
      return;
    }
    requestStore.closeTabs(targetKeys);
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
  const keys = store.value.tabs.filter((tab) => tab.key !== key).map((tab) => tab.key);
  requestCloseTabs(keys, "others");
}

function requestCloseAllTabs() {
  requestCloseTabs(store.value.tabs.map((tab) => tab.key), "all");
}

function openHtmlPreview() {
  const tab = htmlPreviewTab.value;
  if (!tab) return;
  // Recheck on click: blur-triggered auto-save must finish before disk preview.
  if (tab.dirty || tab.saving || tab.conflictOpen) {
    message.info(t("editor.htmlPreview.saveFirst"));
    return;
  }
  openWorkspacePreview({ workspaceId: props.workspaceId, path: tab.path, documentRef: document as unknown as PreviewDocument });
}

function imageFailureLabel(tab: FileEditorTab) {
  if (tab.image?.reason === "too_large") return t("editor.image.tooLarge");
  if (tab.image?.reason === "missing") return t("files.preview.missing");
  if (tab.image?.reason === "unsafe_path") return t("files.preview.unsafePath");
  return t("editor.image.loadFailed");
}

function onImageError(tab: FileEditorTab, event: Event) {
  const src = (event.target as HTMLImageElement | null)?.getAttribute("src");
  if (!tab.image?.url || tab.image.url !== src || !store.value.tabs.includes(tab)) return;
  releaseEditorImage(tab);
  tab.image = { status: "error", reason: "load_failed" };
  tab.previewable = false;
}

// Dock keys are tool IDs, so the same view can receive another Workspace.
// Bind the store reactively instead of changing every tool's KeepAlive lifecycle.
watch(() => props.workspaceId, (_next, previous) => {
  workspaceRequestVersion++;
  latestOpenFileSeq = 0;
  fileRequestSeqByPath.clear();
  getEditorStore(previous).reset();
  editor?.setModel(null);
  scheduleApplyEditor();
}, { flush: "sync" });

watch(
  () => store.value.tabs.filter((tab) => tab.kind === "file" && tab.needsReload).map((tab) => tab.key),
  () => {
    for (const tab of store.value.tabs) {
      if (tab.kind !== "file" || !tab.needsReload || tab.dirty || tab.saving) continue;
      void reloadTab(tab.path);
    }
  },
  { immediate: true }
);

function notPreviewableLabel(tab: FileEditorTab) {
  if (tab.reason === "too_large") return t("files.preview.tooLarge");
  if (tab.reason === "binary") return t("files.preview.binary");
  if (tab.reason === "decode_failed") return t("files.preview.decodeFailed");
  if (tab.reason === "unsafe_path") return t("files.preview.unsafePath");
  if (tab.reason === "missing") return t("files.preview.missing");
  return t("files.preview.unavailable");
}

watch(
  () => store.value.pendingOpenFiles.value.length,
  () => {
    const pending = store.value.drainPendingOpenFiles();
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
  // A rename-back can keep the key while replacing the Monaco model.
  () => [store.value.activeTabKey.value, activeTab.value?.kind === "file" ? activeTab.value.model : null],
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
  () => store.value.tabs.length,
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
    refresh: () => refreshActiveFileTab()
  });
  scheduleApplyEditor();
  requestAnimationFrame(() => maybeMinimizeEditorWhenEmpty());
  if (typeof window !== "undefined") window.addEventListener("keydown", handleEditorKeydown, true);
});

onBeforeUnmount(() => {
  disposed = true;
  workspaceRequestVersion++;
  // Text Tabs keep their existing store behavior; image data is recreated on remount.
  for (const tab of store.value.tabs) {
    if (tab.kind !== "file" || !tab.image) continue;
    tab.loadVersion = (tab.loadVersion ?? 0) + 1;
    releaseEditorImage(tab);
    tab.needsReload = true;
    tab.image = { status: "loading" };
  }
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
.editor-mermaid-actions {
  top: min(5rem, max(0.5rem, calc(100% - 8.5rem)));
  max-height: calc(100% - 1rem);
  overflow-y: auto;
  scrollbar-width: none;
}
.editor-mermaid-actions > :deep(*) { flex-shrink: 0; }

:deep(.editor-search-hit) {
  background: rgba(255, 214, 102, 0.45);
}

:deep(.editor-search-line) {
  background: rgba(255, 214, 102, 0.2);
}
</style>
