<template>
  <article class="metric-card" :class="{ selected, clickable }" :data-testid="testId">
    <button v-if="clickable" class="metric-button" type="button" :aria-pressed="selected" @click="$emit('select')">
      <span class="metric-title">{{ title }}</span><strong class="metric-value">{{ value }}</strong><DashboardStatusBadge :status="result.status" /><small>{{ comparisonLabel }}</small><small v-if="reason">{{ t(`dashboard.reason.${reason}`) }}</small>
    </button>
    <template v-else><span class="metric-title">{{ title }}</span><strong class="metric-value">{{ value }}</strong><DashboardStatusBadge :status="result.status" /><small>{{ comparisonLabel }}</small><small v-if="reason">{{ t(`dashboard.reason.${reason}`) }}</small></template>
  </article>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { MetricResult } from "@agent-workbench/shared";
import { formatComparison, resultReason, type ResultReason } from "../dashboard-formatters";
import DashboardStatusBadge from "./DashboardStatusBadge.vue";
const props = defineProps<{ title: string; value: string; result: MetricResult<unknown>; selected?: boolean; clickable?: boolean; testId?: string }>();
defineEmits<{ select: [] }>();
const { t, locale } = useI18n();
const reason = computed<ResultReason | null>(() => props.result.status === "partial" || props.result.status === "unavailable" ? resultReason(props.result) : null);
const comparisonLabel = computed(() => props.result.comparison.status === "available" ? formatComparison(props.result.comparison, locale.value) : t(`dashboard.comparison.${props.result.comparison.status}`));
</script>
<style scoped>.metric-card{min-width:0;background:var(--panel-bg-elevated);border:1px solid var(--border-color);border-radius:8px;padding:14px;display:grid;gap:6px}.metric-card.selected{border-color:var(--primary-color);box-shadow:0 0 0 1px var(--primary-color)}.metric-button{all:unset;display:grid;gap:6px;cursor:pointer}.metric-button:focus-visible{outline:2px solid var(--primary-color);border-radius:4px}.metric-title,small{color:var(--text-color-secondary);font-size:12px}.metric-value{font-size:23px;line-height:1.2}</style>
