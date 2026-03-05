<template>
  <div ref="containerEl" :class="containerClass" :style="containerStyle"></div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/min/vs/editor/editor.main.css";
import { ensureMonacoEnvironment } from "@/shared/monaco/monacoEnv";
import { applyMonacoPanelTheme } from "@/shared/monaco/monacoTheme";
import { ensureMonacoLanguage } from "@/shared/monaco/languageLoader";
import { normalizeMonacoLanguage } from "@/shared/monaco/languageUtils";
import { editorFontSize } from "@/shared/settings/uiFontSizes";

const props = defineProps<{
  value: string;
  language?: string;
  readOnly?: boolean;
  autoHeight?: boolean;
  minHeight?: number;
  maxHeight?: number;
}>();

const containerEl = ref<HTMLDivElement | null>(null);
const autoHeightPx = ref(0);
const containerClass = computed(() => (props.autoHeight ? "w-full" : "h-full w-full"));
const containerStyle = computed(() => {
  if (!props.autoHeight) return undefined;
  const fallback = resolveAutoHeightBounds().min;
  return { height: `${Math.max(autoHeightPx.value || 0, fallback)}px` };
});

let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let model: monaco.editor.ITextModel | null = null;
let disposeContentSize: monaco.IDisposable | null = null;
let stopWatchFontSize: (() => void) | null = null;
let modelSeq = 0;

function toPositiveInt(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function resolveAutoHeightBounds() {
  const min = toPositiveInt(props.minHeight, 112);
  if (typeof props.maxHeight !== "number") {
    return {
      min,
      max: Number.POSITIVE_INFINITY
    };
  }
  const maxRaw = toPositiveInt(props.maxHeight, 420);
  return {
    min,
    max: Math.max(min, maxRaw)
  };
}

function updateAutoHeight() {
  if (!editor || !props.autoHeight) return;
  const raw = editor.getContentHeight();
  const bounds = resolveAutoHeightBounds();
  autoHeightPx.value = Math.min(bounds.max, Math.max(bounds.min, Math.ceil(raw)));
}

async function applyLanguage(seq: number) {
  if (!model) return;
  const language = normalizeMonacoLanguage(props.language);
  if (!language) return;
  try {
    await ensureMonacoLanguage(language);
  } catch {
    return;
  }
  if (seq !== modelSeq || !model) return;
  monaco.editor.setModelLanguage(model, language);
}

function ensureModel() {
  if (!editor) return;
  modelSeq += 1;
  const seq = modelSeq;
  const language = normalizeMonacoLanguage(props.language);

  const prevModel = model;
  const nextModel = monaco.editor.createModel(props.value ?? "", language);
  model = nextModel;
  editor.setModel(nextModel);
  prevModel?.dispose();

  void applyLanguage(seq);
  updateAutoHeight();
}

onMounted(() => {
  ensureMonacoEnvironment();
  if (!containerEl.value) return;

  applyMonacoPanelTheme();
  editor = monaco.editor.create(containerEl.value, {
    automaticLayout: true,
    readOnly: props.readOnly !== false,
    fontSize: editorFontSize.value,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: "off",
    renderWhitespace: "selection",
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: { vertical: "hidden", horizontal: "auto" }
  });

  ensureModel();
  updateAutoHeight();

  disposeContentSize = editor.onDidContentSizeChange(() => updateAutoHeight());
  stopWatchFontSize = watch(
    () => editorFontSize.value,
    (next) => {
      if (!editor) return;
      editor.updateOptions({ fontSize: next });
      updateAutoHeight();
    }
  );
});

watch(
  () => [props.value, props.language],
  () => ensureModel()
);

onBeforeUnmount(() => {
  stopWatchFontSize?.();
  stopWatchFontSize = null;
  disposeContentSize?.dispose();
  disposeContentSize = null;
  model?.dispose();
  model = null;
  editor?.dispose();
  editor = null;
});
</script>
