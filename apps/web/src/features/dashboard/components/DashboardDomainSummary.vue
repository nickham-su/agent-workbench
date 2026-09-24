<template>
  <DashboardPanelShell :title="t('dashboard.domainStatusSummary')" test-id="overview-domain-health">
    <p v-if="result.status !== 'available'" class="health-reason">{{ t(`dashboard.reason.${result.status === 'partial' ? result.partialReason : result.unavailableReason}`) }}</p>
    <div v-if="result.status !== 'unavailable'" class="health-table-scroll">
      <table class="health-table"><thead><tr><th scope="col">{{ t('dashboard.domain') }}</th><th scope="col">{{ t('dashboard.statusLabel') }}</th><th scope="col">{{ t('dashboard.lastSucceededAt') }}</th></tr></thead>
        <tbody>
          <tr v-for="domain in result.data" :key="domain.domain">
            <th scope="row">{{ t(`dashboard.${domainLabels[domain.domain]}`) }}</th>
            <td>
              <span class="health-state">
                <DashboardStatusBadge :status="domain.status" />
                <Popover v-if="domain.status !== 'healthy'" :trigger="['hover', 'focus', 'click']" placement="leftTop">
                  <template #title>{{ t('dashboard.healthEvidenceTitle') }}</template>
                  <template #content>
                    <ul class="health-evidence-list"><li v-for="item in evidence(domain)" :key="item">{{ item }}</li></ul>
                  </template>
                  <button class="health-evidence-trigger" type="button" :aria-label="`${t(`dashboard.${domainLabels[domain.domain]}`)}：${t('dashboard.healthEvidenceTitle')}；${evidence(domain).join('；')}`">ⓘ</button>
                </Popover>
              </span>
            </td>
            <td>{{ formatDateTime(domain.lastSucceededAt, timezone, locale) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </DashboardPanelShell>
</template>
<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { AnalyticsDomain, DashboardData } from "@agent-workbench/shared";
import { Popover } from "ant-design-vue";
import { formatDateTime } from "../dashboard-formatters";
import DashboardPanelShell from "./DashboardPanelShell.vue";
import DashboardStatusBadge from "./DashboardStatusBadge.vue";

const { t, locale } = useI18n();
withDefaults(defineProps<{ result: DashboardData["exceptions"]["domainHealth"]; timezone?: string }>(), { timezone: "UTC" });
type HealthRow = NonNullable<DashboardData["exceptions"]["domainHealth"]["data"]>[number];
function evidence(domain: HealthRow): string[] {
  const items: string[] = [];
  if (domain.status === "disabled") items.push(t("dashboard.healthEvidenceDisabled"));
  if (domain.coverageGaps.openCount > 0)
    items.push(t("dashboard.healthEvidenceGaps", { count: domain.coverageGaps.openCount }));
  if (domain.expectedSlotCount > domain.activeGenerationCount)
    items.push(t("dashboard.healthEvidenceMissingGeneration", { count: domain.expectedSlotCount - domain.activeGenerationCount }));
  const stale = domain.slots.filter((slot) => slot.checkpoint.freshness === "stale").length;
  const missing = domain.slots.filter((slot) => slot.slotStatus === "generation_active" && slot.checkpoint.freshness === "missing").length;
  if (stale > 0) items.push(t("dashboard.healthEvidenceStaleCheckpoint", { count: stale }));
  if (missing > 0) items.push(t("dashboard.healthEvidenceMissingCheckpoint", { count: missing }));
  return items.length ? items : [t("dashboard.healthEvidenceUnknown")];
}
const domainLabels: Record<AnalyticsDomain, string> = {
  model: "monitoringModel", run: "monitoringRun", execution: "monitoringExecution",
  agent_duration: "domainAgentDuration", tool: "monitoringTool", message: "monitoringMessage",
  session: "monitoringSession", worker: "monitoringWorker", git: "monitoringGit",
};
</script>
<style scoped>
.health-reason{font-size:12px;color:var(--text-color-secondary);margin:0 0 8px}
.health-table-scroll{max-height:344px;overflow:auto;min-width:0}
.health-table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap;text-align:left}.health-table th,.health-table td{padding:9px 6px;border-bottom:1px solid var(--border-color-secondary)}.health-table thead th{color:var(--text-color-secondary);font-weight:400;position:sticky;top:0;background:var(--panel-bg-elevated)}.health-table tbody th{font-weight:500}.health-table td:last-child{color:var(--text-color-secondary);font-variant-numeric:tabular-nums}
.health-state{display:inline-flex;align-items:center;gap:5px}
.health-evidence-trigger{border:0;padding:3px;background:transparent;color:var(--text-color-secondary);cursor:pointer;font-size:13px;line-height:1;border-radius:3px}.health-evidence-trigger:hover{color:var(--text-color)}.health-evidence-trigger:focus-visible{outline:2px solid var(--primary-color);outline-offset:2px}
.health-evidence-list{margin:0;padding-left:16px;max-width:280px;white-space:normal;line-height:1.5}
</style>
