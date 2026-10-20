import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import { buildGitProcessEnv } from "../../infra/git/gitExec.js";
import { fileCompare, gitStatus, gitWorkspaceStatus, listChanges, stageWorkspace, unstageWorkspace, discardWorkspace } from "./git.service.js";
import { createGitFixture } from "./git.test-support.js";

// This file launches Git only inside freshly created project-owned fixtures.
// Run explicitly from the repository root: node --import tsx --test apps/api/src/modules/git/git-status.integration.test.ts
const exec = promisify(execFile);
async function fixture(t: TestContext, count = 1, objectFormat?: "sha256") {
  const f = await createGitFixture(t, count, false);
  const overrides: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: path.join(f.ctx.dataDir, "empty-global-config"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test"
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const git = async (repoPath: string, ...args: string[]) => {
    assert.ok(path.resolve(repoPath).startsWith(path.resolve(f.ctx.dataDir) + path.sep), "Git fixture must remain inside its isolated data directory");
    return exec("git", ["-C", repoPath, "-c", "init.defaultBranch=main", "-c", `core.hooksPath=${path.join(f.ctx.dataDir, "empty-hooks")}`, ...args], { cwd: f.ctx.dataDir, env: buildGitProcessEnv(overrides), timeout: 15_000 });
  };
  for (const repoPath of f.paths) await git(repoPath, "init", ...(objectFormat ? [`--object-format=${objectFormat}`] : []));
  const target = (index = 0) => ({ kind: "workspaceRepo" as const, workspaceId: f.workspaceId, dirName: `repo-${index}` });
  return { ...f, git, target };
}

test("real eight-repository summary: staged/unstaged/untracked, stable order and ahead-only stays clean", async (t) => {
  const f = await fixture(t, 8);
  await fs.mkdir(path.join(f.paths[0]!, "new-dir"));
  await fs.writeFile(path.join(f.paths[0]!, "new-dir", "new.txt"), "new");
  await fs.writeFile(path.join(f.paths[1]!, "staged.txt"), "stage");
  await f.git(f.paths[1]!, "add", "--", "staged.txt");
  await fs.writeFile(path.join(f.paths[2]!, "tracked.txt"), "base");
  await f.git(f.paths[2]!, "add", ".");
  await f.git(f.paths[2]!, "commit", "-m", "base");
  await fs.appendFile(path.join(f.paths[2]!, "tracked.txt"), "modified");
  const ahead = f.paths[3]!;
  await f.git(ahead, "commit", "--allow-empty", "-m", "base");
  await f.git(ahead, "commit", "--allow-empty", "-m", "ahead");
  await f.git(ahead, "remote", "add", "origin", "https://example.test/not-contacted.git");
  await f.git(ahead, "update-ref", "refs/remotes/origin/main", "HEAD~1");
  await f.git(ahead, "config", "branch.main.remote", "origin");
  await f.git(ahead, "config", "branch.main.merge", "refs/heads/main");
  const result = await gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId });
  assert.deepEqual(result.repos.map((repo) => repo.dirName), Array.from({ length: 8 }, (_, i) => `repo-${i}`));
  assert.deepEqual(result.repos.map((repo) => repo.hasChanges), [true, true, true, false, false, false, false, false]);
  assert.equal((await listChanges(f.ctx, { target: f.target(), mode: "unstaged" })).files[0]?.path, "new-dir/new.txt");
  const legacy = await gitStatus(f.ctx, { target: f.target(3) });
  assert.equal(legacy.upstream?.name, "origin/main");
  assert.equal(legacy.upstream?.ahead, 1);
});

test("real unborn and detached HEAD are valid; legacy dirty counts remain available", async (t) => {
  const f = await fixture(t);
  let result = await gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId });
  assert.deepEqual(result.repos[0]?.head, { branch: "main", detached: false, sha: "" });
  await fs.writeFile(path.join(f.paths[0]!, "new.txt"), "new");
  assert.equal((await gitStatus(f.ctx, { target: f.target() })).dirty?.untracked, 1);
  await f.git(f.paths[0]!, "add", ".");
  assert.equal((await gitStatus(f.ctx, { target: f.target() })).dirty?.staged, 1);
  await f.git(f.paths[0]!, "commit", "-m", "base");
  await f.git(f.paths[0]!, "switch", "--detach");
  result = await gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId });
  assert.equal(result.repos[0]?.head.detached, true);
  assert.equal(result.repos[0]?.head.branch, null);
  assert.match(result.repos[0]?.head.sha ?? "", /^[0-9a-f]{40}$/);
});

test("real staged rename handles special original and current paths", async (t) => {
  const f = await fixture(t);
  const repo = f.paths[0]!;
  await fs.writeFile(path.join(repo, "# branch.head fake"), "same text\n");
  await f.git(repo, "add", ".");
  await f.git(repo, "commit", "-m", "base");
  await f.git(repo, "mv", "--", "# branch.head fake", "new\n中文 name");
  const changes = await listChanges(f.ctx, { target: f.target(), mode: "staged" });
  assert.deepEqual(changes.files.map(({ path, oldPath, status }) => ({ path, oldPath, status })), [{ path: "new\n中文 name", oldPath: "# branch.head fake", status: "R" }]);
  assert.equal((await gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId })).repos[0]?.hasChanges, true);
});

test("real merge conflict appears in summary and both lists", async (t) => {
  const f = await fixture(t);
  const repo = f.paths[0]!;
  await fs.writeFile(path.join(repo, "conflict.txt"), "base\n");
  await f.git(repo, "add", "."); await f.git(repo, "commit", "-m", "base");
  await f.git(repo, "switch", "-c", "side");
  await fs.writeFile(path.join(repo, "conflict.txt"), "side\n");
  await f.git(repo, "commit", "-am", "side"); await f.git(repo, "switch", "main");
  await fs.writeFile(path.join(repo, "conflict.txt"), "main\n");
  await f.git(repo, "commit", "-am", "main");
  await assert.rejects(() => f.git(repo, "merge", "side"));
  assert.equal((await gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId })).repos[0]?.hasChanges, true);
  for (const mode of ["staged", "unstaged"]) assert.equal((await listChanges(f.ctx, { target: f.target(), mode })).files[0]?.status, "U");
});

test("nested repository is an explicit directory item, never a text Diff", async (t) => {
  const f = await fixture(t);
  const nested = path.join(f.paths[0]!, "nested");
  await fs.mkdir(nested);
  await f.git(nested, "init"); await f.git(nested, "commit", "--allow-empty", "-m", "nested");
  assert.equal((await gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId })).repos[0]?.hasChanges, true);
  const changes = await listChanges(f.ctx, { target: f.target(), mode: "unstaged" });
  assert.equal(changes.files[0]?.path, "nested");
  assert.equal(changes.files[0]?.kind, "directory");
  const compare = await fileCompare(f.ctx, { target: f.target(), mode: "unstaged", path: "nested" });
  assert.equal(compare.base.previewable, false); assert.equal(compare.current.previewable, false);
});

test("submodule untracked dirtiness is visible in the list and respects Git ignore policy", async (t) => {
  const f = await fixture(t, 2);
  const [repo, source] = f.paths as [string, string];
  await fs.writeFile(path.join(source, "tracked.txt"), "module");
  await f.git(source, "add", "."); await f.git(source, "commit", "-m", "module");
  await f.git(repo, "-c", "protocol.file.allow=always", "submodule", "add", source, "modules/child");
  await f.git(repo, "commit", "-am", "module");
  await fs.writeFile(path.join(repo, "modules/child/new.txt"), "untracked");
  assert.equal((await gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId })).repos[0]?.hasChanges, true);
  const changes = await listChanges(f.ctx, { target: f.target(), mode: "unstaged" });
  assert.equal(changes.files[0]?.path, "modules/child"); assert.equal(changes.files[0]?.kind, "submodule");
  await f.git(repo, "config", "submodule.modules/child.ignore", "all");
  assert.equal((await gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId })).repos[0]?.hasChanges, false);
  assert.equal((await listChanges(f.ctx, { target: f.target(), mode: "unstaged" })).files.length, 0);
});

test("real linked worktree is supported without querying another repository", async (t) => {
  const f = await fixture(t, 2);
  const [linked, source] = f.paths as [string, string];
  await f.git(source, "commit", "--allow-empty", "-m", "base");
  await fs.rm(linked, { recursive: true });
  await f.git(source, "worktree", "add", "-b", "review", linked);
  await fs.writeFile(path.join(linked, "new.txt"), "linked");
  const result = await gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId });
  assert.equal(result.repos[0]?.head.branch, "review"); assert.equal(result.repos[0]?.hasChanges, true);
  assert.equal(result.repos[1]?.head.branch, "main"); assert.equal(result.repos[1]?.hasChanges, false);
});

test("real Git failure is never converted to clean/empty and errors do not leak paths", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.paths[0]!, ".git/config"), "[invalid\n");
  for (const call of [() => gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId }), () => gitStatus(f.ctx, { target: f.target() }), () => listChanges(f.ctx, { target: f.target(), mode: "unstaged" })]) {
    await assert.rejects(call, (error: Error) => { assert.ok(!error.message.includes(f.ctx.dataDir)); return true; });
  }
});

test("configured but pruned upstream does not fail legacy status", async (t) => {
  const f = await fixture(t);
  const repo = f.paths[0]!;
  await f.git(repo, "commit", "--allow-empty", "-m", "base");
  await f.git(repo, "remote", "add", "origin", "https://example.test/not-contacted.git");
  await f.git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  await f.git(repo, "config", "branch.main.remote", "origin");
  await f.git(repo, "config", "branch.main.merge", "refs/heads/main");
  assert.equal((await gitStatus(f.ctx, { target: f.target() })).upstream?.name, "origin/main");
  await f.git(repo, "update-ref", "-d", "refs/remotes/origin/main");
  await fs.writeFile(path.join(repo, "new.txt"), "new");
  const result = await gitStatus(f.ctx, { target: f.target() });
  assert.equal(result.head.branch, "main");
  assert.equal(result.dirty?.untracked, 1);
  assert.equal(result.upstream, undefined);
  assert.equal((await gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId })).repos[0]?.hasChanges, true);
});

test("unborn branch with an unfetched upstream remains valid", async (t) => {
  const f = await fixture(t);
  const repo = f.paths[0]!;
  await f.git(repo, "remote", "add", "origin", "https://example.test/not-contacted.git");
  await f.git(repo, "config", "branch.main.remote", "origin");
  await f.git(repo, "config", "branch.main.merge", "refs/heads/main");
  const result = await gitStatus(f.ctx, { target: f.target() });
  assert.deepEqual(result.head, { branch: "main", detached: false, sha: "" });
  assert.equal(result.upstream, undefined);
  assert.deepEqual(result.dirty, { staged: 0, unstaged: 0, untracked: 0 });
});

async function submoduleFixture(t: TestContext) {
  const f = await fixture(t, 2);
  const [repo, source] = f.paths as [string, string];
  await fs.writeFile(path.join(source, "tracked.txt"), "module");
  await f.git(source, "add", "."); await f.git(source, "commit", "-m", "module");
  await f.git(repo, "-c", "protocol.file.allow=always", "submodule", "add", source, "modules/child");
  await f.git(repo, "commit", "-am", "module");
  return { ...f, repo, child: path.join(repo, "modules/child") };
}

for (const state of ["deleted", "deinitialized", "staged-removal"] as const) {
  test(`submodule ${state} is never EMPTY-to-EMPTY or commit text`, async (t) => {
    const f = await submoduleFixture(t);
    if (state === "deleted") await fs.rm(f.child, { recursive: true });
    else if (state === "deinitialized") {
      await f.git(f.repo, "submodule", "deinit", "-f", "--", "modules/child");
      await fs.rm(f.child, { recursive: true });
    } else await f.git(f.repo, "rm", "-f", "--", "modules/child");
    for (const mode of ["staged", "unstaged"]) {
      const result = await fileCompare(f.ctx, { target: f.target(), mode, path: "modules/child" });
      assert.equal(result.base.previewable, false);
      assert.equal(result.current.previewable, false);
      assert.equal(result.base.content, undefined);
      assert.equal(result.current.content, undefined);
    }
  });
}

test("ordinary added and deleted files preserve text comparisons after non-blob guards", async (t) => {
  const f = await fixture(t);
  const repo = f.paths[0]!;
  await fs.writeFile(path.join(repo, "old.txt"), "old");
  await f.git(repo, "add", "."); await f.git(repo, "commit", "-m", "base");
  await fs.rm(path.join(repo, "old.txt"));
  let result = await fileCompare(f.ctx, { target: f.target(), mode: "unstaged", path: "old.txt" });
  assert.equal(result.base.content, "old"); assert.equal(result.current.content, "");
  assert.equal(result.base.previewable, true); assert.equal(result.current.previewable, true);
  await f.git(repo, "add", "-u");
  result = await fileCompare(f.ctx, { target: f.target(), mode: "staged", path: "old.txt" });
  assert.equal(result.base.content, "old"); assert.equal(result.current.content, "");
  await fs.writeFile(path.join(repo, "new.txt"), "new");
  result = await fileCompare(f.ctx, { target: f.target(), mode: "unstaged", path: "new.txt" });
  assert.equal(result.base.content, ""); assert.equal(result.current.content, "new");
  await f.git(repo, "add", "new.txt");
  result = await fileCompare(f.ctx, { target: f.target(), mode: "staged", path: "new.txt" });
  assert.equal(result.base.content, ""); assert.equal(result.current.content, "new");
});


test("selected special filenames never stage, unstage, restore or clean a sibling match", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const repo = f.paths[0]!;
  const selected = ["a*.txt", "a[1].txt", ":(glob)*.txt", "-dash.txt", "line\nbreak.txt", "tab\tname.txt", "space name.txt"];
  const siblings = ["a1.txt", "a11.txt", "other.txt", "dash.txt", "line.txt", "tab.txt", "space.txt"];
  for (const filename of [...selected, ...siblings]) await fs.writeFile(path.join(repo, filename), "base");
  await f.git(repo, "add", "."); await f.git(repo, "commit", "-m", "base");
  for (const filename of [...selected, ...siblings]) await fs.writeFile(path.join(repo, filename), "modified");
  const items = selected.map((path) => ({ path }));
  await stageWorkspace(f.ctx, { target: f.target(), items });
  let staged = await listChanges(f.ctx, { target: f.target(), mode: "staged" });
  assert.deepEqual(new Set(staged.files.map((file) => file.path)), new Set(selected));
  assert.ok(staged.files.every((file) => /^[0-9a-f]{40}$/.test(file.indexSha ?? "")));
  await unstageWorkspace(f.ctx, { target: f.target(), items });
  assert.equal((await listChanges(f.ctx, { target: f.target(), mode: "staged" })).files.length, 0);
  await stageWorkspace(f.ctx, { target: f.target(), all: true });
  await unstageWorkspace(f.ctx, { target: f.target(), items });
  staged = await listChanges(f.ctx, { target: f.target(), mode: "staged" });
  assert.deepEqual(new Set(staged.files.map((file) => file.path)), new Set(siblings));
  await discardWorkspace(f.ctx, { target: f.target(), items });
  for (const filename of selected) assert.equal(await fs.readFile(path.join(repo, filename), "utf8"), "base");
  for (const filename of siblings) assert.equal(await fs.readFile(path.join(repo, filename), "utf8"), "modified");
  await fs.writeFile(path.join(repo, "new*.txt"), "remove-selected");
  await fs.writeFile(path.join(repo, "new1.txt"), "keep-sibling");
  await discardWorkspace(f.ctx, { target: f.target(), items: [{ path: "new*.txt" }] });
  await assert.rejects(() => fs.stat(path.join(repo, "new*.txt")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(repo, "new1.txt"), "utf8"), "keep-sibling");
});

test("SHA-256 index metadata and new-file Diff support literal newline/glob names", async (t) => {
  const f = await fixture(t, 1, "sha256");
  const filename = "hash\n*.txt";
  await fs.writeFile(path.join(f.paths[0]!, filename), "sha256");
  await stageWorkspace(f.ctx, { target: f.target(), items: [{ path: filename }] });
  const list = await listChanges(f.ctx, { target: f.target(), mode: "staged" });
  assert.equal(list.files[0]?.path, filename); assert.match(list.files[0]?.indexSha ?? "", /^[0-9a-f]{64}$/);
  const compared = await fileCompare(f.ctx, { target: f.target(), mode: "staged", path: filename });
  assert.equal(compared.base.content, ""); assert.equal(compared.current.content, "sha256");
});

for (const deletion of [false, true]) {
  test(`staged text ${deletion ? "deletion" : "modification"} is independent of a same-name worktree directory`, async (t) => {
    const f = await fixture(t);
    const repo = f.paths[0]!;
    await fs.writeFile(path.join(repo, "item"), "old");
    await f.git(repo, "add", "."); await f.git(repo, "commit", "-m", "base");
    if (deletion) await fs.rm(path.join(repo, "item"));
    else await fs.writeFile(path.join(repo, "item"), "new");
    await stageWorkspace(f.ctx, { target: f.target(), items: [{ path: "item" }] });
    await fs.rm(path.join(repo, "item"), { force: true }); await fs.mkdir(path.join(repo, "item"));
    const result = await fileCompare(f.ctx, { target: f.target(), mode: "staged", path: "item" });
    assert.equal(result.base.content, "old"); assert.equal(result.current.content, deletion ? "" : "new");
    assert.equal(result.base.previewable, true); assert.equal(result.current.previewable, true);
  });
}

for (const broken of ["index-blob", "head-tree", "head-commit"] as const) {
  test(`missing ${broken} object is an explicit comparison error, never EMPTY`, async (t) => {
    const f = await fixture(t);
    const repo = f.paths[0]!;
    await fs.writeFile(path.join(repo, "item"), "old");
    await f.git(repo, "add", "."); await f.git(repo, "commit", "-m", "base");
    await fs.writeFile(path.join(repo, "item"), "new"); await f.git(repo, "add", ".");
    const object = (await f.git(repo, "rev-parse", broken === "index-blob" ? ":item" : broken === "head-tree" ? "HEAD^{tree}" : "HEAD")).stdout.trim();
    await fs.rm(path.join(repo, ".git", "objects", object.slice(0, 2), object.slice(2)));
    await assert.rejects(() => fileCompare(f.ctx, { target: f.target(), mode: "staged", path: "item" }), (error: Error) => {
      assert.match(error.message, /Failed to read repository file comparison/);
      assert.ok(!error.message.includes(f.ctx.dataDir)); return true;
    });
  });
}

for (const external of [false, true]) {
  test(`private index symlink to ${external ? "external fixture location" : "repository B"} is rejected before querying or changing A`, async (t) => {
    const f = await fixture(t, 2);
    const [a, b] = f.paths as [string, string];
    for (const [repo, name] of [[a, "only-a.txt"], [b, "only-b.txt"]] as const) {
      await fs.writeFile(path.join(repo, name), name); await f.git(repo, "add", "."); await f.git(repo, "commit", "-m", "base");
    }
    let target = path.join(b, ".git", "index");
    if (external) { const destination = path.join(f.ctx.dataDir, "external-index"); await fs.copyFile(target, destination); target = destination; }
    await fs.rm(path.join(a, ".git", "index")); await fs.symlink(target, path.join(a, ".git", "index"));
    // Raw fixture Git demonstrates whether this Git version follows an index symlink.
    const raw = (await f.git(a, "ls-files", "-z")).stdout.split("\0").filter(Boolean);
    assert.ok(raw.includes("only-b.txt")); assert.ok(!raw.includes("only-a.txt"));
    for (const call of [
      () => gitWorkspaceStatus(f.ctx, { workspaceId: f.workspaceId }),
      () => listChanges(f.ctx, { target: f.target(), mode: "unstaged" }),
      () => stageWorkspace(f.ctx, { target: f.target(), items: [{ path: "only-a.txt" }] }),
      () => fileCompare(f.ctx, { target: f.target(), mode: "staged", path: "only-a.txt" })
    ]) await assert.rejects(call, /invalid/);
  });
}
