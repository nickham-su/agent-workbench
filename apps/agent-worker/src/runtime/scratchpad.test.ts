import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScratchpadArgs, toScratchpadResult } from "./scratchpad.js";

test("scratchpad trims content", () => {
  const parsed = parseScratchpadArgs({ content: "  hello  " });
  assert.equal(parsed.content, "hello");
  assert.deepEqual(toScratchpadResult(parsed), { content: "hello" });
});

test("scratchpad allows empty after trim", () => {
  const parsed = parseScratchpadArgs({ content: "   \n\t  " });
  assert.equal(parsed.content, "");
  assert.deepEqual(toScratchpadResult(parsed), { content: "" });
});

test("scratchpad does not fail for >200 chars (schema-only guidance)", () => {
  const content = "a".repeat(250);
  const parsed = parseScratchpadArgs({ content });
  assert.equal(parsed.content.length, 250);
});

test("scratchpad truncates to 1000 chars", () => {
  const content = "x".repeat(1005);
  const parsed = parseScratchpadArgs({ content });
  assert.equal(parsed.content.length, 1000);
  assert.equal(parsed.content, "x".repeat(1000));
});

test("scratchpad.content must be a string", () => {
  assert.throws(() => parseScratchpadArgs({ content: 123 as any }), /scratchpad\.content must be a string/);
  assert.throws(() => parseScratchpadArgs({} as any), /scratchpad\.content must be a string/);
});
