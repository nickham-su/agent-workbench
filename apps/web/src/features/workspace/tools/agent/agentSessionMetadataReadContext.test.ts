import assert from "node:assert/strict";
import test from "node:test";
import { createAgentSessionMetadataReads, sameContinuationQualification } from "./agentSessionMetadataReadContext";
import type { AgentSessionRecord } from "@agent-workbench/shared";

test("mutation watermarks survive protected-record convergence and reject old timeline reads", () => {
  const reads = createAgentSessionMetadataReads(() => ({ workspaceId: "ws", workspaceGeneration: 1 }));
  const timeline = reads.captureReadToken("ws", "s")!;
  reads.mutation("s");
  const newer = reads.captureReadToken("ws", "s")!;
  assert.equal(reads.accept(newer), "accepted");
  assert.equal(reads.accept(timeline), "protected");
  assert.equal(reads.epoch("s"), 1);
  assert.equal(reads.accept(newer), "supersededRead");
});

test("snapshot captures mutation epochs at issue time; a newer title read protects whole records", () => {
  const reads = createAgentSessionMetadataReads(() => ({ workspaceId: "ws", workspaceGeneration: 1 }));
  const snapshot = reads.captureSnapshot()!;
  const timeline = reads.captureReadToken("ws", "s")!;
  assert.equal(reads.accept(timeline), "accepted");
  assert.equal(reads.accept(snapshot("s")), "supersededRead");
  const next = reads.captureReadToken("ws", "s")!;
  reads.mutation("s");
  assert.equal(reads.accept(next), "protected");
});

test("same-title reads do not change continuation qualification", () => {
  const record = { kind: "primary", headMessageId: "head", title: " Title " } as AgentSessionRecord;
  assert.equal(sameContinuationQualification(record, { ...record, title: "Title", updatedAt: 5 }), true);
  assert.equal(sameContinuationQualification(record, { ...record, headMessageId: null }), false);
});
