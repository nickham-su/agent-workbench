import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareWorkspaceRelativePathsUtf8,
  parseExternalWorkspaceSkillId,
  parseWorkspaceAgentsInstructionPath,
  parseWorkspaceRelativePosixPath,
} from "../src/workspace-context-paths.js";

test("shared relative parser rejects ambiguous or dangerous segments without normalizing", () => {
  for (const raw of [
    "", "/a", "C:/a", "a/", "a//b", "a/./b", "a/../b", "../a", "a\\b", "a`b",
    " a", "a ", "a\tb", "a\t", "\u00a0a", "a\u00a0", "a\u200eb", "a\u2028b", "a\u2029b",
    "a\u0000b", "\ud800", "a/\udc00",
  ]) {
    assert.equal(parseWorkspaceRelativePosixPath(raw), null, JSON.stringify(raw));
  }
  assert.equal(parseWorkspaceRelativePosixPath(42), null);
  for (const raw of ["汉字/é", "a b/c", "e\u0301", "é", "A/a", "a/A"]) {
    assert.deepEqual(parseWorkspaceRelativePosixPath(raw), { path: raw, segments: raw.split("/") });
  }
  assert.notEqual(parseWorkspaceRelativePosixPath("é")?.path, parseWorkspaceRelativePosixPath("e\u0301")?.path);
  assert.notEqual(parseWorkspaceRelativePosixPath("A")?.path, parseWorkspaceRelativePosixPath("a")?.path);
});

test("Skill and AGENTS identities enforce independent depth, filename and builtin rules", () => {
  for (const raw of ["a", "a/b/c/d", ".claude/skills/review", "a/builtin/x"]) {
    assert.equal(parseExternalWorkspaceSkillId(raw)?.path, raw);
  }
  for (const raw of ["", "builtin", "builtin/a", "a/b/c/d/e", "a/SKILL.md/child/SKILL.md/x"]) {
    assert.equal(parseExternalWorkspaceSkillId(raw), null, raw);
  }
  for (const raw of ["AGENTS.md", "a/AGENTS.md", "a/b/c/d/AGENTS.md", "builtin/AGENTS.md"]) {
    assert.equal(parseWorkspaceAgentsInstructionPath(raw)?.path, raw);
  }
  for (const raw of ["a/b/c/d/e/AGENTS.md", "agents.md", "a/AGENTS.MD", "a/AGENTS.md/child", " AGENTS.md"]) {
    assert.equal(parseWorkspaceAgentsInstructionPath(raw), null, raw);
  }
});

test("UTF-8 byte sorting is deterministic and does not use locale comparison", () => {
  const input = ["é", "e\u0301", "z", "A", "a"];
  assert.deepEqual(input.sort(compareWorkspaceRelativePathsUtf8), ["A", "a", "e\u0301", "z", "é"]);
});
