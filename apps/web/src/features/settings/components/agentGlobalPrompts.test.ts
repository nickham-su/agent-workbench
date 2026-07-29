import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeAgentGlobalPromptItems,
  toAgentGlobalPromptsRequest
} from "./agentGlobalPrompts";

test("normalizeAgentGlobalPromptItems 仅为带指令的普通条目保留展开配置", () => {
  const items = normalizeAgentGlobalPromptItems([
    {
      id: "expand",
      title: "Expand",
      prompt: "Prompt text",
      command: "summarize",
      expandOnSelect: true
    },
    {
      id: "disabled",
      title: "Disabled",
      prompt: "Prompt text",
      command: "rewrite",
      expandOnSelect: false
    },
    {
      id: "without-command",
      title: "Without command",
      prompt: "Prompt text",
      expandOnSelect: true
    },
    {
      id: "global_system_prompt",
      title: "Global System Prompt",
      prompt: "Prompt text",
      command: "system",
      expandOnSelect: true
    }
  ]);

  assert.deepEqual(items, [
    {
      id: "expand",
      title: "Expand",
      prompt: "Prompt text",
      command: "summarize",
      expandOnSelect: true
    },
    {
      id: "disabled",
      title: "Disabled",
      prompt: "Prompt text",
      command: "rewrite"
    },
    {
      id: "without-command",
      title: "Without command",
      prompt: "Prompt text"
    },
    {
      id: "global_system_prompt",
      title: "Global System Prompt",
      prompt: "Prompt text"
    }
  ]);
});

test("toAgentGlobalPromptsRequest 仅序列化有效指令的开启状态", () => {
  const request = toAgentGlobalPromptsRequest([
    {
      id: "expand",
      title: " Expand ",
      prompt: "Prompt text",
      command: " summarize ",
      expandOnSelect: true
    },
    {
      id: "without-command",
      title: "Without command",
      prompt: "Prompt text",
      expandOnSelect: true
    },
    {
      id: "global_system_prompt",
      title: "Global System Prompt",
      prompt: "Prompt text",
      command: "system",
      expandOnSelect: true
    }
  ]);

  assert.deepEqual(request, {
    items: [
      { id: "expand", title: "Expand", prompt: "Prompt text", command: "summarize", expandOnSelect: true },
      { id: "without-command", title: "Without command", prompt: "Prompt text" },
      { id: "global_system_prompt", title: "Global System Prompt", prompt: "Prompt text" }
    ]
  });
});

test("toAgentGlobalPromptsRequest 在删除指令后不保留展开配置", () => {
  const request = toAgentGlobalPromptsRequest([
    {
      id: "without-command",
      title: "Without command",
      prompt: "Prompt text",
      command: "   ",
      expandOnSelect: true
    }
  ]);

  assert.deepEqual(request, {
    items: [
      { id: "without-command", title: "Without command", prompt: "Prompt text" }
    ]
  });
});

test("normalizeAgentGlobalPromptItems 在清空指令后不保留展开配置", () => {
  const items = normalizeAgentGlobalPromptItems([
    {
      id: "without-command",
      title: "Without command",
      prompt: "Prompt text",
      command: "   ",
      expandOnSelect: true
    }
  ]);

  assert.deepEqual(items, [
    {
      id: "without-command",
      title: "Without command",
      prompt: "Prompt text"
    }
  ]);
});
