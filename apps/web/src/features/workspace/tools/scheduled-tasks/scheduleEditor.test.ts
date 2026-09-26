import test from "node:test";
import assert from "node:assert/strict";
import { editorToUtc, nextThreePreview, parseMinute, toLocalEditor } from "./scheduleEditor.js";

test("single-offset daily and weekly boundary conversions round-trip", () => {
  assert.deepEqual(editorToUtc({kind:"daily",minutesOfDay:[15]}, -330), {kind:"daily",minutesOfDayUtc:[1125]});
  const weekly = editorToUtc({kind:"weekly",mode:"pairs",slots:[{weekday:1,minuteOfDay:15}]}, -345);
  assert.deepEqual(weekly, {kind:"weekly",slotsUtc:[{weekdayUtc:0,minuteOfDayUtc:1110}]});
  assert.deepEqual(editorToUtc({kind:"weekly",mode:"pairs",slots:[{weekday:6,minuteOfDay:1410}]}, 420),
    {kind:"weekly",slotsUtc:[{weekdayUtc:0,minuteOfDayUtc:390}]});
  assert.deepEqual(toLocalEditor(weekly,-345), {kind:"weekly",mode:"grid",weekdays:[1],times:[15]});
});
test("non-factorizable weekly schedule stays in pair mode with no extra slots", () => {
  const schedule = {kind:"weekly" as const,slotsUtc:[{weekdayUtc:1,minuteOfDayUtc:540},{weekdayUtc:2,minuteOfDayUtc:600}]};
  const editor = toLocalEditor(schedule,0);
  assert.equal(editor.kind,"weekly");
  if (editor.kind !== "weekly") return;
  assert.equal(editor.mode,"pairs");
  assert.deepEqual(editorToUtc(editor,0),schedule);
  const grid = editorToUtc({kind:"weekly",mode:"grid",weekdays:[1,2],times:[540,600]},0);
  assert.equal(grid.kind,"weekly");
  if (grid.kind === "weekly") assert.equal(grid.slotsUtc.length,4);
});
test("minute parsing and previews use actual instant timestamps", () => {
  assert.equal(parseMinute("23:59"),1439);
  assert.equal(parseMinute("24:00"),null);
  const seen:number[] = [];
  nextThreePreview({kind:"hourly",minutesUtc:[0]},Date.UTC(2025,0,1,0,0),date=>{seen.push(date.getTime());return date.toISOString();});
  assert.deepEqual(seen,[Date.UTC(2025,0,1,1),Date.UTC(2025,0,1,2),Date.UTC(2025,0,1,3)]);
});
