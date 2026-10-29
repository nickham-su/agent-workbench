import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { gitWorkspaceStatus } from "./git.service.js";
import { parseRepositoryStatus } from "./git-status.js";
import { registerGitRoutes } from "./git.routes.js";
import { HttpError } from "../../app/errors.js";
import { createGitFixture } from "./git.test-support.js";

const status = parseRepositoryStatus("# branch.oid (initial)\0# branch.head main\0");

for (const count of [0, 1, 8]) {
  test(`Workspace summary: ${count} registered repositories, stable order, at most four concurrent reads`, async (t) => {
    const f = await createGitFixture(t, count);
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const result = await gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId }, async ({ repoPath }) => {
      calls++;
      maxActive = Math.max(maxActive, ++active);
      const index = Number(path.basename(repoPath).slice(5));
      await new Promise((resolve) => setTimeout(resolve, 10 - index));
      active--;
      return { ...status, head: { ...status.head, branch: `branch-${index}` }, hasChanges: index % 2 === 0 };
    });
    assert.equal(calls, count);
    assert.ok(maxActive <= 4);
    assert.equal(active, 0);
    assert.deepEqual(result.repos.map((repo) => repo.dirName), Array.from({ length: count }, (_, index) => `repo-${index}`));
    assert.deepEqual(result.repos.map((repo) => repo.head.branch), Array.from({ length: count }, (_, index) => `branch-${index}`));
    for (const [index, repo] of result.repos.entries()) {
      assert.equal(repo.hasChanges, index % 2 === 0);
      assert.deepEqual(Object.keys(repo).sort(), ["dirName", "hasChanges", "head", "repoId"], "no file paths or per-repo error state");
    }
  });
}

test("one failure rejects the entire batch and waits for active readers; error is sanitized", async (t) => {
  const f = await createGitFixture(t, 8);
  let active = 0;
  await assert.rejects(() => gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId }, async ({ repoPath }) => {
    active++;
    await new Promise((resolve) => setTimeout(resolve, path.basename(repoPath) === "repo-1" ? 1 : 10));
    active--;
    if (path.basename(repoPath) === "repo-1") throw new Error("private-absolute-path: secret-material");
    return status;
  }), (error: HttpError) => {
    assert.equal(error.statusCode, 500);
    assert.equal(error.code, "GIT_WORKSPACE_STATUS_FAILED");
    assert.match(error.message, /repo-1/);
    assert.ok(!error.message.includes("private-absolute-path"));
    assert.ok(!error.message.includes("secret-material"));
    return true;
  });
  assert.equal(active, 0);
});

test("timeout reason names the failed repository without a partial response", async (t) => {
  const f = await createGitFixture(t);
  await assert.rejects(() => gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId }, async () => { throw new Error("Git status timed out"); }), /repository "repo-0": Git status timed out/);
});

test("missing registered repository fails the entire batch before executing Git", async (t) => {
  const f = await createGitFixture(t);
  await fs.rm(f.paths[0]!, { recursive: true });
  let calls = 0;
  await assert.rejects(() => gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId }, async () => { calls++; return status; }), /repo-0.*invalid/);
  assert.equal(calls, 0);
});

test("input validation and route schemas handle empty Workspaces without running Git", async (t) => {
  const f = await createGitFixture(t, 0);
  await assert.rejects(() => gitWorkspaceStatus(f.ctx, {}), (error: HttpError) => error.statusCode === 400);
  await assert.rejects(() => gitWorkspaceStatus(f.ctx, { workspaceId: "absent" }), (error: HttpError) => error.statusCode === 404);
  const app = Fastify();
  t.after(() => app.close());
  await registerGitRoutes(app, f.ctx);
  const response = await app.inject({ method: "POST", url: "/api/git/workspace-status", payload: { workspaceId: f.workspaceId } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { repos: [] });
  assert.equal((await app.inject({ method: "POST", url: "/api/git/workspace-status", payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/git/workspace-status", payload: { workspaceId: "absent" } })).statusCode, 404);
});
