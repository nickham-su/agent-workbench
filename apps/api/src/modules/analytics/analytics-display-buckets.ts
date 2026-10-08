import type { AnalyticsRangeKind } from "@agent-workbench/shared";
import { HOUR_MS } from "./analytics-rollups.js";

export type DisplayBucket = { from: number; to: number };

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayKey(value: number, timezone: string) {
  let formatter = dayFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    dayFormatters.set(timezone, formatter);
  }
  return formatter.format(value);
}

function transitionAfter(from: number, to: number, previousDay: string, timezone: string) {
  let low = from;
  let high = to;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (dayKey(middle, timezone) === previousDay) low = middle;
    else high = middle;
  }
  return high;
}

function hourlyBuckets(from: number, to: number): DisplayBucket[] {
  const buckets: DisplayBucket[] = [];
  for (let cursor = from; cursor < to; cursor += HOUR_MS) {
    buckets.push({ from: Math.max(from, cursor), to: Math.min(to, cursor + HOUR_MS) });
  }
  return buckets;
}

/**
 * Business facts are always filtered in UTC. This planner only determines
 * presentation intervals. Long ranges follow IANA local calendar days, so a
 * daylight-saving day naturally spans 23 or 25 elapsed hours.
 */
export function planDisplayBuckets(input: {
  from: number;
  to: number;
  timezone: string;
  rangeKind: AnalyticsRangeKind;
}): DisplayBucket[] {
  if (input.to <= input.from) return [];
  if (input.rangeKind === "preset_24h" || input.to - input.from <= 24 * HOUR_MS) return hourlyBuckets(input.from, input.to);

  const boundaries = [input.from];
  let cursor = input.from;
  let currentDay = dayKey(cursor, input.timezone);
  while (cursor < input.to) {
    const next = Math.min(input.to, cursor + HOUR_MS);
    const nextDay = dayKey(next, input.timezone);
    if (nextDay !== currentDay) {
      const boundary = transitionAfter(cursor, next, currentDay, input.timezone);
      if (boundary > boundaries.at(-1)!) boundaries.push(boundary);
      currentDay = nextDay;
    }
    cursor = next;
  }
  if (boundaries.at(-1)! < input.to) boundaries.push(input.to);
  return boundaries.slice(0, -1).map((from, index) => ({ from, to: boundaries[index + 1]! }));
}
