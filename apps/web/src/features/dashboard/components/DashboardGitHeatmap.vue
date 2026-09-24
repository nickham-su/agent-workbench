<template>
  <DashboardPanelShell :title="t('dashboard.heatmap')">
    <p class="heatmap-caption">{{ t("dashboard.heatmapRange") }}: {{ formatDateTime(result.from, timezone, locale) }} — {{ formatDateTime(result.to, timezone, locale) }} · {{ t("dashboard.asOf") }}: {{ formatDateTime(result.asOf, timezone, locale) }}</p>
    <template v-if="result.status !== 'unavailable' && result.data.days.length">
      <p v-if="comparisonLabel">{{ comparisonLabel }}</p>
      <div class="calendar-scroll">
        <div class="calendar" role="group" :aria-label="summary">
          <div class="month-axis" aria-hidden="true" :style="calendarColumns">
            <span v-for="month in months" :key="month.column" :style="{ gridColumn: month.column }">{{ month.label }}</span>
          </div>
          <div class="calendar-body">
            <div class="weekday-axis" aria-hidden="true">
              <span v-for="(label, index) in weekdays" :key="index">{{ index % 2 === 0 ? label : '' }}</span>
            </div>
            <div class="heatmap" :style="calendarColumns">
              <span v-for="day in calendarDays" :key="day.from" class="heatmap-day" :class="[`level-${day.level}`, { 'partial-zero': result.status === 'partial' && day.commits === 0 }]" :style="{ gridColumn: day.column, gridRow: day.row }" :title="`${formatDateTime(day.from, timezone, locale)}: ${dayCount(day.commits)}`" :aria-label="`${formatDateTime(day.from, timezone, locale)}: ${dayCount(day.commits)}`" tabindex="0" role="group" />
            </div>
          </div>
          <div class="heatmap-legend" aria-hidden="true"><span>{{ t('dashboard.heatmapLess') }}</span><i v-for="level in [0, 1, 2, 3, 4]" :key="level" :class="`level-${level}`" /><span>{{ t('dashboard.heatmapMore') }}</span></div>
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
import { formatComparison, formatCount, formatDateTime } from "../dashboard-formatters";
import DashboardPanelShell from "./DashboardPanelShell.vue";
import DashboardEmptyValue from "./DashboardEmptyValue.vue";

const props = defineProps<{ result: DashboardData["exceptions"]["gitHeatmap180d"]; timezone: string }>();
const { t, locale } = useI18n();
const dayMs = 86_400_000;
const localDayFormatter = computed(() => new Intl.DateTimeFormat("en-US", { timeZone: props.timezone, year: "numeric", month: "numeric", day: "numeric", weekday: "short" }));
// Comparing calendar-day ordinals, rather than timestamps, keeps 23/25-hour DST days in their own cells.
function localDay(timestamp: number) {
  const parts = localDayFormatter.value.formatToParts(new Date(timestamp));
  const value = (key: string) => parts.find((part) => part.type === key)?.value ?? "";
  return { ordinal: Date.UTC(Number(value("year")), Number(value("month")) - 1, Number(value("day"))) / dayMs, weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(value("weekday")) };
}
const firstDay = computed(() => localDay(props.result.from));
const maximum = computed(() => props.result.status === "unavailable" ? 0 : Math.max(0, ...props.result.data.days.map((day) => day.commits)));
const calendarDays = computed(() => props.result.status === "unavailable" ? [] : props.result.data.days.map((day) => {
  const index = localDay(day.from).ordinal - firstDay.value.ordinal + firstDay.value.weekday;
  const ratio = maximum.value === 0 ? 0 : day.commits / maximum.value;
  return { ...day, column: Math.floor(index / 7) + 1, row: index % 7 + 1, level: day.commits === 0 ? 0 : Math.max(1, Math.ceil(ratio * 4)) };
}));
const weekCount = computed(() => Math.max(1, Math.ceil((firstDay.value.weekday + localDay(props.result.to - 1).ordinal - firstDay.value.ordinal + 1) / 7)));
const calendarColumns = computed(() => ({ gridTemplateColumns: `repeat(${weekCount.value}, 12px)` }));
const monthFormatter = computed(() => new Intl.DateTimeFormat(locale.value, { timeZone: props.timezone, month: "short", year: "numeric" }));
const shortMonthFormatter = computed(() => new Intl.DateTimeFormat(locale.value, { timeZone: props.timezone, month: "short" }));
const months = computed(() => {
  const markers: Array<{ column: number; label: string }> = [];
  let previousMonth = "";
  for (const day of calendarDays.value) {
    const month = monthFormatter.value.format(new Date(day.from));
    if (month !== previousMonth && markers.at(-1)?.column !== day.column) markers.push({ column: day.column, label: shortMonthFormatter.value.format(new Date(day.from)) });
    previousMonth = month;
  }
  return markers;
});
const weekdays = computed(() => Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(locale.value, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + day)))));
const summary = computed(() => `${t("dashboard.heatmap")}: ${calendarDays.value.length} ${t("dashboard.days")}`);
const comparisonLabel = computed(() => props.result.status === "available" && props.result.comparison.status === "available" ? formatComparison(props.result.comparison, locale.value) : "");
function dayCount(count: number) { const label = formatCount(count, locale.value); return props.result.status === "partial" ? `≥${label}` : label; }
</script>
<style scoped>
.heatmap-caption{font-size:12px;color:var(--text-color-secondary);line-height:1.5;overflow-wrap:anywhere}
.calendar-scroll{max-width:100%;overflow-x:auto;overflow-y:hidden;padding:10px 2px}
.calendar{width:max-content;max-width:none;--cell-gap:4px}
.month-axis,.heatmap{display:grid;column-gap:var(--cell-gap)}
.month-axis{height:24px;margin-left:32px;color:var(--text-color-secondary);font-size:11px;white-space:nowrap}
.month-axis span{overflow:visible}
.calendar-body{display:flex;gap:7px}
.weekday-axis{display:grid;grid-template-rows:repeat(7,12px);gap:var(--cell-gap);font-size:10px;line-height:12px;color:var(--text-color-secondary);white-space:nowrap}
.heatmap{grid-template-rows:repeat(7,12px);row-gap:var(--cell-gap)}
.heatmap-day,.heatmap-legend i{width:12px;height:12px;border-radius:2px;background:#35465a;display:block}
.level-1{background:#145c35!important}.level-2{background:#1b8048!important}.level-3{background:#2db764!important}.level-4{background:#73dc91!important}
.heatmap-day.partial-zero{background:repeating-linear-gradient(135deg,#35465a 0 3px,#596471 3px 5px)}
.heatmap-day:focus-visible{outline:2px solid #ffdc73;outline-offset:1px}
.heatmap-legend{display:flex;gap:4px;align-items:center;justify-content:flex-end;margin-top:14px;font-size:11px;color:var(--text-color-secondary)}
</style>
