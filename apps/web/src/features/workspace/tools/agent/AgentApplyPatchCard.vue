<template>
  <div>
    <div class="flex flex-col gap-0.5">
      <div
        v-for="(file, idx) in files"
        :key="`${file.path}-${idx}`"
      >
        <div
          class="flex items-center gap-2 min-w-0 flex-wrap w-full pl-2 pr-0 py-0.5 rounded cursor-pointer hover:bg-[var(--hover-bg)] transition-colors duration-100 text-[0.85em] font-mono text-[color:var(--text-secondary)]"
          role="button"
          tabindex="0"
          @click="onPickFile(file.path)"
          @keydown.enter.prevent="onPickFile(file.path)"
          @keydown.space.prevent="onPickFile(file.path)"
        >
          <span class="min-w-0 flex-1 inline-flex items-baseline gap-0"><span class="shrink-0">applypatch(</span><span class="min-w-0 truncate" :title="file.path">{{ file.path }}</span><span class="shrink-0">)</span></span>
          <span class="shrink-0">[+{{ file.additions }} -{{ file.deletions }}]</span>
        </div>

        <div v-if="isExpanded(file.path)">
          <div v-if="loading" class="text-[0.92em] text-[color:var(--text-tertiary)]">
            Loading diff...
          </div>
          <div v-else-if="loadError" class="text-[0.92em] text-red-500">
            diff unavailable: {{ loadError }}
          </div>
          <div v-else-if="diffByPath.get(file.path)" class="rounded border border-[var(--border-color-secondary)] overflow-hidden">
            <MonacoDiffViewer
              :original="diffByPath.get(file.path)?.before || ''"
              :modified="diffByPath.get(file.path)?.after || ''"
              :language="inferLanguageFromPath(file.path)"
              :sideBySide="false"
              :showOverviewRuler="false"
              :compactMode="true"
              :hideUnchangedRegions="{ enabled: true, contextLineCount: 1, minimumLineCount: 1, revealLineCount: 1 }"
              :autoHeight="true"
              :minHeight="72"
              :ignoreTrimWhitespace="true"
            />
          </div>
        </div>
      </div>
    </div>

    <div v-if="errorText" class="pl-2 pr-0 text-[0.92em] text-red-500 py-0.5">error: {{ errorText }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import MonacoDiffViewer from "@/shared/components/MonacoDiffViewer.vue";
import { inferLanguageFromPath } from "@/shared/monaco/languageUtils";

type ApplyPatchFileMeta = {
  type: "add" | "update" | "delete" | "move";
  path: string;
  fromPath?: string;
  additions: number;
  deletions: number;
};

type ApplyPatchSummary = {
  fileCount: number;
  additions: number;
  deletions: number;
};

type ApplyPatchUiArtifactFile = ApplyPatchFileMeta & {
  before: string;
  after: string;
};

type ApplyPatchUiArtifact = {
  schemaVersion: number;
  toolName: string;
  workspaceId: string;
  toolCallId: string;
  createdAt: number;
  summary: ApplyPatchSummary;
  files: ApplyPatchUiArtifactFile[];
};

const props = defineProps<{
  workspaceId: string;
  sessionId: string;
  itemId: number;
  toolCallId?: string;
  summary: ApplyPatchSummary;
  files: ApplyPatchFileMeta[];
  omittedFiles: number;
  errorText?: string;
}>();

const emit = defineEmits<{
  "request-measure": [];
}>();

type CacheEntry = {
  expandedPaths: string[];
  artifact: ApplyPatchUiArtifact | null;
  loading: boolean;
  error: string;
  promise: Promise<ApplyPatchUiArtifact> | null;
};

// 模块级缓存: 虚拟列表 unmount/remount 后保留展开状态与 diff 数据。
// key 使用 workspaceId+toolCallId,避免不同会话/工作区的 toolCallId 冲突串数据。
const cache = new Map<string, CacheEntry>();

function cacheKey(workspaceId: string, toolCallId: string) {
  return `${workspaceId}:${toolCallId}`;
}

function touchLru(key: string, value: CacheEntry) {
  // 简易 LRU: 访问时移动到 Map 尾部。
  cache.delete(key);
  cache.set(key, value);
  const MAX = 16;
  while (cache.size > MAX) {
    const first = cache.keys().next().value as string | undefined;
    if (!first) break;
    cache.delete(first);
  }
}

function ensureEntry(key: string): CacheEntry {
  const existing = cache.get(key);
  if (existing) return existing;
  const next: CacheEntry = { expandedPaths: [], artifact: null, loading: false, error: "", promise: null };
  cache.set(key, next);
  return next;
}

const expandedPaths = ref<string[]>([]);
const loading = ref(false);
const loadError = ref("");
const artifact = ref<ApplyPatchUiArtifact | null>(null);

function isExpanded(pathValue: string) {
  return expandedPaths.value.includes(pathValue);
}

const diffByPath = computed(() => {
  const map = new Map<string, ApplyPatchUiArtifactFile>();
  const art = artifact.value;
  if (!art) return map;
  for (const file of art.files) {
    map.set(file.path, file);
  }
  return map;
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
    const url = `/api/agent/sessions/${encodeURIComponent(props.sessionId)}/context-items/${props.itemId}/apply-patch-artifact`;
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `http ${response.status}`);
    }
    return (await response.json()) as ApplyPatchUiArtifact;
  })();

  try {
    const res = await entry.promise;
    // 保护性校验,避免缓存串数据。
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

async function onPickFile(pathValue: string) {
  const p = String(pathValue || "").trim();
  if (!p) return;

  const next = new Set(expandedPaths.value);
  const isOpen = next.has(p);
  if (isOpen) {
    next.delete(p);
  } else {
    next.add(p);
  }
  expandedPaths.value = Array.from(next);

  if (props.toolCallId) {
    const key = cacheKey(props.workspaceId, props.toolCallId);
    const entry = ensureEntry(key);
    touchLru(key, entry);
    entry.expandedPaths = expandedPaths.value;
  }

  await nextTick();
  emit("request-measure");

  if (isOpen) return;

  if (props.toolCallId) {
    const key = cacheKey(props.workspaceId, props.toolCallId);
    await loadArtifact(key, props.toolCallId);
  } else {
    loadError.value = "missing toolCallId";
  }

  await nextTick();
  emit("request-measure");
}

onMounted(() => {
  if (!props.toolCallId) return;
  const key = cacheKey(props.workspaceId, props.toolCallId);
  const entry = ensureEntry(key);
  touchLru(key, entry);
  expandedPaths.value = Array.isArray(entry.expandedPaths) ? entry.expandedPaths : [];
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
    expandedPaths.value = Array.isArray(entry.expandedPaths) ? entry.expandedPaths : [];
    artifact.value = entry.artifact;
    loadError.value = entry.error;
  }
);
</script>
