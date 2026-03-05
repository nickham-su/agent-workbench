<template>
  <div class="py-0.5 pl-2">
    <div class="flex items-center gap-2 min-w-0 text-[12px] leading-5 flex-wrap">
      <span class="font-semibold shrink-0">write</span>
      <span class="font-mono text-[11px] text-[color:var(--text-secondary)] min-w-0 max-w-[60%] truncate">{{ summary.filePath }}</span>
      <span class="shrink-0 text-[11px] text-[color:var(--text-tertiary)]">{{ summary.bytesWritten }} bytes</span>
      <span v-if="errorText" class="min-w-0 max-w-[30%] truncate text-[11px] text-red-500">error: {{ errorText }}</span>
      <a-button size="small" type="text" class="shrink-0 !px-1" @click="onToggleExpand">
        {{ expanded ? "收起" : "查看" }}
      </a-button>
    </div>

    <div v-if="expanded" class="pt-2">
      <div v-if="loading" class="text-[12px] text-[color:var(--text-tertiary)]">Loading diff...</div>
      <div v-else-if="loadError" class="text-[12px] text-red-500">diff unavailable: {{ loadError }}</div>
      <template v-else-if="artifact">
        <div v-if="showCreateFileContent" class="rounded border border-[var(--border-color-secondary)] overflow-hidden">
          <div class="px-2 py-1 text-[11px] text-[color:var(--text-tertiary)] border-b border-[var(--border-color-secondary)]">
            New file content
          </div>
          <MonacoCodeViewer
            :value="artifact.after.text || ''"
            :language="inferLanguageFromPath(summary.filePath)"
            :read-only="true"
            :auto-height="true"
            :min-height="72"
          />
        </div>
        <div v-else-if="!canRenderDiff" class="text-[12px] text-[color:var(--text-tertiary)]">diff unavailable</div>
        <div v-else class="rounded border border-[var(--border-color-secondary)] overflow-hidden">
          <MonacoDiffViewer
            :original="artifact.before.text || ''"
            :modified="artifact.after.text || ''"
            :language="inferLanguageFromPath(summary.filePath)"
            :sideBySide="false"
            :showOverviewRuler="false"
            :compactMode="true"
            :hideUnchangedRegions="{ enabled: true, contextLineCount: 1, minimumLineCount: 1, revealLineCount: 1 }"
            :autoHeight="true"
            :minHeight="72"
            :ignoreTrimWhitespace="true"
          />
        </div>
        <div v-if="truncatedHint" class="pt-1 text-[11px] text-[color:var(--text-tertiary)]">{{ truncatedHint }}</div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import MonacoDiffViewer from "@/shared/components/MonacoDiffViewer.vue";
import MonacoCodeViewer from "@/shared/components/MonacoCodeViewer.vue";
import { inferLanguageFromPath } from "@/shared/monaco/languageUtils";

type WriteDisplay = {
  summary: string;
  filePath: string;
  bytesWritten: number;
  existedBefore: boolean;
};

type WriteUiArtifactSide = {
  available: boolean;
  text?: string;
  truncated: boolean;
  bytes: number;
  reason?: string;
};

type WriteUiArtifact = {
  schemaVersion: number;
  toolName: string;
  workspaceId: string;
  toolCallId: string;
  createdAt: number;
  filePath: string;
  summary: {
    bytesWritten: number;
    existedBefore: boolean;
  };
  before: WriteUiArtifactSide;
  after: WriteUiArtifactSide;
};

const props = defineProps<{
  workspaceId: string;
  sessionId: string;
  itemId: number;
  toolCallId?: string;
  summary: WriteDisplay;
  errorText?: string;
}>();

const emit = defineEmits<{
  "request-measure": [];
}>();

type CacheEntry = {
  expanded: boolean;
  artifact: WriteUiArtifact | null;
  loading: boolean;
  error: string;
  promise: Promise<WriteUiArtifact> | null;
};

const cache = new Map<string, CacheEntry>();

function cacheKey(workspaceId: string, toolCallId: string) {
  return `${workspaceId}:${toolCallId}`;
}

function touchLru(key: string, value: CacheEntry) {
  cache.delete(key);
  cache.set(key, value);
  const MAX = 24;
  while (cache.size > MAX) {
    const first = cache.keys().next().value as string | undefined;
    if (!first) break;
    cache.delete(first);
  }
}

function ensureEntry(key: string): CacheEntry {
  const existing = cache.get(key);
  if (existing) return existing;
  const next: CacheEntry = { expanded: false, artifact: null, loading: false, error: "", promise: null };
  cache.set(key, next);
  return next;
}

const expanded = ref(false);
const loading = ref(false);
const loadError = ref("");
const artifact = ref<WriteUiArtifact | null>(null);

const canRenderDiff = computed(() => artifact.value?.before?.available === true && artifact.value?.after?.available === true);

const showCreateFileContent = computed(() => {
  const art = artifact.value;
  if (!art || art.after?.available !== true) return false;
  if (art.before?.available === true) return false;
  const reason = typeof art.before?.reason === "string" ? art.before.reason.trim() : "";
  return props.summary.existedBefore === false || reason === "missing_file";
});

const truncatedHint = computed(() => {
  const afterTruncated = artifact.value?.after?.truncated === true;
  if (showCreateFileContent.value) {
    return afterTruncated ? "文件内容已截断,仅展示前缀" : "";
  }
  const beforeTruncated = artifact.value?.before?.truncated === true;
  if (!beforeTruncated && !afterTruncated) return "";
  return "diff 内容已截断,仅展示前缀";
});

async function loadArtifact(key: string, toolCallId: string) {
  const entry = ensureEntry(key);
  touchLru(key, entry);
  if (entry.artifact) {
    artifact.value = entry.artifact;
    loading.value = false;
    loadError.value = "";
    return;
  }
  if (entry.promise) {
    loading.value = true;
    loadError.value = "";
    try {
      const res = await entry.promise;
      artifact.value = res;
      return;
    } finally {
      loading.value = false;
    }
  }

  entry.loading = true;
  entry.error = "";
  loading.value = true;
  loadError.value = "";

  entry.promise = (async () => {
    const url = `/api/agent/sessions/${encodeURIComponent(props.sessionId)}/context-items/${props.itemId}/write-artifact`;
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `http ${response.status}`);
    }
    return (await response.json()) as WriteUiArtifact;
  })();

  try {
    const res = await entry.promise;
    if (res.toolCallId !== toolCallId || res.workspaceId !== props.workspaceId) {
      throw new Error("artifact mismatch");
    }
    entry.artifact = res;
    artifact.value = res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    entry.error = message;
    loadError.value = message;
  } finally {
    entry.loading = false;
    entry.promise = null;
    loading.value = false;
  }
}

async function onToggleExpand() {
  const next = !expanded.value;
  expanded.value = next;
  if (props.toolCallId) {
    const key = cacheKey(props.workspaceId, props.toolCallId);
    const entry = ensureEntry(key);
    touchLru(key, entry);
    entry.expanded = next;
  }

  await nextTick();
  emit("request-measure");

  if (!next) return;
  if (!props.toolCallId) {
    loadError.value = "missing toolCallId";
    return;
  }
  const key = cacheKey(props.workspaceId, props.toolCallId);
  await loadArtifact(key, props.toolCallId);

  await nextTick();
  emit("request-measure");
}

onMounted(() => {
  if (!props.toolCallId) return;
  const key = cacheKey(props.workspaceId, props.toolCallId);
  const entry = ensureEntry(key);
  touchLru(key, entry);
  expanded.value = entry.expanded;
  artifact.value = entry.artifact;
  loadError.value = entry.error;
});

watch(
  () => props.toolCallId,
  (next) => {
    if (!next) return;
    const key = cacheKey(props.workspaceId, next);
    const entry = ensureEntry(key);
    touchLru(key, entry);
    expanded.value = entry.expanded;
    artifact.value = entry.artifact;
    loadError.value = entry.error;
  }
);
</script>
