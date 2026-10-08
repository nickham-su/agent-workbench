import assert from "node:assert/strict";
import { test } from "node:test";
import { isAnalyticsChildMessage, isAnalyticsParentMessage } from "./analytics.protocol.js";

test("Analytics IPC accepts only closed discriminated DTO messages", () => {
  assert.equal(isAnalyticsParentMessage({ type: "initialize", requestId: "start-1" }), true);
  assert.equal(isAnalyticsParentMessage({ type: "initialize", requestId: "start-1", dataDir: "/secret" }), false);
  assert.equal(isAnalyticsParentMessage({ type: "dashboard_query", requestId: "query-1", request: { rangeKind: "preset_7d", timezone: "UTC" } }), true);
  assert.equal(isAnalyticsParentMessage({ type: "dashboard_query", requestId: "query-1", request: { rangeKind: "preset_7d", timezone: "UTC", extra: true } }), false);
  assert.equal(isAnalyticsParentMessage({ type: "unknown", requestId: "x" }), false);

  assert.equal(isAnalyticsChildMessage({ type: "ready", requestId: "start-1" }), true);
  assert.equal(isAnalyticsChildMessage({ type: "ready", requestId: "start-1", stack: "nope" }), false);
  assert.equal(isAnalyticsChildMessage({ type: "dashboard_result", requestId: "query-1", response: { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } } }), true);
  assert.equal(isAnalyticsChildMessage({ type: "dashboard_result", requestId: "query-1", response: { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE", message: "leak" } } }), false);
  assert.equal(isAnalyticsChildMessage({ type: "dashboard_result", requestId: "query-1", response: { kind: "success" } }), false);
});
