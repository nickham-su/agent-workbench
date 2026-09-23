<template><span class="status" :class="`status-${status}`">{{ t(`dashboard.status.${status}`) }}</span></template>
<script setup lang="ts">
import { useI18n } from "vue-i18n";
type DisplayStatus = "available" | "partial" | "unavailable" | "healthy" | "degraded" | "stale" | "disabled";
defineProps<{ status: DisplayStatus }>();
const { t } = useI18n();
</script>
<style scoped>.status{display:inline-block;border-radius:999px;padding:2px 7px;font-size:11px;color:#fff;background:#64748b}.status-available,.status-healthy{background:#26734d}.status-partial,.status-degraded,.status-stale{background:#9a6700}.status-unavailable,.status-disabled{background:#a33}</style>
