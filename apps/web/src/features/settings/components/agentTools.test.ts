import assert from "node:assert/strict";
import { test } from "node:test";
import { agentToolLabelKey, DEFAULT_AGENT_TOOLS, normalizeAgentTools, toAgentToolOptions } from "./agentTools";

test("normalizeAgentTools 保留可配置工具、去重并过滤隐藏默认工具", () => {
  assert.deepEqual(
    normalizeAgentTools([
      "bash",
      "todolist",
      "read",
      "visual_analyze",
      "todolist",
      "archive_search",
      "archive_read",
      "skill"
    ]),
    ["bash", "todolist", "visual_analyze"]
  );
});

test("DEFAULT_AGENT_TOOLS 默认不包含 scratchpad", () => {
  assert.equal(DEFAULT_AGENT_TOOLS.includes("scratchpad"), false);
});

test("DEFAULT_AGENT_TOOLS 默认不包含 todolist 和 visual_analyze", () => {
  assert.equal(DEFAULT_AGENT_TOOLS.includes("todolist"), false);
  assert.equal(DEFAULT_AGENT_TOOLS.includes("visual_analyze"), false);
});

test("toAgentToolOptions 包含可配置工具并复用标签 key", () => {
  const options = toAgentToolOptions((key) => key);
  assert.deepEqual(options.map((item) => item.value), ["bash", "write", "apply_patch", "subtask", "scratchpad", "todolist", "visual_analyze"]);
  const scratchpad = options.find((item) => item.value === "scratchpad");
  const todolist = options.find((item) => item.value === "todolist");
  const visualAnalyze = options.find((item) => item.value === "visual_analyze");
  assert.equal(scratchpad?.label, agentToolLabelKey("scratchpad"));
  assert.equal(todolist?.label, agentToolLabelKey("todolist"));
  assert.equal(visualAnalyze?.label, agentToolLabelKey("visual_analyze"));
});
