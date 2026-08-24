import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { AppContext } from "../../app/context.js";
import type { Db } from "../../infra/db/db.js";
import { insertRepo } from "../repos/repo.store.js";
import { insertWorkspace, insertWorkspaceRepo } from "../workspaces/workspace.store.js";
import { getAgentWorkspaceRunContext } from "./agent-run-context.js";
import { createAgentTestFixture, type AgentTestFixture } from "./testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];

async function createContext(params?: { withWorkspace?: boolean }): Promise<{ ctx: AppContext; db: Db; workspacePath: string }> {
  const fixture = await createAgentTestFixture({
    dataDirPrefix: "agent-run-context-",
    repoRoot: path.resolve(process.cwd(), "../..")
  });
  fixtures.push(fixture);
  const workspacePath = path.join(fixture.dataDir, "workspaces", "workspace-a");

  if (params?.withWorkspace !== false) {
    insertWorkspace(fixture.db, {
      id: "ws-a",
      dirName: "workspace-a",
      title: "workspace",
      path: workspacePath,
      terminalCredentialId: null,
      createdAt: 1,
      updatedAt: 1
    });
  }

  return {
    db: fixture.db,
    workspacePath,
    ctx: fixture.ctx
  };
}

function addRepo(db: Db, params: { id: string; dirName: string; repoPath: string }) {
  insertRepo(db, {
    id: params.id,
    url: `https://example.test/${params.id}.git`,
    credentialId: null,
    defaultBranch: "main",
    mirrorPath: `/mirrors/${params.id}.git`,
    syncStatus: "idle",
    syncError: null,
    lastSyncAt: 1,
    createdAt: 1,
    updatedAt: 1
  });
  insertWorkspaceRepo(db, {
    workspaceId: "ws-a",
    repoId: params.id,
    dirName: params.dirName,
    path: params.repoPath,
    createdAt: 1,
    updatedAt: 1
  });
}

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
  if (failures.length > 1) throw new AggregateError(failures, "Agent run-context fixture cleanup failed");
});

test("getAgentWorkspaceRunContext returns null for a missing workspace", async () => {
  const { ctx } = await createContext({ withWorkspace: false });

  assert.equal(getAgentWorkspaceRunContext(ctx, "missing"), null);
});

test("getAgentWorkspaceRunContext returns an empty repo list for a workspace without repositories", async () => {
  const { ctx, workspacePath } = await createContext();

  assert.deepEqual(getAgentWorkspaceRunContext(ctx, "ws-a"), {
    workspacePath,
    workspaceRepoDirNames: []
  });
});

test("getAgentWorkspaceRunContext keeps registered safe directory names in stable order and filters corrupt entries", async () => {
  const { ctx, db } = await createContext();
  addRepo(db, { id: "repo-z", dirName: "repo-z", repoPath: "/not-returned/repo-z" });
  addRepo(db, { id: "repo-slash", dirName: "repo/a", repoPath: "/not-returned/repo-slash" });
  addRepo(db, { id: "repo-dot", dirName: "..", repoPath: "/not-returned/repo-dot" });
  addRepo(db, { id: "repo-space", dirName: " repo-space", repoPath: "/not-returned/repo-space" });
  addRepo(db, { id: "repo-a", dirName: "repo-a", repoPath: "/not-returned/repo-a" });

  db.exec(`drop index idx_workspace_repos_workspace_dir`);
  addRepo(db, { id: "repo-z-duplicate", dirName: "repo-z", repoPath: "/not-returned/repo-z-duplicate" });

  assert.deepEqual(getAgentWorkspaceRunContext(ctx, "ws-a"), {
    workspacePath: path.join(ctx.dataDir, "workspaces", "workspace-a"),
    workspaceRepoDirNames: ["repo-z", "repo-a"]
  });
});
