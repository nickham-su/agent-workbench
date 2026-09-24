<template>
  <article class="metric-card" :class="{ selected }" :data-testid="testId">
    <button type="button" :aria-pressed="selected" @click="$emit('select')">
      <span class="metric-head"><span class="metric-title">{{ title }}</span></span>
      <strong :aria-label="numericLabel">{{ numericLabel }}</strong>
      <span v-if="comparisonLabel" class="metric-foot">{{ comparisonLabel }}</span>
    </button>
  </article>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { DashboardData } from "@agent-workbench/shared";
import { formatComparison } from "../dashboard-formatters";
type GitMetric = DashboardData["git"]["metrics"][keyof DashboardData["git"]["metrics"]] | DashboardData["overview"]["gitCommits"];
const props = defineProps<{ title: string; value: string; result: GitMetric; selected: boolean; testId?: string }>();
defineEmits<{ select: [] }>();
const { locale } = useI18n();
// A partial Git count is a lower bound, never an exact total.
const numericLabel = computed(() => props.result.status === "unavailable" ? "—" : props.result.status === "partial" && props.value !== "—" ? `≥${props.value}` : props.value);
const comparisonLabel = computed(() => props.result.status === "available" && props.result.comparison.status === "available" ? formatComparison(props.result.comparison, locale.value) : "");
</script>
<style scoped>
.metric-card{min-width:0;min-height:112px;background:var(--panel-bg-elevated);border:1px solid var(--border-color-secondary);border-radius:3px;overflow:hidden}.metric-card.selected{border-color:#1677ff;box-shadow:inset 0 0 0 1px #1677ff}.metric-card:hover{border-color:var(--border-color)}button{box-sizing:border-box;background:transparent;border:0;color:inherit;font:inherit;text-align:left;width:100%;height:100%;padding:12px 13px 10px;display:flex;flex-direction:column;cursor:pointer}button:focus-visible{outline:2px solid #69b1ff;outline-offset:-3px}.metric-head{display:flex;align-items:center;justify-content:space-between;gap:5px;min-width:0}.metric-title{font-size:12px;color:var(--text-color-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}strong{margin-top:13px;font-size:25px;line-height:30px;font-variant-numeric:tabular-nums}.metric-foot{display:flex;align-items:center;gap:6px;margin-top:auto;padding-top:5px;color:var(--text-color-secondary);min-width:0;font-size:11px}
</style>
