import assert from "node:assert/strict";
import { test } from "node:test";
import { buildToolSuccessTextForTest } from "./runner.js";

test("runner skill tool-result text uses V2 headers only", () => {
  const text = buildToolSuccessTextForTest({
    toolName: "skill",
    args: { skill_id: "builtin/tooling" },
    result: {
      skill_id: "builtin/tooling",
      file_path: "SKILL.md",
      content: "Skill body\n\n## Skill files\n\n```text\nnotes.txt\n```",
      truncated: false
    }
  });

  assert.ok(text.includes("tool: skill"));
  assert.ok(text.includes("skill_id: builtin/tooling"));
  assert.ok(text.includes("file_path: SKILL.md"));
  assert.ok(text.includes("truncated: false"));
  assert.ok(text.includes("Skill body"));
  assert.equal(text.includes("\nskill: "), false);
  assert.equal(text.includes("\npath: "), false);
  assert.equal(text.includes("\nid: "), false);
  assert.equal(text.includes("children:"), false);
  assert.equal(text.includes("type: skill"), false);
});

test("runner preserves empty V2 skill content without a placeholder", () => {
  const text = buildToolSuccessTextForTest({
    toolName: "skill",
    args: { skill_id: "builtin/tooling", file_path: "empty.txt" },
    result: { skill_id: "builtin/tooling", file_path: "empty.txt", content: "", truncated: false }
  });

  assert.ok(text.includes("file_path: empty.txt"));
  assert.ok(text.includes("truncated: false"));
  assert.equal(text.includes("empty file content"), false);
  assert.equal(text.includes("empty skill content"), false);
});

test("runner preserves V2 root content exactly", () => {
  const content = "line one\r\nline two\r";
  const text = buildToolSuccessTextForTest({
    toolName: "skill",
    args: { skill_id: "builtin/tooling" },
    result: { skill_id: "builtin/tooling", file_path: "SKILL.md", content, truncated: false }
  });

  assert.equal(text, `tool: skill\nstatus: completed\nskill_id: builtin/tooling\nfile_path: SKILL.md\ntruncated: false\n\n${content}`);
});
