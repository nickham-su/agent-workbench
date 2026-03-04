<template>
  <div class="rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-2">
    <div class="flex items-center justify-between gap-2">
      <div class="text-[12px] font-semibold">
        apply_patch
      </div>
      <div class="text-[11px] text-[color:var(--text-tertiary)]">
        files: {{ summary.fileCount }}
        <span class="inline-block w-2" />
        +{{ summary.additions }}
        <span class="inline-block w-1" />
        -{{ summary.deletions }}
        <span v-if="omittedFiles > 0" class="inline-block w-2" />
        <span v-if="omittedFiles > 0">(+{{ omittedFiles }} omitted)</span>
      </div>
    </div>

    <div v-if="errorText" class="pt-1 text-[12px] text-red-500">
      Error: {{ errorText }}
    </div>

    <div class="pt-2">
      <div class="text-[11px] text-[color:var(--text-tertiary)] pb-1">Files</div>
      <!--
        用 antd 按钮替代原生 button:
        - Tailwind 关闭 preflight 时,原生 button 会保留 UA 默认背景(暗色主题下尤其明显)
        - 这里改成小号按钮,从左到右排列,不足自动换行
      -->
      <div class="flex flex-wrap gap-1">
        <a-button
          v-for="(file, idx) in files"
          :key="`${file.path}-${idx}`"
          size="small"
          :type="selectedPath === file.path ? 'primary' : 'default'"
          class="!max-w-full !inline-flex !items-center !gap-2 !px-2"
          :title="file.path"
          @click="onPickFile(file.path)"
        >
          <span class="font-mono text-[10px] opacity-70">{{ file.type }}</span>
          <span class="min-w-0 max-w-[42ch] truncate text-[12px] font-medium">{{ file.path }}</span>
          <span class="text-[11px] opacity-70 whitespace-nowrap">+{{ file.additions }} -{{ file.deletions }}</span>
        </a-button>
      </div>
    </div>

    <div v-if="selectedPath" class="pt-2">
      <div class="flex items-center justify-between gap-2">
        <div class="text-[11px] text-[color:var(--text-tertiary)] break-all">
          Diff: {{ selectedPath }}
        </div>
        <a-button size="small" type="text" class="!px-2" @click="onClose">
          Close
        </a-button>
      </div>

      <div v-if="loading" class="pt-2 text-[12px] text-[color:var(--text-tertiary)]">
        Loading diff...
      </div>
      <div v-else-if="loadError" class="pt-2 text-[12px] text-red-500">
        diff unavailable: {{ loadError }}
      </div>
      <div v-else-if="selectedDiff" class="pt-2 rounded border border-[var(--border-color-secondary)] overflow-hidden">
        <MonacoDiffViewer
          :original="selectedDiff.before"
          :modified="selectedDiff.after"
          :language="inferLanguageFromPath(selectedDiff.path)"
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
  selectedPath: string;
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
  const next: CacheEntry = { selectedPath: "", artifact: null, loading: false, error: "", promise: null };
  cache.set(key, next);
  return next;
}

const selectedPath = ref("");
const loading = ref(false);
const loadError = ref("");
const artifact = ref<ApplyPatchUiArtifact | null>(null);

const selectedDiff = computed(() => {
  const art = artifact.value;
  const p = selectedPath.value;
  if (!art || !p) return null;
  return art.files.find((f) => f.path === p) ?? null;
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

  // toggle
  if (selectedPath.value === p) {
    onClose();
    return;
  }

  selectedPath.value = p;
  if (props.toolCallId) {
    const key = cacheKey(props.workspaceId, props.toolCallId);
    const entry = ensureEntry(key);
    touchLru(key, entry);
    entry.selectedPath = p;
  }

  await nextTick();
  emit("request-measure");

  if (props.toolCallId) {
    const key = cacheKey(props.workspaceId, props.toolCallId);
    await loadArtifact(key, props.toolCallId);
  } else {
    loadError.value = "missing toolCallId";
  }

  await nextTick();
  emit("request-measure");
}

async function onClose() {
  selectedPath.value = "";
  loadError.value = "";
  if (props.toolCallId) {
    const key = cacheKey(props.workspaceId, props.toolCallId);
    const entry = ensureEntry(key);
    touchLru(key, entry);
    entry.selectedPath = "";
  }
  await nextTick();
  emit("request-measure");
}

onMounted(() => {
  if (!props.toolCallId) return;
  const key = cacheKey(props.workspaceId, props.toolCallId);
  const entry = ensureEntry(key);
  touchLru(key, entry);
  selectedPath.value = entry.selectedPath;
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
    selectedPath.value = entry.selectedPath;
    artifact.value = entry.artifact;
    loadError.value = entry.error;
  }
);
</script>
