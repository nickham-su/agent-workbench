import type { InjectionKey } from "vue";
import type { DashboardQuery } from "./dashboard-state";

/** Test seam only; production falls back to the Dashboard API client. */
export const dashboardQueryKey: InjectionKey<DashboardQuery> = Symbol("dashboard-query");
