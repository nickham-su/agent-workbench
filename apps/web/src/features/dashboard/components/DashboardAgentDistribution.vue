<template>
  <DashboardPanelShell :title="title" :test-id="testId">
    <template v-if="$slots.actions" #actions><slot name="actions" /></template>
    <template v-if="panel.status !== 'unavailable' && (rows.length || panel.status === 'available')">
      <div :class="['distribution-layout', variant]">
        <DashboardDistributionEChart :title="title" :rows="rows" :variant="variant" :partial="panel.status === 'partial'" :label-group="labelGroup" :colors="colors" />
        <div v-if="variant === 'bars' && panel.status === 'partial'" class="known-note">{{ t('dashboard.knownShare') }}</div>
        <div v-if="variant === 'donut'" class="distribution-list">
          <div class="distribution-rows">
            <div v-for="(row, index) in rows" :key="row.label" class="distribution-row">
              <div class="distribution-label"><span class="swatch" :style="{ background: colors[index % colors.length] }" aria-hidden="true" />{{ t(`dashboard.${labelGroup}.${row.label}`) }}<b>{{ formatCount(row.count, locale) }}</b></div>
              <span v-if="panel.status === 'available' && total > 0" class="percentage">{{ formatRatio(row.count / total, locale) }}</span>
            </div>
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
import { formatCount, formatRatio } from "../dashboard-formatters";
import DashboardDistributionEChart from "./DashboardDistributionEChart.vue";
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
</script>
<style scoped>
.distribution-layout{min-width:0;display:grid;gap:12px}.distribution-layout.donut{grid-template-columns:minmax(120px,42%) minmax(0,1fr);align-items:center}.distribution-list,.distribution-rows{display:grid;gap:8px;min-width:0}.distribution-row{min-width:0;display:grid;gap:4px}.distribution-label{display:flex;align-items:center;gap:6px;font-size:12px;min-width:0;overflow-wrap:anywhere}.distribution-label b{margin-left:auto;padding-left:6px}.swatch{width:9px;height:9px;flex:none;border-radius:2px}.percentage,.known-note{font-size:11px;color:var(--text-secondary)}
@container(max-width:760px){.distribution-layout.donut{grid-template-columns:1fr 1fr}}@container(max-width:450px){.distribution-layout.donut{grid-template-columns:1fr}}
</style>
