import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { getWorkspace } from "../workspaces/workspace.store.js";
import { assertWorkspaceRepoSafe } from "./git-target.js";
import { createGitFixture } from "./git.test-support.js";

async function check(f: Awaited<ReturnType<typeof createGitFixture>>) {
  return assertWorkspaceRepoSafe(f.ctx, getWorkspace(f.ctx.db, f.workspaceId)!, { dirName: "repo-0", path: f.paths[0]! });
}

test("registered physical roots and structurally valid repository metadata are accepted", async (t) => {
  const f = await createGitFixture(t);
  await check(f);
});

test("path traversal, mismatched Workspace path, and missing .git cannot discover an ancestor", async (t) => {
  const f = await createGitFixture(t);
  const ws = getWorkspace(f.ctx.db, f.workspaceId)!;
  await assert.rejects(() => assertWorkspaceRepoSafe(f.ctx, ws, { dirName: "../repo-0", path: f.paths[0]! }), /invalid/);
  await assert.rejects(() => assertWorkspaceRepoSafe(f.ctx, { ...ws, path: f.paths[0]! }, { dirName: "repo-0", path: f.paths[0]! }), /invalid/);
  await fs.rm(path.join(f.paths[0]!, ".git"), { recursive: true });
  // Even if a parent looks like a repository, this registered target must fail closed.
  await fs.mkdir(path.join(f.workspacePath, ".git", "objects"), { recursive: true });
  await fs.mkdir(path.join(f.workspacePath, ".git", "refs"), { recursive: true });
  await fs.writeFile(path.join(f.workspacePath, ".git", "HEAD"), "ref: refs/heads/main\n");
  await assert.rejects(() => check(f), /invalid/);
});

test("repository and Workspace directory symlinks are rejected", async (t) => {
  const f = await createGitFixture(t);
  const moved = path.join(f.ctx.dataDir, "other");
  await fs.rename(f.paths[0]!, moved);
  await fs.symlink(moved, f.paths[0]!, "dir");
  await assert.rejects(() => check(f), /invalid/);
  await fs.unlink(f.paths[0]!);
  await fs.rename(moved, f.paths[0]!);
  const movedWorkspace = path.join(f.ctx.dataDir, "moved-workspace");
  await fs.rename(f.workspacePath, movedWorkspace);
  await fs.symlink(movedWorkspace, f.workspacePath, "dir");
  await assert.rejects(() => check(f), /invalid/);
});

test("Git metadata symlinks and external gitfiles are rejected without leaking paths", async (t) => {
  const f = await createGitFixture(t);
  const dotGit = path.join(f.paths[0]!, ".git");
  const moved = path.join(f.ctx.dataDir, "elsewhere");
  await fs.rename(dotGit, moved);
  await fs.symlink(moved, dotGit, "dir");
  await assert.rejects(() => check(f), (error: Error) => !error.message.includes(f.ctx.dataDir));
  await fs.unlink(dotGit);
  await fs.writeFile(dotGit, `gitdir: ${moved}\n`);
  await assert.rejects(() => check(f), /invalid/);
});

test("linked worktree gitfile with owned common metadata and matching back-link is accepted", async (t) => {
  const f = await createGitFixture(t);
  const dotGit = path.join(f.paths[0]!, ".git");
  await fs.rm(dotGit, { recursive: true });
  const common = path.join(f.ctx.dataDir, "repos", "r_0", "mirror.git");
  const gitDir = path.join(common, "worktrees", "repo-0");
  await fs.mkdir(gitDir, { recursive: true });
  await fs.mkdir(path.join(common, "objects"), { recursive: true });
  await fs.mkdir(path.join(common, "refs"), { recursive: true });
  await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  await fs.writeFile(path.join(gitDir, "commondir"), "../..\n");
  await fs.writeFile(path.join(gitDir, "gitdir"), dotGit + "\n");
  await fs.writeFile(dotGit, `gitdir: ${gitDir}\n`);
  await check(f);
  await fs.writeFile(path.join(gitDir, "gitdir"), path.join(f.workspacePath, "other", ".git") + "\n");
  await assert.rejects(() => check(f), /invalid/);
});

test("objects directory cannot resolve outside owned metadata roots", async (t) => {
  const f = await createGitFixture(t);
  const objects = path.join(f.paths[0]!, ".git", "objects");
  await fs.rmdir(objects);
  const other = path.join(f.ctx.dataDir, "not-a-repository");
  await fs.mkdir(other);
  await fs.symlink(other, objects, "dir");
  await assert.rejects(() => check(f), /invalid/);
});

test("a gitfile cannot borrow another registered repository's standalone index", async (t) => {
  const f = await createGitFixture(t, 2);
  const dotGit = path.join(f.paths[0]!, ".git");
  await fs.rm(dotGit, { recursive: true });
  await fs.writeFile(dotGit, `gitdir: ${path.join(f.paths[1]!, ".git")}\n`);
  await assert.rejects(() => assertWorkspaceRepoSafe(f.ctx, getWorkspace(f.ctx.db, f.workspaceId)!, { dirName: "repo-0", path: f.paths[0]! }), /invalid/);
});

test("a worktree private index symlink cannot borrow another repository or external fixture index", async (t) => {
  const f = await createGitFixture(t, 2);
  const other = path.join(f.paths[1]!, ".git", "index");
  const external = path.join(f.ctx.dataDir, "external-index");
  await fs.writeFile(other, "other-index"); await fs.writeFile(external, "external-index");
  const index = path.join(f.paths[0]!, ".git", "index");
  for (const destination of [other, external]) {
    await fs.symlink(destination, index);
    await assert.rejects(() => check(f), /invalid/);
    await fs.unlink(index);
  }
  await check(f); // no index yet is valid for an unborn repository
  await fs.writeFile(index, "own-index");
  await check(f);
});
