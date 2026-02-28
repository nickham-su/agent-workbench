<template>
  <div class="patch-card rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-2">
    <div class="flex items-center gap-2">
      <div class="text-[12px] font-semibold">{{ t("agent.client.applyPatchCardTitle") }}</div>
      <a-tag color="default" class="!m-0 !text-[10px] !leading-[16px] !px-1 !py-0">{{ status }}</a-tag>
      <a-tag v-if="status === 'awaiting_permission'" color="blue" class="!m-0 !text-[10px] !leading-[16px] !px-1 !py-0">
        {{ t("agent.client.applyPatchPreview") }}
      </a-tag>
      <a-tag
        v-else-if="status === 'completed'"
        color="green"
        class="!m-0 !text-[10px] !leading-[16px] !px-1 !py-0"
      >
        {{ t("agent.client.applyPatchApplied") }}
      </a-tag>
    </div>
    <div class="pt-0.5 text-[12px] text-[color:var(--text-secondary)]">
      {{ t("agent.client.applyPatchFileCount") }}: {{ summary.fileCount }}
      <span class="inline-block w-3" />
      {{ t("agent.client.applyPatchLineStats") }}: +{{ summary.additions }} / -{{ summary.deletions }}
    </div>
    <div v-if="text" class="pt-0.5 text-[12px] text-[color:var(--text-secondary)] whitespace-pre-wrap break-words">
      {{ text }}
    </div>
    <div v-if="errorText" class="pt-0.5 text-[12px] text-red-500 whitespace-pre-wrap break-words">
      error: {{ errorText }}
    </div>

    <div v-if="files.length === 0" class="pt-2 text-[12px] text-[color:var(--text-tertiary)]">
      {{ t("agent.client.applyPatchNoFiles") }}
    </div>

    <div v-else class="pt-2 flex flex-col gap-2">
      <div
        v-for="(file, index) in files"
        :key="`${file.path}-${index}`"
        class="rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg)] p-2"
      >
        <div class="text-[12px] font-medium break-all">
          <span class="inline-flex items-center rounded border border-[var(--border-color-secondary)] px-1 py-0 text-[10px] mr-1.5">
            {{ fileTypeLabel(file.type) }}
          </span>
          {{ file.path }}
        </div>
        <div v-if="file.fromPath" class="pt-0.5 text-[11px] text-[color:var(--text-tertiary)] break-all">
          {{ t("agent.client.applyPatchFrom") }}: {{ file.fromPath }}
        </div>
        <div class="pt-0.5 text-[11px] text-[color:var(--text-tertiary)]">+{{ file.additions }} / -{{ file.deletions }}</div>
        <div class="mt-1 h-48 rounded border border-[var(--border-color-secondary)] overflow-hidden">
          <MonacoDiffViewer
            class="h-full"
            :original="file.before"
            :modified="file.after"
            :language="inferLanguageFromPath(file.path)"
            :sideBySide="false"
            :ignoreTrimWhitespace="true"
          />
        </div>
      </div>
      <div v-if="omittedFiles > 0" class="text-[11px] text-[color:var(--text-tertiary)]">
        {{ t("agent.client.applyPatchOmittedFiles", { count: omittedFiles }) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
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
  status: string;
  text: string;
  errorText?: string;
  summary: {
    fileCount: number;
    additions: number;
    deletions: number;
  };
  files: ApplyPatchFileView[];
  omittedFiles: number;
}>();

const { t } = useI18n();

function fileTypeLabel(type: ApplyPatchFileView["type"]) {
  if (type === "add") return "A";
  if (type === "delete") return "D";
  if (type === "move") return "R";
  return "M";
}
</script>
