import { Value } from "@sinclair/typebox/value";
import { UtcScheduleSchema } from "./contracts/scheduled-tasks.js";
import type { UtcSchedule } from "./contracts/scheduled-tasks.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const mod = (value: number, size: number) => ((value % size) + size) % size;

export class ScheduleInvalidError extends Error {
  readonly code = "SCHEDULE_INVALID";
  constructor() { super("Invalid UTC schedule"); }
}

/** Parse, validate and canonicalize untrusted input; no local timezone or system clock. */
export function normalizeSchedule(input: unknown): UtcSchedule {
  if (!Value.Check(UtcScheduleSchema, input)) throw new ScheduleInvalidError();
  const schedule = input as UtcSchedule;
  if (schedule.kind === "hourly") {
    return { kind: "hourly", minutesUtc: [...new Set(schedule.minutesUtc)].sort((a, b) => a - b) };
  }
  if (schedule.kind === "daily") {
    return { kind: "daily", minutesOfDayUtc: [...new Set(schedule.minutesOfDayUtc)].sort((a, b) => a - b) };
  }
  const slots = [...new Map(schedule.slotsUtc.map((slot) => [
    `${slot.weekdayUtc}:${slot.minuteOfDayUtc}`, { weekdayUtc: slot.weekdayUtc, minuteOfDayUtc: slot.minuteOfDayUtc }
  ])).values()].sort((a, b) => a.weekdayUtc - b.weekdayUtc || a.minuteOfDayUtc - b.minuteOfDayUtc);
  return { kind: "weekly", slotsUtc: slots };
}

/** First UTC instant strictly after nowMs, regardless of the host timezone. */
export function nextRunAt(schedule: UtcSchedule, nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new ScheduleInvalidError();
  const canonical = normalizeSchedule(schedule);
  const period = canonical.kind === "hourly" ? HOUR_MS : canonical.kind === "daily" ? DAY_MS : WEEK_MS;
  const offsets = canonical.kind === "hourly" ? canonical.minutesUtc.map((v) => v * MINUTE_MS)
    : canonical.kind === "daily" ? canonical.minutesOfDayUtc.map((v) => v * MINUTE_MS)
    // Unix epoch (1970-01-01) was a Thursday; shift Sunday-based weekday into epoch weeks.
    : canonical.slotsUtc.map((v) => mod(v.weekdayUtc - 4, 7) * DAY_MS + v.minuteOfDayUtc * MINUTE_MS);
  const base = Math.floor(nowMs / period) * period;
  const future = Math.min(...offsets.map((offset) => {
    const instant = base + offset;
    return instant > nowMs ? instant : instant + period;
  }));
  if (!Number.isSafeInteger(future)) throw new ScheduleInvalidError();
  return future;
}

export type LocalWeeklySlot = { weekday: number; minuteOfDay: number };
export type LocalSchedule =
  | { kind: "hourly"; minutes: number[] }
  | { kind: "daily"; minutesOfDay: number[] }
  | { kind: "weekly"; slots: LocalWeeklySlot[] };
/** offsetMinutes must be captured ONCE per form submission via Date.getTimezoneOffset(). */
export function localToUtcSchedule(input: LocalSchedule, offsetMinutes: number): UtcSchedule {
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 1440) throw new ScheduleInvalidError();
  if (input.kind === "hourly") {
    if (!input.minutes.length || input.minutes.length > 60 || input.minutes.some((v) => !Number.isInteger(v) || v < 0 || v > 59)) throw new ScheduleInvalidError();
    return normalizeSchedule({ kind: "hourly", minutesUtc: input.minutes.map((v) => mod(v + offsetMinutes, 60)) });
  }
  if (input.kind === "daily") {
    if (!input.minutesOfDay.length || input.minutesOfDay.length > 1440 || input.minutesOfDay.some((v) => !Number.isInteger(v) || v < 0 || v > 1439)) throw new ScheduleInvalidError();
    return normalizeSchedule({ kind: "daily", minutesOfDayUtc: input.minutesOfDay.map((v) => mod(v + offsetMinutes, 1440)) });
  }
  if (!("slots" in input) || !Array.isArray(input.slots) || input.slots.length === 0 || input.slots.length > 10080 || input.slots.some((v) =>
    !Number.isInteger(v.weekday) || v.weekday < 0 || v.weekday > 6 || !Number.isInteger(v.minuteOfDay) || v.minuteOfDay < 0 || v.minuteOfDay > 1439
  )) throw new ScheduleInvalidError();
  return normalizeSchedule({ kind: "weekly", slotsUtc: input.slots.map((slot) => {
    const raw = slot.minuteOfDay + offsetMinutes;
    return { weekdayUtc: mod(slot.weekday + Math.floor(raw / 1440), 7), minuteOfDayUtc: mod(raw, 1440) };
  }) });
}

/** Inverse display conversion, using one current offset for the entire schedule. */
export function utcToLocalSchedule(schedule: UtcSchedule, offsetMinutes: number): LocalSchedule {
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 1440) throw new ScheduleInvalidError();
  const canonical = normalizeSchedule(schedule);
  if (canonical.kind === "hourly") {
    return { kind: "hourly", minutes: canonical.minutesUtc.map((v) => mod(v - offsetMinutes, 60)).sort((a, b) => a - b) };
  }
  if (canonical.kind === "daily") {
    return { kind: "daily", minutesOfDay: canonical.minutesOfDayUtc.map((v) => mod(v - offsetMinutes, 1440)).sort((a, b) => a - b) };
  }
  return { kind: "weekly", slots: canonical.slotsUtc.map((slot) => {
    const raw = slot.minuteOfDayUtc - offsetMinutes;
    return { weekday: mod(slot.weekdayUtc + Math.floor(raw / 1440), 7), minuteOfDay: mod(raw, 1440) };
  }).sort((a, b) => a.weekday - b.weekday || a.minuteOfDay - b.minuteOfDay) };
}
