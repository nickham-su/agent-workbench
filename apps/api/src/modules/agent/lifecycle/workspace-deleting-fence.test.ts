import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../../app/errors.js";
import { WorkspaceDeletingFence } from "./workspace-deleting-fence.js";

test("workspace deleting fence rejects only the deleting workspace and releases it afterwards", () => {
  const fence = new WorkspaceDeletingFence();
  fence.begin("workspace-a");
  assert.equal(fence.isDeleting("workspace-a"), true);
  assert.doesNotThrow(() => fence.assertWritable("workspace-b"));
  assert.throws(
    () => fence.assertWritable("workspace-a"),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.code === "WORKSPACE_DELETING",
  );
  assert.throws(
    () => fence.begin("workspace-a"),
    (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_DELETING",
  );
  fence.end("workspace-a");
  assert.equal(fence.isDeleting("workspace-a"), false);
  assert.doesNotThrow(() => fence.assertWritable("workspace-a"));
});
