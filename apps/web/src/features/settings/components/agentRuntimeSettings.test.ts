import assert from "node:assert/strict";
import { test } from "node:test";
import { modelPathFromReference, modelReferenceFromPath } from "./agentRuntimeSettings";

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
