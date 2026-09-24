<template>
  <article class="metric-card" :class="{ selected, clickable }" :data-testid="testId">
    <button v-if="clickable" class="metric-button" type="button" :aria-pressed="selected" @click="$emit('select')">
      <span class="metric-head"><span class="metric-title">{{ title }}</span></span>
      <strong class="metric-value">{{ result.status === 'unavailable' ? '—' : value }}</strong>
      <span v-if="comparisonLabel" class="metric-foot"><span :class="comparisonClass">{{ comparisonLabel }}</span></span>
    </button>
    <div v-else class="metric-static">
      <span class="metric-head"><span class="metric-title">{{ title }}</span></span>
      <strong class="metric-value">{{ result.status === 'unavailable' ? '—' : value }}</strong>
      <span v-if="comparisonLabel" class="metric-foot"><span :class="comparisonClass">{{ comparisonLabel }}</span></span>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { MetricResult } from "@agent-workbench/shared";
import { formatComparison } from "../dashboard-formatters";
const props = defineProps<{ title: string; value: string; result: MetricResult<unknown>; selected?: boolean; clickable?: boolean; testId?: string }>();
defineEmits<{ select: [] }>();
const { locale } = useI18n();
const comparisonLabel = computed(() => props.result.status === "available" && props.result.comparison.status === "available" ? formatComparison(props.result.comparison, locale.value) : "");
const comparisonClass = computed(() => props.result.status === "available" && props.result.comparison.status === "available" ? ((props.result.comparison.delta ?? 0) >= 0 ? "comparison-positive" : "comparison-negative") : "");
</script>
<style scoped>
.metric-card{min-width:0;min-height:112px;background:var(--panel-bg-elevated);border:1px solid var(--border-color-secondary);border-radius:3px;overflow:hidden}.metric-card:hover{border-color:var(--border-color)}.metric-card.selected{border-color:#1677ff;box-shadow:inset 0 0 0 1px #1677ff}.metric-button,.metric-static{width:100%;height:100%;box-sizing:border-box;padding:12px 13px 10px;display:flex;flex-direction:column;text-align:left;gap:0}.metric-button{background:transparent;border:0;color:inherit;font:inherit;cursor:pointer}.metric-button:focus-visible{outline:2px solid #69b1ff;outline-offset:-3px}.metric-head{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}.metric-title{font-size:12px;color:var(--text-color-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metric-value{margin-top:13px;font-size:25px;line-height:30px;letter-spacing:-.3px;font-weight:600;font-variant-numeric:tabular-nums}.metric-foot{margin-top:auto;padding-top:5px;display:flex;align-items:center;gap:6px;color:var(--text-color-secondary);font-size:11px;min-width:0}.comparison-positive{color:#95de64}.comparison-negative{color:#ff7875}
</style>
