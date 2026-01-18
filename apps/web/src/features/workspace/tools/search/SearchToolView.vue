<template>
  <div class="h-full min-h-0 flex flex-col">
    <div v-if="!target" class="flex-1 min-h-0 flex items-center justify-center text-xs text-[color:var(--text-tertiary)]">
      {{ t("search.placeholder.selectRepo") }}
    </div>

    <div v-else class="flex-1 min-h-0 flex flex-col gap-2 px-3 py-3">
      <div class="flex items-center gap-2">
        <a-input
          v-model:value="query"
          :placeholder="t('search.placeholder.query')"
          @pressEnter="runSearch"
        />
        <a-button type="primary" size="small" :loading="loading" :disabled="!canSearch" @click="runSearch">
          {{ t("search.actions.search") }}
        </a-button>
      </div>

      <div class="flex items-center gap-4 text-xs text-[color:var(--text-tertiary)]">
        <a-checkbox v-model:checked="useRegex">{{ t("search.options.regex") }}</a-checkbox>
        <a-checkbox v-model:checked="caseSensitive">{{ t("search.options.caseSensitive") }}</a-checkbox>
        <a-checkbox v-model:checked="wholeWord">{{ t("search.options.wholeWord") }}</a-checkbox>
        <span>{{ t("search.hint.ignore") }} · {{ t("search.hint.hidden") }}</span>
      </div>

      <div class="flex-1 min-h-0 flex flex-col border border-[var(--border-color-secondary)] rounded overflow-hidden">
        <div class="px-3 py-2 text-xs text-[color:var(--text-tertiary)] border-b border-[var(--border-color-secondary)]">
          {{ summaryLabel }}
          <span v-if="truncated" class="ml-2 text-[color:var(--warning-color)]">{{ t("search.status.truncated") }}</span>
          <span v-if="timedOut" class="ml-2 text-[color:var(--warning-color)]">{{ t("search.status.timedOut") }}</span>
        </div>
        <div class="flex-1 min-h-0 overflow-auto px-3 py-2">
          <div v-if="error" class="text-xs text-[color:var(--danger-color)]">
            {{ error }}
          </div>
          <div v-else-if="!loading && matches.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
            {{ t("search.status.empty") }}
          </div>
          <div v-else class="space-y-4">
            <div v-for="group in blockGroups" :key="group.path" class="space-y-3">
              <div class="text-xs font-mono text-[color:var(--text-secondary)]">{{ group.path }}</div>
              <div v-for="block in group.blocks" :key="blockKey(block)" class="rounded border border-[var(--border-color-secondary)]">
                <div
                  class="px-2 py-1 text-[11px] text-[color:var(--text-tertiary)] border-b border-[var(--border-color-secondary)] flex items-center gap-2"
                >
                  <span>{{ block.fromLine }} - {{ block.toLine }}</span>
                  <a-button type="link" size="small" class="h-auto p-0 !text-xs" @click="openBlock(block)">打开</a-button>
                </div>
                <div class="font-mono text-[12px] leading-5">
                  <div
                    v-for="line in block.lines"
                    :key="line.line"
                    class="px-2 flex gap-3 items-start"
                    :class="isHitLine(block, line) ? 'bg-[var(--panel-bg-elevated)]' : ''"
                  >
                    <div class="w-10 shrink-0 text-[color:var(--text-tertiary)] text-right">
                      {{ line.line }}
                    </div>
                    <div class="flex-1 whitespace-pre-wrap break-all">
                      <template v-if="line.hits && line.hits.length > 0">
                        <span v-for="part in splitLineByHits(line.text, line.hits)" :key="part.key">
                          <span v-if="part.hit" class="search-hit">{{ part.text }}</span>
                          <span v-else class="text-[color:var(--text-secondary)]">{{ part.text }}</span>
                        </span>
                      </template>
                      <span v-else class="text-[color:var(--text-secondary)]">{{ line.text }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick } from "vue";
import { message } from "ant-design-vue";
import { useI18n } from "vue-i18n";
import type { FileSearchBlock, GitTarget } from "@agent-workbench/shared";
import { searchFiles } from "@/shared/api";
import { useWorkspaceHost } from "@/features/workspace/host";
import { getSearchStore } from "./store";

const props = defineProps<{ workspaceId: string; target: GitTarget | null; toolId: string }>();
const { t } = useI18n();
const host = useWorkspaceHost(props.toolId);
const store = getSearchStore(props.workspaceId);

const query = store.query;
const useRegex = store.useRegex;
const caseSensitive = store.caseSensitive;
const wholeWord = store.wholeWord;
const matches = store.matches;
const blocks = store.blocks;
const loading = store.loading;
const error = store.error;
const truncated = store.truncated;
const timedOut = store.timedOut;
const tookMs = store.tookMs;
const canSearch = computed(() => Boolean(props.target) && Boolean(query.value.trim()));

const summaryLabel = computed(() => {
  if (loading.value) return t("search.status.searching");
  if (error.value) return t("search.status.error");
  if (matches.value.length === 0) return t("search.status.empty");
  return t("search.status.results", { count: matches.value.length, tookMs: tookMs.value ?? 0 });
});

const blockGroups = computed(() => {
  const grouped = new Map<string, FileSearchBlock[]>();
  for (const block of blocks.value) {
    const list = grouped.get(block.path) ?? [];
    list.push(block);
    grouped.set(block.path, list);
  }
  return Array.from(grouped.entries()).map(([path, list]) => ({ path, blocks: list }));
});

function blockKey(block: FileSearchBlock) {
  return `${block.path}:${block.fromLine}:${block.toLine}`;
}

function splitLineByHits(
  lineText: string,
  hits: Array<{ kind: "range"; startCol: number; endCol: number }>
) {
  const sorted = hits.slice().sort((a, b) => a.startCol - b.startCol);
  const parts: Array<{ key: string; text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const hit of sorted) {
    const start = Math.max(hit.startCol - 1, cursor);
    const end = Math.max(hit.endCol - 1, start);
    if (start > cursor) {
      parts.push({ key: `text-${cursor}-${start}`, text: lineText.slice(cursor, start), hit: false });
    }
    if (end > start) {
      parts.push({ key: `hit-${start}-${end}`, text: lineText.slice(start, end), hit: true });
    }
    cursor = end;
  }
  if (cursor < lineText.length) {
    parts.push({ key: `tail-${cursor}`, text: lineText.slice(cursor), hit: false });
  }
  return parts;
}

function isHitLine(block: FileSearchBlock, line: FileSearchBlock["lines"][number]) {
  return block.hitLines.includes(line.line);
}

async function openBlock(block: FileSearchBlock) {
  const hitLine = block.hitLines.length > 0 ? Math.min(...block.hitLines) : block.fromLine;
  const line = block.lines.find((item) => item.line === hitLine);
  const highlight =
    line?.hits && line.hits.length > 0
      ? { kind: "range" as const, startCol: line.hits[0].startCol, endCol: line.hits[0].endCol }
      : { kind: "line" as const };
  host.openTool("files");
  await nextTick();
  host.call("files", {
    type: "files.openAt",
    payload: {
      path: block.path,
      line: hitLine,
      highlight
    }
  });
}

async function runSearch() {
  if (!props.target) return;
  const q = query.value.trim();
  if (!q) {
    message.warning(t("search.placeholder.queryEmpty"));
    return;
  }
  const seq = store.nextRequestSeq();
  store.resetResults();
  loading.value = true;
  try {
    const res = await searchFiles({
      target: props.target,
      query: q,
      useRegex: useRegex.value,
      caseSensitive: caseSensitive.value,
      wholeWord: wholeWord.value || undefined
    });
    if (seq !== store.requestSeq.value) return;
    matches.value = res.matches;
    blocks.value = res.blocks;
    truncated.value = res.truncated;
    timedOut.value = res.timedOut;
    tookMs.value = res.tookMs;
  } catch (err) {
    if (seq !== store.requestSeq.value) return;
    error.value = err instanceof Error ? err.message : String(err);
    matches.value = [];
    blocks.value = [];
  } finally {
    if (seq === store.requestSeq.value) loading.value = false;
  }
}

</script>

<style scoped>
.search-hit {
  background: rgba(255, 214, 102, 0.45);
}
</style>
