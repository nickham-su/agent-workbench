import { HOUR_MS } from "./analytics-rollups.js";

const MINUTE_MS = 60_000;
const hourFormatters = new Map<string, Intl.DateTimeFormat>();

/** First real local 00-minute boundary at or after the supplied UTC instant. */
export function ceilLocalHour(value: number, timezone: string): number {
  let formatter = hourFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      minute: "2-digit",
      second: "2-digit",
    });
    hourFormatters.set(timezone, formatter);
  }

  let cursor = value;
  for (;;) {
    const parts = formatter.formatToParts(cursor);
    const minute = Number(parts.find((part) => part.type === "minute")!.value);
    const second = Number(parts.find((part) => part.type === "second")!.value);
    const millisecond = ((cursor % 1_000) + 1_000) % 1_000;
    const remainder = minute * MINUTE_MS + second * 1_000 + millisecond;
    if (remainder === 0) return cursor;
    // Recheck the local clock at least every minute. Adding a fixed elapsed
    // hour would miss offset changes, notably Lord Howe's half-hour DST.
    cursor += Math.min(MINUTE_MS, HOUR_MS - remainder);
  }
}
