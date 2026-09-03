import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_SUBTASK_DEPTH,
  DEFAULT_MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS,
  MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS_MAX,
  MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS_MIN,
  MAX_SUBTASK_DEPTH_MAX,
  MAX_SUBTASK_DEPTH_MIN,
  mapRuntimeSettingsRetryBackoffToFormState,
  modelPathFromReference,
  modelRequestRetryBackoffMaxSecondsFromMs,
  modelReferenceFromPath,
  normalizeMaxSubtaskDepth,
  normalizeModelRequestRetryBackoffMaxSeconds,
  toRuntimeSettingsMaxSubtaskDepthPayload,
  toRuntimeSettingsModelRequestRetryBackoffMaxMsPayload,
  toRuntimeSettingsRetryBackoffUpdatePayload
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

test("runtime retry backoff maximum converts between API milliseconds and form seconds", () => {
  assert.equal(DEFAULT_MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS, 60);
  assert.equal(MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS_MIN, 2);
  assert.equal(MODEL_REQUEST_RETRY_BACKOFF_MAX_SECONDS_MAX, 3600);
  assert.equal(modelRequestRetryBackoffMaxSecondsFromMs(60_000), 60);
  assert.equal(modelRequestRetryBackoffMaxSecondsFromMs(120_000), 120);
  assert.equal(modelRequestRetryBackoffMaxSecondsFromMs(undefined), 60);
  assert.equal(modelRequestRetryBackoffMaxSecondsFromMs("invalid"), 60);
  assert.equal(normalizeModelRequestRetryBackoffMaxSeconds(1), 2);
  assert.equal(normalizeModelRequestRetryBackoffMaxSeconds(3601), 3600);
  assert.equal(normalizeModelRequestRetryBackoffMaxSeconds(120.9), 120);
  assert.equal(toRuntimeSettingsModelRequestRetryBackoffMaxMsPayload(2), 2_000);
  assert.equal(toRuntimeSettingsModelRequestRetryBackoffMaxMsPayload(120), 120_000);
  assert.equal(toRuntimeSettingsModelRequestRetryBackoffMaxMsPayload("invalid"), 60_000);
});

test("runtime settings panel retry backoff mapping loads API milliseconds and saves form seconds", () => {
  const formState = mapRuntimeSettingsRetryBackoffToFormState({
    modelRequestRetryBackoffMaxMs: 120_000
  });

  assert.deepEqual(formState, {
    modelRequestRetryBackoffMaxSeconds: 120
  });

  formState.modelRequestRetryBackoffMaxSeconds = 180;
  assert.deepEqual(toRuntimeSettingsRetryBackoffUpdatePayload(formState), {
    modelRequestRetryBackoffMaxMs: 180_000
  });
});
