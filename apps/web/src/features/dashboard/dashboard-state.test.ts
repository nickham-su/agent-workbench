import assert from "node:assert/strict";
import test from "node:test";
import type { DashboardQueryRequest, DashboardQuerySuccessResponse } from "@agent-workbench/shared";
import { dashboardSuccessFixture } from "./dashboard-fixture";
import { createDashboardState } from "./dashboard-state";

function response(rangeId: string, overrides: Partial<DashboardQuerySuccessResponse> = {}): DashboardQuerySuccessResponse {
  return { ...dashboardSuccessFixture, rangeId, ...overrides };
}
function responseRangeId(state: ReturnType<typeof createDashboardState>) { return state.response.value?.rangeId; }

/** Replace only the browser's no-argument timezone lookup; keep IANA validation real. */
function withBrowserTimezone<T>(timezone: string | null, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(Intl, "DateTimeFormat");
  const dateTimeFormat = Intl.DateTimeFormat;
  Object.defineProperty(Intl, "DateTimeFormat", {
    configurable: true,
    value: function mockDateTimeFormat(...args: Parameters<typeof Intl.DateTimeFormat>) {
      if (args.length) return new dateTimeFormat(...args);
      if (timezone === "throws") throw new Error("Browser timezone lookup failed");
      if (timezone === "optionsThrow") return { resolvedOptions: () => { throw new Error("Browser timezone options failed"); } };
      return { resolvedOptions: () => ({ timeZone: timezone }) };
    },
  });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(Intl, "DateTimeFormat", original);
  }
}

test("默认使用 preset_7d 和浏览器本地时区，首次刷新只发出一个 POST", async () => {
  const requests: DashboardQueryRequest[] = [];
  const state = withBrowserTimezone("Asia/Shanghai", () => createDashboardState(async (request) => {
    requests.push(request);
    return response("range-1", { timezone: request.timezone });
  }));
  await state.refresh();
  assert.deepEqual(requests, [{ rangeKind: "preset_7d", timezone: "Asia/Shanghai" }]);
  assert.equal(state.response.value?.rangeId, "range-1");
});

test("浏览器时区查找抛错、缺失或无效时回退 UTC", async () => {
  for (const candidate of ["throws", "optionsThrow", null, "", "Invalid/Zone"] as const) {
    const requests: DashboardQueryRequest[] = [];
    const state = withBrowserTimezone(candidate, () => createDashboardState(async (request) => {
      requests.push(request);
      return response("range-fallback", { timezone: request.timezone });
    }));
    await state.refresh();
    assert.deepEqual(requests, [{ rangeKind: "preset_7d", timezone: "UTC" }]);
    assert.equal(state.response.value?.rangeId, "range-fallback");
  }
});

test("preset 自动单次刷新并以本地 sequence 丢弃旧响应", async () => {
  let resolveOld!: (value: DashboardQuerySuccessResponse) => void;
  const old = new Promise<DashboardQuerySuccessResponse>((resolve) => { resolveOld = resolve; });
  const requests: DashboardQueryRequest[] = [];
  const state = createDashboardState((request) => {
    requests.push(request);
    return requests.length === 1 ? old : Promise.resolve(response(`range-${requests.length}`, { timezone: request.timezone }));
  });
  const pending = state.refresh();
  state.setRangeKind("preset_30d");
  assert.equal(state.response.value, null);
  assert.equal(state.stale.value, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].timezone, requests[0].timezone);
  assert.equal(responseRangeId(state), "range-2");
  resolveOld(response("old-range"));
  await pending;
  assert.equal(responseRangeId(state), "range-2");
});

test("custom 编辑不请求，Apply 恰好一次且旧响应不能覆盖", async () => {
  let firstResolve!: (value: DashboardQuerySuccessResponse) => void;
  const first = new Promise<DashboardQuerySuccessResponse>((resolve) => { firstResolve = resolve; });
  let calls = 0;
  const state = createDashboardState((request) => {
    if (++calls === 1) return first;
    return Promise.resolve(response("new-range", { timezone: request.timezone, from: request.rangeKind === "custom" ? request.from : 1, to: request.rangeKind === "custom" ? request.to : 2 }));
  });
  const pending = state.refresh();
  state.setRangeKind("custom");
  state.setCustomInput("from", "2024-01-01T00:00");
  state.setCustomInput("to", "2024-01-02T00:00");
  assert.equal(calls, 1);
  await state.refresh();
  assert.equal(calls, 2);
  firstResolve(response("old-range"));
  await pending;
  assert.equal(state.response.value?.rangeId, "new-range");
});

test("custom 用浏览器时区解析本地时间，DST 不存在或歧义时不请求", async () => {
  const requests: DashboardQueryRequest[] = [];
  const state = withBrowserTimezone("America/New_York", () => createDashboardState(async (request) => {
    requests.push(request);
    return response("custom-range", { timezone: request.timezone, from: request.rangeKind === "custom" ? request.from : 1, to: request.rangeKind === "custom" ? request.to : 2 });
  }));
  state.setRangeKind("custom");
  state.setCustomInput("from", "2024-03-10T02:30");
  state.setCustomInput("to", "2024-03-10T03:30");
  await state.refresh();
  assert.equal(state.errorCode.value, "CUSTOM_RANGE_DST_NONEXISTENT");
  assert.equal(requests.length, 0);

  state.setCustomInput("from", "2024-11-03T01:30");
  state.setCustomInput("to", "2024-11-03T02:30");
  await state.refresh();
  assert.equal(state.errorCode.value, "CUSTOM_RANGE_DST_AMBIGUOUS");
  assert.equal(requests.length, 0);

  state.setCustomInput("from", "2024-01-01T00:00");
  state.setCustomInput("to", "2024-01-02T00:00");
  await state.refresh();
  assert.deepEqual(requests, [{
    rangeKind: "custom", timezone: "America/New_York",
    from: Date.UTC(2024, 0, 1, 5), to: Date.UTC(2024, 0, 2, 5),
  }]);
});

test("无效 custom 不发请求，展示受控本地错误", async () => {
  let calls = 0;
  const state = createDashboardState(async () => { calls++; return response("unexpected"); });
  state.setRangeKind("custom");
  state.setCustomInput("from", "2024-01-02T00:00");
  state.setCustomInput("to", "2024-01-01T00:00");
  await state.refresh();
  assert.equal(calls, 0);
  assert.equal(state.errorCode.value, "CUSTOM_RANGE_ORDER");
});
