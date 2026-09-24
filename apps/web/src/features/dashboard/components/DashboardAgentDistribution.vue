<template>
  <DashboardPanelShell :title="title" :test-id="testId">
    <template v-if="$slots.actions" #actions><slot name="actions" /></template>
    <template v-if="panel.status !== 'unavailable' && (rows.length || panel.status === 'available')">
      <div :class="['distribution-layout', variant]">
        <div v-if="variant === 'donut'" class="donut-ring" :style="{ background: segments }">
          <div class="donut-center"><b>{{ formatCount(total, locale) }}</b><small>{{ panel.status === 'partial' ? t('dashboard.knownObserved') : labelGroup === 'runStatus' ? t('dashboard.terminalRunTotal') : t('dashboard.distributionTotal') }}</small></div>
        </div>
        <div v-if="variant === 'bars' && panel.status === 'partial'" class="known-note">{{ t('dashboard.knownShare') }}</div>
        <div class="distribution-rows">
          <div v-for="(row, index) in rows" :key="row.label" class="distribution-row">
            <div class="distribution-label"><span class="swatch" :style="{ background: colors[index % colors.length] }" aria-hidden="true" />{{ t(`dashboard.${labelGroup}.${row.label}`) }}<b>{{ formatCount(row.count, locale) }}</b></div>
            <div v-if="variant === 'bars'" class="bar-track" aria-hidden="true"><div class="bar-fill" :style="{ width: `${share(row.count)}%`, background: colors[index % colors.length] }" /></div>
            <span v-if="panel.status === 'available' && total > 0" class="percentage">{{ formatPercent(row.count) }}</span>
          </div>
        </div>
      </div>
    </template>
    <DashboardEmptyValue v-else />
  </DashboardPanelShell>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { DashboardData } from "@agent-workbench/shared";
import { formatCount } from "../dashboard-formatters";
import DashboardEmptyValue from "./DashboardEmptyValue.vue";
import DashboardPanelShell from "./DashboardPanelShell.vue";

type Agent = DashboardData["agent"];
type DistributionPanel = Agent["runTerminalDistribution"] | Agent["runTypeDistribution"] | Agent["messageTypeDistribution"] | Agent["toolStatusDistribution"];
type Scope = keyof NonNullable<Agent["runTerminalDistribution"]["data"]>;
const props = defineProps<{ title: string; panel: DistributionPanel; labelGroup: "runStatus" | "distribution"; variant: "donut" | "bars"; scope?: Scope; testId?: string }>();
const { t, locale } = useI18n();
const colors = ["#7388e9", "#57bfa7", "#eca978", "#bd97d8", "#94a6b9"];
const rows = computed(() => {
  if (props.panel.status === "unavailable") return [];
  const data = props.panel.data;
  const source = Array.isArray(data) ? data : data[props.scope ?? "all"];
  return source.map((row) => ({ label: "kind" in row ? row.kind : "type" in row ? row.type : row.status, count: row.count }));
});
const total = computed(() => rows.value.reduce((sum, row) => sum + row.count, 0));
function share(count: number): number { return total.value > 0 ? count / total.value * 100 : 0; }
function formatPercent(count: number): string { return new Intl.NumberFormat(locale.value, { style: "percent", maximumFractionDigits: 1 }).format(count / total.value); }
const segments = computed(() => {
  if (!total.value) return "var(--border-color-secondary)";
  let from = 0;
  const stops = rows.value.map((row, index) => {
    const to = from + share(row.count);
    const segment = `${colors[index % colors.length]} ${from}% ${to}%`;
    from = to;
    return segment;
  });
  return `conic-gradient(${stops.join(", ")})`;
});
</script>
<style scoped>
.distribution-layout{min-width:0;display:grid;gap:18px}.distribution-layout.donut{grid-template-columns:minmax(120px,42%) minmax(0,1fr);align-items:center}
.donut-ring{width:min(100%,170px);aspect-ratio:1;border-radius:50%;display:grid;place-items:center;margin:8px auto}.donut-center{width:70%;aspect-ratio:1;border-radius:50%;background:var(--panel-bg-elevated);display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center}.donut-center b{font-size:22px}.donut-center small{font-size:11px;color:var(--text-color-secondary)}
.distribution-rows{display:grid;gap:10px;min-width:0}.distribution-row{min-width:0;display:grid;gap:4px}.distribution-label{display:flex;align-items:center;gap:6px;font-size:12px;min-width:0;overflow-wrap:anywhere}.distribution-label b{margin-left:auto;padding-left:6px}.swatch{width:9px;height:9px;flex:none;border-radius:2px}.bar-track{height:8px;background:var(--panel-bg);border-radius:8px;overflow:hidden}.bar-fill{height:100%;border-radius:8px}.percentage{font-size:11px;color:var(--text-color-secondary)}.known-note{font-size:11px;color:var(--text-color-secondary)}
@container(max-width:760px){.distribution-layout.donut{grid-template-columns:1fr 1fr}}@container(max-width:450px){.distribution-layout.donut{grid-template-columns:1fr}}
</style>
