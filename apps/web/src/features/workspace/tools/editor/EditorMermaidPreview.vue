<template>
  <div ref="scrollEl" class="editor-mermaid-preview h-full min-h-0 overflow-auto" data-editor-mermaid-preview @scroll.passive="emit('scroll-position', scrollEl?.scrollTop ?? 0)">
    <div v-if="status" class="mermaid-status" role="status">{{ status }}</div>
    <div v-else class="editor-mermaid-content" v-html="svg" />
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { MermaidPreviewError, renderMermaidPreview, validateMermaidSource } from "./editorMermaid";

const props = defineProps<{ text: string; scrollTop?: number }>();
const emit = defineEmits<{ "scroll-position": [top: number] }>();
const { t } = useI18n();
const scrollEl = ref<HTMLElement | null>(null);
const svg = ref("");
const status = ref("");
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let rendering: AbortController | undefined;
let disposed = false;

watch(() => props.text, (text) => {
  const request = ++generation;
  if (timer) clearTimeout(timer);
  rendering?.abort();
  svg.value = "";
  let source: string;
  try { source = validateMermaidSource(text); } catch (error) {
    status.value = t(`editor.mermaid.${error instanceof MermaidPreviewError ? error.reason : "renderFailed"}`);
    return;
  }
  status.value = t("editor.mermaid.loading");
  // Debounce layout work; async rendering itself still runs on the browser's main thread.
  timer = setTimeout(async () => {
    const isCurrent = () => !disposed && request === generation && text === props.text;
    const controller = rendering = new AbortController();
    try {
      const result = await renderMermaidPreview(source, controller.signal);
      if (!isCurrent()) return;
      svg.value = result;
      status.value = "";
      await nextTick();
      if (isCurrent() && scrollEl.value) scrollEl.value.scrollTop = props.scrollTop ?? 0;
    } catch (error) {
      if (isCurrent()) status.value = t(`editor.mermaid.${error instanceof MermaidPreviewError ? error.reason : "renderFailed"}`);
    }
  }, 120);
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation++; if (timer) clearTimeout(timer); rendering?.abort(); });
</script>

<style scoped>
.mermaid-status { padding: 1rem 5rem 1rem 1rem; font-size: 12px; color: var(--text-secondary); }
.editor-mermaid-content { padding: 1rem 5rem 1rem 1rem; min-width: min-content; }
.editor-mermaid-content :deep(svg) { background: #fff; border-radius: 4px; max-width: none; }
</style>
