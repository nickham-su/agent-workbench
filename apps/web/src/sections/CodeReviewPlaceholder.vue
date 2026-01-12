<template>
  <a-card size="small" :title="t('codeReview.placeholder.title')">
    <div class="grid gap-2 text-xs text-[color:var(--text-secondary)]">
      <div>{{ t("codeReview.placeholder.desc") }}</div>
      <div v-if="workspace">
        <div>{{ t("codeReview.placeholder.repoLine", { url: workspace.repo.url }) }}</div>
        <div>{{ t("codeReview.placeholder.branchLine", { branch: workspace.checkout.branch }) }}</div>
      </div>
    </div>
  </a-card>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { WorkspaceDetail } from "@agent-workbench/shared";

defineProps<{ workspace: WorkspaceDetail | null }>();
const { t } = useI18n();
</script>
