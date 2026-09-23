import assert from "node:assert/strict";
import test from "node:test";
import { resolveZonedDateTime, validateCustomRange } from "./dashboard-timezone";

test("按选定 IANA 时区转换并验证 datetime-local 往返", () => { const result = resolveZonedDateTime("2024-01-15T12:30", "America/New_York"); assert.equal(result.kind, "ok"); if (result.kind === "ok") assert.equal(new Date(result.timestamp).toISOString(), "2024-01-15T17:30:00.000Z"); });
test("DST 不存在和歧义墙上时间均被拒绝", () => { assert.equal(resolveZonedDateTime("2024-03-10T02:30", "America/New_York").kind, "nonexistent"); assert.equal(resolveZonedDateTime("2024-11-03T01:30", "America/New_York").kind, "ambiguous"); });
test("自定义范围校验顺序、安全值与 366 天上限", () => { assert.equal(validateCustomRange("2024-01-02T00:00", "2024-01-01T00:00", "UTC").valid, false); const tooLarge = validateCustomRange("2024-01-01T00:00", "2025-01-02T00:01", "UTC"); assert.deepEqual(tooLarge, { valid: false, code: "CUSTOM_RANGE_TOO_LARGE" }); const valid = validateCustomRange("2024-01-01T00:00", "2024-01-02T00:00", "UTC"); assert.equal(valid.valid, true); });
