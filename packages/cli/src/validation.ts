import { CliError } from "./errors.js";

const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
export function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !controls.test(value) && !/[\uD800-\uDFFF]/u.test(value);
}
export function validateId(value: unknown, pathSegment = false): string {
  if (!isId(value) || (pathSegment && (value === "." || value === ".."))) {
    throw new CliError(2, "资源 ID 必须非空、无首尾空白和控制字符；路径段不得为点段。", { effect: "not_sent" });
  }
  return value;
}
export function encodeId(value: string): string { return encodeURIComponent(validateId(value, true)); }
export function parseDuration(value: unknown, maximumSeconds: number, label = "时长"): number {
  const match = typeof value === "string" && /^([1-9][0-9]*)(s|m|h|d)$/.exec(value);
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = match && match[0] === value ? Number(match[1]) * units[match[2]] : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > maximumSeconds) {
    throw new CliError(2, `${label}必须是范围内的正整数 s/m/h/d 时长。`, { effect: "not_sent" });
  }
  return seconds;
}
export function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}
export function isCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
