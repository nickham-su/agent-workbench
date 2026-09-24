<template>
  <div class="model-section">
    <div class="model-primary-metrics">
      <DashboardMetricCard :title="t('dashboard.requestCount')" :value="formatCount(metricNumberValue(model.metrics.requestCount), locale)" :result="model.metrics.requestCount" clickable :selected="trend === 'requests'" test-id="model-metric-requestCount" @select="trend = 'requests'" />
      <DashboardMetricCard :title="t('dashboard.successRate')" :value="formatRatio(metricRatioValue(model.metrics.successRate), locale)" :result="model.metrics.successRate" clickable :selected="trend === 'successRate'" test-id="model-metric-successRate" @select="trend = 'successRate'" />
      <DashboardMetricCard :title="t('dashboard.timeoutRate')" :value="formatRatio(metricRatioValue(model.metrics.timeoutRate), locale)" :result="model.metrics.timeoutRate" clickable :selected="trend === 'timeoutRate'" test-id="model-metric-timeoutRate" @select="trend = 'timeoutRate'" />
      <DashboardMetricCard :title="t('dashboard.completedAverageDuration')" :value="formatDuration(model.metrics.completedAverageDuration.status === 'unavailable' ? null : model.metrics.completedAverageDuration.value.durationMs)" :result="model.metrics.completedAverageDuration" clickable :selected="trend === 'completedAverageDuration'" test-id="model-metric-completedAverageDuration" @select="trend = 'completedAverageDuration'" />
      <article class="token-card" :class="{ selected: trend === 'tokens' }" data-testid="model-metric-tokens">
        <button type="button" :aria-pressed="trend === 'tokens'" @click="trend = 'tokens'">
          <span class="token-title">{{ t('dashboard.inputOutputTokens') }}</span>
          <span class="token-values">
            <span>
              <span class="token-label">{{ t('dashboard.inputTokens') }}</span>
              <strong>{{ formatCount(metricNullableCountValue(model.metrics.inputTokens), locale) }}</strong>
              <span v-if="comparisonLabel(model.metrics.inputTokens, metricNullableCountValue(model.metrics.inputTokens) !== null)" class="token-comparison">{{ comparisonLabel(model.metrics.inputTokens, true) }}</span>
            </span>
            <span>
              <span class="token-label">{{ t('dashboard.outputTokens') }}</span>
              <strong>{{ formatCount(metricNullableCountValue(model.metrics.outputTokens), locale) }}</strong>
              <span v-if="comparisonLabel(model.metrics.outputTokens, metricNullableCountValue(model.metrics.outputTokens) !== null)" class="token-comparison">{{ comparisonLabel(model.metrics.outputTokens, true) }}</span>
            </span>
          </span>
        </button>
      </article>
      <DashboardMetricCard :title="t('dashboard.cacheHitRate')" :value="formatRatio(metricRatioValue(cacheHitRate), locale)" :result="cacheHitRate" clickable :selected="trend === 'cacheHitRate'" test-id="model-metric-cacheHitRate" @select="trend = 'cacheHitRate'" />
    </div>

    <div class="model-main">
      <DashboardTrendChart :title="t(`dashboard.${trend}`)" :kind="kinds[trend]" :panel="model.trends[trend]" :test-id="`model-trend-${trend}`" :timezone="timezone" />
      <DashboardPanelShell :title="t('dashboard.tokenCoverage')" test-id="model-coverage">
        <div class="coverage-list">
          <div v-for="item in coverage" :key="item.key" class="coverage-item" :data-testid="`model-coverage-${item.key}`">
            <div class="coverage-label"><span>{{ t(`dashboard.${item.key}`) }}</span><span class="coverage-value"><strong>{{ formatRatio(metricRatioValue(item.result), locale) }}</strong><span v-if="comparisonLabel(item.result, metricRatioValue(item.result) !== null)" class="coverage-comparison">{{ comparisonLabel(item.result, true) }}</span></span></div>
            <progress v-if="metricRatioValue(item.result) !== null" :value="metricRatioValue(item.result)!" max="1" :aria-label="`${t(`dashboard.${item.key}`)}: ${formatRatio(metricRatioValue(item.result), locale)}${comparisonLabel(item.result, true) ? `, ${comparisonLabel(item.result, true)}` : ''}`" />
            <div v-else class="coverage-unknown" aria-hidden="true" />
          </div>
        </div>
      </DashboardPanelShell>
    </div>

    <DashboardTables :title="t('dashboard.byModel')" :panel="model.byModel" table-kind="models" />
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { DashboardData, MetricResult } from "@agent-workbench/shared";
import { formatComparison, formatCount, formatDuration, formatRatio } from "../dashboard-formatters";
import { metricNumberValue, metricNullableCountValue, metricRatioValue } from "../dashboard-types";
import DashboardMetricCard from "./DashboardMetricCard.vue";
import DashboardPanelShell from "./DashboardPanelShell.vue";
import DashboardTables from "./DashboardTables.vue";
import DashboardTrendChart from "./DashboardTrendChart.vue";

const props = defineProps<{ model: DashboardData["model"]; cacheHitRate: DashboardData["overview"]["cacheHitRate"]; timezone: string }>();
const { t, locale } = useI18n();
const kinds = { requests: "model_status", successRate: "ratio", timeoutRate: "ratio", completedAverageDuration: "duration", tokens: "tokens", cacheHitRate: "ratio" } as const;
const trend = ref<keyof typeof kinds>("requests");
function comparisonLabel(result: MetricResult<unknown>, hasValue: boolean): string {
  return hasValue && result.status === "available" && result.comparison.status === "available" ? formatComparison(result.comparison, locale.value) : "";
}
const coverage = computed(() => {
  const m = props.model.metrics;
  return [
    { key: "inputTokenCoverage", result: m.inputTokenCoverage },
    { key: "outputTokenCoverage", result: m.outputTokenCoverage },
    { key: "totalTokenCoverage", result: m.totalTokenCoverage },
    { key: "inputCacheCoverage", result: m.inputCacheCoverage },
  ];
});
</script>
<style scoped>
.model-section{display:grid;gap:12px;min-width:0}
.model-primary-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}
.model-main{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:12px;align-items:stretch;min-width:0}
.model-main>*{min-width:0}
.token-card{min-width:0;min-height:112px;background:var(--panel-bg-elevated);border:1px solid var(--border-color-secondary);border-radius:3px;overflow:hidden}
.token-card.selected{border-color:#1677ff;box-shadow:inset 0 0 0 1px #1677ff}
.token-card button{width:100%;height:100%;padding:12px 13px 10px;display:flex;flex-direction:column;gap:12px;text-align:left;color:inherit;font:inherit;background:transparent;border:0;cursor:pointer}
.token-card button:focus-visible{outline:2px solid #69b1ff;outline-offset:-3px}
.token-title,.token-label{font-size:12px;color:var(--text-color-secondary)}
.token-values{display:flex;gap:14px;min-width:0}
.token-values>span{display:grid;gap:3px;min-width:0}
.token-values strong{font-size:20px;line-height:26px;white-space:nowrap;font-variant-numeric:tabular-nums}
.token-comparison,.coverage-comparison{font-size:11px;color:var(--text-color-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.token-values .token-comparison{align-self:end}
.coverage-list{display:grid;gap:16px;margin:10px 0}
.coverage-item{display:grid;gap:7px}
.coverage-label{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--text-color-secondary)}
.coverage-value{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;justify-content:flex-end;text-align:right}
.coverage-label strong{color:var(--text-color);font-weight:600;font-variant-numeric:tabular-nums}
.coverage-item progress,.coverage-unknown{width:100%;height:7px;display:block;overflow:hidden;border:0;border-radius:4px;background:var(--border-color-secondary)}
.coverage-item progress::-webkit-progress-bar{background:var(--border-color-secondary)}
.coverage-item progress::-webkit-progress-value{background:#1677ff;border-radius:4px}
.coverage-item progress::-moz-progress-bar{background:#1677ff;border-radius:4px}
@container(max-width:1050px){.model-primary-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}}
@container(max-width:850px){.model-main{grid-template-columns:minmax(0,1fr)}}
@container(max-width:580px){.model-primary-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.token-values{gap:8px}.token-values strong{font-size:17px}}
</style>
