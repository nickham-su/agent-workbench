<template>
  <div class="flex flex-col gap-2">
    <div
      v-for="(file, index) in files"
      :key="`${file.path}-${index}`"
    >
      <div class="text-[12px] font-medium break-all">{{ file.path }}</div>
      <div class="mt-1 rounded border border-[var(--border-color-secondary)] overflow-hidden">
        <MonacoDiffViewer
          :original="file.before"
          :modified="file.after"
          :language="inferLanguageFromPath(file.path)"
          :sideBySide="false"
          :showOverviewRuler="false"
          :compactMode="true"
          :hideUnchangedRegions="{ enabled: true, contextLineCount: 1, minimumLineCount: 1, revealLineCount: 1 }"
          :autoHeight="true"
          :minHeight="72"
          :maxHeight="420"
          :ignoreTrimWhitespace="true"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import MonacoDiffViewer from "@/shared/components/MonacoDiffViewer.vue";
import { inferLanguageFromPath } from "@/shared/monaco/languageUtils";

type ApplyPatchFileView = {
  type: "add" | "update" | "delete" | "move";
  path: string;
  fromPath?: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
};

defineProps<{
  files: ApplyPatchFileView[];
}>();
</script>

<style scoped>
:deep(.diff-hidden-lines-compact .text) {
  display: none !important;
}
</style>
