import { computed, ref } from "vue";
import type { AnalyticsRangeKind, DashboardQueryRequest, DashboardQuerySuccessResponse } from "@agent-workbench/shared";
import { DashboardApiError, queryDashboard, type DashboardClientErrorCode } from "./dashboard-api";
import { validateCustomRange, type CustomRangeValidation } from "./dashboard-timezone";

export type DashboardQuery = (request: DashboardQueryRequest) => Promise<DashboardQuerySuccessResponse>;
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
  const rangeKind = ref<AnalyticsRangeKind>("preset_7d");
  const timezone = ref(browserTimezone());
  const customFromLocal = ref("");
  const customToLocal = ref("");
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
