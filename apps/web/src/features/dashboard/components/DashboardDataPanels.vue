<template>
  <section class="panel"><header><h3>{{ title }}</h3><DashboardStatusBadge :status="panel.status" /></header><template v-if="panel.status !== 'unavailable'"><div class="distribution"><span v-for="row in rows" :key="row.label">{{ t(`dashboard.distribution.${row.label}`) }} <b>{{ formatCount(row.count, locale) }}</b></span></div><p v-if="panel.status === 'partial'">{{ t(`dashboard.reason.${panel.partialReason}`) }}</p></template><p v-else>{{ t(`dashboard.reason.${panel.unavailableReason}`) }}</p></section>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { DashboardData } from "@agent-workbench/shared";
import { formatCount } from "../dashboard-formatters";
import DashboardStatusBadge from "./DashboardStatusBadge.vue";
type DistributionPanel = DashboardData["agent"]["runTypeDistribution"] | DashboardData["agent"]["messageTypeDistribution"] | DashboardData["agent"]["toolStatusDistribution"];
const props = defineProps<{ title: string; panel: DistributionPanel }>(); const { t, locale } = useI18n();
const rows = computed(() => props.panel.status === "unavailable" ? [] : props.panel.data.map((row) => ({ label: "kind" in row ? row.kind : "type" in row ? row.type : row.status, count: row.count })));
</script>
<style scoped>.panel{background:var(--panel-bg-elevated);border:1px solid var(--border-color);border-radius:8px;padding:14px}.panel header{display:flex;justify-content:space-between;gap:8px}.panel h3{margin:0;font-size:14px}.distribution{display:flex;flex-wrap:wrap;gap:12px;margin-top:12px}.distribution span{padding:6px;background:var(--panel-bg);border-radius:5px;font-size:12px}</style>
