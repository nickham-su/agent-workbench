import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAgentComposition } from "../agent.composition.js";
import { createAgentTestFixture, type AgentTestFixture } from "../testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

test("P4 composition wires Lifecycle to its narrow persistence and active-child collaborators", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);

  const { testOnly } = createAgentComposition(fixture.ctx, fixture.app.log);
  assert.equal(typeof testOnly.lifecyclePersistence.activateUserRun, "function");
  assert.equal(typeof testOnly.lifecyclePersistence.completeRunFromWorker, "function");
  assert.equal(typeof testOnly.lifecycleActiveSubtaskChildQuery.listByParentRun, "function");
  assert.deepEqual(testOnly.lifecycleActiveSubtaskChildQuery.listByParentRun({
    workspaceId: "workspace",
    sessionId: "session",
    runId: "run"
  }), []);
});
