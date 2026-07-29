import assert from "node:assert/strict";
import { test } from "node:test";
import { agentToolLabelKey, DEFAULT_AGENT_TOOLS, normalizeAgentTools, toAgentToolOptions } from "./agentTools";

test("normalizeAgentTools 保留 scratchpad、去重并过滤非配置工具", () => {
  assert.deepEqual(
    normalizeAgentTools(["bash", "scratchpad", "read", "scratchpad", "subtask", "archive_search"]),
    ["bash", "scratchpad", "subtask"]
  );
});

test("DEFAULT_AGENT_TOOLS 默认不包含 scratchpad", () => {
  assert.equal(DEFAULT_AGENT_TOOLS.includes("scratchpad"), false);
});

test("toAgentToolOptions 包含 scratchpad 并复用标签 key", () => {
  const options = toAgentToolOptions((key) => key);
  assert.deepEqual(options.map((item) => item.value), ["bash", "write", "apply_patch", "subtask", "scratchpad"]);
  const scratchpad = options.find((item) => item.value === "scratchpad");
  assert.equal(scratchpad?.label, agentToolLabelKey("scratchpad"));
});
