import axios from "axios";
import type { DashboardErrorCode, DashboardQueryRequest, DashboardQuerySuccessResponse } from "@agent-workbench/shared";
import { apiClient } from "@/shared/api/api";

const DASHBOARD_ERROR_CODES = new Set<DashboardErrorCode>([
  "ANALYTICS_RANGE_INVALID", "ANALYTICS_RANGE_TOO_LARGE", "ANALYTICS_TIMEZONE_INVALID", "ANALYTICS_RANGE_NOT_READY", "ANALYTICS_UNAVAILABLE",
]);
export type DashboardClientErrorCode = DashboardErrorCode | "NETWORK_ERROR" | "CUSTOM_RANGE_REQUIRED" | "CUSTOM_RANGE_INVALID" | "CUSTOM_RANGE_DST_AMBIGUOUS" | "CUSTOM_RANGE_DST_NONEXISTENT" | "CUSTOM_RANGE_ORDER" | "CUSTOM_RANGE_TOO_LARGE";

export class DashboardApiError extends Error {
  constructor(public readonly code: DashboardClientErrorCode, public readonly status?: number) { super(code); }
}

export function knownDashboardErrorCode(value: unknown): DashboardErrorCode | null {
  return typeof value === "string" && DASHBOARD_ERROR_CODES.has(value as DashboardErrorCode) ? value as DashboardErrorCode : null;
}

/** Dashboard owns its response contract and never exposes transport diagnostics to the UI. */
export async function queryDashboard(request: DashboardQueryRequest): Promise<DashboardQuerySuccessResponse> {
  try {
    const response = await apiClient.post<DashboardQuerySuccessResponse>("/analytics/dashboard/query", request);
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const code = knownDashboardErrorCode(error.response?.data?.error?.code);
      if (code) throw new DashboardApiError(code, error.response?.status);
      if (error.response?.status === 503) throw new DashboardApiError("ANALYTICS_UNAVAILABLE", 503);
    }
    throw new DashboardApiError("NETWORK_ERROR");
  }
}
