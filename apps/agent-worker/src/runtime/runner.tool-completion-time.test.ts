import assert from "node:assert/strict";
import { test } from "node:test";
import { buildToolSuccessTextForTest } from "./runner.js";

const completedAt = Date.parse("2026-05-20T16:30:12.345+08:00");
const completedAtText = "2026-05-20T08:30:12.345Z";

type SuccessCase = {
  name?: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  headers: string[];
  body: string;
};

const cases: SuccessCase[] = [
  {
    toolName: "read", args: { filePath: "notes.txt" },
    result: { actualStart: 2, actualEnd: 3, content: "second\nthird" },
    headers: ["source: notes.txt", "range: 2-3"], body: "second\nthird"
  },
  {
    name: "read directory", toolName: "read", args: { filePath: "src" },
    result: { actualStart: 1, actualEnd: 2, content: "a.ts\nb.ts" },
    headers: ["source: src", "range: 1-2"], body: "a.ts\nb.ts"
  },
  {
    name: "read out of range", toolName: "read", args: { filePath: "empty.txt" },
    result: { actualStart: 9, actualEnd: 9, offsetOutOfRange: true, content: "End of file" },
    headers: ["source: empty.txt"], body: "End of file"
  },
  {
    toolName: "write", args: { filePath: "notes.txt" }, result: { summary: "Written" },
    headers: ["target: notes.txt"], body: "Written"
  },
  {
    toolName: "apply_patch", args: {},
    result: { summary: { fileCount: 1, additions: 2, deletions: 0 }, text: "Updated notes.txt" },
    headers: ["files: 1", "additions: 2", "deletions: 0"], body: "Updated notes.txt"
  },
  {
    toolName: "bash", args: {}, result: { command: "echo ok", exitCode: 0, stdout: "ok\n" },
    headers: ["command: echo ok", "exit_code: 0"], body: "stdout:\nok"
  },
  {
    name: "bash nonzero and timeout", toolName: "bash", args: {},
    result: { command: "fixture", exitCode: 1, timedOut: true, outputLimitExceeded: true, stderr: "error\n" },
    headers: ["command: fixture", "exit_code: 1", "timed_out: true", "output_limit_exceeded: true"],
    body: "stderr:\nerror"
  },
  {
    name: "bash missing optional fields", toolName: "bash", args: {}, result: {},
    headers: ["exit_code: null"], body: "(no output)"
  },
  {
    toolName: "skill", args: { skillId: "builtin/fixture" },
    result: { skillId: "builtin/fixture", filePath: "SKILL.md", truncated: false, content: "first\r\nsecond\r \n" },
    headers: ["skill_id: builtin/fixture", "file_path: SKILL.md", "truncated: false"], body: "first\r\nsecond\r \n"
  },
  {
    name: "skill empty body and truncated", toolName: "skill", args: { skillId: "builtin/fixture", filePath: "notes.txt" },
    result: { truncated: true, content: "" },
    headers: ["skill_id: builtin/fixture", "file_path: notes.txt", "truncated: true"], body: ""
  },
  {
    toolName: "subtask", args: {},
    result: { subtaskSessionId: "session_child", sourceSessionId: "session_source", resultText: "Done" },
    headers: ["subtask_session_id: session_child", 'source_session_id: "session_source"'], body: "Done"
  },
  {
    name: "subtask without source", toolName: "subtask", args: {},
    result: { subtaskSessionId: "session_child", resultText: "Done" },
    headers: ["subtask_session_id: session_child"], body: "Done"
  },
  {
    toolName: "todolist", args: {},
    result: { summary: { total: 1, pending: 0, inProgress: 0, completed: 1, cancelled: 0 } },
    headers: ["total: 1", "pending: 0", "in_progress: 0", "completed: 1", "cancelled: 0"], body: "Todo list updated."
  },
  {
    toolName: "scratchpad", args: {}, result: { content: "fixture notes" },
    headers: [], body: "Scratchpad saved"
  },
  {
    toolName: "archive_read", args: {}, result: { items: [], nextCursor: null },
    headers: [], body: JSON.stringify({ items: [], nextCursor: null }, null, 2)
  },
  {
    toolName: "archive_search", args: {}, result: { items: [{ text: "fixture" }] },
    headers: [], body: JSON.stringify({ items: [{ text: "fixture" }] }, null, 2)
  },
  {
    toolName: "mcp_fixture_lookup", args: {}, result: { text: "MCP result" },
    headers: [], body: "MCP result"
  },
  {
    name: "MCP raw result", toolName: "mcp_fixture_lookup", args: {}, result: { raw: { value: 1 } },
    headers: [], body: JSON.stringify({ value: 1 }, null, 2)
  },
  {
    toolName: "plugin_fixture_lookup", args: {}, result: { text: "Plugin result" },
    headers: [], body: "Plugin result"
  },
  {
    name: "plugin raw result", toolName: "plugin_fixture_lookup", args: {}, result: { raw: { value: 2 } },
    headers: [], body: JSON.stringify({ value: 2 }, null, 2)
  },
  {
    name: "apply_patch missing summary", toolName: "apply_patch", args: {}, result: {},
    headers: [], body: "apply_patch completed"
  },
  {
    name: "todolist missing summary", toolName: "todolist", args: {}, result: {},
    headers: [], body: "Todo list updated."
  }
];

for (const fixture of cases) {
  test(`${fixture.name ?? fixture.toolName} adds fixed completion time without changing existing output`, () => {
    const text = buildToolSuccessTextForTest({ ...fixture, completedAt });
    const header = [
      `tool: ${fixture.toolName}`, "status: completed", `completed_at: ${completedAtText}`, ...fixture.headers
    ].join("\n");
    assert.equal(text, fixture.body === "" ? header : `${header}\n\n${fixture.body}`);
    assert.equal(buildToolSuccessTextForTest({ ...fixture, completedAt }), text);
  });
}

test("view_image keeps its image path preview without completion metadata", () => {
  assert.equal(buildToolSuccessTextForTest({
    toolName: "view_image", args: { path: "screens/fixture.png" },
    result: { type: "image_ref", path: "screens/fixture.png" }, completedAt
  }), "view_image path: screens/fixture.png (image not attached to this preview)");
});

test("unknown formatter fallback does not acquire completion metadata", () => {
  assert.equal(buildToolSuccessTextForTest({
    toolName: "future_tool", args: {}, result: "Future result", completedAt
  }), "tool: future_tool\nstatus: completed\n\nFuture result");
});
