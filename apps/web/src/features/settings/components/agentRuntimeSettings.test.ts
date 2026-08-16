import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_SUBTASK_DEPTH,
  MAX_SUBTASK_DEPTH_MAX,
  MAX_SUBTASK_DEPTH_MIN,
  modelPathFromReference,
  modelReferenceFromPath,
  normalizeMaxSubtaskDepth,
  toRuntimeSettingsMaxSubtaskDepthPayload
} from "./agentRuntimeSettings";

test("runtime model reference maps to and from a cascader path", () => {
  const reference = { providerId: "provider-a", modelId: "model-a" };
  assert.deepEqual(modelPathFromReference(reference), ["provider-a", "model-a"]);
  assert.deepEqual(
    modelReferenceFromPath(["provider-a", "model-a"], (providerId, modelId) => providerId === "provider-a" && modelId === "model-a"),
    reference
  );
});

test("runtime model reference clears to null and rejects unknown selections", () => {
  assert.deepEqual(modelPathFromReference(undefined), []);
  assert.equal(modelReferenceFromPath([], () => true), null);
  assert.equal(modelReferenceFromPath(["provider-a", "missing"], () => false), undefined);
  assert.equal(modelReferenceFromPath(["provider-a"], () => true), undefined);
});

test("runtime maxSubtaskDepth form value defaults and clamps to the supported integer range", () => {
  assert.equal(DEFAULT_MAX_SUBTASK_DEPTH, 1);
  assert.equal(MAX_SUBTASK_DEPTH_MIN, 1);
  assert.equal(MAX_SUBTASK_DEPTH_MAX, 5);
  assert.equal(normalizeMaxSubtaskDepth(undefined), 1);
  assert.equal(normalizeMaxSubtaskDepth("invalid"), 1);
  assert.equal(normalizeMaxSubtaskDepth(0), 1);
  assert.equal(normalizeMaxSubtaskDepth(1), 1);
  assert.equal(normalizeMaxSubtaskDepth(5), 5);
  assert.equal(normalizeMaxSubtaskDepth(6), 5);
  assert.equal(normalizeMaxSubtaskDepth(3.9), 3);
});

test("runtime settings payload writes a normalized maxSubtaskDepth", () => {
  assert.equal(toRuntimeSettingsMaxSubtaskDepthPayload(undefined), 1);
  assert.equal(toRuntimeSettingsMaxSubtaskDepthPayload(1), 1);
  assert.equal(toRuntimeSettingsMaxSubtaskDepthPayload(5), 5);
  assert.equal(toRuntimeSettingsMaxSubtaskDepthPayload(0), 1);
  assert.equal(toRuntimeSettingsMaxSubtaskDepthPayload(6), 5);
  assert.equal(toRuntimeSettingsMaxSubtaskDepthPayload(2.8), 2);
  assert.equal(toRuntimeSettingsMaxSubtaskDepthPayload("invalid"), 1);
});
