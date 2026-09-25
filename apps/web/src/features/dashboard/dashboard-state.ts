import { computed, ref } from "vue";
import type { AnalyticsRangeKind, DashboardQueryRequest, DashboardQuerySuccessResponse } from "@agent-workbench/shared";
import { DashboardApiError, queryDashboard, type DashboardClientErrorCode } from "./dashboard-api";
import { formatWallTime, validateCustomRange, type CustomRangeValidation } from "./dashboard-timezone";

export type DashboardQuery = (request: DashboardQueryRequest) => Promise<DashboardQuerySuccessResponse>;
const RANGE_STORAGE_KEY = "awb.dashboard.range.v1";
type CustomBounds = { from: number; to: number };
type SavedRange = { version: 1; rangeKind: AnalyticsRangeKind; custom: CustomBounds | null };
const presets: readonly AnalyticsRangeKind[] = ["preset_24h", "preset_7d", "preset_30d", "preset_90d"];

function isCustomBounds(value: unknown): value is CustomBounds {
  if (typeof value !== "object" || value === null) return false;
  const { from, to } = value as Record<string, unknown>;
  return typeof from === "number" && typeof to === "number" &&
    Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && from < to && to <= 8_640_000_000_000_000;
}

function readStoredRange(timezone: string) {
  try {
    const raw = localStorage.getItem(RANGE_STORAGE_KEY);
    if (raw === null || raw.length > 512) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const saved = value as Record<string, unknown>;
    if (saved.version !== 1 ||
        (saved.rangeKind !== "custom" && !presets.includes(saved.rangeKind as AnalyticsRangeKind)) ||
        (saved.custom !== null && !isCustomBounds(saved.custom))) return null;
    const presetWithoutCustom = { rangeKind: saved.rangeKind as AnalyticsRangeKind, custom: null, fromLocal: "", toLocal: "" };
    if (saved.custom === null) return saved.rangeKind === "custom" ? null : presetWithoutCustom;
    try {
      const fromLocal = formatWallTime(saved.custom.from, timezone);
      const toLocal = formatWallTime(saved.custom.to, timezone);
      const checked = validateCustomRange(fromLocal, toLocal, timezone);
      if (checked.valid && checked.from === saved.custom.from && checked.to === saved.custom.to) {
        return { rangeKind: saved.rangeKind as AnalyticsRangeKind, custom: saved.custom, fromLocal, toLocal };
      }
    } catch {
      // The saved instants may not be representable in the current browser zone.
    }
    // A stale custom draft must not discard an independently valid preset choice.
    return saved.rangeKind === "custom" ? null : presetWithoutCustom;
  } catch {
    // Storage may be blocked or corrupt; browser-local defaults remain usable.
    return null;
  }
}

function storeRange(value: SavedRange) {
  try { localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify(value)); } catch { /* Storage is optional. */ }
}

function browserTimezone() {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof timezone === "string" && timezone.trim()) {
      Intl.DateTimeFormat("en-US", { timeZone: timezone });
      return timezone;
    }
  } catch {
    // A missing or invalid browser timezone must not prevent the Dashboard from loading.
  }
  return "UTC";
}

export function createDashboardState(requestDashboard: DashboardQuery = queryDashboard) {
  const timezone = ref(browserTimezone());
  const saved = readStoredRange(timezone.value);
  const rangeKind = ref<AnalyticsRangeKind>(saved?.rangeKind ?? "preset_7d");
  const customFromLocal = ref(saved?.fromLocal ?? "");
  const customToLocal = ref(saved?.toLocal ?? "");
  let lastAppliedCustom = saved?.custom ?? null;
  const response = ref<DashboardQuerySuccessResponse | null>(null);
  const loading = ref(false);
  const stale = ref(false);
  const errorCode = ref<DashboardClientErrorCode | null>(null);
  const customValidation = computed<CustomRangeValidation>(() => validateCustomRange(customFromLocal.value, customToLocal.value, timezone.value));
  let sequence = 0;

  const request = computed<DashboardQueryRequest | null>(() => {
    if (rangeKind.value !== "custom") return { rangeKind: rangeKind.value, timezone: timezone.value };
    const validated = customValidation.value;
    return validated.valid ? { rangeKind: "custom", timezone: timezone.value, from: validated.from, to: validated.to } : null;
  });

  /** A local sequence is the sole write authority for responses. */
  function invalidate() {
    sequence += 1;
    response.value = null;
    loading.value = false;
    stale.value = true;
    errorCode.value = null;
  }

  function setRangeKind(next: AnalyticsRangeKind) {
    if (rangeKind.value === next) return;
    rangeKind.value = next;
    invalidate();
    if (next !== "custom") void refresh();
  }

  function setCustomInput(field: "from" | "to", value: string) {
    if (field === "from") customFromLocal.value = value; else customToLocal.value = value;
    invalidate();
  }

  async function refresh() {
    const body = request.value;
    if (!body) {
      errorCode.value = rangeKind.value === "custom" && !customValidation.value.valid ? customValidation.value.code : "ANALYTICS_RANGE_INVALID";
      return;
    }
    if (body.rangeKind === "custom") {
      lastAppliedCustom = { from: body.from, to: body.to };
      storeRange({ version: 1, rangeKind: "custom", custom: lastAppliedCustom });
    } else {
      storeRange({ version: 1, rangeKind: body.rangeKind, custom: lastAppliedCustom });
    }
    const requestSequence = ++sequence;
    loading.value = true;
    stale.value = false;
    errorCode.value = null;
    try {
      const next = await requestDashboard(body);
      const matchingCustomRange = body.rangeKind !== "custom" || (next.from === body.from && next.to === body.to);
      if (requestSequence !== sequence || next.timezone !== body.timezone || !matchingCustomRange) return;
      // rangeId is server audit/display metadata, not a client-side concurrency token.
      response.value = next;
    } catch (error) {
      if (requestSequence === sequence) errorCode.value = error instanceof DashboardApiError ? error.code : "NETWORK_ERROR";
    } finally {
      if (requestSequence === sequence) loading.value = false;
    }
  }

  return { rangeKind, timezone, customFromLocal, customToLocal, response, loading, stale, errorCode, customValidation, request, refresh, setRangeKind, setCustomInput, invalidate };
}
