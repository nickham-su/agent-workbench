<template>
  <p class="empty-value" role="note" :aria-label="t('dashboard.emptyValue')">—</p>
</template>
<script setup lang="ts">
import { useI18n } from "vue-i18n";
const { t } = useI18n();
</script>
<style scoped>
.empty-value{margin:12px 0;color:var(--text-color-secondary);font-size:14px}
</style>
