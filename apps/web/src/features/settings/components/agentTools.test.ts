import assert from "node:assert/strict";
import { test } from "node:test";
import enUS from "../../../shared/i18n/locales/en-US";
import zhCN from "../../../shared/i18n/locales/zh-CN";
import { agentToolLabelKey, DEFAULT_AGENT_TOOLS, normalizeAgentTools, toAgentToolOptions } from "./agentTools";

test("normalizeAgentTools 保留可配置工具、去重并过滤隐藏默认工具", () => {
  assert.deepEqual(
    normalizeAgentTools([
      "bash",
      "todolist",
      "read",
      "view_image",
      "todolist",
      "skill"
    ]),
    ["bash", "todolist", "view_image"]
  );
});

test("DEFAULT_AGENT_TOOLS 默认不包含 scratchpad", () => {
  assert.equal(DEFAULT_AGENT_TOOLS.includes("scratchpad"), false);
});

test("DEFAULT_AGENT_TOOLS 默认不包含 todolist 和 view_image", () => {
  assert.equal(DEFAULT_AGENT_TOOLS.includes("todolist"), false);
  assert.equal(DEFAULT_AGENT_TOOLS.includes("view_image"), false);
});

test("toAgentToolOptions 包含可配置工具并复用标签 key", () => {
  const options = toAgentToolOptions((key) => key);
  assert.deepEqual(options.map((item) => item.value), ["bash", "write", "apply_patch", "subtask", "scratchpad", "todolist", "view_image", "archive_read", "archive_search"]);
  const scratchpad = options.find((item) => item.value === "scratchpad");
  const todolist = options.find((item) => item.value === "todolist");
  const viewImage = options.find((item) => item.value === "view_image");
  const archiveRead = options.find((item) => item.value === "archive_read");
  const archiveSearch = options.find((item) => item.value === "archive_search");
  assert.equal(scratchpad?.label, agentToolLabelKey("scratchpad"));
  assert.equal(todolist?.label, agentToolLabelKey("todolist"));
  assert.equal(viewImage?.label, agentToolLabelKey("view_image"));
  assert.equal(archiveRead?.label, agentToolLabelKey("archive_read"));
  assert.equal(archiveSearch?.label, agentToolLabelKey("archive_search"));
});

test("Agent 配置工具列表在中英文下显示 View Image，工具值仍为 view_image", () => {
  for (const locale of [zhCN, enUS]) {
    const options = toAgentToolOptions((key) =>
      key === agentToolLabelKey("view_image") ? locale.settings.agentProfiles.tools.viewImage : key
    );
    assert.deepEqual(options.find((option) => option.value === "view_image"), {
      label: "View Image",
      value: "view_image"
    });
  }
});
