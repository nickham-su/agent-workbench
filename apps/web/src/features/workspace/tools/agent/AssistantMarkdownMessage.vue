<template>
  <div
    ref="rootEl"
    class="assistant-markdown-message break-words"
    :class="toneClass"
    :style="{ fontSize: 'var(--agent-font-size, 13px)' }"
    v-html="safeHtml"
  />
</template>

<script setup lang="ts">
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import type { Config as DOMPurifyConfig } from "dompurify";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  text: string;
  messageId: number;
  streaming?: boolean;
  tone?: "normal" | "error";
}>();

const MARKDOWN_DEBOUNCE_MS = 280;
const MERMAID_DEBOUNCE_MS = 900;
const MARKDOWN_CACHE_MAX = 240;
const MERMAID_CACHE_MAX = 180;

const markdownCache = new Map<string, string>();
const mermaidCache = new Map<string, string>();

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false
});

// 当前版本不支持图片渲染.
markdown.renderer.rules.image = () => "";

let hookInstalled = false;

function isSafeHref(raw: string) {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (value.startsWith("#")) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return true;
  try {
    const url = new URL(value, "https://awb.local");
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function ensurePurifyHooks() {
  if (hookInstalled) return;
  hookInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    for (const attr of Array.from(node.attributes || [])) {
      if (attr.name.toLowerCase().startsWith("on")) {
        node.removeAttribute(attr.name);
      }
    }

    const tagName = node.tagName?.toLowerCase?.() || "";
    if (tagName === "img") {
      node.remove();
      return;
    }

    if (tagName === "a") {
      const href = node.getAttribute("href") || "";
      if (!isSafeHref(href)) {
        node.removeAttribute("href");
      } else {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    }

    if (node.hasAttribute("xlink:href")) {
      node.removeAttribute("xlink:href");
    }
  });
}

const MARKDOWN_SANITIZE_CONFIG: DOMPurifyConfig = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["img", "script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "option", "meta", "link"],
  FORBID_ATTR: ["style"]
};

const SVG_SANITIZE_CONFIG: DOMPurifyConfig = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ["a", "foreignObject"],
  FORBID_ATTR: ["style", "href", "xlink:href"]
};

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string } | string>;
};

let mermaidApiPromise: Promise<MermaidApi> | null = null;
let mermaidInitialized = false;

async function getMermaidApi() {
  if (!mermaidApiPromise) {
    mermaidApiPromise = import("mermaid").then((mod) => {
      const api = (mod.default ?? mod) as MermaidApi;
      if (!mermaidInitialized) {
        api.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          flowchart: { htmlLabels: false },
          sequence: { useMaxWidth: true }
        });
        mermaidInitialized = true;
      }
      return api;
    }).catch((err) => {
      // 首次加载失败时清空缓存,后续渲染可继续重试.
      mermaidApiPromise = null;
      throw err;
    });
  }
  return mermaidApiPromise;
}

function stableHash(input: string) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function cacheKeyOf(input: string) {
  return `${input.length}:${stableHash(input)}:${input.slice(0, 24)}`;
}

function getCacheValue(cache: Map<string, string>, key: string) {
  const value = cache.get(key);
  if (typeof value !== "string") return null;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setCacheValue(cache: Map<string, string>, key: string, value: string, max: number) {
  if (!key) return;
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  while (cache.size > max) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) break;
    cache.delete(firstKey);
  }
}

function stripSvgLinks(svgText: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const links = Array.from(doc.querySelectorAll("a"));
  for (const link of links) {
    const parent = link.parentNode;
    if (!parent) continue;
    while (link.firstChild) {
      parent.insertBefore(link.firstChild, link);
    }
    parent.removeChild(link);
  }
  const hrefNodes = Array.from(doc.querySelectorAll("[href], [xlink\\:href]"));
  for (const node of hrefNodes) {
    node.removeAttribute("href");
    node.removeAttribute("xlink:href");
  }
  const svg = doc.documentElement;
  return svg ? new XMLSerializer().serializeToString(svg) : "";
}

function hasClosedMermaidFence(text: string) {
  return /```\s*mermaid[\t ]*\r?\n[\s\S]*?```/i.test(text);
}

ensurePurifyHooks();

const rootEl = ref<HTMLElement | null>(null);
const safeHtml = ref("");
const toneClass = computed(() => (props.tone === "error" ? "is-error" : ""));

let markdownTimer: number | null = null;
let mermaidTimer: number | null = null;
let renderSeq = 0;
let lastRawText = "";

function clearMarkdownTimer() {
  if (markdownTimer == null) return;
  window.clearTimeout(markdownTimer);
  markdownTimer = null;
}

function clearMermaidTimer() {
  if (mermaidTimer == null) return;
  window.clearTimeout(mermaidTimer);
  mermaidTimer = null;
}

function scheduleMarkdownRender() {
  clearMarkdownTimer();
  const delay = props.streaming ? MARKDOWN_DEBOUNCE_MS : 0;
  if (delay <= 0) {
    // 历史消息(非流式)在挂载时同步渲染,避免先空白后回填造成虚拟列表行高突变。
    void renderMarkdown();
    return;
  }
  markdownTimer = window.setTimeout(() => {
    markdownTimer = null;
    void renderMarkdown();
  }, delay);
}

function scheduleMermaidRender(seq: number, rawText: string) {
  clearMermaidTimer();
  if (!hasClosedMermaidFence(rawText)) return;
  const delay = props.streaming ? MERMAID_DEBOUNCE_MS : 80;
  mermaidTimer = window.setTimeout(() => {
    mermaidTimer = null;
    void renderMermaidBlocks(seq, rawText);
  }, delay);
}

async function renderMarkdown() {
  const seq = ++renderSeq;
  const rawText = String(props.text || "");
  lastRawText = rawText;
  const key = cacheKeyOf(rawText);
  const cached = getCacheValue(markdownCache, key);
  if (cached != null) {
    safeHtml.value = cached;
    scheduleMermaidRender(seq, rawText);
    return;
  }

  const html = markdown.render(rawText);
  const sanitized = DOMPurify.sanitize(html, MARKDOWN_SANITIZE_CONFIG);
  if (seq !== renderSeq) return;
  const safe = typeof sanitized === "string" ? sanitized : String(sanitized);
  safeHtml.value = safe;
  setCacheValue(markdownCache, key, safe, MARKDOWN_CACHE_MAX);
  scheduleMermaidRender(seq, rawText);
}

async function renderMermaidBlocks(seq: number, rawText: string) {
  if (seq !== renderSeq) return;
  if (rawText !== lastRawText) return;

  await nextTick();
  if (seq !== renderSeq) return;
  if (rawText !== lastRawText) return;

  const root = rootEl.value;
  if (!root) return;

  const blocks = Array.from(root.querySelectorAll("pre > code")).filter((node) => {
    const classList = String(node.className || "").split(/\s+/);
    return classList.some((name) => name === "language-mermaid" || name === "lang-mermaid");
  });
  if (blocks.length === 0) return;

  const mermaid = await getMermaidApi();
  for (let i = 0; i < blocks.length; i += 1) {
    if (seq !== renderSeq) return;
    if (rawText !== lastRawText) return;

    const codeEl = blocks[i];
    const source = String(codeEl.textContent || "").trim();
    if (!source) continue;

    const cacheKey = cacheKeyOf(source);
    let safeSvg = getCacheValue(mermaidCache, cacheKey);
    if (safeSvg == null) {
      try {
        const renderId = `awb_mermaid_${props.messageId}_${i}_${Date.now()}`;
        const rendered = await mermaid.render(renderId, source);
        const rawSvg = typeof rendered === "string" ? rendered : rendered.svg;
        const sanitizedSvg = DOMPurify.sanitize(rawSvg, SVG_SANITIZE_CONFIG);
        const safeSvgText = typeof sanitizedSvg === "string" ? sanitizedSvg : String(sanitizedSvg);
        safeSvg = stripSvgLinks(safeSvgText);
        setCacheValue(mermaidCache, cacheKey, safeSvg, MERMAID_CACHE_MAX);
      } catch {
        continue;
      }
    }

    const pre = codeEl.parentElement;
    if (!pre || pre.tagName.toLowerCase() !== "pre") continue;
    const wrapper = document.createElement("div");
    wrapper.className = "assistant-mermaid-wrapper";
    wrapper.innerHTML = safeSvg;
    pre.replaceWith(wrapper);
  }
}

watch(
  () => [props.text, !!props.streaming] as const,
  () => {
    scheduleMarkdownRender();
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  clearMarkdownTimer();
  clearMermaidTimer();
  renderSeq += 1;
});
</script>

<style scoped>
.assistant-markdown-message {
  line-height: 1.65;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.assistant-markdown-message.is-error {
  color: rgb(239 68 68);
}

.assistant-markdown-message :deep(p),
.assistant-markdown-message :deep(ul),
.assistant-markdown-message :deep(ol),
.assistant-markdown-message :deep(blockquote),
.assistant-markdown-message :deep(pre),
.assistant-markdown-message :deep(table) {
  margin: 0.5rem 0;
}

.assistant-markdown-message :deep(h1),
.assistant-markdown-message :deep(h2),
.assistant-markdown-message :deep(h3),
.assistant-markdown-message :deep(h4) {
  margin: 0.6rem 0 0.35rem;
  line-height: 1.35;
  font-weight: 600;
}

.assistant-markdown-message :deep(h1) {
  font-size: 1.05rem;
}

.assistant-markdown-message :deep(h2) {
  font-size: 1rem;
}

.assistant-markdown-message :deep(h3),
.assistant-markdown-message :deep(h4) {
  font-size: 0.95rem;
}

.assistant-markdown-message :deep(ul),
.assistant-markdown-message :deep(ol) {
  padding-left: 1.25rem;
}

.assistant-markdown-message :deep(li + li) {
  margin-top: 0.2rem;
}

.assistant-markdown-message :deep(blockquote) {
  border-left: 3px solid rgba(59, 130, 246, 0.45);
  padding-left: 0.75rem;
  color: var(--text-secondary);
}

.assistant-markdown-message :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.9em;
}

.assistant-markdown-message :deep(pre) {
  border: 1px solid var(--border-color-secondary);
  border-radius: 6px;
  padding: 0.65rem 0.75rem;
  overflow-x: auto;
  background: var(--panel-bg-elevated);
}

.assistant-markdown-message :deep(pre code) {
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
}

.assistant-markdown-message :deep(a[href]) {
  color: rgb(37 99 235);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.assistant-markdown-message :deep(table) {
  border-collapse: collapse;
  display: block;
  max-width: 100%;
  overflow-x: auto;
}

.assistant-markdown-message :deep(th),
.assistant-markdown-message :deep(td) {
  border: 1px solid var(--border-color-secondary);
  padding: 0.35rem 0.5rem;
  white-space: nowrap;
}

.assistant-markdown-message :deep(th) {
  background: var(--panel-bg-elevated);
  font-weight: 600;
}

.assistant-markdown-message :deep(.assistant-mermaid-wrapper) {
  margin: 0.5rem 0;
  padding: 0.4rem;
  border: 1px solid var(--border-color-secondary);
  border-radius: 6px;
  overflow-x: auto;
  background: var(--panel-bg-elevated);
}

.assistant-markdown-message :deep(.assistant-mermaid-wrapper svg) {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}
</style>
