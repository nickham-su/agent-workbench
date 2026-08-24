import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, test } from "node:test";
import { createAgentComposition } from "../agent.composition.js";
import type { LocalAgentRuntimeExecutionPort } from "../agent.runtime-port.js";
import {
  createAgentTestFixture,
  type AgentTestFixture,
} from "../testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

test("P3 wiring: Lifecycle and Subtask share only the lineage query and child-run activator", async () => {
  const fixture = await createAgentTestFixture({
    withApp: true,
    agentWorkerConcurrency: 0,
  });
  fixtures.push(fixture);
  assert.ok(fixture.app);

  const { testOnly } = createAgentComposition(fixture.ctx, fixture.app.log);
  assert.strictEqual(
    testOnly.lifecycleActiveSubtaskChildQuery,
    testOnly.subtaskLineagePersistence,
  );
  assert.strictEqual(
    testOnly.lifecyclePersistence,
    testOnly.subtaskChildRunActivator,
  );
  assert.equal(
    typeof testOnly.subtaskLineagePersistence.findChildByParentTool,
    "function",
  );
  assert.equal(
    typeof testOnly.subtaskChildRunActivator.activate,
    "function",
  );
});

test("P4 structure: module triggers the startup coordinator and keeps startup policy out", async () => {
  const moduleSource = await fs.readFile(
    new URL("../agent.module.ts", import.meta.url),
    "utf8",
  );
  assert.match(moduleSource, /createAgentComposition/);
  assert.match(moduleSource, /startupCoordinator\.runPreListen\(\)/);
  assert.match(moduleSource, /startupCoordinator\.registerRecoverOnListen\(app, runtime\)/);
  assert.doesNotMatch(moduleSource, /agent\.store/);
  assert.doesNotMatch(moduleSource, /ArchiveStartupReconcileApplication/);
  assert.doesNotMatch(moduleSource, /scanAndCleanupSubtaskOrphansBestEffort/);
  assert.doesNotMatch(moduleSource, /listSuspects|deleteSuspectIfStillEligible/);
  assert.doesNotMatch(moduleSource, /60 \* 60 \* 1000|24 \* 60 \* 60 \* 1000/);
});

test("P4 composition exposes only narrow Subtask collaborators and not capability or dependency bags", async () => {
  const fixture = await createAgentTestFixture({
    withApp: true,
    agentWorkerConcurrency: 0,
  });
  fixtures.push(fixture);
  assert.ok(fixture.app);

  const composition = createAgentComposition(fixture.ctx, fixture.app.log);
  const { service, testOnly } = composition;
  assert.equal("capabilities" in composition, false);
  assert.equal("wiring" in composition, false);
  assert.equal("getRunLifecycleDependencies" in testOnly, false);
  assert.equal("getSubtaskDependencies" in testOnly, false);
  assert.equal("subtaskApplication" in (service as object), false);
  assert.equal(typeof testOnly.subtaskLineagePersistence.findChildByParentTool, "function");
  assert.equal(typeof testOnly.subtaskChildRunActivator.activate, "function");
  assert.equal(typeof service.startSubtaskRunFromWorker, "function");
  assert.equal(typeof service.getSubtaskPreforkPlanFromWorker, "function");
  assert.equal(typeof service.getSubtaskRunResultFromWorker, "function");
  assert.equal(typeof service.getSubtaskRunStatusFromWorker, "function");
  assert.equal(typeof service.cleanupSubtaskOrphansOnStartup, "function");
});

test("P2 structure: local fallback execution port has no Subtask or nested-runtime capability", () => {
  const localPortKeys = [
    "getPromptContextForRun",
    "appendContextItemFromWorker",
    "updateContextItemFromWorker",
    "updateRunStateFromWorker",
    "completeRunFromWorker",
    "getSession",
  ] satisfies Array<keyof LocalAgentRuntimeExecutionPort>;

  assert.deepEqual(localPortKeys, [
    "getPromptContextForRun",
    "appendContextItemFromWorker",
    "updateContextItemFromWorker",
    "updateRunStateFromWorker",
    "completeRunFromWorker",
    "getSession",
  ]);
});
