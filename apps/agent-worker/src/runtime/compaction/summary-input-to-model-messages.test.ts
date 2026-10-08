import assert from "node:assert/strict";
import test from "node:test";
import type { ModelMessage } from "ai";
import { summaryInputToModelMessages } from "./summary-input-to-model-messages.js";
import type { SummaryInputBlock } from "./types.js";

const blocks: SummaryInputBlock[] = [{
  sourceBlockId: "message-1",
  isProjectionEmpty: false,
  messages: [
    { role: "system", content: "prior compaction" },
    { role: "user", content: [
      { type: "text", text: "inspect this" },
      { type: "attachment", mediaType: "image/png", filename: "screen.png" },
    ] },
    { role: "assistant", content: [
      { type: "reasoning", text: "reasoning retained as visible text" },
      { type: "tool-call", toolName: "read_file", input: { path: "src/a.ts" } },
    ] },
    { role: "tool", content: [
      { type: "tool-result", toolName: "read_file", output: { type: "text", value: "contents" } },
    ] },
  ],
}];

for (const provider of ["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/anthropic"] as const) {
  test(`${provider} receives portable textual AI SDK ModelMessage shapes`, () => {
    const messages: ModelMessage[] = summaryInputToModelMessages(blocks);
    assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
    for (const message of messages) assert.equal(typeof message.content, "string");
    const serialized = JSON.stringify(messages);
    assert.match(serialized, /Attachment omitted: image\/png, filename=screen\.png/);
    assert.match(serialized, /\[Tool call: read_file\]/);
    assert.match(serialized, /\[Tool result: read_file\]/);
    assert.equal(serialized.includes("attachmentId"), false);
    assert.equal(serialized.includes("providerReplay"), false);
    assert.equal(serialized.includes("encrypted"), false);
  });
}
