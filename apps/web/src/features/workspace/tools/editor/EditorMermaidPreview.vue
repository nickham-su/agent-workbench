<template>
  <div
    ref="scrollEl"
    class="editor-mermaid-preview h-full min-h-0 overflow-auto"
    :class="{ 'is-pan-ready': spaceHeld, 'is-panning': dragging }"
    data-editor-mermaid-preview
    tabindex="0"
    :aria-label="t('editor.mermaid.navigation')"
    @scroll.passive="publishViewport"
    @wheel="onWheel"
    @keydown="onKeydown"
    @keyup="onKeyup"
    @blur="cancelPan"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="endPan"
    @pointercancel="cancelPan"
    @lostpointercapture="endPan"
  >
    <div v-if="status" class="mermaid-status" role="status">{{ status }}</div>
    <div v-else class="editor-mermaid-content">
      <div ref="canvasEl" class="editor-mermaid-canvas" v-html="svg" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { MermaidPreviewError, renderMermaidPreview, validateMermaidSource } from "./editorMermaid";
import {
  clampMermaidScale, fitMermaidScale, getMermaidSvgSize, isMermaidViewportState,
  MERMAID_MAX_SCALE, MERMAID_ZOOM_STEP, zoomMermaidViewport,
  type MermaidSize, type MermaidViewportState
} from "./mermaidViewport";

export type MermaidPreviewExposed = {
  readonly ready: boolean;
  readonly canZoomIn: boolean;
  readonly canZoomOut: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  fitToViewport: () => void;
};

const props = defineProps<{ text: string; viewport?: MermaidViewportState; contentRevision?: number }>();
const emit = defineEmits<{ "viewport-change": [state: MermaidViewportState] }>();
const { t } = useI18n();
const scrollEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLElement | null>(null);
const svg = ref("");
const status = ref("");
const ready = ref(false);
const scale = ref(1);
const minimumScale = ref(0.05);
const spaceHeld = ref(false);
const dragging = ref(false);
const canZoomIn = computed(() => ready.value && scale.value < MERMAID_MAX_SCALE - 0.00001);
const canZoomOut = computed(() => ready.value && scale.value > minimumScale.value + 0.00001);
let baseSize: MermaidSize | null = null;
let svgElement: SVGSVGElement | null = null;
let generation = 0;
let activeRevision = 0;
let firstSource = true;
let timer: ReturnType<typeof setTimeout> | undefined;
let rendering: AbortController | undefined;
let resizeObserver: ResizeObserver | undefined;
let disposed = false;
let fitting = false;
let pan: { pointer: number; x: number; y: number } | undefined;

function currentFit() {
  const el = scrollEl.value;
  return baseSize && el ? fitMermaidScale(baseSize, el.clientWidth, el.clientHeight) : 1;
}
function publishViewport() {
  const el = scrollEl.value;
  if (!ready.value || disposed || !el) return;
  emit("viewport-change", { scale: scale.value, left: el.scrollLeft, top: el.scrollTop, contentRevision: activeRevision });
}
function writeScale(value: number) {
  if (!baseSize || !svgElement || !canvasEl.value) return;
  const fit = currentFit();
  minimumScale.value = clampMermaidScale(0, fit);
  scale.value = clampMermaidScale(value, fit);
  const width = `${baseSize.width * scale.value}px`;
  const height = `${baseSize.height * scale.value}px`;
  // Give scaling a real layout footprint, not just a visual transform. Override
  // Mermaid's percentage width and inline max-width without modifying its viewBox.
  Object.assign(canvasEl.value.style, { width, height });
  Object.assign(svgElement.style, { width, height, maxWidth: "none", maxHeight: "none", display: "block" });
}
function zoomTo(value: number, anchor?: { x: number; y: number }) {
  const el = scrollEl.value;
  if (!ready.value || !el) return;
  const next = clampMermaidScale(value, currentFit());
  if (next === scale.value) return;
  const offset = zoomMermaidViewport({ scale: scale.value, left: el.scrollLeft, top: el.scrollTop }, next,
    anchor ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 });
  fitting = false;
  writeScale(next);
  // Synchronous dimension updates let the browser clamp against the new extent.
  el.scrollLeft = offset.left;
  el.scrollTop = offset.top;
  publishViewport();
}
function zoomIn() { zoomTo(scale.value * MERMAID_ZOOM_STEP); }
function zoomOut() { zoomTo(scale.value / MERMAID_ZOOM_STEP); }
function fitToViewport() {
  if (!ready.value || !scrollEl.value) return;
  fitting = true;
  writeScale(currentFit());
  scrollEl.value.scrollLeft = 0;
  scrollEl.value.scrollTop = 0;
  publishViewport();
}
function onWheel(event: WheelEvent) {
  if (!ready.value || (!event.ctrlKey && !event.metaKey) || !scrollEl.value) return;
  event.preventDefault(); // Only consume modified wheel events over this preview.
  const el = scrollEl.value;
  const rect = el.getBoundingClientRect();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1);
  zoomTo(scale.value * Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.002),
    { x: event.clientX - rect.left - el.clientLeft, y: event.clientY - rect.top - el.clientTop });
}
function onKeydown(event: KeyboardEvent) {
  if (ready.value && event.code === "Space" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    spaceHeld.value = true;
  }
}
function onKeyup(event: KeyboardEvent) { if (event.code === "Space") cancelPan(); }
function onPointerDown(event: PointerEvent) {
  const el = scrollEl.value;
  if (!ready.value || !el || event.pointerType === "touch") return;
  if (event.button !== 1 && !(event.button === 0 && spaceHeld.value)) {
    // Focus the viewport for Space navigation without preventing text selection.
    if (event.button === 0) el.focus({ preventScroll: true });
    return;
  }
  event.preventDefault();
  el.focus({ preventScroll: true });
  pan = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
  dragging.value = true;
  fitting = false;
  try { el.setPointerCapture(event.pointerId); } catch { /* A cancelled pointer may already be gone. */ }
}
function onPointerMove(event: PointerEvent) {
  if (!pan || event.pointerId !== pan.pointer || !scrollEl.value) return;
  event.preventDefault();
  scrollEl.value.scrollLeft -= event.clientX - pan.x;
  scrollEl.value.scrollTop -= event.clientY - pan.y;
  pan.x = event.clientX;
  pan.y = event.clientY;
  publishViewport();
}
function endPan() {
  const pointer = pan?.pointer;
  pan = undefined;
  dragging.value = false;
  if (pointer !== undefined) {
    try { scrollEl.value?.releasePointerCapture(pointer); } catch { /* Capture may already be released. */ }
  }
}
function cancelPan() { spaceHeld.value = false; endPan(); }

watch(() => [props.text, props.contentRevision ?? 0] as const, ([text, revision]) => {
  const request = ++generation;
  const saved = firstSource && isMermaidViewportState(props.viewport, revision) ? { ...props.viewport } : undefined;
  firstSource = false;
  if (timer) clearTimeout(timer);
  rendering?.abort();
  cancelPan();
  ready.value = false;
  svgElement = null;
  baseSize = null;
  svg.value = "";
  let source: string;
  try { source = validateMermaidSource(text); } catch (error) {
    status.value = t(`editor.mermaid.${error instanceof MermaidPreviewError ? error.reason : "renderFailed"}`);
    return;
  }
  status.value = t("editor.mermaid.loading");
  // Only source changes run layout. Navigation changes display dimensions only.
  timer = setTimeout(async () => {
    const isCurrent = () => !disposed && request === generation && text === props.text && revision === (props.contentRevision ?? 0);
    const controller = rendering = new AbortController();
    try {
      const result = await renderMermaidPreview(source, controller.signal);
      if (!isCurrent()) return;
      svg.value = result;
      status.value = "";
      await nextTick();
      if (!isCurrent() || !scrollEl.value) return;
      svgElement = canvasEl.value?.querySelector("svg") ?? null;
      if (!svgElement) throw new MermaidPreviewError("renderFailed");
      let measured: { x: number; y: number; width: number; height: number } | undefined;
      try { const box = svgElement.getBBox(); measured = { x: box.x, y: box.y, width: box.width, height: box.height }; } catch { /* Some DOM implementations cannot measure SVG. */ }
      const viewBoxSize = getMermaidSvgSize(svgElement.getAttribute("viewBox"), null, null);
      const absoluteSize = getMermaidSvgSize(null, svgElement.getAttribute("width"), svgElement.getAttribute("height"));
      baseSize = viewBoxSize ?? absoluteSize ?? getMermaidSvgSize(null, null, null, measured);
      if (!baseSize) throw new MermaidPreviewError("renderFailed");
      if (!viewBoxSize) {
        // Width/height alone resize the viewport, not its drawing coordinates.
        // Give fallback SVGs a coordinate system so their contents scale too.
        const x = !absoluteSize && Number.isFinite(measured?.x) ? measured!.x : 0;
        const y = !absoluteSize && Number.isFinite(measured?.y) ? measured!.y : 0;
        svgElement.setAttribute("viewBox", `${x} ${y} ${baseSize.width} ${baseSize.height}`);
      }
      activeRevision = revision;
      writeScale(saved?.scale ?? currentFit());
      scrollEl.value.scrollLeft = saved?.left ?? 0;
      scrollEl.value.scrollTop = saved?.top ?? 0;
      fitting = !saved;
      ready.value = true;
      publishViewport();
    } catch (error) {
      if (isCurrent()) {
        ready.value = false;
        status.value = t(`editor.mermaid.${error instanceof MermaidPreviewError ? error.reason : "renderFailed"}`);
      }
    }
  }, 120);
}, { immediate: true });

onMounted(() => {
  window.addEventListener("blur", cancelPan);
  if (typeof ResizeObserver !== "undefined" && scrollEl.value) {
    resizeObserver = new ResizeObserver(() => {
      if (!ready.value) return;
      minimumScale.value = clampMermaidScale(0, currentFit());
      if (fitting) fitToViewport(); else publishViewport();
    });
    resizeObserver.observe(scrollEl.value);
  }
});
onBeforeUnmount(() => {
  publishViewport();
  disposed = true;
  generation++;
  if (timer) clearTimeout(timer);
  rendering?.abort();
  cancelPan();
  resizeObserver?.disconnect();
  window.removeEventListener("blur", cancelPan);
});
defineExpose({ ready, canZoomIn, canZoomOut, zoomIn, zoomOut, fitToViewport });
</script>

<style scoped>
.editor-mermaid-preview { overflow-anchor: none; }
.editor-mermaid-preview:focus-visible { outline: 1px solid var(--border-color-secondary); outline-offset: -1px; }
.mermaid-status { padding: 1rem 5rem 1rem 1rem; font-size: 12px; color: var(--text-secondary); }
.editor-mermaid-content { padding: 16px 80px 16px 16px; width: max-content; min-width: 100%; min-height: 100%; box-sizing: border-box; }
.editor-mermaid-content :deep(svg) { background: #fff; border-radius: 4px; max-width: none; }
.is-pan-ready, .is-pan-ready :deep(*) { cursor: grab; }
.is-panning, .is-panning :deep(*) { cursor: grabbing; user-select: none; }
</style>
