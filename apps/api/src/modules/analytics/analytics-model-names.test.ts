import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { DashboardQuerySuccessResponseSchema, type DashboardQuerySuccessResponse } from "@agent-workbench/shared";
import { buildEmptyDashboardResponse } from "./analytics-empty-dashboard.js";
import { withConfiguredModelNames } from "./analytics-model-names.js";

function dashboard(rows: Array<{ provider: string; model: string; requests?: number }>): DashboardQuerySuccessResponse {
  const empty = buildEmptyDashboardResponse({ request: { rangeKind: "custom", timezone: "UTC", from: 1, to: 2 }, asOf: 2, states: [] });
  assert.equal(empty.kind, "success");
  if (empty.kind !== "success") throw new Error("fixture requires a valid range");
  return {
    ...empty,
    data: {
      ...empty.data,
      model: {
        ...empty.data.model,
        byModel: {
          status: "available", completeness: "complete", dataIncomplete: false,
          requiredDomains: ["model"], comparison: { status: "not_applicable", kind: null, delta: null },
          data: rows.map(({ provider, model, requests = 1 }) => ({
            provider, model, requests, successRate: null, timeoutRate: null,
            completedAverageDurationMs: null, reliableDurationSampleCount: 0,
            inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheHitRate: null,
          })),
        },
      },
    },
  };
}

test("current configured names use local IDs and only expose optional display labels", () => {
  const original = dashboard([
    { provider: "p1", model: "shared", requests: 2 },
    { provider: "p2", model: "shared", requests: 3 },
    { provider: "p1", model: "removed" },
    { provider: "old", model: "shared" },
  ]);
  const providers = [
    { id: "p1", name: "Provider One", models: [{ id: "shared", name: "Model One", providerModelId: "remote-id" }], options: { apiKey: "TEST_SENTINEL_DO_NOT_RETURN", baseURL: "http://local.invalid" } },
    { id: "p2", name: "Provider Two", models: [{ id: "shared", name: "Model Two" }], options: { apiKey: "TEST_SENTINEL_DO_NOT_RETURN" } },
  ];
  const named = withConfiguredModelNames(original, providers);
  assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, named));
  assert.equal(named.data.model.byModel.status, "available");
  assert.deepEqual(named.data.model.byModel.data.map(({ provider, providerName, model, modelName, requests }) => ({ provider, providerName, model, modelName, requests })), [
    { provider: "p1", providerName: "Provider One", model: "shared", modelName: "Model One", requests: 2 },
    { provider: "p2", providerName: "Provider Two", model: "shared", modelName: "Model Two", requests: 3 },
    { provider: "p1", providerName: "Provider One", model: "removed", modelName: undefined, requests: 1 },
    { provider: "old", providerName: undefined, model: "shared", modelName: undefined, requests: 1 },
  ]);
  assert.equal(JSON.stringify(named).includes("TEST_SENTINEL_DO_NOT_RETURN"), false);
  assert.equal(JSON.stringify(named).includes("http://local.invalid"), false);
  assert.equal(original.data.model.byModel.status, "available");
  assert.equal(original.data.model.byModel.data[0]?.providerName, undefined);
  const renamed = withConfiguredModelNames(original, [{ id: "p1", name: "Renamed", models: [] }]);
  assert.equal(renamed.data.model.byModel.status, "available");
  assert.equal(renamed.data.model.byModel.data[0]?.providerName, "Renamed");
});

test("unavailable and empty results preserve the child response; blank labels fall back to IDs", () => {
  const original = dashboard([]);
  assert.equal(withConfiguredModelNames(original, []), original);
  const unavailable = buildEmptyDashboardResponse({ request: { rangeKind: "custom", timezone: "UTC", from: 1, to: 2 }, asOf: 2, states: [] });
  assert.equal(unavailable.kind, "success");
  if (unavailable.kind !== "success") return;
  assert.equal(withConfiguredModelNames(unavailable, []), unavailable);
  const named = withConfiguredModelNames(dashboard([{ provider: "p", model: "m" }]), [{ id: "p", name: "  ", models: [{ id: "m", name: "  " }] }]);
  assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, named));
  if (named.data.model.byModel.status !== "unavailable") {
    assert.equal(named.data.model.byModel.data[0]?.providerName, undefined);
    assert.equal(named.data.model.byModel.data[0]?.modelName, undefined);
  }
});
