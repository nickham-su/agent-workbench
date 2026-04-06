<template>
  <div ref="rootEl" class="assistant-markdown-message break-words" :class="toneClass" v-html="safeHtml" @click="onMarkdownClick" />
</template>

<script setup lang="ts">
import { message } from "ant-design-vue";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import type { Config as DOMPurifyConfig } from "dompurify";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  text: string;
  messageId: number;
  streaming?: boolean;
  tone?: "normal" | "error";
  sectionKey?: string;
}>();

const MARKDOWN_DEBOUNCE_MS = 280;
const MARKDOWN_CACHE_MAX = 240;

const markdownCache = new Map<string, string>();

const { t, locale } = useI18n();

const rootEl = ref<HTMLElement | null>(null);

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false
});

function escapeHtml(value: string) {
  return markdown.utils.escapeHtml(value);
}

// 当前版本不支持图片渲染.
markdown.renderer.rules.image = () => "";

markdown.renderer.rules.fence = (tokens, idx, options) => {
  const token = tokens[idx];
  const info = markdown.utils.unescapeAll(String(token.info || "")).trim();
  const languageName = info.split(/\s+/, 1)[0] || "";
  const className = languageName ? `${options.langPrefix}${escapeHtml(languageName)}` : "";
  const classAttr = className ? ` class="${className}"` : "";
  const copyLabel = escapeHtml(t("agent.client.copyCode"));
  const code = escapeHtml(String(token.content || ""));
  return `<div class="assistant-code-block" data-assistant-code-block="1"><button type="button" class="assistant-code-copy-btn" data-copy-code="1" aria-label="${copyLabel}">${copyLabel}</button><pre><code${classAttr}>${code}</code></pre></div>`;
};

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
  FORBID_TAGS: ["img", "script", "style", "iframe", "object", "embed", "form", "input", "textarea", "select", "option", "meta", "link"],
  FORBID_ATTR: ["style"]
};

function stableHash(input: string) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function cacheKeyOf(input: string, namespace = "") {
  return `${namespace}:${input.length}:${stableHash(input)}:${input.slice(0, 24)}`;
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

ensurePurifyHooks();

const safeHtml = ref("");
const toneClass = computed(() => (props.tone === "error" ? "is-error" : ""));

let markdownTimer: number | null = null;
let renderSeq = 0;

function clearMarkdownTimer() {
  if (markdownTimer == null) return;
  window.clearTimeout(markdownTimer);
  markdownTimer = null;
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

async function renderMarkdown() {
  const seq = ++renderSeq;
  const rawText = String(props.text || "");
  const key = cacheKeyOf(rawText, `markdown:${props.sectionKey || "body"}:${locale.value}`);
  const cached = getCacheValue(markdownCache, key);
  if (cached != null) {
    safeHtml.value = cached;
    return;
  }

  const html = markdown.render(rawText);
  const sanitized = DOMPurify.sanitize(html, MARKDOWN_SANITIZE_CONFIG);
  if (seq !== renderSeq) return;
  const safe = typeof sanitized === "string" ? sanitized : String(sanitized);
  safeHtml.value = safe;
  setCacheValue(markdownCache, key, safe, MARKDOWN_CACHE_MAX);
}

async function onCopyCode(code: string) {
  try {
    await navigator.clipboard.writeText(code);
    message.success(t("agent.client.codeCopied"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err || "unknown error");
    message.error(t("common.copyFailed", { reason }));
  }
}

function onMarkdownClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const button = target.closest<HTMLElement>("[data-copy-code='1']");
  if (!button || !rootEl.value?.contains(button)) return;
  const block = button.closest<HTMLElement>("[data-assistant-code-block='1']");
  const codeElement = block?.querySelector<HTMLElement>("pre > code");
  if (!codeElement) return;

  event.preventDefault();
  event.stopPropagation();
  void onCopyCode(codeElement.textContent || "");
}

watch(
  () => [props.text, !!props.streaming] as const,
  () => {
    scheduleMarkdownRender();
  },
  { immediate: true }
);

watch(
  () => locale.value,
  () => {
    scheduleMarkdownRender();
  }
);

onBeforeUnmount(() => {
  clearMarkdownTimer();
  renderSeq += 1;
});
</script>

<style scoped>
.assistant-markdown-message {
  line-height: 1.65;
  /* font-size 由上层消息列表容器提供,统一由 --agent-font-size 控制。 */
  color: var(--text-color);
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
  font-size: 1.05em;
}

.assistant-markdown-message :deep(h2) {
  font-size: 1em;
}

.assistant-markdown-message :deep(h3),
.assistant-markdown-message :deep(h4) {
  font-size: 0.95em;
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

.assistant-markdown-message :deep(.assistant-code-block) {
  position: relative;
  margin: 0.5rem 0;
}

.assistant-markdown-message :deep(.assistant-code-block > pre) {
  margin: 0;
  padding-top: 2rem;
}

.assistant-markdown-message :deep(.assistant-code-copy-btn) {
  position: absolute;
  top: 0.4rem;
  right: 0.45rem;
  border: 1px solid var(--border-color-secondary);
  border-radius: 6px;
  padding: 0.08rem 0.45rem;
  font-size: 0.9em;
  color: var(--text-secondary);
  background: var(--panel-bg-elevated);
  cursor: pointer;
}

.assistant-markdown-message :deep(a[href]) {
  color: rgb(37 99 235);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.assistant-markdown-message :deep(pre code) {
  font-size: 0.9em;
  line-height: 1.5;
  white-space: pre;
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
</style>
