import assert from "node:assert/strict";
import { test } from "node:test";
import { buildToolSuccessTextForTest } from "./runner.js";

test("runner note tool-result text for non-empty content", () => {
  const text = buildToolSuccessTextForTest({
    toolName: "note",
    args: { content: "hello" },
    result: { content: "hello" }
  });
  assert.ok(text.includes("tool: note"));
  assert.ok(text.includes("Note saved"));
  assert.equal(text.includes("empty content"), false);
});

test("runner note tool-result text for empty content", () => {
  const text = buildToolSuccessTextForTest({
    toolName: "note",
    args: { content: "" },
    result: { content: "" }
  });
  assert.ok(text.includes("Note saved (empty content)"));
});
