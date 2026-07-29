import assert from "node:assert/strict";
import { test } from "node:test";
import {
  promptCommandInsertCaret,
  promptCommandInsertText,
  shouldConvertLeadingIdeographicCommaToSlash
} from "./agentInputCandidates";

test("shouldConvertLeadingIdeographicCommaToSlash 仅在空输入以顿号开始时转换", () => {
  assert.equal(shouldConvertLeadingIdeographicCommaToSlash("", "、"), true);
  assert.equal(shouldConvertLeadingIdeographicCommaToSlash("", "、请总结"), true);
  assert.equal(shouldConvertLeadingIdeographicCommaToSlash("/summarize", "、请总结"), false);
  assert.equal(shouldConvertLeadingIdeographicCommaToSlash("已有内容", "、请总结"), false);
  assert.equal(shouldConvertLeadingIdeographicCommaToSlash("", "请总结"), false);
});

test("promptCommandInsertText 在开关关闭时保留 slash 指令", () => {
  const item = {
    id: "summarize",
    title: "Summarize",
    prompt: "Summarize the selected text.",
    command: "summarize"
  };

  assert.equal(promptCommandInsertText(item, "summarize"), "/summarize");
  assert.equal(promptCommandInsertCaret(item, "summarize"), "/summarize".length);
});

test("promptCommandInsertText 在开关开启时回填提示词原文", () => {
  const prompt = "请总结以下内容：\n\n";
  const item = {
    id: "summarize",
    title: "Summarize",
    prompt,
    command: "summarize",
    expandOnSelect: true
  };

  assert.equal(promptCommandInsertText(item, "summarize"), prompt);
  assert.equal(promptCommandInsertCaret(item, "summarize"), prompt.length);
});
