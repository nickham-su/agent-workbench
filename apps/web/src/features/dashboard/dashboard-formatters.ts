import type { AnalyticsComparisonResult, AnalyticsPartialReason, AnalyticsUnavailableReason } from "@agent-workbench/shared";

export function formatCount(value: number | null | undefined, locale = "zh-CN") { return value == null ? "—" : new Intl.NumberFormat(locale).format(value); }
export function formatRatio(value: number | null | undefined, locale = "zh-CN") { return value == null ? "—" : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value); }
export function formatDuration(value: number | null | undefined) { if (value == null) return "—"; const minutes = Math.floor(value / 60_000); return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`; }
export function formatDateTime(value: number | null | undefined, timezone: string, locale = "zh-CN") { return value == null ? "—" : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(value); }

export function formatComparison(comparison: AnalyticsComparisonResult, locale = "zh-CN") {
  if (comparison.status !== "available" || comparison.kind === null || comparison.delta === null) return comparison.status;
  if (comparison.kind === "percentage_points") return `${comparison.delta >= 0 ? "+" : ""}${comparison.delta.toFixed(1)}pp`;
  return `${comparison.delta >= 0 ? "+" : ""}${formatRatio(comparison.delta, locale)}`;
}

export type ResultReason = AnalyticsPartialReason | AnalyticsUnavailableReason;
export function resultReason(result: { status: "partial"; partialReason: AnalyticsPartialReason } | { status: "unavailable"; unavailableReason: AnalyticsUnavailableReason }): ResultReason { return result.status === "partial" ? result.partialReason : result.unavailableReason; }
