<template>
  <div class="agent-section">
    <div class="agent-primary-metrics">
      <DashboardMetricCard v-for="metric in primaryMetrics" :key="metric.key" :title="t(`dashboard.${metric.key}`)" :value="metric.value" :result="metric.result" clickable :selected="trend === metric.key" :test-id="`agent-metric-${metric.key}`" @select="trend = metric.key" />
    </div>
    <div class="agent-main">
      <DashboardTrendChart class="agent-chart" :title="t(`dashboard.${trend}`)" :kind="kinds[trend]" :panel="agent.trends[trend]" :test-id="`agent-trend-${trend}`" :timezone="timezone" />
      <div class="agent-secondary-metrics">
        <DashboardMetricCard v-for="metric in secondaryMetrics" :key="metric.key" :title="t(`dashboard.${metric.key}`)" :value="metric.value" :result="metric.result" clickable :selected="trend === metric.key" :test-id="`agent-metric-${metric.key}`" @select="trend = metric.key" />
      </div>
    </div>
    <div class="agent-distributions">
      <DashboardAgentDistribution :title="t('dashboard.runTerminalTitle')" :panel="agent.runTerminalDistribution" :scope="runScope" label-group="runStatus" variant="donut" test-id="agent-run-terminal">
        <template #actions><div class="scope-controls" :aria-label="t('dashboard.runScope')" role="group"><button v-for="scope in scopes" :key="scope" type="button" :aria-pressed="runScope === scope" @click="runScope = scope">{{ t(`dashboard.${scope}`) }}</button></div></template>
      </DashboardAgentDistribution>
      <DashboardAgentDistribution :title="t('dashboard.runType')" :panel="agent.runTypeDistribution" label-group="distribution" variant="donut" test-id="agent-run-type" />
      <DashboardAgentDistribution :title="t('dashboard.messageType')" :panel="agent.messageTypeDistribution" label-group="distribution" variant="bars" test-id="agent-message-type" />
    </div>
    <div class="agent-tools">
      <DashboardTables :title="t('dashboard.toolDetails')" :panel="agent.toolDetails" table-kind="tools" />
      <DashboardAgentDistribution :title="t('dashboard.toolStatus')" :panel="agent.toolStatusDistribution" label-group="distribution" variant="donut" test-id="agent-tool-status" />
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { DashboardData, MetricResult } from "@agent-workbench/shared";
import { formatCount, formatDuration, formatRatio } from "../dashboard-formatters";
import { metricNumberValue, metricRatioValue, type CountResult, type RatioResult } from "../dashboard-types";
import DashboardAgentDistribution from "./DashboardAgentDistribution.vue";
import DashboardMetricCard from "./DashboardMetricCard.vue";
import DashboardTables from "./DashboardTables.vue";
import DashboardTrendChart from "./DashboardTrendChart.vue";

const props = defineProps<{ agent: DashboardData["agent"]; timezone: string }>();
const { t, locale } = useI18n();
const kinds = { totalDuration: "duration", runCount: "count", primaryRunCount: "count", subtaskRunCount: "count", userMessageCount: "count", assistantMessageCount: "count", toolCallCount: "count", toolSuccessRate: "ratio", manualCompactionCount: "count", autoCompactionCount: "count" } as const;
type Trend = keyof typeof kinds;
type Metric = { key: Trend; result: MetricResult<unknown>; value: string };
const trend = ref<Trend>("runCount");
const scopes = ["all", "main", "subtask"] as const;
const runScope = ref<(typeof scopes)[number]>("all");
function count(key: Exclude<Trend, "toolSuccessRate">): Metric {
  const result = props.agent.metrics[key] as CountResult;
  return { key, result, value: key === "totalDuration" ? formatDuration(metricNumberValue(result)) : formatCount(metricNumberValue(result), locale.value) };
}
function ratio(key: "toolSuccessRate"): Metric {
  const result = props.agent.metrics[key] as RatioResult;
  return { key, result, value: formatRatio(metricRatioValue(result), locale.value) };
}
const primaryMetrics = computed(() => ([count("totalDuration"), count("runCount"), count("primaryRunCount"), count("subtaskRunCount"), count("userMessageCount"), count("assistantMessageCount")]));
const secondaryMetrics = computed(() => ([count("toolCallCount"), ratio("toolSuccessRate"), count("manualCompactionCount"), count("autoCompactionCount")]));
</script>
<style scoped>
.agent-section{display:grid;gap:12px;min-width:0;container-type:inline-size}.agent-primary-metrics,.agent-secondary-metrics,.agent-distributions,.agent-tools,.agent-main{display:grid;gap:12px;min-width:0}.agent-primary-metrics{grid-template-columns:repeat(6,minmax(0,1fr))}.agent-main,.agent-tools{grid-template-columns:minmax(0,2fr) minmax(280px,1fr)}.agent-main>* ,.agent-tools>* ,.agent-distributions>*{min-width:0}.agent-secondary-metrics{grid-template-columns:repeat(2,minmax(0,1fr));align-self:stretch}.agent-distributions{grid-template-columns:repeat(3,minmax(0,1fr))}.scope-controls{display:flex;flex-wrap:wrap;gap:2px}.scope-controls button{font-size:11px;border:0;background:transparent;color:var(--text-color-secondary);border-radius:4px;cursor:pointer;padding:4px 6px}.scope-controls button[aria-pressed=true]{background:var(--panel-bg);color:var(--primary-color)}.scope-controls button:focus-visible{outline:2px solid var(--primary-color);outline-offset:2px}
@container(max-width:1050px){.agent-primary-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.agent-distributions{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container(max-width:780px){.agent-main,.agent-tools,.agent-distributions{grid-template-columns:minmax(0,1fr)}}
@container(max-width:550px){.agent-primary-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container(max-width:380px){.agent-primary-metrics,.agent-secondary-metrics{grid-template-columns:minmax(0,1fr)}}
</style>
