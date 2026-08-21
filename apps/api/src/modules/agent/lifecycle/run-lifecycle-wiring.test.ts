import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AgentService } from "../agent.service.js";
import { createAgentTestFixture, type AgentTestFixture } from "../testkit/agent-testkit.js";
import type { RunLifecycleApplication } from "./run-lifecycle-application.js";
import type { RunLifecycleApplicationDependencies } from "./run-lifecycle-ports.js";

const fixtures: AgentTestFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

function getWiredDependencies(service: AgentService): RunLifecycleApplicationDependencies {
  // P2 intentionally exposes no product facade before a use-case is migrated.
  // Keep this narrow white-box read in one place for constructor wiring only.
  const application = (service as unknown as { runLifecycleApplication: RunLifecycleApplication }).runLifecycleApplication;
  return (application as unknown as { dependencies: RunLifecycleApplicationDependencies }).dependencies;
}

test("AgentService Lifecycle wiring directly exercises reader, child-query, clock and id adapters", async () => {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  assert.ok(fixture.app);
  const service = new AgentService(fixture.ctx, fixture.app.log);
  const dependencies = getWiredDependencies(service);

  assert.equal(typeof dependencies.persistence.activateUserRun, "function");
  assert.equal(typeof dependencies.persistence.failRunAfterEnqueueFailureIfCurrent, "function");
  assert.equal(typeof dependencies.persistence.getCancelSessionSnapshot, "function");
  assert.equal(typeof dependencies.persistence.cancelSessions, "function");
  assert.equal(typeof dependencies.persistence.updateRunStateFromWorker, "function");
  assert.equal(typeof dependencies.persistence.completeRunFromWorker, "function");
  assert.equal(dependencies.workspaceRunContextReader.get("missing-workspace"), null);
  assert.throws(() => dependencies.runStateReader.get("missing-session"));
  assert.deepEqual(dependencies.activeSubtaskChildQuery.listByParentRun({
    workspaceId: "workspace",
    sessionId: "session",
    runId: "run"
  }), []);
  assert.equal(dependencies.clock.nowMs() <= Date.now(), true);
  assert.match(dependencies.ids.newId("run"), /^run_/);
});
