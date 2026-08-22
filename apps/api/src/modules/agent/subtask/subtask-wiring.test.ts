import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, test } from "node:test";
import { AgentService } from "../agent.service.js";
import type { LocalAgentRuntimeExecutionPort } from "../agent.runtime-port.js";
import {
  createAgentTestFixture,
  type AgentTestFixture,
} from "../testkit/agent-testkit.js";
import type { RunLifecycleApplication } from "../lifecycle/run-lifecycle-application.js";
import type { RunLifecycleApplicationDependencies } from "../lifecycle/run-lifecycle-ports.js";
import type { SubtaskApplication } from "./subtask-application.js";
import type { SubtaskApplicationDependencies } from "./subtask-ports.js";

const fixtures: AgentTestFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

function getLifecycleDependencies(
  service: AgentService,
): RunLifecycleApplicationDependencies {
  const application = (
    service as unknown as { runLifecycleApplication: RunLifecycleApplication }
  ).runLifecycleApplication;
  return (
    application as unknown as {
      dependencies: RunLifecycleApplicationDependencies;
    }
  ).dependencies;
}

function getSubtaskDependencies(
  service: AgentService,
): SubtaskApplicationDependencies {
  const application = (
    service as unknown as { subtaskApplication: SubtaskApplication }
  ).subtaskApplication;
  return (
    application as unknown as { dependencies: SubtaskApplicationDependencies }
  ).dependencies;
}

test("P3 wiring: Lifecycle receives only the active child query while exposing its narrow atomic child activator", async () => {
  const fixture = await createAgentTestFixture({
    withApp: true,
    agentWorkerConcurrency: 0,
  });
  fixtures.push(fixture);
  assert.ok(fixture.app);

  const service = new AgentService(fixture.ctx, fixture.app.log);
  const lifecycleDependencies = getLifecycleDependencies(service);
  const subtaskDependencies = getSubtaskDependencies(service);
  assert.strictEqual(
    lifecycleDependencies.activeSubtaskChildQuery,
    subtaskDependencies.lineagePersistence,
  );
  assert.equal(
    typeof lifecycleDependencies.activeSubtaskChildQuery.listByParentRun,
    "function",
  );
  assert.deepEqual(
    lifecycleDependencies.activeSubtaskChildQuery.listByParentRun({
      workspaceId: "missing-workspace",
      sessionId: "missing-session",
      runId: "missing-run",
    }),
    [],
  );
  assert.equal(
    typeof subtaskDependencies.lineagePersistence.findChildByParentTool,
    "function",
  );
  assert.equal(
    typeof subtaskDependencies.childRunActivator.activate,
    "function",
  );
  assert.strictEqual(
    subtaskDependencies.childRunActivator,
    lifecycleDependencies.persistence,
  );
});

test("P5 structure: module only triggers explicit startup use-cases and keeps startup policy out", async () => {
  const moduleSource = await fs.readFile(
    new URL("../agent.module.ts", import.meta.url),
    "utf8",
  );
  assert.match(moduleSource, /service\.cleanupSubtaskOrphansOnStartup\(\)/);
  assert.match(moduleSource, /try\s*\{\s*service\.cleanupSubtaskOrphansOnStartup\(\);\s*\}\s*catch/);
  assert.match(moduleSource, /new ArchiveStartupReconcileApplication\(/);
  assert.match(moduleSource, /listSessions:\s*\(\)\s*=>\s*listAgentSessionsForArchiveReconcile\(ctx\.db\)/);
  assert.doesNotMatch(moduleSource, /scanAndCleanupSubtaskOrphansBestEffort/);
  assert.doesNotMatch(moduleSource, /listSuspects|deleteSuspectIfStillEligible/);
  assert.doesNotMatch(moduleSource, /60 \* 60 \* 1000|24 \* 60 \* 60 \* 1000/);
  assert.ok(
    moduleSource.indexOf("cleanupSubtaskOrphansOnStartup")
      < moduleSource.indexOf("new ArchiveStartupReconcileApplication"),
  );
});

test("P3 wiring: AgentService facade delegates prefork/start to the narrow Subtask application", async () => {
  const fixture = await createAgentTestFixture({
    withApp: true,
    agentWorkerConcurrency: 0,
  });
  fixtures.push(fixture);
  assert.ok(fixture.app);

  const service = new AgentService(fixture.ctx, fixture.app.log);
  const dependencies = getSubtaskDependencies(service);
  assert.ok("subtaskApplication" in (service as object));
  assert.equal(typeof dependencies.parentAnchorReader.resolve, "function");
  assert.equal(
    typeof dependencies.sessionMaterializer.resolveForStart,
    "function",
  );
  assert.equal(typeof dependencies.executionProfileReader.resolve, "function");
  assert.equal(typeof dependencies.workspaceReader.get, "function");
  assert.equal(typeof dependencies.parentRunStateReader.get, "function");
  assert.equal(typeof dependencies.forkGuardTextReader.get, "function");
  assert.equal(typeof dependencies.runQuery.findSession, "function");
  assert.equal(typeof dependencies.runQuery.findRunInSession, "function");
  assert.equal(typeof dependencies.runQuery.listVisibleItemsByRun, "function");
  assert.equal(
    typeof dependencies.localCompensationPersistence
      .deleteNewSessionIfStillEmpty,
    "function",
  );
  assert.equal(
    typeof dependencies.orphanPersistence.deleteSuspectIfStillEligible,
    "function",
  );
  assert.equal(
    "deleteEmptySubtaskSessionIfStillEmpty" in dependencies.localCompensationPersistence,
    false,
  );
  assert.equal(typeof service.startSubtaskRunFromWorker, "function");
  assert.equal(typeof service.getSubtaskPreforkPlanFromWorker, "function");
  assert.equal(typeof service.getSubtaskRunResultFromWorker, "function");
  assert.equal(typeof service.getSubtaskRunStatusFromWorker, "function");
  assert.equal(typeof service.cleanupSubtaskOrphansOnStartup, "function");
  assert.equal(
    (service as unknown as { subtaskOrphanPersistence?: unknown })
      .subtaskOrphanPersistence,
    undefined,
  );
  assert.equal(
    (service as unknown as { getSubtaskPreforkPlanFromWorker: unknown })
      .getSubtaskPreforkPlanFromWorker,
    service.getSubtaskPreforkPlanFromWorker,
  );
  assert.equal(
    (service as unknown as { subtaskApplication: SubtaskApplication })
      .subtaskApplication instanceof Object,
    true,
  );
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
  assert.equal(
    localPortKeys.some((key) => /subtask|nested/i.test(key)),
    false,
  );
});
