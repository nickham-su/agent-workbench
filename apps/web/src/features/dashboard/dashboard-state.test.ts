import assert from "node:assert/strict";
import test from "node:test";
import type { DashboardQueryRequest, DashboardQuerySuccessResponse } from "@agent-workbench/shared";
import { dashboardSuccessFixture } from "./dashboard-fixture";
import { createDashboardState } from "./dashboard-state";

function response(rangeId: string, overrides: Partial<DashboardQuerySuccessResponse> = {}): DashboardQuerySuccessResponse {
  return { ...dashboardSuccessFixture, rangeId, ...overrides };
}
function responseRangeId(state: ReturnType<typeof createDashboardState>) { return state.response.value?.rangeId; }

const rangeStorageKey = "awb.dashboard.range.v1";
async function withLocalStorage<T>(run: (entries: Map<string, string>) => Promise<T>, initial?: string): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const entries = new Map<string, string>();
  if (initial !== undefined) entries.set(rangeStorageKey, initial);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    },
  });
  try { return await run(entries); }
  finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

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

test("localStorage 写入被拒绝不会阻止已保存的预设刷新", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => JSON.stringify({ version: 1, rangeKind: "preset_24h", custom: null }),
    setItem: () => { throw new Error("Storage write blocked"); },
  } });
  try {
    const requests: DashboardQueryRequest[] = [];
    const state = createDashboardState(async (request) => { requests.push(request); return response("write-blocked", { timezone: request.timezone }); });
    await state.refresh();
    assert.equal(state.response.value?.rangeId, "write-blocked");
    assert.equal(requests[0]?.rangeKind, "preset_24h");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
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

test("预设选项即时存储，重开后按缓存首次只发一个请求", async () => withLocalStorage(async (entries) => {
  const first = withBrowserTimezone("Asia/Shanghai", () => createDashboardState(async (request) => response("preset", { timezone: request.timezone })));
  first.setRangeKind("preset_30d");
  assert.deepEqual(JSON.parse(entries.get(rangeStorageKey)!), { version: 1, rangeKind: "preset_30d", custom: null });
  const requests: DashboardQueryRequest[] = [];
  const reopened = withBrowserTimezone("America/New_York", () => createDashboardState(async (request) => {
    requests.push(request);
    return response("restored", { timezone: request.timezone });
  }));
  assert.equal(reopened.rangeKind.value, "preset_30d");
  assert.equal(requests.length, 0);
  await reopened.refresh();
  assert.deepEqual(requests, [{ rangeKind: "preset_30d", timezone: "America/New_York" }]);
}));

test("仅提交有效自定义范围才存储；跨时区恢复同一绝对时间且保留上次自定义值", async () => withLocalStorage(async (entries) => {
  const first = withBrowserTimezone("America/New_York", () => createDashboardState(async (request) => {
    throw new Error(`Network failure for ${request.rangeKind}`);
  }));
  first.setRangeKind("custom");
  first.setCustomInput("from", "2024-01-01T00:00");
  first.setCustomInput("to", "2024-01-02T00:00");
  assert.equal(entries.has(rangeStorageKey), false);
  await first.refresh();
  const saved = JSON.parse(entries.get(rangeStorageKey)!);
  assert.deepEqual(saved, { version: 1, rangeKind: "custom", custom: { from: Date.UTC(2024, 0, 1, 5), to: Date.UTC(2024, 0, 2, 5) } });
  const requests: DashboardQueryRequest[] = [];
  const reopened = withBrowserTimezone("Asia/Shanghai", () => createDashboardState(async (request) => {
    requests.push(request);
    return response("restored-custom", { timezone: request.timezone, from: request.rangeKind === "custom" ? request.from : 1, to: request.rangeKind === "custom" ? request.to : 2 });
  }));
  assert.equal(reopened.rangeKind.value, "custom");
  assert.equal(reopened.customFromLocal.value, "2024-01-01T13:00");
  assert.equal(reopened.customToLocal.value, "2024-01-02T13:00");
  await reopened.refresh();
  assert.deepEqual(requests, [{ rangeKind: "custom", timezone: "Asia/Shanghai", from: saved.custom.from, to: saved.custom.to }]);

  reopened.setRangeKind("preset_24h");
  assert.deepEqual(JSON.parse(entries.get(rangeStorageKey)!), { version: 1, rangeKind: "preset_24h", custom: saved.custom });
  const restoredPreset = withBrowserTimezone("Asia/Shanghai", () => createDashboardState(async (request) => response("preset", { timezone: request.timezone })));
  assert.equal(restoredPreset.rangeKind.value, "preset_24h");
  assert.equal(restoredPreset.customFromLocal.value, "2024-01-01T13:00");
  assert.equal(restoredPreset.customToLocal.value, "2024-01-02T13:00");
}));

test("未应用的自定义选择和非法草稿不覆盖上次已应用选项", async () => withLocalStorage(async (entries) => {
  const first = createDashboardState(async (request) => response("preset", { timezone: request.timezone }));
  first.setRangeKind("preset_90d");
  first.setRangeKind("custom");
  first.setCustomInput("from", "2024-11-03T01:30");
  first.setCustomInput("to", "2024-01-02T00:00");
  await first.refresh();
  assert.equal(first.errorCode.value !== null, true);
  assert.deepEqual(JSON.parse(entries.get(rangeStorageKey)!), { version: 1, rangeKind: "preset_90d", custom: null });
  assert.equal(createDashboardState().rangeKind.value, "preset_90d");
}));

test("跨时区后自定义起点落在 DST 歧义小时则退回 7 天，不发错误请求", async () => withLocalStorage(async (entries) => {
  entries.set(rangeStorageKey, JSON.stringify({ version: 1, rangeKind: "custom", custom: {
    from: Date.UTC(2024, 10, 3, 5, 30), to: Date.UTC(2024, 10, 3, 8),
  } }));
  const requests: DashboardQueryRequest[] = [];
  const reopened = withBrowserTimezone("America/New_York", () => createDashboardState(async (request) => {
    requests.push(request);
    return response("fallback", { timezone: request.timezone });
  }));
  assert.equal(reopened.rangeKind.value, "preset_7d");
  assert.equal(reopened.customFromLocal.value, "");
  await reopened.refresh();
  assert.deepEqual(requests, [{ rangeKind: "preset_7d", timezone: "America/New_York" }]);
}));

test("附带旧自定义范围在新时区落入 DST 歧义小时，不影响已保存的预设", async () => withLocalStorage(async (entries) => {
  entries.set(rangeStorageKey, JSON.stringify({ version: 1, rangeKind: "preset_30d", custom: {
    from: Date.UTC(2024, 10, 3, 5, 30), to: Date.UTC(2024, 10, 3, 8),
  } }));
  const requests: DashboardQueryRequest[] = [];
  const reopened = withBrowserTimezone("America/New_York", () => createDashboardState(async (request) => {
    requests.push(request);
    return response("preset-restored", { timezone: request.timezone });
  }));
  assert.equal(reopened.rangeKind.value, "preset_30d");
  assert.equal(reopened.customFromLocal.value, "");
  assert.equal(reopened.customToLocal.value, "");
  assert.equal(requests.length, 0);
  await reopened.refresh();
  assert.deepEqual(requests, [{ rangeKind: "preset_30d", timezone: "America/New_York" }]);
  assert.deepEqual(JSON.parse(entries.get(rangeStorageKey)!), { version: 1, rangeKind: "preset_30d", custom: null });
}));

test("损坏、过期版本与字段不合法的缓存静默退回默认范围", async () => {
  const corrupt = ["{", JSON.stringify({ version: 0, rangeKind: "preset_30d", custom: null }),
    JSON.stringify({ version: 1, rangeKind: "unknown", custom: null }),
    JSON.stringify({ version: 1, rangeKind: "custom", custom: null }),
    JSON.stringify({ version: 1, rangeKind: "custom", custom: { from: "0", to: 10 } }),
    JSON.stringify({ version: 1, rangeKind: "custom", custom: { from: 10, to: 0 } }),
    JSON.stringify({ version: 1, rangeKind: "preset_7d", custom: { from: 0.5, to: 100 } }),
  ];
  for (const raw of corrupt) {
    await withLocalStorage(async () => {
      const restored = createDashboardState();
      assert.equal(restored.rangeKind.value, "preset_7d");
      assert.equal(restored.customFromLocal.value, "");
    }, raw);
  }
});

test("localStorage 访问被拒绝时仍可选择和刷新", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("Storage blocked"); } });
  try {
    const requests: DashboardQueryRequest[] = [];
    const state = createDashboardState(async (request) => { requests.push(request); return response("stored-unavailable", { timezone: request.timezone }); });
    state.setRangeKind("preset_30d");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.rangeKind.value, "preset_30d");
    assert.equal(requests.length, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
