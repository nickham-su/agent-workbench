import assert from "node:assert/strict";
import { test } from "node:test";
import { buildToolSuccessTextForTest } from "./runner.js";

test("runner skill tool-result text for skill node", () => {
  const text = buildToolSuccessTextForTest({
    toolName: "skill",
    args: { id: "builtin/tooling" },
    result: {
      id: "builtin/tooling",
      type: "skill",
      name: "Tooling",
      description: "Tooling desc",
      content: "Skill body",
      children: [
        { id: "builtin/tooling/child", type: "skill", name: "Child" },
        { id: "builtin/tooling/notes.txt", type: "file", name: "notes.txt" }
      ],
      truncated: false
    }
  });

  assert.ok(text.includes("tool: skill"));
  assert.ok(text.includes("id: builtin/tooling"));
  assert.ok(text.includes("type: skill"));
  assert.ok(text.includes("name: Tooling"));
  assert.ok(text.includes("description: Tooling desc"));
  assert.ok(text.includes("children:"));
  assert.ok(text.includes("- id: builtin/tooling/child; type: skill; name: Child"));
  assert.ok(text.includes("Skill body"));
  assert.equal(text.includes('"type": "skill"'), false);
});

test("runner skill tool-result text for skill file", () => {
  const text = buildToolSuccessTextForTest({
    toolName: "skill",
    args: { id: "ws/deploy/template.yaml" },
    result: {
      id: "ws/deploy/template.yaml",
      type: "file",
      content: "kind: Pod",
      truncated: true
    }
  });

  assert.ok(text.includes("tool: skill"));
  assert.ok(text.includes("id: ws/deploy/template.yaml"));
  assert.ok(text.includes("type: file"));
  assert.ok(text.includes("truncated: true"));
  assert.ok(text.includes("kind: Pod"));
  assert.equal(text.includes('"content": "kind: Pod"'), false);
});
