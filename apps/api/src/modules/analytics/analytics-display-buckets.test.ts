import assert from "node:assert/strict";
import test from "node:test";
import { HOUR_MS } from "./analytics-rollups.js";
import { planDisplayBuckets } from "./analytics-display-buckets.js";
import { resolveDashboardRange } from "./analytics.service.js";

function custom(from: string, to: string, timezone: string) {
  return planDisplayBuckets({ from: Date.parse(from), to: Date.parse(to), timezone, rangeKind: "custom" });
}

function preset(at: string, timezone: string) {
  const to = Date.parse(at);
  const range = resolveDashboardRange({ rangeKind: "preset_24h", timezone }, { rangeId: "test", asOf: to, reportingLagAnchor: to });
  assert.ok(!("ok" in range));
  const buckets = planDisplayBuckets({ ...range, rangeKind: "preset_24h" });
  assert.equal(buckets[0]?.from, range.from);
  assert.equal(buckets.at(-1)?.to, to);
  for (const [index, bucket] of buckets.entries()) {
    assert.ok(bucket.to > bucket.from);
    if (index > 0) assert.equal(buckets[index - 1]!.to, bucket.from);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, minute: "2-digit", second: "2-digit" }).formatToParts(bucket.from);
    assert.equal(parts.find((part) => part.type === "minute")?.value, "00");
    assert.equal(parts.find((part) => part.type === "second")?.value, "00");
    assert.equal(bucket.from % 1_000, 0);
  }
  assert.equal(buckets.reduce((total, bucket) => total + bucket.to - bucket.from, 0), to - range.from);
  return { range, buckets };
}

test("IANA local-day buckets preserve UTC filtering and represent DST 23/25-hour days", () => {
  const spring = custom("2024-03-09T05:00:00.000Z", "2024-03-11T04:00:00.000Z", "America/New_York");
  assert.deepEqual(spring.map((bucket) => bucket.to - bucket.from), [24 * HOUR_MS, 23 * HOUR_MS]);
  const fall = custom("2024-11-02T04:00:00.000Z", "2024-11-04T05:00:00.000Z", "America/New_York");
  assert.deepEqual(fall.map((bucket) => bucket.to - bucket.from), [24 * HOUR_MS, 25 * HOUR_MS]);
  const shanghai = custom("2024-03-09T16:00:00.000Z", "2024-03-11T16:00:00.000Z", "Asia/Shanghai");
  assert.deepEqual(shanghai.map((bucket) => bucket.to - bucket.from), [24 * HOUR_MS, 24 * HOUR_MS]);
});

test("24h starts at the next Shanghai local hour and retains the live partial hour", () => {
  const { range, buckets } = preset("2026-06-09T10:37:12.123+08:00", "Asia/Shanghai");
  assert.equal(range.from, Date.parse("2026-06-08T11:00:00+08:00"));
  assert.equal(buckets.length, 24);
  assert.deepEqual(buckets[0], { from: range.from, to: Date.parse("2026-06-08T12:00:00+08:00") });
  assert.equal(buckets.at(-1)?.from, Date.parse("2026-06-09T10:00:00+08:00"));
});

test("24h preserves an exact hour and rounds seconds/milliseconds upward", () => {
  for (const timezone of ["UTC", "Asia/Shanghai"]) {
    const exact = preset("2026-06-09T02:00:00.000Z", timezone);
    assert.equal(exact.range.from, exact.range.to - 24 * HOUR_MS);
    assert.equal(exact.buckets.length, 24);
    assert.ok(exact.buckets.every((bucket) => bucket.to - bucket.from === HOUR_MS));
    for (const at of ["2026-06-09T02:00:00.001Z", "2026-06-09T02:00:01.000Z"]) {
      const fractional = preset(at, timezone);
      assert.equal(fractional.range.from, Date.parse("2026-06-08T03:00:00Z"));
      assert.equal(fractional.buckets.length, 24);
    }
  }
});

test("24h respects half-hour and 45-minute IANA offsets rather than UTC hour boundaries", () => {
  for (const [timezone, at, first, last] of [
    ["Asia/Kolkata", "2026-06-09T10:37:12.123+05:30", "2026-06-08T11:00:00+05:30", "2026-06-09T10:00:00+05:30"],
    ["Asia/Kathmandu", "2026-06-09T10:37:12.123+05:45", "2026-06-08T11:00:00+05:45", "2026-06-09T10:00:00+05:45"],
  ]) {
    const { range, buckets } = preset(at!, timezone!);
    assert.equal(range.from, Date.parse(first!));
    assert.equal(buckets.at(-1)?.from, Date.parse(last!));
    assert.equal(buckets.length, 24);
  }
});

test("24h DST spring skips nonexistent hours and fall includes both real repeated hours", () => {
  const spring = preset("2024-03-10T08:37:00Z", "America/New_York");
  assert.equal(spring.range.from, Date.parse("2024-03-09T09:00:00Z"));
  assert.equal(spring.buckets.length, 24);
  assert.deepEqual(spring.buckets.find((bucket) => bucket.from === Date.parse("2024-03-10T06:00:00Z")), {
    from: Date.parse("2024-03-10T06:00:00Z"), to: Date.parse("2024-03-10T07:00:00Z"),
  });
  const fall = preset("2024-11-03T08:37:00Z", "America/New_York");
  assert.equal(fall.range.from, Date.parse("2024-11-02T09:00:00Z"));
  assert.equal(fall.buckets.length, 24);
  assert.ok(fall.buckets.some((bucket) => bucket.from === Date.parse("2024-11-03T05:00:00Z")));
  assert.ok(fall.buckets.some((bucket) => bucket.from === Date.parse("2024-11-03T06:00:00Z")));
});

test("24h half-hour DST uses real top-of-hour boundaries without forcing 24 buckets", () => {
  const spring = preset("2024-10-06T05:07:00Z", "Australia/Lord_Howe");
  assert.equal(spring.range.from, Date.parse("2024-10-05T05:30:00Z"));
  assert.ok(spring.buckets.some((bucket) => bucket.to - bucket.from === 1.5 * HOUR_MS));
  const fall = preset("2024-04-07T05:07:00Z", "Australia/Lord_Howe");
  assert.equal(fall.range.from, Date.parse("2024-04-06T06:00:00Z"));
  assert.ok(fall.buckets.some((bucket) => bucket.to - bucket.from === 1.5 * HOUR_MS));
  assert.equal(fall.buckets.length, 23);
});

test("24h aligns the reporting anchor, including a raw start inside a half-hour DST transition", () => {
  const anchor = Date.parse("2026-06-09T10:37:12.123+08:00");
  const range = resolveDashboardRange({ rangeKind: "preset_24h", timezone: "Asia/Shanghai" }, {
    rangeId: "lagged", asOf: anchor + HOUR_MS, reportingLagAnchor: anchor,
  });
  assert.ok(!("ok" in range));
  assert.equal(range.to, anchor);
  assert.equal(range.from, Date.parse("2026-06-08T11:00:00+08:00"));
  assert.equal(range.asOf, anchor + HOUR_MS);
  assert.equal(preset("2024-10-06T15:10:00Z", "Australia/Lord_Howe").range.from, Date.parse("2024-10-05T16:00:00Z"));
  assert.equal(preset("2024-04-07T15:10:00Z", "Australia/Lord_Howe").range.from, Date.parse("2024-04-06T15:30:00Z"));
});

test("short custom ranges retain their original unaligned elapsed-hour intervals", () => {
  const from = 123;
  const to = from + 24 * HOUR_MS;
  const range = resolveDashboardRange({ rangeKind: "custom", from, to, timezone: "Asia/Kathmandu" }, { rangeId: "test", asOf: to, reportingLagAnchor: to });
  assert.ok(!("ok" in range));
  assert.equal(range.from, from);
  const buckets = planDisplayBuckets({ ...range, rangeKind: "custom" });
  assert.equal(buckets.length, 24);
  assert.equal(buckets[0]?.from, from);
  assert.ok(buckets.every((bucket) => bucket.to - bucket.from === HOUR_MS));
});

test("7d/30d/90d keep rolling windows and local-midnight day boundaries", () => {
  const to = Date.parse("2026-06-09T10:37:12.123+08:00");
  for (const [rangeKind, days] of [["preset_7d", 7], ["preset_30d", 30], ["preset_90d", 90]] as const) {
    const range = resolveDashboardRange({ rangeKind, timezone: "Asia/Shanghai" }, { rangeId: "test", asOf: to, reportingLagAnchor: to });
    assert.ok(!("ok" in range));
    assert.equal(range.from, to - days * 24 * HOUR_MS);
    const buckets = planDisplayBuckets({ ...range, rangeKind });
    assert.equal(buckets.length, days + 1);
    assert.equal(buckets[0]?.from, range.from);
    assert.equal(buckets.at(-1)?.to, to);
    assert.equal(buckets.at(-1)?.from, Date.parse("2026-06-09T00:00:00+08:00"));
  }
});
