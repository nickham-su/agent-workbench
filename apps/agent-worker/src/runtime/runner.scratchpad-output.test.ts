import assert from "node:assert/strict";
import { test } from "node:test";
import { buildToolSuccessTextForTest } from "./runner.js";

test("runner scratchpad tool-result text for non-empty content", () => {
  const text = buildToolSuccessTextForTest({
    toolName: "scratchpad",
    args: { content: "hello" },
    result: { content: "hello" }
  });
  assert.ok(text.includes("tool: scratchpad"));
  assert.ok(text.includes("Scratchpad saved"));
  assert.equal(text.includes("empty content"), false);
});

test("runner scratchpad tool-result text for empty content", () => {
  const text = buildToolSuccessTextForTest({
    toolName: "scratchpad",
    args: { content: "" },
    result: { content: "" }
  });
  assert.ok(text.includes("Scratchpad saved (empty content)"));
});
