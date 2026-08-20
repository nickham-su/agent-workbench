import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, test } from "node:test";
import Fastify from "fastify";
import { getRepo } from "../../repos/repo.store.js";
import { getWorkspace, listWorkspaceRepos } from "../../workspaces/workspace.store.js";
import { AgentRuntimeRun } from "../agent.runtime-port.js";
import {
  createAgentTestFixture,
  createFakeAgentRuntime,
  createTestRepository,
  createTestWorkspace,
  injectJson
} from "./agent-testkit.js";

const fixtures: Array<Awaited<ReturnType<typeof createAgentTestFixture>>> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Agent testkit cleanup failed");
});

async function fixture(options?: Parameters<typeof createAgentTestFixture>[0]) {
  const value = await createAgentTestFixture(options);
  fixtures.push(value);
  return value;
}

test("Agent testkit creates and disposes an explicit real SQLite fixture", async () => {
  const value = await fixture({ dataDirPrefix: "agent-testkit-lifecycle-" });
  const dbPath = `${value.dataDir}/db.sqlite`;

  await fs.access(dbPath);
  assert.equal(value.app, null);
  assert.equal(value.ctx.db, value.db);
  assert.equal(value.ctx.agentWorkerEnabled, false);
  assert.equal(value.ctx.agentWorkerConcurrency, 2);

  await value.dispose();
  assert.equal(fixtures.includes(value), true, "dispose is idempotent so afterEach retains ownership");
  await assert.rejects(fs.access(value.dataDir));
});

test("Agent testkit preserves an initialization failure while continuing cleanup", async () => {
  const initializationFailure = new Error("app initialization failed");
  const closeFailure = new Error("database close failed");
  let dataDir = "";

  await assert.rejects(
    createAgentTestFixture({
      withApp: true,
      async appFactory(ctx) {
        dataDir = ctx.dataDir;
        const close = ctx.db.close.bind(ctx.db);
        ctx.db.close = () => {
          close();
          throw closeFailure;
        };
        const app = Fastify();
        app.addHook("onReady", async () => {
          throw initializationFailure;
        });
        return app;
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal((error as Error & { cause?: unknown }).cause, initializationFailure);
      assert.deepEqual(error.errors, [closeFailure]);
      return true;
    }
  );

  assert.ok(dataDir);
  await assert.rejects(fs.access(dataDir));
});

test("Agent testkit creates visible workspace and repository records without creating unrelated entities", async () => {
  const value = await fixture();
  const workspace = await createTestWorkspace(value, {
    id: "ws-testkit",
    dirName: "workspace-testkit",
    title: "Workspace for testkit"
  });
  const { repo, workspaceRepo } = await createTestRepository(value, {
    workspace,
    id: "repo-testkit",
    dirName: "repo-testkit"
  });

  assert.deepEqual(getWorkspace(value.db, workspace.id), workspace);
  assert.deepEqual(getRepo(value.db, repo.id), repo);
  assert.deepEqual(listWorkspaceRepos(value.db, workspace.id), [workspaceRepo]);
  await fs.access(workspace.path);
  await fs.access(workspaceRepo.path);
  assert.equal((value.db.prepare("select count(*) as count from agent_session").get() as { count: number }).count, 0);
  assert.equal((value.db.prepare("select count(*) as count from agent_run").get() as { count: number }).count, 0);
});

test("Agent testkit can expose a real Fastify app through explicit low-level JSON injection", async () => {
  const value = await fixture({ withApp: true });
  assert.ok(value.app);

  const response = await injectJson(value.app, {
    method: "GET",
    url: "/api/health",
    internalToken: value.internalToken
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal((response.json() as { ok: boolean }).ok, true);
});

test("Agent testkit fake runtime records order, runs hooks, and supports controlled failures", async () => {
  const observed: string[] = [];
  const runtime = createFakeAgentRuntime({
    onEnqueueRun(run) {
      observed.push(`enqueue:${run.runId}`);
    },
    onCancelSession(sessionId) {
      observed.push(`cancel:${sessionId}`);
    },
    cancelSessionError: () => new Error("cancel blocked")
  });
  const run: AgentRuntimeRun = {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    runId: "run-a",
    inputText: "hello",
    workspacePath: "/workspace/a",
    workspaceRepoDirNames: ["repo-a"]
  };

  await runtime.enqueueRun(run);
  await assert.rejects(async () => await runtime.cancelSession("sess-a"), /cancel blocked/);

  assert.deepEqual(runtime.enqueueRunCalls, [run]);
  assert.deepEqual(runtime.cancelSessionCalls, ["sess-a"]);
  assert.deepEqual(observed, ["enqueue:run-a", "cancel:sess-a"]);
});
