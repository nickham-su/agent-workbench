import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNoteArgs, toNoteResult } from "./note.js";

test("note trims content", () => {
  const parsed = parseNoteArgs({ content: "  hello  " });
  assert.equal(parsed.content, "hello");
  assert.deepEqual(toNoteResult(parsed), { content: "hello" });
});

test("note allows empty after trim", () => {
  const parsed = parseNoteArgs({ content: "   \n\t  " });
  assert.equal(parsed.content, "");
  assert.deepEqual(toNoteResult(parsed), { content: "" });
});

test("note does not fail for >200 chars (schema-only guidance)", () => {
  const content = "a".repeat(250);
  const parsed = parseNoteArgs({ content });
  assert.equal(parsed.content.length, 250);
});

test("note truncates to 1000 chars", () => {
  const content = "x".repeat(1005);
  const parsed = parseNoteArgs({ content });
  assert.equal(parsed.content.length, 1000);
  assert.equal(parsed.content, "x".repeat(1000));
});

test("note.content must be a string", () => {
  assert.throws(() => parseNoteArgs({ content: 123 as any }), /note\.content must be a string/);
  assert.throws(() => parseNoteArgs({} as any), /note\.content must be a string/);
});
