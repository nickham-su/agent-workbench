<template>
  <a-card size="small" :title="t('codeReview.placeholder.title')">
    <div class="grid gap-2 text-xs text-[color:var(--text-secondary)]">
      <div>{{ t("codeReview.placeholder.desc") }}</div>
      <div>{{ t("codeReview.placeholder.selectRepo") }}</div>
    </div>
  </a-card>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>
