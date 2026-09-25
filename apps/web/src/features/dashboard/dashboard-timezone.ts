export const MAX_CUSTOM_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export type CustomRangeValidation =
  | { valid: true; from: number; to: number }
  | { valid: false; code: "CUSTOM_RANGE_REQUIRED" | "CUSTOM_RANGE_INVALID" | "CUSTOM_RANGE_DST_AMBIGUOUS" | "CUSTOM_RANGE_DST_NONEXISTENT" | "CUSTOM_RANGE_ORDER" | "CUSTOM_RANGE_TOO_LARGE" };

function isValidTimezone(timezone: string) {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: timezone }); return true; } catch { return false; }
}

function parsedLocalParts(local: string): { year: number; month: number; day: number; hour: number; minute: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (![year, month, day, hour, minute].every(Number.isSafeInteger) || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const naive = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return naive.getUTCFullYear() === year && naive.getUTCMonth() === month - 1 && naive.getUTCDate() === day ? { year, month, day, hour, minute } : null;
}

export function formatWallTime(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(timestamp);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  // Some ICU implementations still render midnight as 24:00 despite h23.
  const hour = value("hour") === "24" ? "00" : value("hour");
  return `${value("year")}-${value("month")}-${value("day")}T${hour}:${value("minute")}`;
}

function offsetAt(timestamp: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(timestamp);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - timestamp;
}

/**
 * Resolves a datetime-local wall time in the chosen IANA zone. Matching the formatted
 * wall time again makes nonexistent DST times fail and duplicate fall-back times explicit.
 */
export function resolveZonedDateTime(local: string, timezone: string): { kind: "ok"; timestamp: number } | { kind: "invalid" | "nonexistent" | "ambiguous" } {
  const parts = parsedLocalParts(local);
  if (!parts || !isValidTimezone(timezone)) return { kind: "invalid" };
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const offsets = new Set<number>();
  for (let probe = naive - 30 * 60 * 60 * 1000; probe <= naive + 30 * 60 * 60 * 1000; probe += 60 * 60 * 1000) offsets.add(offsetAt(probe, timezone));
  const matches = [...offsets].map((offset) => naive - offset).filter((timestamp) => formatWallTime(timestamp, timezone) === local);
  if (matches.length === 1) return { kind: "ok", timestamp: matches[0] };
  return matches.length === 0 ? { kind: "nonexistent" } : { kind: "ambiguous" };
}

export function validateCustomRange(fromLocal: string, toLocal: string, timezone: string): CustomRangeValidation {
  if (!fromLocal || !toLocal) return { valid: false, code: "CUSTOM_RANGE_REQUIRED" };
  const from = resolveZonedDateTime(fromLocal, timezone);
  const to = resolveZonedDateTime(toLocal, timezone);
  const resolution = [from, to].find((value) => value.kind !== "ok");
  if (resolution?.kind === "ambiguous") return { valid: false, code: "CUSTOM_RANGE_DST_AMBIGUOUS" };
  if (resolution?.kind === "nonexistent") return { valid: false, code: "CUSTOM_RANGE_DST_NONEXISTENT" };
  if (resolution || from.kind !== "ok" || to.kind !== "ok") return { valid: false, code: "CUSTOM_RANGE_INVALID" };
  if (!Number.isSafeInteger(from.timestamp) || !Number.isSafeInteger(to.timestamp)) return { valid: false, code: "CUSTOM_RANGE_INVALID" };
  if (from.timestamp >= to.timestamp) return { valid: false, code: "CUSTOM_RANGE_ORDER" };
  if (to.timestamp - from.timestamp > MAX_CUSTOM_RANGE_MS) return { valid: false, code: "CUSTOM_RANGE_TOO_LARGE" };
  return { valid: true, from: from.timestamp, to: to.timestamp };
}
