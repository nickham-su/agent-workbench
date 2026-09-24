<template>
  <DashboardPanelShell :title="title">
    <div v-if="displayRows.length" class="table-wrap"><table><thead><tr><th v-for="column in columns" :key="column" scope="col">{{ column }}</th></tr></thead><tbody><tr v-for="row in displayRows" :key="row.key"><td v-for="(value, index) in row.cells" :key="`${row.key}-${index}`">{{ value }}</td></tr></tbody></table></div>
    <DashboardEmptyValue v-else />
  </DashboardPanelShell>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { DashboardData } from "@agent-workbench/shared";
import { formatCount, formatRatio, formatDuration } from "../dashboard-formatters";
import DashboardPanelShell from "./DashboardPanelShell.vue";
import DashboardEmptyValue from "./DashboardEmptyValue.vue";
type ToolPanel = DashboardData["agent"]["toolDetails"]; type ModelPanel = DashboardData["model"]["byModel"]; type TablePanel = ToolPanel | ModelPanel; type DataRow = NonNullable<ToolPanel["data"]>[number] | NonNullable<ModelPanel["data"]>[number]; type ToolRow = NonNullable<ToolPanel["data"]>[number]; type ModelRow = NonNullable<ModelPanel["data"]>[number];
const props = defineProps<{ title: string; panel: TablePanel; tableKind: "tools" | "models" }>(); const { t, locale } = useI18n();
function isToolRow(row: DataRow): row is ToolRow { return "toolName" in row; } function isModelRow(row: DataRow): row is ModelRow { return "provider" in row; }
const columns = computed(() => props.tableKind === "tools" ? [t("dashboard.toolName"), t("dashboard.calls"), t("dashboard.completed"), t("dashboard.failed"), t("dashboard.distribution.cancelled"), t("dashboard.unknown"), t("dashboard.completedAverageDuration")] : [t("dashboard.provider"), t("dashboard.modelName"), t("dashboard.requests"), t("dashboard.successRate"), t("dashboard.timeoutRate"), t("dashboard.completedAverageDuration"), t("dashboard.totalTokens"), t("dashboard.cacheHitRate")]);
const displayRows = computed(() => { if (props.panel.status === "unavailable") return []; const rows: DataRow[] = props.panel.data; if (props.tableKind === "tools") return rows.filter(isToolRow).map((row, index) => ({ key: `${row.toolName ?? "unknown"}-${index}`, cells: [row.toolName ?? t("dashboard.unknown"), formatCount(row.calls, locale.value), formatCount(row.completed, locale.value), formatCount(row.failed, locale.value), formatCount(row.cancelled, locale.value), formatCount(row.unknown, locale.value), formatDuration(row.completedAverageDurationMs)] })); return rows.filter(isModelRow).map((row) => ({ key: `${row.provider}-${row.model}`, cells: [row.provider, row.model, formatCount(row.requests, locale.value), formatRatio(row.successRate, locale.value), formatRatio(row.timeoutRate, locale.value), formatDuration(row.completedAverageDurationMs), formatCount(row.totalTokens, locale.value), formatRatio(row.cacheHitRate, locale.value)] })); });
</script>
<style scoped>.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}th,td{text-align:left;padding:8px;border-top:1px solid var(--border-color);white-space:nowrap}td:nth-child(-n+2){max-width:240px;overflow-wrap:anywhere;white-space:normal}</style>
