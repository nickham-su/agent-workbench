import type { AnalyticsComparisonResult, AnalyticsPartialReason, AnalyticsUnavailableReason } from "@agent-workbench/shared";

export function formatCount(value: number | null | undefined, locale = "zh-CN") { return value == null ? "—" : new Intl.NumberFormat(locale).format(value); }
export function formatRatio(value: number | null | undefined, locale = "zh-CN") { return value == null ? "—" : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value); }
export function formatDuration(value: number | null | undefined) { if (value == null) return "—"; if (value < 60_000) return formatChartDuration(value); const minutes = Math.floor(value / 60_000); return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`; }

/** Chart axes have limited room; tooltips/details still use the unabridged count. */
export function formatChartAxisCount(value: number, locale = "zh-CN") {
  const magnitude = value >= 1e15 ? 1e15 : value >= 1e12 ? 1e12 : value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  const suffix = magnitude === 1e15 ? "P" : magnitude === 1e12 ? "T" : magnitude === 1e9 ? "B" : magnitude === 1e6 ? "M" : magnitude === 1e3 ? "k" : "";
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: magnitude === 1 ? 0 : 1 }).format(value / magnitude)}${suffix}`;
}

/** Preserve sub-minute resolution rather than showing every short duration as 0m. */
export function formatChartDuration(value: number, locale = "zh-CN") {
  const magnitude = value >= 3_600_000 ? 3_600_000 : value >= 60_000 ? 60_000 : value >= 1_000 ? 1_000 : 1;
  const suffix = magnitude === 3_600_000 ? "h" : magnitude === 60_000 ? "m" : magnitude === 1_000 ? "s" : "ms";
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: magnitude === 1 ? 0 : 3 }).format(value / magnitude)}${suffix}`;
}
export function formatDateTime(value: number | null | undefined, timezone: string, locale = "zh-CN") { return value == null ? "—" : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(value); }

export function formatComparison(comparison: AnalyticsComparisonResult, locale = "zh-CN") {
  if (comparison.status !== "available" || comparison.kind === null || comparison.delta === null) return comparison.status;
  if (comparison.kind === "percentage_points") return `${comparison.delta >= 0 ? "+" : ""}${(comparison.delta * 100).toFixed(1)}pp`;
  return `${comparison.delta >= 0 ? "+" : ""}${formatRatio(comparison.delta, locale)}`;
}

export type ResultReason = AnalyticsPartialReason | AnalyticsUnavailableReason;
export function resultReason(result: { status: "partial"; partialReason: AnalyticsPartialReason } | { status: "unavailable"; unavailableReason: AnalyticsUnavailableReason }): ResultReason { return result.status === "partial" ? result.partialReason : result.unavailableReason; }
