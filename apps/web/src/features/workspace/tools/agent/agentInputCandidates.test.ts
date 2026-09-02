import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPromptCommandMap,
  buildSlashInputCandidates,
  createInputCandidateDomId,
  createInputCandidateListId,
  limitMentionCandidates,
  promptCommandInsertCaret,
  promptCommandInsertText,
  shouldConvertLeadingIdeographicCommaToSlash,
  type SlashCommandDefinition
} from "./agentInputCandidates";

const builtInCommands: SlashCommandDefinition[] = [
  { name: "compact", usage: "/compact", summaryKey: "compact", strictOnly: true, action: "compact" },
  { name: "clear", usage: "/clear", summaryKey: "clear", strictOnly: true, action: "clear" }
];

test("shouldConvertLeadingIdeographicCommaToSlash 仅在空输入以顿号开始时转换", () => {
  assert.equal(shouldConvertLeadingIdeographicCommaToSlash("", "、"), true);
  assert.equal(shouldConvertLeadingIdeographicCommaToSlash("", "、请总结"), true);
  assert.equal(shouldConvertLeadingIdeographicCommaToSlash("/summarize", "、请总结"), false);
  assert.equal(shouldConvertLeadingIdeographicCommaToSlash("已有内容", "、请总结"), false);
  assert.equal(shouldConvertLeadingIdeographicCommaToSlash("", "请总结"), false);
});

test("promptCommandInsertText 在开关关闭时保留 slash 指令", () => {
  const item = { id: "summarize", title: "Summarize", prompt: "Summarize the selected text.", command: "summarize" };
  assert.equal(promptCommandInsertText(item, "summarize"), "/summarize");
  assert.equal(promptCommandInsertCaret(item, "summarize"), "/summarize".length);
});

test("promptCommandInsertText 在开关开启时回填提示词原文", () => {
  const prompt = "请总结以下内容：\n\n";
  const item = { id: "summarize", title: "Summarize", prompt, command: "summarize", expandOnSelect: true };
  assert.equal(promptCommandInsertText(item, "summarize"), prompt);
  assert.equal(promptCommandInsertCaret(item, "summarize"), prompt.length);
});

test("buildSlashInputCandidates 保留超过 10 条 slash 指令", () => {
  const promptCommands = new Map(Array.from({ length: 11 }, (_, index) => {
    const command = `command-${index}`;
    return [command, { id: command, title: command, prompt: "", command }];
  }));
  const candidates = buildSlashInputCandidates({ commands: builtInCommands, promptCommands, query: "" });
  assert.equal(candidates.length, 13);
  assert.equal(candidates.at(-1)?.id, "prompt_command:command-10");
});

test("buildSlashInputCandidates 按 slash 前缀过滤自定义指令", () => {
  const promptCommands = new Map([
    ["test", { id: "test", title: "Test", prompt: "", command: "test" }],
    ["testing", { id: "testing", title: "Testing", prompt: "", command: "testing" }],
    ["other", { id: "other", title: "Other", prompt: "", command: "other" }]
  ]);
  const candidates = buildSlashInputCandidates({ commands: builtInCommands, promptCommands, query: "test" });
  assert.deepEqual(candidates.map((item) => item.id), ["prompt_command:test", "prompt_command:testing"]);
});

test("buildPromptCommandMap 保持内置命令优先并排除冲突", () => {
  const map = buildPromptCommandMap([
    { id: "compact-prompt", title: "Prompt Compact", prompt: "", command: "COMPACT" },
    { id: "first", title: "First", prompt: "", command: "Review" },
    { id: "second", title: "Second", prompt: "", command: "review" }
  ], builtInCommands);
  assert.deepEqual([...map.keys()], ["review"]);
  assert.equal(map.get("review")?.id, "first");
});

test("limitMentionCandidates 最多保留 10 条 mention 候选", () => {
  const candidates = limitMentionCandidates(Array.from({ length: 11 }, (_, index) => index), 10);
  assert.deepEqual(candidates, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("候选 listbox ID 按组件实例编号区分且稳定", () => {
  assert.equal(createInputCandidateListId("session-7"), createInputCandidateListId("session-7"));
  assert.notEqual(createInputCandidateListId("session-7"), createInputCandidateListId("session-8"));
});

test("候选 DOM ID 按列表索引生成且不同候选不碰撞", () => {
  const listId = createInputCandidateListId("session-3");
  const first = createInputCandidateDomId(listId, 0);
  const second = createInputCandidateDomId(listId, 1);
  assert.equal(first, `${listId}-option-0`);
  assert.notEqual(first, second);
});
