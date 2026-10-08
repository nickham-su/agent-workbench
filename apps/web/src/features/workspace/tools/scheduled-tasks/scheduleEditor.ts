import { localToUtcSchedule, nextRunAt, type LocalSchedule, type UtcSchedule } from "@agent-workbench/shared";

export type WeeklyEditor = { mode: "grid"; weekdays: number[]; times: number[] } | { mode: "pairs"; slots: { weekday: number; minuteOfDay: number }[] };
export type ScheduleEditor = { kind: "hourly"; minutes: number[] } | { kind: "daily"; minutesOfDay: number[] } | ({ kind: "weekly" } & WeeklyEditor);
const mod = (n: number, size: number) => ((n % size) + size) % size;
const sorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
export const formatMinute = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
export const parseMinute = (value: string): number | null => {
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour! < 24 && minute! < 60 ? hour! * 60 + minute! : null;
};
export function toLocalEditor(schedule: UtcSchedule, offset: number): ScheduleEditor {
  if (schedule.kind === "hourly") return { kind: "hourly", minutes: sorted(schedule.minutesUtc.map((n) => mod(n - offset, 60))) };
  if (schedule.kind === "daily") return { kind: "daily", minutesOfDay: sorted(schedule.minutesOfDayUtc.map((n) => mod(n - offset, 1440))) };
  const slots = schedule.slotsUtc.map((slot) => {
    const raw = slot.minuteOfDayUtc - offset;
    return { weekday: mod(slot.weekdayUtc + Math.floor(raw / 1440), 7), minuteOfDay: mod(raw, 1440) };
  }).sort((a, b) => a.weekday - b.weekday || a.minuteOfDay - b.minuteOfDay);
  const weekdays = sorted(slots.map((s) => s.weekday));
  const times = sorted(slots.map((s) => s.minuteOfDay));
  if (weekdays.length * times.length === slots.length && weekdays.every((weekday) => times.every((minuteOfDay) =>
    slots.some((s) => s.weekday === weekday && s.minuteOfDay === minuteOfDay)))) {
    return { kind: "weekly", mode: "grid", weekdays, times };
  }
  return { kind: "weekly", mode: "pairs", slots };
}
export function editorToLocal(editor: ScheduleEditor): LocalSchedule {
  if (editor.kind === "hourly") return { kind: "hourly", minutes: editor.minutes };
  if (editor.kind === "daily") return { kind: "daily", minutesOfDay: editor.minutesOfDay };
  return { kind: "weekly", slots: editor.mode === "pairs" ? editor.slots : editor.weekdays.flatMap((weekday) => editor.times.map((minuteOfDay) => ({ weekday, minuteOfDay }))) };
}
/** Caller captures getTimezoneOffset once, immediately before submit. */
export function editorToUtc(editor: ScheduleEditor, offset: number): UtcSchedule { return localToUtcSchedule(editorToLocal(editor), offset); }
export function nextThreePreview(schedule: UtcSchedule, now: number, format: (date: Date) => string = (date) => date.toLocaleString()): string[] {
  const result: string[] = [];
  for (let i = 0; i < 3; i++) { now = nextRunAt(schedule, now); result.push(format(new Date(now))); }
  return result;
}
export const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export function summarize(schedule: UtcSchedule, offset: number): string {
  const editor = toLocalEditor(schedule, offset);
  if (editor.kind === "hourly") return `每小时 ${editor.minutes.map((n) => `${String(n).padStart(2, "0")} 分`).join("、")}`;
  if (editor.kind === "daily") return `每天 ${editor.minutesOfDay.map(formatMinute).join("、")}`;
  const pairs = editor.mode === "pairs" ? editor.slots : editor.weekdays.flatMap((weekday) => editor.times.map((minuteOfDay) => ({weekday, minuteOfDay})));
  return `每周 ${pairs.map((p) => `${WEEKDAYS[p.weekday]} ${formatMinute(p.minuteOfDay)}`).join("、")}`;
}
