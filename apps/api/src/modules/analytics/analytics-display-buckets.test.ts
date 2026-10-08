import assert from "node:assert/strict";
import test from "node:test";
import { HOUR_MS } from "./analytics-rollups.js";
import { planDisplayBuckets } from "./analytics-display-buckets.js";

function custom(from: string, to: string, timezone: string) {
  return planDisplayBuckets({ from: Date.parse(from), to: Date.parse(to), timezone, rangeKind: "custom" });
}

test("IANA local-day buckets preserve UTC filtering and represent DST 23/25-hour days", () => {
  const spring = custom("2024-03-09T05:00:00.000Z", "2024-03-11T04:00:00.000Z", "America/New_York");
  assert.deepEqual(spring.map((bucket) => bucket.to - bucket.from), [24 * HOUR_MS, 23 * HOUR_MS]);

  const fall = custom("2024-11-02T04:00:00.000Z", "2024-11-04T05:00:00.000Z", "America/New_York");
  assert.deepEqual(fall.map((bucket) => bucket.to - bucket.from), [24 * HOUR_MS, 25 * HOUR_MS]);

  const shanghai = custom("2024-03-09T16:00:00.000Z", "2024-03-11T16:00:00.000Z", "Asia/Shanghai");
  assert.deepEqual(shanghai.map((bucket) => bucket.to - bucket.from), [24 * HOUR_MS, 24 * HOUR_MS]);
});

test("24-hour presentation always uses exact UTC hour intervals", () => {
  const from = 123;
  const to = from + 24 * HOUR_MS;
  const buckets = planDisplayBuckets({ from, to, timezone: "America/New_York", rangeKind: "preset_24h" });
  assert.equal(buckets.length, 24);
  assert.equal(buckets[0]?.from, from);
  assert.equal(buckets.at(-1)?.to, to);
  assert.ok(buckets.every((bucket) => bucket.to > bucket.from && bucket.to - bucket.from <= HOUR_MS));
});
