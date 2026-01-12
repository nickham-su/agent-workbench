<template>
  <div ref="containerEl" class="h-full w-full"></div>
</template>

<script setup lang="ts">
import {onBeforeUnmount, onMounted, ref, watch} from "vue";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/min/vs/editor/editor.main.css";
import {ensureMonacoEnvironment} from "../monaco/monacoEnv";

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

const emit = defineEmits<{
  (e: "layout", layout: DiffViewerLayout): void;
}>();

const containerEl = ref<HTMLDivElement | null>(null);

let editor: monaco.editor.IStandaloneDiffEditor | null = null;
let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
let disposables: monaco.IDisposable[] = [];
let layoutRaf = 0;

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

onMounted(() => {
  ensureMonacoEnvironment();
  if (!containerEl.value) return;

  monaco.editor.setTheme("vs-dark");
  editor = monaco.editor.createDiffEditor(containerEl.value, {
    automaticLayout: true,
    renderSideBySide: true,
    readOnly: true,
    minimap: {enabled: false},
    scrollBeyondLastLine: false,
    wordWrap: "off",
    renderOverviewRuler: false,
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
    scrollbar: {vertical: "auto", horizontal: "auto"},
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true
  });

  disposables = [
    originalEditor.onDidLayoutChange(scheduleEmitLayout),
    modifiedEditor.onDidLayoutChange(scheduleEmitLayout),
    editor.onDidUpdateDiff(scheduleEmitLayout)
  ];
  window.addEventListener("resize", scheduleEmitLayout, {passive: true});

  ensureModels();
  scheduleEmitLayout();
});

watch(
    () => [props.original, props.modified, props.language, props.ignoreTrimWhitespace],
    () => ensureModels()
);

onBeforeUnmount(() => {
  if (layoutRaf) cancelAnimationFrame(layoutRaf);
  layoutRaf = 0;
  window.removeEventListener("resize", scheduleEmitLayout);
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
