import assert from "node:assert/strict";
import test from "node:test";
import { CompactionSourceInvariantError, validateCompactionSourceBlock } from "./source-block-invariants.js";
import { addAssistantReplay, testSource } from "./test-fixtures.js";

const providers = ["@ai-sdk/openai", "@ai-sdk/deepseek", "@ai-sdk/moonshotai"] as const;

function replayBlock(npm: typeof providers[number]) {
  return addAssistantReplay(testSource({ texts: ["answer"], types: ["assistant"] }).blocks[0]!, npm);
}

for (const npm of providers) {
  test(`${npm} compaction accepts its own text, reasoning and tool replay without rewriting metadata`, () => {
    const block = replayBlock(npm);
    const original = structuredClone(block);
    const validated = validateCompactionSourceBlock(block);
    assert.equal(validated.replayByPartId.size, 3);
    for (const replay of block.providerReplay) assert.equal(validated.replayByPartId.get(replay.partId), replay.envelope);
    assert.deepEqual(block, original);
  });

  test(`${npm} compaction rejects a tool replay type from another protocol`, () => {
    const block = replayBlock(npm);
    const replay = block.providerReplay.at(-1)!;
    (replay.envelope.item as { type: string }).type = npm === "@ai-sdk/openai" ? "tool_call" : "function_call";
    assert.throws(() => validateCompactionSourceBlock(block), CompactionSourceInvariantError);
  });

  test(`${npm} compaction still rejects replay part mismatch, duplicate replay and missing associations`, () => {
    const mismatch = replayBlock(npm);
    mismatch.providerReplay.at(-1)!.partId = "absent";
    assert.throws(() => validateCompactionSourceBlock(mismatch), /matching assistant part/);

    const wrongPart = replayBlock(npm);
    wrongPart.providerReplay = [{ ...wrongPart.providerReplay.at(-1)!, partId: wrongPart.message.parts[1]!.id }];
    assert.throws(() => validateCompactionSourceBlock(wrongPart), /matching assistant part/);

    const duplicate = replayBlock(npm);
    duplicate.providerReplay.push(duplicate.providerReplay[0]!);
    assert.throws(() => validateCompactionSourceBlock(duplicate), /duplicate provider replay/);

    const missingExecution = replayBlock(npm);
    missingExecution.toolExecutions = [];
    assert.throws(() => validateCompactionSourceBlock(missingExecution), /execution set mismatch/);

    const wrongExecution = replayBlock(npm);
    wrongExecution.toolExecutions[0]!.callPartId = "absent";
    assert.throws(() => validateCompactionSourceBlock(wrongExecution), /without its execution/);

    const nonAssistant = replayBlock(npm);
    nonAssistant.message.type = "user";
    assert.throws(() => validateCompactionSourceBlock(nonAssistant), CompactionSourceInvariantError);
  });
}

test("compaction rejects incompatible provider/API metadata even when the item type matches", () => {
  const block = replayBlock("@ai-sdk/deepseek");
  (block.providerReplay[0]!.envelope.provider as { api: string }).api = "responses";
  assert.throws(() => validateCompactionSourceBlock(block), /invalid provider replay protocol metadata/);
});
