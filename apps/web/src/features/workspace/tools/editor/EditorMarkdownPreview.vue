<template>
  <div ref="scrollEl" class="editor-markdown-preview h-full min-h-0 overflow-auto" data-editor-markdown-preview tabindex="0"
    @scroll.passive="onScroll" @wheel.passive="onScrollIntent" @touchstart.passive="onScrollIntent"
    @pointerdown="onScrollbarPointerDown" @keydown="onScrollKeydown">
    <div v-if="error" class="preview-error" role="status">{{ error }}</div>
    <article ref="contentEl" class="editor-markdown-content" v-html="rendered.html" @click="onClick" @load.capture="onImageLoad" @error.capture="onImageError" />
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { downloadWorkspacePath, statWorkspaceFile } from "@/shared/api";
import { loadEditorImage } from "./editorImages";
import { editorMarkdownHeadingId, renderEditorMarkdown, type RenderedEditorMarkdown } from "./editorMarkdown";

const props = defineProps<{ workspaceId: string; path: string; text: string; scrollTop?: number }>();
const emit = defineEmits<{ "open-file": [path: string]; "scroll-position": [top: number] }>();
const { t } = useI18n();
const scrollEl = ref<HTMLElement | null>(null);
const contentEl = ref<HTMLElement | null>(null);
const rendered = shallowRef<RenderedEditorMarkdown>({ html: "", images: [], links: [] });
const error = ref("");
const urls = new Set<string>();
let generation = 0;
let linkRequest = 0;
let disposed = false;
const MAX_IMAGES = 32;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const IMAGE_CONCURRENCY = 3;
// Retain the desired offset until downloaded images have load/error dimensions.
// Intermediate browser clamping must never replace the saved Tab offset.
let pendingScrollRestore: { top: number; isCurrent: () => boolean } | null = null;
let restoreFrame: number | null = null;
let imageRequestsFinished = false;
const imagesAwaitingSize = new Set<HTMLImageElement>();

function stopScrollRestore() {
  pendingScrollRestore = null;
  if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
  restoreFrame = null;
}
function scheduleScrollRestore() {
  if (!pendingScrollRestore || restoreFrame !== null) return;
  restoreFrame = requestAnimationFrame(() => {
    restoreFrame = null;
    const pending = pendingScrollRestore;
    const root = scrollEl.value;
    if (!pending || !pending.isCurrent() || !root) return;
    root.scrollTop = pending.top;
    if (imageRequestsFinished && imagesAwaitingSize.size === 0) {
      pendingScrollRestore = null;
      emit("scroll-position", root.scrollTop);
    }
  });
}
function onScroll() {
  if (!disposed && !pendingScrollRestore) emit("scroll-position", scrollEl.value?.scrollTop ?? 0);
}
function onScrollIntent() {
  if (!pendingScrollRestore) return;
  const isCurrent = pendingScrollRestore.isCurrent();
  stopScrollRestore();
  if (isCurrent) onScroll();
}
function onScrollbarPointerDown(event: PointerEvent) {
  if (event.target === scrollEl.value) onScrollIntent();
}
function onScrollKeydown(event: KeyboardEvent) {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) onScrollIntent();
}
function onImageLoad(event: Event) {
  const image = event.target;
  if (!(image instanceof window.HTMLImageElement) || !contentEl.value?.contains(image)) return;
  if (imagesAwaitingSize.delete(image)) scheduleScrollRestore();
}

function releaseImages() {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
}
function showImageStatus(id: string, message: string) {
  const node = contentEl.value?.querySelector<HTMLElement>(`[data-md-image-status="${id}"]`);
  if (node) node.textContent = message;
}
function onImageError(event: Event) {
  const image = event.target;
  if (!(image instanceof window.HTMLImageElement) || !image.dataset.mdImage || !contentEl.value?.contains(image)) return;
  image.removeAttribute("src");
  showImageStatus(image.dataset.mdImage, t("editor.preview.imageFailed"));
  if (imagesAwaitingSize.delete(image)) scheduleScrollRestore();
}

watch(() => [props.workspaceId, props.path, props.text], async (_next, previous) => {
  const request = ++generation;
  linkRequest++;
  const workspaceId = props.workspaceId;
  const documentPath = props.path;
  const text = props.text;
  const sameDocument = previous?.[0] === workspaceId && previous?.[1] === documentPath;
  const target = sameDocument ? pendingScrollRestore?.top ?? scrollEl.value?.scrollTop ?? props.scrollTop ?? 0 : props.scrollTop ?? 0;
  stopScrollRestore();
  imageRequestsFinished = false;
  imagesAwaitingSize.clear();
  const isCurrent = () => !disposed && request === generation && workspaceId === props.workspaceId && documentPath === props.path && text === props.text;
  pendingScrollRestore = { top: Number.isFinite(target) ? Math.max(0, target) : 0, isCurrent };
  releaseImages();
  error.value = "";
  try {
    rendered.value = renderEditorMarkdown(props.text, props.path);
  } catch {
    rendered.value = { html: "", images: [], links: [] };
    error.value = t("editor.preview.renderFailed");
    imageRequestsFinished = true;
    await nextTick();
    if (isCurrent()) scheduleScrollRestore();
    return;
  }
  await nextTick();
  if (!isCurrent()) return;
  scheduleScrollRestore();
  const groups = new Map<string, string[]>();
  for (const image of rendered.value.images) {
    if (image.target.kind !== "file" || image.target.fragment) {
      showImageStatus(image.id, t(image.target.kind === "external" ? "editor.preview.remoteImageBlocked" : "editor.preview.imageBlocked"));
      continue;
    }
    const ids = groups.get(image.target.path) ?? [];
    ids.push(image.id);
    groups.set(image.target.path, ids);
  }
  const entries = [...groups];
  let cursor = 0;
  let reservedBytes = 0;
  let acceptedBytes = 0;
  const worker = async () => {
    while (isCurrent() && cursor < entries.length) {
      const index = cursor++;
      const [path, ids] = entries[index];
      if (index >= MAX_IMAGES) {
        for (const id of ids) showImageStatus(id, t("editor.preview.imageLimit"));
        continue;
      }
      for (const id of ids) showImageStatus(id, t("editor.image.loading"));
      const result = await loadEditorImage({
        path,
        stat: async () => {
          const stat = await statWorkspaceFile({ workspaceId, path });
          if (!isCurrent()) throw new Error("Stale Markdown image");
          if (stat.ok && stat.kind === "file" && stat.version) {
            const size = stat.version.size;
            if (!Number.isSafeInteger(size) || size < 0 || reservedBytes + size > MAX_IMAGE_BYTES) throw new Error("Markdown image budget exceeded");
            reservedBytes += size;
          }
          return stat;
        },
        download: async () => {
          if (!isCurrent()) throw new Error("Stale Markdown image");
          return (await downloadWorkspacePath({ workspaceId, path })).blob;
        }
      });
      if (!isCurrent()) return;
      if (!result.ok || acceptedBytes + result.blob.size > MAX_IMAGE_BYTES) {
        for (const id of ids) showImageStatus(id, t("editor.preview.imageFailed"));
        continue;
      }
      acceptedBytes += result.blob.size;
      const url = URL.createObjectURL(result.blob);
      urls.add(url);
      for (const id of ids) {
        const image = contentEl.value?.querySelector<HTMLImageElement>(`img[data-md-image="${id}"]`);
        if (image) {
          imagesAwaitingSize.add(image);
          image.src = url;
        }
        showImageStatus(id, "");
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: IMAGE_CONCURRENCY }, worker));
  } finally {
    if (isCurrent()) {
      imageRequestsFinished = true;
      scheduleScrollRestore();
    }
  }
}, { immediate: true });

function jumpToHeading(fragment: string) {
  const id = editorMarkdownHeadingId(fragment);
  const heading = Array.from(contentEl.value?.querySelectorAll<HTMLElement>("[id]") ?? []).find((node) => node.id === id);
  if (!heading) {
    error.value = t("editor.preview.headingMissing");
    return;
  }
  onScrollIntent();
  heading.scrollIntoView({ block: "start" });
}
async function onClick(event: MouseEvent) {
  const element = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-md-link]") : null;
  if (!element || !contentEl.value?.contains(element)) return;
  const target = rendered.value.links[Number(element.dataset.mdLink)];
  if (target?.kind === "external") return; // Sanitized, noopener noreferrer, browser-controlled navigation.
  event.preventDefault();
  error.value = "";
  const request = ++linkRequest;
  const currentGeneration = generation;
  if (!target || target.kind === "invalid") {
    error.value = t("editor.preview.linkBlocked");
    return;
  }
  if (target.kind === "anchor" || (target.kind === "file" && target.path === props.path && target.fragment)) {
    jumpToHeading(target.fragment!);
    return;
  }
  // The existing open-file protocol has line/column but no cross-document heading navigation.
  if (target.fragment) {
    error.value = t("editor.preview.crossFileHeadingUnsupported");
    return;
  }
  try {
    const stat = await statWorkspaceFile({ workspaceId: props.workspaceId, path: target.path });
    if (disposed || request !== linkRequest || currentGeneration !== generation) return;
    if (!stat.ok || stat.kind !== "file") {
      error.value = t("editor.preview.linkFailed");
      return;
    }
    emit("open-file", target.path);
  } catch {
    if (!disposed && request === linkRequest && currentGeneration === generation) error.value = t("editor.preview.linkFailed");
  }
}
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  linkRequest++;
  stopScrollRestore();
  imagesAwaitingSize.clear();
  releaseImages();
});
</script>

<style scoped>
.editor-markdown-preview { color: var(--text-primary); }
.preview-error { padding: 8px 20px; color: var(--danger-color); font-size: 12px; }
.editor-markdown-content { max-width: 960px; margin: 0 auto; padding: 20px 64px 32px 24px; line-height: 1.7; overflow-wrap: anywhere; }
.editor-markdown-content :deep(h1), .editor-markdown-content :deep(h2), .editor-markdown-content :deep(h3), .editor-markdown-content :deep(h4) { margin: 1em 0 .5em; font-weight: 600; line-height: 1.3; scroll-margin-top: 12px; }
.editor-markdown-content :deep(h1) { font-size: 1.8em; }
.editor-markdown-content :deep(h2) { font-size: 1.45em; border-bottom: 1px solid var(--border-color-secondary); padding-bottom: .3em; }
.editor-markdown-content :deep(h3) { font-size: 1.2em; }
.editor-markdown-content :deep(p), .editor-markdown-content :deep(ul), .editor-markdown-content :deep(ol), .editor-markdown-content :deep(pre), .editor-markdown-content :deep(blockquote), .editor-markdown-content :deep(table) { margin: .75em 0; }
.editor-markdown-content :deep(ul) { list-style: disc; padding-left: 1.75em; }
.editor-markdown-content :deep(ol) { list-style: decimal; padding-left: 1.75em; }
.editor-markdown-content :deep(a) { color: var(--primary-color); text-decoration: underline; }
.editor-markdown-content :deep(blockquote) { border-left: 3px solid var(--border-color-secondary); padding-left: 1em; color: var(--text-secondary); }
.editor-markdown-content :deep(code) { background: var(--panel-bg-elevated); border-radius: 3px; padding: .1em .3em; font-family: monospace; }
.editor-markdown-content :deep(pre) { overflow: auto; padding: 12px; border: 1px solid var(--border-color-secondary); border-radius: 4px; background: var(--panel-bg-elevated); }
.editor-markdown-content :deep(pre code) { padding: 0; background: none; }
.editor-markdown-content :deep(table) { display: block; overflow: auto; border-collapse: collapse; }
.editor-markdown-content :deep(th), .editor-markdown-content :deep(td) { border: 1px solid var(--border-color-secondary); padding: 6px 12px; }
.editor-markdown-content :deep(th) { font-weight: 600; }
.editor-markdown-content :deep(img) { max-width: 100%; height: auto; }
.editor-markdown-content :deep([data-md-image-status]) { color: var(--text-tertiary); font-size: 12px; }
</style>
