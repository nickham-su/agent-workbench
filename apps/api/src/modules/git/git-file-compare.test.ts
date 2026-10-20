import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { fileCompare } from "./git.service.js";
import { createGitFixture } from "./git.test-support.js";

const headSha = "a".repeat(40);
const indexSha = "b".repeat(40);
type Entry = { mode: string; type: string; sha: string };

function mockGit(t: TestContext, entries: { head?: Entry; index?: Entry; objectType?: string; failAt?: string; headState?: "unborn" | "corrupt"; malformedAt?: string }) {
  const commands: string[][] = [];
  const spawn = (_command: string, args: string[]) => {
    commands.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { setImmediate(() => child.emit("close", null)); return true; }
    });
    setImmediate(() => {
      let stdout = "";
      let code = 0;
      if (entries.failAt && args.includes(entries.failAt)) {
        child.stderr.write("private path / synthetic execution failure");
        child.emit("close", 128);
        return;
      }
      if (args.includes("rev-parse")) {
        if (entries.headState) code = 1;
        else stdout = headSha;
      } else if (args.includes("symbolic-ref")) stdout = "refs/heads/main";
      else if (args.includes("show-ref")) code = entries.headState === "unborn" ? 1 : 0;
      else if (args.includes("ls-files")) {
        const entry = entries.index;
        if (entry) stdout = `${entry.mode} ${entry.sha} 0\titem\0`;
      } else if (args.includes("ls-tree")) {
        const entry = entries.head;
        if (entry) stdout = `${entry.mode} ${entry.type} ${entry.sha}\titem\0`;
      } else if (args.includes("cat-file")) {
        if (args.includes("-t")) stdout = entries.objectType ?? "blob";
        else if (args.includes("-s")) stdout = "3";
        else if (args.includes("-p")) stdout = args.at(-1) === headSha ? "old" : "new";
        else assert.fail("unexpected cat-file command");
      } else assert.fail("unexpected mocked Git command");
      if (entries.malformedAt && args.includes(entries.malformedAt)) stdout = "invalid\0";
      child.stdout.write(stdout);
      child.emit("close", code);
    });
    return child;
  };
  t.mock.method(childProcess, "spawn", spawn as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return commands;
}

for (const mode of ["staged", "unstaged"] as const) {
  for (const source of ["index", "head"] as const) {
    test(`missing submodule is not a text comparison: ${mode}, gitlink in ${source}`, async (t) => {
      const f = await createGitFixture(t);
      const entry = { mode: "160000", type: "commit", sha: indexSha };
      const commands = mockGit(t, { [source]: entry });
      const result = await fileCompare(f.ctx, { target: { kind: "workspaceRepo", workspaceId: f.workspaceId, dirName: "repo-0" }, mode, path: "item" });
      assert.equal(result.base.previewable, false);
      assert.equal(result.current.previewable, false);
      assert.equal(result.base.content, undefined);
      assert.equal(result.current.content, undefined);
      assert.ok(!commands.some((args) => args.includes("cat-file")), "does not try to read unavailable gitlink objects as text");
    });
  }
}

test("a non-blob object is never rendered as commit text even if its index mode is inconsistent", async (t) => {
  const f = await createGitFixture(t);
  await fs.writeFile(path.join(f.paths[0]!, "item"), "working");
  const commands = mockGit(t, { index: { mode: "100644", type: "blob", sha: indexSha }, objectType: "commit" });
  const result = await fileCompare(f.ctx, { target: { kind: "workspaceRepo", workspaceId: f.workspaceId, dirName: "repo-0" }, mode: "unstaged", path: "item" });
  assert.equal(result.base.previewable, false);
  assert.equal(result.base.content, undefined);
  assert.ok(!commands.some((args) => args.includes("-p")));
});

for (const mode of ["staged", "unstaged"] as const) {
  for (const state of ["new", "deleted"] as const) {
    test(`ordinary ${state} file keeps EMPTY comparison semantics (${mode})`, async (t) => {
      const f = await createGitFixture(t);
      const index = { mode: "100644", type: "blob", sha: indexSha };
      const head = { mode: "100644", type: "blob", sha: headSha };
      if (state === "new") await fs.writeFile(path.join(f.paths[0]!, "item"), "new");
      mockGit(t, mode === "staged" ? state === "new" ? { index } : { head } : state === "new" ? {} : { index });
      const result = await fileCompare(f.ctx, { target: { kind: "workspaceRepo", workspaceId: f.workspaceId, dirName: "repo-0" }, mode, path: "item" });
      assert.equal(result.base.previewable, true);
      assert.equal(result.current.previewable, true);
      if (state === "new") {
        assert.equal(result.base.label, "EMPTY"); assert.equal(result.base.content, ""); assert.equal(result.current.content, "new");
      } else {
        assert.equal(result.base.content, mode === "staged" ? "old" : "new"); assert.equal(result.current.label, "EMPTY"); assert.equal(result.current.content, "");
      }
    });
  }
}


for (const command of ["ls-files", "ls-tree", "rev-parse", "-t", "-s", "-p"]) {
  test(`Diff execution failure is not EMPTY: ${command}`, async (t) => {
    const f = await createGitFixture(t);
    mockGit(t, { head: { mode: "100644", type: "blob", sha: headSha }, index: { mode: "100644", type: "blob", sha: indexSha }, failAt: command });
    await assert.rejects(() => fileCompare(f.ctx, { target: { kind: "workspaceRepo", workspaceId: f.workspaceId, dirName: "repo-0" }, mode: "staged", path: "item" }), (error: Error) => {
      assert.match(error.message, /Failed to read repository file comparison/);
      assert.ok(!error.message.includes("private path"));
      return true;
    });
  });
}

for (const command of ["ls-files", "ls-tree"]) {
  test(`malformed Diff entry data is not EMPTY: ${command}`, async (t) => {
    const f = await createGitFixture(t);
    mockGit(t, { malformedAt: command });
    await assert.rejects(() => fileCompare(f.ctx, { target: { kind: "workspaceRepo", workspaceId: f.workspaceId, dirName: "repo-0" }, mode: "staged", path: "item" }), /Failed to read repository file comparison/);
  });
}

test("only verified unborn HEAD is an empty baseline; corrupt HEAD must fail", async (t) => {
  const f = await createGitFixture(t);
  const target = { kind: "workspaceRepo", workspaceId: f.workspaceId, dirName: "repo-0" };
  mockGit(t, { headState: "unborn", index: { mode: "100644", type: "blob", sha: indexSha } });
  const result = await fileCompare(f.ctx, { target, mode: "staged", path: "item" });
  assert.equal(result.base.label, "EMPTY"); assert.equal(result.current.content, "new");
  t.mock.restoreAll(); syncBuiltinESMExports();
  mockGit(t, { headState: "corrupt" });
  await assert.rejects(() => fileCompare(f.ctx, { target, mode: "staged", path: "item" }), /Failed to read repository file comparison/);
});

for (const removed of [false, true]) {
  test(`staged ordinary file ${removed ? "deletion" : "modification"} ignores a same-name working directory`, async (t) => {
    const f = await createGitFixture(t);
    await fs.mkdir(path.join(f.paths[0]!, "item"));
    mockGit(t, { head: { mode: "100644", type: "blob", sha: headSha }, ...(!removed ? { index: { mode: "100644", type: "blob", sha: indexSha } } : {}) });
    const result = await fileCompare(f.ctx, { target: { kind: "workspaceRepo", workspaceId: f.workspaceId, dirName: "repo-0" }, mode: "staged", path: "item" });
    assert.equal(result.base.content, "old"); assert.equal(result.current.content, removed ? "" : "new");
    assert.equal(result.base.previewable, true); assert.equal(result.current.previewable, true);
  });
}

for (const failureAt of ["lstat", "readFile"] as const) {
  test(`working tree ${failureAt} permission failure is not an absent file`, async (t) => {
    const f = await createGitFixture(t);
    const filename = path.join(f.paths[0]!, "item");
    await fs.writeFile(filename, "working");
    mockGit(t, {});
    const original = fs[failureAt];
    const replacement = ((...args: unknown[]) => {
      if (String(args[0]) === filename) return Promise.reject(Object.assign(new Error("private path"), { code: "EACCES" }));
      return (original as (...args: unknown[]) => unknown)(...args);
    }) as typeof original;
    t.mock.method(fs, failureAt, replacement);
    syncBuiltinESMExports();
    await assert.rejects(() => fileCompare(f.ctx, { target: { kind: "workspaceRepo", workspaceId: f.workspaceId, dirName: "repo-0" }, mode: "unstaged", path: "item" }), (error: Error) => {
      assert.match(error.message, /Failed to read/); assert.ok(!error.message.includes("private path")); return true;
    });
  });
}
