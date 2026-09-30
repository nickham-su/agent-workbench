import assert from "node:assert/strict";
import { test } from "node:test";
import swagger from "@fastify/swagger";
import Fastify from "fastify";
import { Value } from "@sinclair/typebox/value";
import { DashboardQuerySuccessResponseSchema } from "@agent-workbench/shared";
import { buildEmptyDashboardResponse } from "./analytics-empty-dashboard.js";
import { registerAnalyticsRoutes } from "./analytics.routes.js";
import { DASHBOARD_MAX_CUSTOM_RANGE_MS, resolveDashboardRange, validateDashboardQueryInput } from "./analytics.service.js";

async function createAnalyticsTestApp() {
  const app = Fastify();
  await app.register(swagger, { openapi: { info: { title: "test", version: "1" } } });
  await registerAnalyticsRoutes(app, {} as any);
  await app.ready();
  return app;
}

test("dashboard query exposes the single documented POST endpoint and safe unavailable response", async (t) => {
  const app = await createAnalyticsTestApp();
  t.after(() => app.close());

  for (const payload of [
    { rangeKind: "preset_7d", timezone: "Asia/Shanghai" },
    { rangeKind: "custom", timezone: "UTC", from: 1, to: 2 }
  ]) {
    const response = await app.inject({ method: "POST", url: "/api/analytics/dashboard/query", payload });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } });
  }

  const spec = (app as any).swagger();
  const endpoint = spec.paths["/api/analytics/dashboard/query"];
  assert.deepEqual(Object.keys(endpoint), ["post"]);
  assert.deepEqual(Object.keys(endpoint.post.responses).sort(), ["200", "400", "503"]);
  assert.equal(endpoint.post.tags[0], "analytics");
  const requestSchema = endpoint.post.requestBody.content["application/json"].schema;
  assert.equal(requestSchema.anyOf.length, 2);
  const [preset, custom] = requestSchema.anyOf;
  assert.equal(preset.additionalProperties, false);
  assert.deepEqual(preset.required, ["rangeKind", "timezone"]);
  assert.deepEqual(preset.properties.rangeKind.anyOf.map((item: any) => item.enum[0]), ["preset_24h", "preset_7d", "preset_30d", "preset_90d"]);
  assert.equal(custom.additionalProperties, false);
  assert.deepEqual(custom.required, ["rangeKind", "timezone", "from", "to"]);
  assert.deepEqual(custom.properties.rangeKind.enum, ["custom"]);
  assert.equal(custom.properties.from.type, "integer");
  assert.equal(custom.properties.to.type, "integer");
});

test("dashboard query keeps real Fastify custom bodies intact and maps invalid input to controlled 400 errors", async (t) => {
  const app = await createAnalyticsTestApp();
  t.after(() => app.close());

  const cases: Array<{ payload: unknown; code: string }> = [
    { payload: { rangeKind: "preset_7d", timezone: "UTC", from: 1 }, code: "ANALYTICS_RANGE_INVALID" },
    { payload: { rangeKind: "preset_7d", timezone: "UTC", ignored: true }, code: "ANALYTICS_RANGE_INVALID" },
    { payload: { rangeKind: "custom", timezone: "UTC", from: 1 }, code: "ANALYTICS_RANGE_INVALID" },
    { payload: { rangeKind: "custom", timezone: "UTC", from: 2, to: 2 }, code: "ANALYTICS_RANGE_INVALID" },
    { payload: { rangeKind: "custom", timezone: "UTC", from: 0, to: DASHBOARD_MAX_CUSTOM_RANGE_MS + 1 }, code: "ANALYTICS_RANGE_TOO_LARGE" },
    { payload: { rangeKind: "preset_24h", timezone: "Not/A_Zone" }, code: "ANALYTICS_TIMEZONE_INVALID" }
  ];

  for (const { payload, code } of cases) {
    const response = await app.inject({ method: "POST", url: "/api/analytics/dashboard/query", payload: payload as Record<string, unknown> });
    assert.equal(response.statusCode, 400, code);
    assert.deepEqual(response.json(), { kind: "error", error: { code } });
    assert.equal("message" in response.json(), false);
  }
});

test("input validation is separate from future Analytics snapshot range resolution", () => {
  const custom = validateDashboardQueryInput({ rangeKind: "custom", timezone: "UTC", from: 10, to: 20 });
  assert.deepEqual(custom, { ok: true, request: { rangeKind: "custom", timezone: "UTC", from: 10, to: 20 } });
  if (!custom.ok) throw new Error("test input must be valid");

  assert.deepEqual(
    resolveDashboardRange(custom.request, { rangeId: "range-2", asOf: 30, reportingLagAnchor: 20 }),
    { rangeId: "range-2", from: 10, to: 20, asOf: 30, timezone: "UTC" }
  );
  assert.deepEqual(
    resolveDashboardRange(custom.request, { rangeId: "range-2", asOf: 30, reportingLagAnchor: 19 }),
    { ok: false, code: "ANALYTICS_RANGE_NOT_READY" }
  );
  assert.deepEqual(
    validateDashboardQueryInput({ rangeKind: "custom", timezone: "UTC", from: Number.MAX_SAFE_INTEGER + 1, to: Number.MAX_SAFE_INTEGER + 2 }),
    { ok: false, code: "ANALYTICS_RANGE_INVALID" }
  );
});

test("dashboard success response enriches only model labels and survives settings failures", async (t) => {
  const base = buildEmptyDashboardResponse({ request: { rangeKind: "custom", timezone: "UTC", from: 1, to: 2 }, asOf: 2, states: [] });
  assert.equal(base.kind, "success");
  if (base.kind !== "success") return;
  const response = {
    ...base,
    data: { ...base.data, model: { ...base.data.model, byModel: {
      status: "available" as const, completeness: "complete" as const, dataIncomplete: false as const,
      requiredDomains: ["model" as const], comparison: { status: "not_applicable" as const, kind: null, delta: null },
      data: [{ provider: "provider-id", model: "local-id", requests: 1, successRate: null, timeoutRate: null,
        completedAverageDurationMs: null, reliableDurationSampleCount: 0, inputTokens: null, outputTokens: null,
        totalTokens: null, cacheReadTokens: null, cacheHitRate: null }],
    } } },
  };
  assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, response));

  const sentinel = "TEST_NONSECRET_SENTINEL";
  let providerName = "Friendly Provider";
  let failRead = false;
  const context = { db: { prepare: () => ({ get: () => {
    if (failRead) throw new Error("test settings read failure");
    return { key: "agent_providers_v1", valueJson: JSON.stringify({ default: null, providers: [{
      id: "provider-id", name: providerName, npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://example.invalid", apiKey: sentinel },
      models: [{ id: "local-id", providerModelId: "remote-id", name: "Friendly Model", contextWindowTokens: 128000 }],
    }] }), updatedAt: 1 };
  } }) } } as any;
  const app = Fastify();
  await registerAnalyticsRoutes(app, context, { query: async () => response } as any);
  await app.ready();
  t.after(() => app.close());
  const query = async () => app.inject({ method: "POST", url: "/api/analytics/dashboard/query", payload: { rangeKind: "custom", timezone: "UTC", from: 1, to: 2 } });

  const first = await query();
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.includes(sentinel), false);
  assert.equal(first.body.includes("https://example.invalid"), false);
  assert.ok(Value.Check(DashboardQuerySuccessResponseSchema, first.json()));
  assert.deepEqual(first.json().data.model.byModel.data[0], {
    ...response.data.model.byModel.data[0], providerName, modelName: "Friendly Model",
  });

  providerName = "Renamed Provider";
  assert.equal((await query()).json().data.model.byModel.data[0].providerName, providerName);
  failRead = true;
  const fallback = await query();
  assert.equal(fallback.statusCode, 200);
  assert.deepEqual(fallback.json().data.model.byModel.data[0], response.data.model.byModel.data[0]);
});
