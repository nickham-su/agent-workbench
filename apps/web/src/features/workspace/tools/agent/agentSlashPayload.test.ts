import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgentSlashSendAction } from "./agentSlashPayload";

function prompts(entries: Array<[string, { prompt: string; expandOnSelect?: boolean }]>) {
  return new Map(entries.map(([command, item]) => [command, {
    id: command,
    title: command,
    command,
    prompt: item.prompt,
    expandOnSelect: item.expandOnSelect,
  }]));
}

test("内建 /compact 优先于同名自定义 prompt", () => {
  assert.deepEqual(resolveAgentSlashSendAction({ text: "/compact", promptCommands: prompts([["compact", { prompt: "custom" }]]) }), { kind: "compact" });
});

test("非展开 custom prompt 在发送时精确展开", () => {
  assert.deepEqual(resolveAgentSlashSendAction({ text: "/review", promptCommands: prompts([["review", { prompt: "请审查变更", expandOnSelect: false }]]) }), { kind: "send", text: "请审查变更" });
});

test("自定义 /clear 是普通 prompt，未知 slash 保持原文", () => {
  const promptCommands = prompts([["clear", { prompt: "清理并重新描述当前问题", expandOnSelect: false }]]);
  assert.deepEqual(resolveAgentSlashSendAction({ text: "/clear", promptCommands }), { kind: "send", text: "清理并重新描述当前问题" });
  assert.deepEqual(resolveAgentSlashSendAction({ text: "/unknown", promptCommands }), { kind: "send", text: "/unknown" });
});

test("已展开的 prompt 与带参数 slash 不会重复展开", () => {
  const promptCommands = prompts([["review", { prompt: "请审查", expandOnSelect: true }]]);
  assert.deepEqual(resolveAgentSlashSendAction({ text: "请审查", promptCommands }), { kind: "send", text: "请审查" });
  assert.deepEqual(resolveAgentSlashSendAction({ text: "/review extra", promptCommands }), { kind: "send", text: "/review extra" });
});
