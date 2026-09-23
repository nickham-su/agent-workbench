import type { DashboardErrorCode, DashboardQueryRequest } from "@agent-workbench/shared";

export const DASHBOARD_MAX_CUSTOM_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

const PRESET_DURATION_MS: Record<Exclude<DashboardQueryRequest["rangeKind"], "custom">, number> = {
  preset_24h: 24 * 60 * 60 * 1000,
  preset_7d: 7 * 24 * 60 * 60 * 1000,
  preset_30d: 30 * 24 * 60 * 60 * 1000,
  preset_90d: 90 * 24 * 60 * 60 * 1000
};

type InvalidDashboardQuery = { ok: false; code: DashboardErrorCode };
export type DashboardQueryInputValidation = InvalidDashboardQuery | { ok: true; request: DashboardQueryRequest };
export type ResolvedDashboardRange = {
  rangeId: string;
  from: number;
  to: number;
  asOf: number;
  timezone: string;
};

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isIanaTimezone(timezone: string) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * API-owned validation only. It intentionally does not establish reporting
 * readiness or response range metadata: both require the future Analytics DB
 * snapshot and must not be guessed by the API process.
 */
export function validateDashboardQueryInput(body: unknown): DashboardQueryInputValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "ANALYTICS_RANGE_INVALID" };
  }

  const request = body as Record<string, unknown>;
  const { rangeKind, timezone } = request;
  if (rangeKind !== "preset_24h" && rangeKind !== "preset_7d" && rangeKind !== "preset_30d" && rangeKind !== "preset_90d" && rangeKind !== "custom") {
    return { ok: false, code: "ANALYTICS_RANGE_INVALID" };
  }
  if (typeof timezone !== "string" || !isIanaTimezone(timezone)) {
    return { ok: false, code: "ANALYTICS_TIMEZONE_INVALID" };
  }

  const allowedKeys = rangeKind === "custom" ? ["rangeKind", "timezone", "from", "to"] : ["rangeKind", "timezone"];
  if (Object.keys(request).some((key) => !allowedKeys.includes(key))) {
    return { ok: false, code: "ANALYTICS_RANGE_INVALID" };
  }

  if (rangeKind !== "custom") {
    return { ok: true, request: { rangeKind, timezone } };
  }

  if (!hasOwn(request, "from") || !hasOwn(request, "to") || !isSafeInteger(request.from) || !isSafeInteger(request.to) || request.from >= request.to) {
    return { ok: false, code: "ANALYTICS_RANGE_INVALID" };
  }
  if (request.to - request.from > DASHBOARD_MAX_CUSTOM_RANGE_MS) {
    return { ok: false, code: "ANALYTICS_RANGE_TOO_LARGE" };
  }

  return { ok: true, request: { rangeKind, timezone, from: request.from, to: request.to } };
}

/**
 * Future Analytics-child helper. Calling this requires an authoritative query
 * snapshot, which supplies the reporting-lag anchor and response identity.
 */
export function resolveDashboardRange(
  request: DashboardQueryRequest,
  snapshot: { rangeId: string; asOf: number; reportingLagAnchor: number }
): ResolvedDashboardRange | InvalidDashboardQuery {
  if (!isSafeInteger(snapshot.asOf) || !isSafeInteger(snapshot.reportingLagAnchor) || snapshot.rangeId.length === 0) {
    return { ok: false, code: "ANALYTICS_UNAVAILABLE" };
  }

  if (request.rangeKind !== "custom") {
    return {
      rangeId: snapshot.rangeId,
      from: snapshot.reportingLagAnchor - PRESET_DURATION_MS[request.rangeKind],
      to: snapshot.reportingLagAnchor,
      asOf: snapshot.asOf,
      timezone: request.timezone
    };
  }
  if (request.to > snapshot.reportingLagAnchor) {
    return { ok: false, code: "ANALYTICS_RANGE_NOT_READY" };
  }
  return {
    rangeId: snapshot.rangeId,
    from: request.from,
    to: request.to,
    asOf: snapshot.asOf,
    timezone: request.timezone
  };
}
