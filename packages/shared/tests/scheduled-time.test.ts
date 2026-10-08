import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  CreateScheduledTaskRequestSchema, ReplaceScheduledTaskRequestSchema, ScheduledTaskCursorSchema,
  ScheduledExecutionCursorSchema, ScheduledExecutionSchema, ScheduledExecutionResponseSchema,
  ScheduledExecutionReasonCodeSchema, normalizeSchedule, nextRunAt, localToUtcSchedule, utcToLocalSchedule
} from "../src/index.js";

const minute = 60_000;
const utc = (s: string) => Date.parse(s);

test("structured UTC schedule validates, sorts and deduplicates without mutating inputs", () => {
  const input = { kind: "weekly", slotsUtc: [
    { weekdayUtc: 2, minuteOfDayUtc: 50 }, { weekdayUtc: 0, minuteOfDayUtc: 20 }, { weekdayUtc: 2, minuteOfDayUtc: 50 }
  ] } as const;
  const canonical = normalizeSchedule(input);
  assert.deepEqual(canonical, { kind: "weekly", slotsUtc: [
    { weekdayUtc: 0, minuteOfDayUtc: 20 }, { weekdayUtc: 2, minuteOfDayUtc: 50 }
  ] });
  assert.equal(input.slotsUtc.length, 3);
  for (const invalid of [
    { kind: "weekly", slotsUtc: [] }, { kind: "weekly", slotsUtc: [{ weekdayUtc: 7, minuteOfDayUtc: 0 }] },
    { kind: "daily", minutesOfDayUtc: [1440] }, { kind: "hourly", minutesUtc: [-1] },
    { kind: "daily", minutesOfDayUtc: [30], timezone: "Asia/Tokyo" }, { kind: "cron", expression: "* * * * *" }
  ]) assert.throws(() => normalizeSchedule(invalid), { code: "SCHEDULE_INVALID" });
});

test("strict future hourly, daily, weekly UTC slots across boundaries", () => {
  const hourly = { kind: "hourly" as const, minutesUtc: [0, 30] };
  assert.equal(nextRunAt(hourly, utc("2025-01-01T00:00:00Z")), utc("2025-01-01T00:30:00Z"));
  assert.equal(nextRunAt(hourly, utc("2025-01-01T00:30:00Z")), utc("2025-01-01T01:00:00Z"));
  const daily = { kind: "daily" as const, minutesOfDayUtc: [0, 1125] };
  assert.equal(nextRunAt(daily, utc("2025-01-01T18:45:00Z")), utc("2025-01-02T00:00:00Z"));
  const weekly = { kind: "weekly" as const, slotsUtc: [{ weekdayUtc: 0, minuteOfDayUtc: 390 }] };
  assert.equal(nextRunAt(weekly, utc("2025-01-04T23:30:00Z")), utc("2025-01-05T06:30:00Z"));
  assert.equal(nextRunAt(weekly, utc("2025-01-05T06:30:00Z")), utc("2025-01-12T06:30:00Z"));
  assert.equal(nextRunAt({ kind: "daily", minutesOfDayUtc: [0] }, 0), 1440 * minute);
});

test("fixed offset local conversion uses weekday rollover and exact pair roundtrip", () => {
  assert.deepEqual(localToUtcSchedule({ kind: "daily", minutesOfDay: [15] }, -330),
    { kind: "daily", minutesOfDayUtc: [1125] });
  const east = localToUtcSchedule({ kind: "weekly", slots: [{ weekday: 1, minuteOfDay: 15 }] }, -345);
  assert.deepEqual(east, { kind: "weekly", slotsUtc: [{ weekdayUtc: 0, minuteOfDayUtc: 1110 }] });
  assert.deepEqual(utcToLocalSchedule(east, -345), { kind: "weekly", slots: [{ weekday: 1, minuteOfDay: 15 }] });
  assert.deepEqual(localToUtcSchedule({ kind: "weekly", slots: [{ weekday: 6, minuteOfDay: 1410 }] }, 420),
    { kind: "weekly", slotsUtc: [{ weekdayUtc: 0, minuteOfDayUtc: 390 }] });
  assert.deepEqual(localToUtcSchedule({ kind: "hourly", minutes: [0] }, 420), { kind: "hourly", minutesUtc: [0] });
  assert.throws(() => localToUtcSchedule({ kind: "hourly", minutes: [60] }, 0), { code: "SCHEDULE_INVALID" });
});

test("public schemas are strict and PUT requires full configuration", () => {
  const req = { name: "Task", prompt: "run", agentId: "agent", schedule: { kind: "hourly", minutesUtc: [1] },
    triggerMode: "new_session", sourceSessionId: null, sourceMessageId: null };
  assert.equal(Value.Check(ReplaceScheduledTaskRequestSchema, req), true);
  assert.equal(Value.Check(ReplaceScheduledTaskRequestSchema, { ...req, enabled: true }), false);
  assert.equal(Value.Check(ReplaceScheduledTaskRequestSchema, { name: "Task" }), false);
  assert.equal(Value.Check(CreateScheduledTaskRequestSchema, { ...req, enabled: true }), true);
  assert.equal(Value.Check(ScheduledTaskCursorSchema, { v: 1, filter: { status: "all", q: null },
    after: { enabled: 1, updatedAt: 1, id: "id" }, extra: true }), false);
  assert.equal(Value.Check(ScheduledExecutionCursorSchema, { v: 2, filter: { result: "all", triggerType: "all" },
    after: { createdAt: 1, id: "id" } }), false);
});

test("Execution contract accepts only stable reason codes or null", () => {
  const execution = {
    id: "execution", taskId: "task", triggerType: "manual", scheduledFor: null,
    status: "failed_to_start", reasonCode: null, reasonMessage: null,
    sessionId: "session", sessionAvailable: false, runId: null, createdAt: 10, startedAt: null, finishedAt: 11
  };
  assert.equal(Value.Check(ScheduledExecutionSchema, execution), true);
  for (const reasonCode of ["worker_unavailable", "run_failed", "previous_execution_running"]) {
    assert.equal(Value.Check(ScheduledExecutionReasonCodeSchema, reasonCode), true);
    assert.equal(Value.Check(ScheduledExecutionSchema, { ...execution, reasonCode }), true);
    assert.equal(Value.Check(ScheduledExecutionResponseSchema, { execution: { ...execution, reasonCode } }), true);
  }
  for (const reasonCode of ["arbitrary_provider_error", "WORKER_UNAVAILABLE", "", 12]) {
    assert.equal(Value.Check(ScheduledExecutionReasonCodeSchema, reasonCode), false);
    assert.equal(Value.Check(ScheduledExecutionSchema, { ...execution, reasonCode }), false);
    assert.equal(Value.Check(ScheduledExecutionResponseSchema, { execution: { ...execution, reasonCode } }), false);
  }
});
