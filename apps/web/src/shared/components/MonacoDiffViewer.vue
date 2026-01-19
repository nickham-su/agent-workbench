<template>
  <div ref="containerEl" class="h-full w-full"></div>
</template>

<script setup lang="ts">
import {onBeforeUnmount, onMounted, ref, watch} from "vue";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/min/vs/editor/editor.main.css";
import { ensureMonacoEnvironment } from "@/shared/monaco/monacoEnv";
import { applyMonacoPanelTheme } from "@/shared/monaco/monacoTheme";
import { editorFontSize } from "@/shared/settings/uiFontSizes";

const props = defineProps<{
  original: string;
  modified: string;
  language?: string;
  ignoreTrimWhitespace?: boolean;
}>();

export type DiffViewerLayout = {
  originalWidth: number;
  modifiedWidth: number;
  splitterWidth: number;
};

export type MonacoDiffViewerExposed = {
  goToFirstDiff: () => void;
  goToPreviousDiff: () => void;
  goToNextDiff: () => void;
};

const emit = defineEmits<{
  (e: "layout", layout: DiffViewerLayout): void;
}>();

const containerEl = ref<HTMLDivElement | null>(null);

let editor: monaco.editor.IStandaloneDiffEditor | null = null;
let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
let disposables: monaco.IDisposable[] = [];
let layoutRaf = 0;
let stopWatchFontSize: (() => void) | null = null;
let pendingRevealFirstDiff = false;

function normalizeLanguage(lang?: string) {
  if (!lang) return undefined;
  if (lang === "vue") return "html";
  return lang;
}

function measureAndEmitLayout() {
  if (!editor) return;
  if (!containerEl.value) return;

  const originalDom = editor.getOriginalEditor().getDomNode();
  const modifiedDom = editor.getModifiedEditor().getDomNode();
  if (!originalDom || !modifiedDom) return;

  const originalRect = originalDom.getBoundingClientRect();
  const modifiedRect = modifiedDom.getBoundingClientRect();

  const originalWidth = Math.max(0, Math.round(originalRect.width));
  const modifiedWidth = Math.max(0, Math.round(modifiedRect.width));
  const splitterWidth = Math.max(0, Math.round(modifiedRect.left - originalRect.right));

  if (originalWidth === 0 && modifiedWidth === 0) return;
  emit("layout", {originalWidth, modifiedWidth, splitterWidth});
}

function scheduleEmitLayout() {
  if (layoutRaf) cancelAnimationFrame(layoutRaf);
  layoutRaf = requestAnimationFrame(() => {
    layoutRaf = 0;
    measureAndEmitLayout();
  });
}

function ensureModels() {
  if (!editor) return;
  const language = normalizeLanguage(props.language);

  const prevOriginalModel = originalModel;
  const prevModifiedModel = modifiedModel;

  const nextOriginalModel = monaco.editor.createModel(props.original ?? "", language);
  const nextModifiedModel = monaco.editor.createModel(props.modified ?? "", language);

  originalModel = nextOriginalModel;
  modifiedModel = nextModifiedModel;
  editor.setModel({original: nextOriginalModel, modified: nextModifiedModel});

  prevOriginalModel?.dispose();
  prevModifiedModel?.dispose();

  editor.updateOptions({ignoreTrimWhitespace: !!props.ignoreTrimWhitespace});
  editor.getOriginalEditor().updateOptions({readOnly: true});
  editor.getModifiedEditor().updateOptions({readOnly: true});
  scheduleEmitLayout();
}

function goToPreviousDiff() {
  if (!editor) return;
  const changes = editor.getLineChanges() || [];
  if (changes.length === 0) return;

  const current = getCurrentLineHint();
  const anchors = changes
    .map(toAnchor)
    .filter((a): a is DiffAnchor => !!a)
    .sort((a, b) => a.line - b.line);
  if (anchors.length === 0) return;

  const idx = lastIndexWhere(anchors, (a) => a.line < current.line);
  const next = idx >= 0 ? anchors[idx]! : anchors[anchors.length - 1]!;
  revealAnchor(next);
}

function revealFirstDiff() {
  if (!editor) return "notReady" as const;
  const changes = editor.getLineChanges();
  if (!changes) return "notReady" as const;
  if (changes.length === 0) return "noChanges" as const;

  const anchors = changes
    .map(toAnchor)
    .filter((a): a is DiffAnchor => !!a)
    .sort((a, b) => a.line - b.line);
  if (anchors.length === 0) return "noChanges" as const;

  revealAnchor(anchors[0]!);
  return "done" as const;
}

function goToFirstDiff() {
  pendingRevealFirstDiff = true;
  const result = revealFirstDiff();
  if (result !== "notReady") pendingRevealFirstDiff = false;
}

function goToNextDiff() {
  if (!editor) return;
  const changes = editor.getLineChanges() || [];
  if (changes.length === 0) return;

  const current = getCurrentLineHint();
  const anchors = changes
    .map(toAnchor)
    .filter((a): a is DiffAnchor => !!a)
    .sort((a, b) => a.line - b.line);
  if (anchors.length === 0) return;

  const idx = anchors.findIndex((a) => a.line > current.line);
  const next = idx >= 0 ? anchors[idx]! : anchors[0]!;
  revealAnchor(next);
}

defineExpose<MonacoDiffViewerExposed>({
  goToFirstDiff,
  goToPreviousDiff,
  goToNextDiff
});

type DiffAnchor = { side: "original" | "modified"; line: number };

function toAnchor(change: monaco.editor.ILineChange): DiffAnchor | null {
  if (change.modifiedStartLineNumber > 0) return { side: "modified", line: change.modifiedStartLineNumber };
  if (change.modifiedEndLineNumber > 0) return { side: "modified", line: change.modifiedEndLineNumber };
  if (change.originalStartLineNumber > 0) return { side: "original", line: change.originalStartLineNumber };
  if (change.originalEndLineNumber > 0) return { side: "original", line: change.originalEndLineNumber };
  return null;
}

function lastIndexWhere<T>(arr: T[], pred: (v: T) => boolean) {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (pred(arr[i]!)) return i;
  }
  return -1;
}

function getCurrentLineHint(): DiffAnchor {
  if (!editor) return { side: "modified", line: 1 };
  const modifiedEditor = editor.getModifiedEditor();
  const originalEditor = editor.getOriginalEditor();

  const modifiedFocused = modifiedEditor.hasTextFocus?.() || false;
  const originalFocused = originalEditor.hasTextFocus?.() || false;

  if (modifiedFocused) {
    const mp = modifiedEditor.getPosition();
    if (mp) return { side: "modified", line: mp.lineNumber };
  }
  if (originalFocused) {
    const op = originalEditor.getPosition();
    if (op) return { side: "original", line: op.lineNumber };
  }

  const mp = modifiedEditor.getPosition();
  if (mp) return { side: "modified", line: mp.lineNumber };

  const op = originalEditor.getPosition();
  if (op) return { side: "original", line: op.lineNumber };

  const mr = modifiedEditor.getVisibleRanges?.() || [];
  if (mr.length > 0) return { side: "modified", line: mr[0]!.startLineNumber };

  const or = originalEditor.getVisibleRanges?.() || [];
  if (or.length > 0) return { side: "original", line: or[0]!.startLineNumber };

  return { side: "modified", line: 1 };
}

function revealAnchor(anchor: DiffAnchor) {
  if (!editor) return;
  const target = anchor.side === "modified" ? editor.getModifiedEditor() : editor.getOriginalEditor();
  const line = Math.max(1, anchor.line);

  target.revealLineInCenter(line);
  target.setPosition({ lineNumber: line, column: 1 });
  target.focus();
}

onMounted(() => {
  ensureMonacoEnvironment();
  if (!containerEl.value) return;

  applyMonacoPanelTheme();
  editor = monaco.editor.createDiffEditor(containerEl.value, {
    automaticLayout: true,
    renderSideBySide: true,
    readOnly: true,
    fontSize: editorFontSize.value,
    minimap: {enabled: false},
    scrollBeyondLastLine: false,
    wordWrap: "off",
    renderOverviewRuler: true,
    renderWhitespace: "selection",
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true
  });

  const originalEditor = editor.getOriginalEditor();
  const modifiedEditor = editor.getModifiedEditor();
  originalEditor.updateOptions({
    scrollbar: {vertical: "hidden", horizontal: "auto"},
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true
  });
  modifiedEditor.updateOptions({
    scrollbar: {vertical: "hidden", horizontal: "auto"},
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true
  });

  const handleDiffUpdated = () => {
    scheduleEmitLayout();
    if (!pendingRevealFirstDiff) return;
    pendingRevealFirstDiff = false;
    revealFirstDiff();
  };

  disposables = [
    originalEditor.onDidLayoutChange(scheduleEmitLayout),
    modifiedEditor.onDidLayoutChange(scheduleEmitLayout),
    editor.onDidUpdateDiff(handleDiffUpdated)
  ];
  window.addEventListener("resize", scheduleEmitLayout, {passive: true});

  ensureModels();
  scheduleEmitLayout();

  stopWatchFontSize = watch(
    () => editorFontSize.value,
    (next) => {
      if (!editor) return;
      editor.updateOptions({ fontSize: next });
      editor.getOriginalEditor().updateOptions({ fontSize: next });
      editor.getModifiedEditor().updateOptions({ fontSize: next });
      scheduleEmitLayout();
    }
  );
});

watch(
    () => [props.original, props.modified, props.language, props.ignoreTrimWhitespace],
    () => ensureModels()
);

onBeforeUnmount(() => {
  if (layoutRaf) cancelAnimationFrame(layoutRaf);
  layoutRaf = 0;
  pendingRevealFirstDiff = false;
  window.removeEventListener("resize", scheduleEmitLayout);
  stopWatchFontSize?.();
  stopWatchFontSize = null;
  disposables.forEach((d) => d.dispose());
  disposables = [];
  if (editor) {
    try {
      editor.setModel(null as any);
    } catch {
      // ignore
    }
  }
  editor?.dispose();
  originalModel?.dispose();
  modifiedModel?.dispose();
  originalModel = null;
  modifiedModel = null;
  editor = null;
});
</script>

<style scoped>
:deep(.monaco-diff-editor.side-by-side .editor.modified) {
  box-shadow: none !important;
  border-left: 1px solid var(--border-color-secondary) !important;
}
</style>
