import assert from "node:assert/strict";
import test from "node:test";
import { knownDashboardErrorCode } from "./dashboard-api";

test("Dashboard API 仅接受合同内错误码，未知 code 不进入 UI", () => {
  assert.equal(knownDashboardErrorCode("ANALYTICS_UNAVAILABLE"), "ANALYTICS_UNAVAILABLE");
  assert.equal(knownDashboardErrorCode("SERVER_STACK_TRACE"), null);
  assert.equal(knownDashboardErrorCode({ code: "ANALYTICS_UNAVAILABLE" }), null);
});
