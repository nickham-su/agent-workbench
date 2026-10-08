<template><span class="status" :class="`status-${status}`"><span class="status-dot" aria-hidden="true" />{{ t(`dashboard.status.${status}`) }}</span></template>
<script setup lang="ts">
import { useI18n } from "vue-i18n";
type DisplayStatus = "available" | "partial" | "unavailable" | "healthy" | "degraded" | "stale" | "disabled";
defineProps<{ status: DisplayStatus }>();
const { t } = useI18n();
</script>
<style scoped>.status{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-size:11px;line-height:18px;color:var(--text-color-secondary)}.status-dot{display:inline-block;flex:none;width:6px;height:6px;border-radius:50%;background:#8c8c8c}.status-healthy,.status-available{color:#95de64}.status-healthy .status-dot,.status-available .status-dot{background:#95de64}.status-partial,.status-degraded,.status-stale{color:#e7b75b}.status-partial .status-dot,.status-degraded .status-dot,.status-stale .status-dot{background:#e7b75b}.status-unavailable{color:#ff7875}.status-unavailable .status-dot{background:#ff7875}</style>
