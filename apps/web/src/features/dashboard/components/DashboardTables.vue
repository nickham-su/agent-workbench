<template>
  <section class="panel"><header><h3>{{ title }}</h3><DashboardStatusBadge :status="panel.status" /></header><p v-if="panel.status === 'unavailable'">{{ t(`dashboard.reason.${panel.unavailableReason}`) }}</p><template v-else><p v-if="panel.status === 'partial'">{{ t(`dashboard.reason.${panel.partialReason}`) }}</p><div class="table-wrap"><table><thead><tr><th v-for="column in columns" :key="column">{{ column }}</th></tr></thead><tbody><tr v-for="row in displayRows" :key="row.key"><td v-for="(value, index) in row.cells" :key="`${row.key}-${index}`">{{ value }}</td></tr></tbody></table></div></template></section>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { DashboardData } from "@agent-workbench/shared";
import { formatCount, formatRatio } from "../dashboard-formatters";
import DashboardStatusBadge from "./DashboardStatusBadge.vue";
type ToolPanel = DashboardData["agent"]["toolDetails"]; type ModelPanel = DashboardData["model"]["byModel"]; type TablePanel = ToolPanel | ModelPanel; type DataRow = NonNullable<ToolPanel["data"]>[number] | NonNullable<ModelPanel["data"]>[number]; type ToolRow = NonNullable<ToolPanel["data"]>[number]; type ModelRow = NonNullable<ModelPanel["data"]>[number];
const props = defineProps<{ title: string; panel: TablePanel; tableKind: "tools" | "models" }>(); const { t, locale } = useI18n();
function isToolRow(row: DataRow): row is ToolRow { return "toolName" in row; } function isModelRow(row: DataRow): row is ModelRow { return "provider" in row; }
const columns = computed(() => props.tableKind === "tools" ? [t("dashboard.toolName"), t("dashboard.calls"), t("dashboard.completed"), t("dashboard.failed")] : [t("dashboard.provider"), t("dashboard.modelName"), t("dashboard.requests"), t("dashboard.successRate"), t("dashboard.totalTokens")]);
const displayRows = computed(() => { if (props.panel.status === "unavailable") return []; const rows: DataRow[] = props.panel.data; if (props.tableKind === "tools") return rows.filter(isToolRow).map((row) => ({ key: `${row.toolName ?? "unknown"}-${row.calls}`, cells: [row.toolName ?? t("dashboard.unknown"), formatCount(row.calls, locale.value), formatCount(row.completed, locale.value), formatCount(row.failed, locale.value)] })); return rows.filter(isModelRow).map((row) => ({ key: `${row.provider}-${row.model}`, cells: [row.provider, row.model, formatCount(row.requests, locale.value), formatRatio(row.successRate, locale.value), formatCount(row.totalTokens, locale.value)] })); });
</script>
<style scoped>.panel{background:var(--panel-bg-elevated);border:1px solid var(--border-color);border-radius:8px;padding:14px}.panel header{display:flex;justify-content:space-between}.panel h3{font-size:14px;margin:0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}th,td{text-align:left;padding:8px;border-top:1px solid var(--border-color);white-space:nowrap}</style>
