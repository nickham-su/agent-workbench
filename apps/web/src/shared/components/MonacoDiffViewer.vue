<template>
  <div ref="containerEl" class="h-full w-full"></div>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from "vue";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/min/vs/editor/editor.main.css";
import { ensureMonacoEnvironment } from "@/shared/monaco/monacoEnv";
import { applyMonacoPanelTheme } from "@/shared/monaco/monacoTheme";
import { ensureMonacoLanguage } from "@/shared/monaco/languageLoader";
import { normalizeMonacoLanguage } from "@/shared/monaco/languageUtils";
import { editorFontSize } from "@/shared/settings/uiFontSizes";

const props = defineProps<{
  original: string;
  modified: string;
  language?: string;
  ignoreTrimWhitespace?: boolean;
  sideBySide?: boolean;
}>();

export type MonacoDiffViewerExposed = {
  goToFirstDiff: () => void;
  goToPreviousDiff: () => void;
  goToNextDiff: () => void;
  getActiveLine: () => number | null;
};

const containerEl = ref<HTMLDivElement | null>(null);
const isSideBySide = computed(() => props.sideBySide !== false);

let editor: monaco.editor.IStandaloneDiffEditor | null = null;
let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
let disposables: monaco.IDisposable[] = [];
let stopWatchFontSize: (() => void) | null = null;
let pendingRevealFirstDiff = false;
let modelSeq = 0;

async function applyLanguageToModels(language: string | undefined, seq: number) {
  if (!language) return;
  try {
    await ensureMonacoLanguage(language);
  } catch {
    return;
  }
  if (seq !== modelSeq) return;
  if (originalModel) monaco.editor.setModelLanguage(originalModel, language);
  if (modifiedModel) monaco.editor.setModelLanguage(modifiedModel, language);
}

function ensureModels() {
  if (!editor) return;
  const language = normalizeMonacoLanguage(props.language);
  modelSeq += 1;
  const seq = modelSeq;

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
  void applyLanguageToModels(language, seq);
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

function getActiveLine() {
  if (!editor) return null;
  const modifiedEditor = editor.getModifiedEditor();
  const ranges = modifiedEditor.getVisibleRanges?.() || [];
  if (ranges.length > 0) return Math.max(1, ranges[0]!.startLineNumber);
  const pos = modifiedEditor.getPosition();
  if (pos) return Math.max(1, pos.lineNumber);
  return 1;
}

defineExpose<MonacoDiffViewerExposed>({
  goToFirstDiff,
  goToPreviousDiff,
  goToNextDiff,
  getActiveLine
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
  const target = isSideBySide.value
    ? (anchor.side === "modified" ? editor.getModifiedEditor() : editor.getOriginalEditor())
    : editor.getModifiedEditor();
  const line = Math.max(1, anchor.line);

  target.revealLineInCenter(line);
  target.setPosition({ lineNumber: line, column: 1 });
  target.focus();
}

onMounted(() => {
  ensureMonacoEnvironment();
  if (!containerEl.value) return;

  applyMonacoPanelTheme();
  const renderSideBySide = isSideBySide.value;
  editor = monaco.editor.createDiffEditor(containerEl.value, {
    automaticLayout: true,
    renderSideBySide,
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
    if (!pendingRevealFirstDiff) return;
    pendingRevealFirstDiff = false;
    revealFirstDiff();
  };

  disposables = [
    editor.onDidUpdateDiff(handleDiffUpdated)
  ];

  ensureModels();

  stopWatchFontSize = watch(
    () => editorFontSize.value,
    (next) => {
      if (!editor) return;
      editor.updateOptions({ fontSize: next });
      editor.getOriginalEditor().updateOptions({ fontSize: next });
      editor.getModifiedEditor().updateOptions({ fontSize: next });
    }
  );
});

watch(
    () => [props.original, props.modified, props.language, props.ignoreTrimWhitespace],
    () => ensureModels()
);

watch(
    () => props.sideBySide,
    (next) => {
      if (!editor) return;
      editor.updateOptions({ renderSideBySide: next !== false });
    }
);

onBeforeUnmount(() => {
  pendingRevealFirstDiff = false;
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
