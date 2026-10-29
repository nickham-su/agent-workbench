import assert from "node:assert/strict";
import test from "node:test";
import { allowedToolAreas, normalizeToolLayout, TOOL_IDS } from "./toolLayout";

const defaults = {
  leftTop: ["files", "search", "codeReview", "scheduledTasks", "environmentVariables", "agent"],
  leftBottom: ["terminal"],
  rightTop: ["editor"]
};

test("absent and malformed layouts use defaults", () => {
  for (const raw of [null, undefined, false, 2, "invalid", [], {}, { leftTop: "files", leftBottom: null }]) {
    assert.deepEqual(normalizeToolLayout(raw), defaults);
  }
});

test("normalization retains preferences, removes duplicates/unknown IDs and fixes editor constraints", () => {
  const layout = normalizeToolLayout({
    leftTop: ["agent", "editor", "unknown", "agent", null],
    leftBottom: ["files", "agent", "terminal", "editor", "codeReview"],
    rightTop: ["search", "editor", "editor"]
  });
  assert.deepEqual(layout, {
    leftTop: ["agent", "search", "scheduledTasks", "environmentVariables"],
    leftBottom: ["files", "terminal", "codeReview"],
    rightTop: ["editor"]
  });
  assert.equal(new Set(Object.values(layout).flat()).size, TOOL_IDS.length);
  assert.deepEqual(allowedToolAreas("editor"), ["rightTop"]);
  assert.deepEqual(allowedToolAreas("terminal"), ["leftTop", "leftBottom"]);
});

test("omitted/new tools are appended in default order without disturbing existing preferences", () => {
  assert.deepEqual(normalizeToolLayout({ leftTop: ["agent", "files"], leftBottom: ["codeReview", "terminal"] }), {
    leftTop: ["agent", "files", "search", "scheduledTasks", "environmentVariables"],
    leftBottom: ["codeReview", "terminal"],
    rightTop: ["editor"]
  });
});

test("normalization does not mutate source data or shared defaults", () => {
  const raw = { leftTop: ["agent"] };
  const normalized = normalizeToolLayout(raw);
  normalized.leftTop.reverse();
  raw.leftTop.push("files");
  assert.deepEqual(normalizeToolLayout(null), defaults);
  assert.deepEqual(normalizeToolLayout({ leftTop: ["agent"] }).leftTop, ["agent", "files", "search", "codeReview", "scheduledTasks", "environmentVariables"]);
});
