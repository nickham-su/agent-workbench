import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  UpdateWorkspaceAgentSessionTabVisibilityRequestSchema,
  WorkspaceAgentSessionTabStateParamsSchema,
  WorkspaceAgentSessionTabVisibilityMutationSchema,
  WorkspaceAgentTabStateSchema
} from "../src/index.js";

test("Agent 会话 Tab 状态共享契约保持精简且从包入口导出", () => {
  assert.deepEqual(Object.keys(WorkspaceAgentTabStateSchema.properties), [
    "workspaceId",
    "openedSessionIds",
    "closedSessionIds",
    "openedSubtaskSessionIds"
  ]);
  assert.deepEqual(WorkspaceAgentTabStateSchema.required, [
    "workspaceId",
    "openedSessionIds",
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

test("opened Session IDs are mandatory, unique and non-empty while compatibility projections remain available", () => {
  const state = { workspaceId: "workspace", openedSessionIds: ["hidden-open"], closedSessionIds: [], openedSubtaskSessionIds: [] };
  assert.equal(Value.Check(WorkspaceAgentTabStateSchema, state), true);
  for (const ids of [undefined, null, [""], ["duplicate", "duplicate"]]) {
    assert.equal(Value.Check(WorkspaceAgentTabStateSchema, { ...state, openedSessionIds: ids }), false);
  }
  assert.equal(Value.Check(UpdateWorkspaceAgentSessionTabVisibilityRequestSchema, { visible: true, includeUnlisted: true }), false);
});
