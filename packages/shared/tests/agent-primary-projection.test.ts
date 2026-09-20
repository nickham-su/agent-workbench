import assert from "node:assert/strict";
import test from "node:test";
import {
  canStartPrimaryRetainedTail,
  hasPrimaryBlockVisibleProjection,
  type AgentMessage,
  type PrimaryReplayProjectionDescriptor,
} from "../src/index.js";

const officialProfile = {
  provider: { id: "openai", npm: "@ai-sdk/openai" as const },
  model: { id: "gpt-5", providerModelId: "gpt-5" },
};

function message(input: AgentMessage["type"], parts: AgentMessage["parts"]): AgentMessage {
  return {
    id: "message",
    workspaceId: "workspace",
    previousMessageId: null,
    replacesMessageId: null,
    depth: 0,
    type: input,
    status: "completed",
    originSessionId: "session",
    originRunId: "run",
    updatedRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    parts,
  } as AgentMessage;
}

function reasoningReplay(providerId = "openai"): PrimaryReplayProjectionDescriptor {
  return {
    adapter: "openai_responses",
    providerId,
    modelId: "gpt-5",
    itemType: "reasoning",
  };
}

test("Primary retained-start projection uses a private-data-free visible/replay profile vector", () => {
  const safeReplay = reasoningReplay();
  assert.deepEqual(Object.keys(safeReplay).sort(), ["adapter", "itemType", "modelId", "providerId"]);
  assert.equal("encryptedContent" in safeReplay, false);
  assert.equal("itemId" in safeReplay, false);
  assert.equal("summaryIndex" in safeReplay, false);
  assert.equal("phase" in safeReplay, false);
  assert.equal("options" in safeReplay, false);

  const emptyUser = message("user", [{
    id: "empty", messageId: "message", position: 0, type: "text", text: "", updatedRevision: 1, createdAt: 1, updatedAt: 1,
  }]);
  assert.equal(hasPrimaryBlockVisibleProjection({ message: emptyUser, profile: officialProfile, replayProjectionByPartId: new Map() }), false);
  assert.equal(canStartPrimaryRetainedTail({ message: emptyUser, profile: officialProfile, replayProjectionByPartId: new Map() }), false);

  const replayOnlyAssistant = message("assistant", [{
    id: "reason", messageId: "message", position: 0, type: "reasoning", text: "", updatedRevision: 1, createdAt: 1, updatedAt: 1,
  }]);
  const compatible = new Map([["reason", safeReplay]]);
  assert.equal(canStartPrimaryRetainedTail({ message: replayOnlyAssistant, profile: officialProfile, replayProjectionByPartId: compatible }), true);
  assert.equal(canStartPrimaryRetainedTail({
    message: replayOnlyAssistant,
    profile: { ...officialProfile, provider: { ...officialProfile.provider, npm: "@ai-sdk/openai-compatible" } },
    replayProjectionByPartId: compatible,
  }), false);
  assert.equal(hasPrimaryBlockVisibleProjection({
    message: replayOnlyAssistant,
    profile: officialProfile,
    replayProjectionByPartId: new Map([["reason", reasoningReplay("other")]]),
  }), false);

  const visibleAssistant = message("assistant", [{
    id: "text", messageId: "message", position: 0, type: "text", text: "answer", updatedRevision: 1, createdAt: 1, updatedAt: 1,
  }]);
  const nonOfficialProfile = {
    ...officialProfile,
    provider: { ...officialProfile.provider, npm: "@ai-sdk/openai-compatible" as const },
  };
  assert.equal(hasPrimaryBlockVisibleProjection({ message: visibleAssistant, profile: nonOfficialProfile, replayProjectionByPartId: new Map() }), true);
  assert.equal(canStartPrimaryRetainedTail({ message: visibleAssistant, profile: nonOfficialProfile, replayProjectionByPartId: new Map() }), false);
});
