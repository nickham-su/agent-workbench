import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeManualSessionTitle, normalizeScheduledTaskName, buildScheduledExecutionSessionTitle, toAutomaticSessionTitle } from "./session-title.js";

// 首消息自动标题的既有行为回归：空白回退“新会话”、精确 50 字符截断。
// 权威实现：lifecycle/sqlite-run-lifecycle-persistence.ts 的 toSessionTitleFromFirstMessage。

test("toAutomaticSessionTitle 空白与纯空白回退为空标题回退值", () => {
  assert.equal(toAutomaticSessionTitle("", "新会话"), "新会话");
  assert.equal(toAutomaticSessionTitle("   \n\t  ", "新会话"), "新会话");
});

test("toAutomaticSessionTitle 压缩连续空白并 trim", () => {
  assert.equal(toAutomaticSessionTitle("  修复   登录\n问题\t ", "新会话"), "修复 登录 问题");
  assert.equal(toAutomaticSessionTitle("a　　b", "新会话"), "a b");
});

test("toAutomaticSessionTitle 不超过 50 字符时不截断", () => {
  assert.equal(toAutomaticSessionTitle("a".repeat(50), "新会话"), "a".repeat(50));
});

test("toAutomaticSessionTitle 精确 50 字符截断：49 字符 + 省略号", () => {
  const long = "自".repeat(60); // 60 字符，超过 50 触发截断
  const result = toAutomaticSessionTitle(long, "新会话");
  assert.equal(result.length, 50);
  assert.equal(result, `${"自".repeat(49)}…`);
});

test("toAutomaticSessionTitle 恰好 51 个规范化字符时截断", () => {
  const input = `  ${"b".repeat(51)}  `;
  const result = toAutomaticSessionTitle(input, "新会话");
  assert.equal(result.length, 50);
  assert.match(result, /…$/);
  assert.equal(result, `${"b".repeat(49)}…`);
});

test("normalizeManualSessionTitle 空白拒绝、合法接受、超长与控制字符拒绝", () => {
  assert.deepEqual(normalizeManualSessionTitle("   "), { ok: false, reason: "empty" });
  const ok = normalizeManualSessionTitle("  我的  标题 ");
  assert.deepEqual(ok, { ok: true, title: "我的 标题" });
  assert.deepEqual(normalizeManualSessionTitle("a".repeat(51)), { ok: false, reason: "too_long" });
  assert.deepEqual(normalizeManualSessionTitle("ab\u0007cd"), { ok: false, reason: "invalid_characters" });
});

test("定时任务名称与手动标题保持相同的空白和控制字符规则，按 code point 限长", () => {
  assert.deepEqual(normalizeManualSessionTitle("😀".repeat(50)), { ok: true, title: "😀".repeat(50) });
  assert.deepEqual(normalizeManualSessionTitle("😀".repeat(51)), { ok: false, reason: "too_long" });
  assert.deepEqual(normalizeScheduledTaskName("\t a\n\r b  "), { ok: true, title: "a b" });
  assert.deepEqual(normalizeScheduledTaskName("😀".repeat(100)), { ok: true, title: "😀".repeat(100) });
  assert.deepEqual(normalizeScheduledTaskName("😀".repeat(101)), { ok: false, reason: "too_long" });
  for (const value of ["\t\n ", "\r"]) {
    assert.deepEqual(normalizeScheduledTaskName(value), { ok: false, reason: "empty" });
  }
  for (const value of ["a\0b", "a\bb", "a\u0085b"]) {
    assert.deepEqual(normalizeScheduledTaskName(value), { ok: false, reason: "invalid_characters" });
  }
  const title = buildScheduledExecutionSessionTitle("😀".repeat(100));
  assert.equal(title, "😀".repeat(43) + " · 定时任务");
  assert.equal([...title].length, 50);
});
