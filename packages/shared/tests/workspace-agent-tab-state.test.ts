import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UpdateWorkspaceAgentSessionTabVisibilityRequestSchema,
  WorkspaceAgentSessionTabStateParamsSchema,
  WorkspaceAgentSessionTabVisibilityMutationSchema,
  WorkspaceAgentTabStateSchema
} from "../src/index.js";

test("Agent 会话 Tab 状态共享契约保持精简且从包入口导出", () => {
  assert.deepEqual(Object.keys(WorkspaceAgentTabStateSchema.properties), [
    "workspaceId",
    "closedSessionIds",
    "openedSubtaskSessionIds"
  ]);
  assert.deepEqual(WorkspaceAgentTabStateSchema.required, [
    "workspaceId",
    "closedSessionIds",
    "openedSubtaskSessionIds"
  ]);

  assert.deepEqual(Object.keys(UpdateWorkspaceAgentSessionTabVisibilityRequestSchema.properties), ["visible"]);
  assert.deepEqual(UpdateWorkspaceAgentSessionTabVisibilityRequestSchema.required, ["visible"]);
  assert.equal(UpdateWorkspaceAgentSessionTabVisibilityRequestSchema.additionalProperties, false);
  assert.equal(UpdateWorkspaceAgentSessionTabVisibilityRequestSchema.properties.visible.type, "boolean");

  assert.deepEqual(Object.keys(WorkspaceAgentSessionTabStateParamsSchema.properties), ["workspaceId", "sessionId"]);
  assert.deepEqual(WorkspaceAgentSessionTabStateParamsSchema.required, ["workspaceId", "sessionId"]);
  assert.equal(WorkspaceAgentSessionTabStateParamsSchema.properties.workspaceId.minLength, 1);
  assert.equal(WorkspaceAgentSessionTabStateParamsSchema.properties.sessionId.minLength, 1);

  assert.deepEqual(Object.keys(WorkspaceAgentSessionTabVisibilityMutationSchema.properties), [
    "workspaceId",
    "sessionId",
    "visible"
  ]);
  assert.deepEqual(WorkspaceAgentSessionTabVisibilityMutationSchema.required, ["workspaceId", "sessionId", "visible"]);
  assert.equal(WorkspaceAgentSessionTabVisibilityMutationSchema.properties.visible.type, "boolean");
});
