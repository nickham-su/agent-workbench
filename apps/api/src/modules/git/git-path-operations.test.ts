import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { discardWorkspace, listChanges, stageWorkspace, unstageWorkspace } from "./git.service.js";
import { createGitFixture } from "./git.test-support.js";

const sha = "a".repeat(64);
const names = ["a*.txt", "a[1].txt", ":(glob)*.txt", "-dash.txt", "line\nbreak.txt", "tab\tname.txt", "space name.txt"];

function mockGit(t: TestContext, options: { unborn?: boolean; tracked?: boolean; status?: boolean } = {}) {
  const commands: string[][] = [];
  const spawn = (_command: string, args: string[]) => {
    commands.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.emit("close", null); return true; } });
    setImmediate(() => {
      let stdout = ""; let code = 0;
      if (args.includes("status")) stdout = `# branch.oid ${sha}\0# branch.head main\0` + names.map((name) => `1 M. N... 100644 100644 100644 ${sha} ${sha} ${name}\0`).join("");
      else if (args.includes("diff")) stdout = names.join("\0") + "\0";
      else if (args.includes("rev-parse")) { if (options.unborn) code = 1; else stdout = sha; }
      else if (args.includes("symbolic-ref")) stdout = "refs/heads/main";
      else if (args.includes("show-ref")) code = 1;
      else if (args.includes("ls-files") && args.includes("-s")) stdout = names.map((name) => `100644 ${sha} 0\t${name}\0`).join("");
      else if (args.includes("ls-files") && options.tracked) stdout = names.join("\0") + "\0";
      child.stdout.write(stdout); child.emit("close", code);
    });
    return child;
  };
  t.mock.method(childProcess, "spawn", spawn as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return commands;
}

for (const operation of ["stage", "unstage", "unstage-unborn", "discard-tracked", "discard-untracked"] as const) {
  test(`selected paths use literal Git matching: ${operation}`, async (t) => {
    const f = await createGitFixture(t);
    const commands = mockGit(t, { unborn: operation === "unstage-unborn", tracked: operation === "discard-tracked" });
    const body = { target: { kind: "workspaceRepo", workspaceId: f.workspaceId, dirName: "repo-0" }, items: names.map((path) => ({ path })) };
    if (operation === "stage") await stageWorkspace(f.ctx, body);
    else if (operation.startsWith("unstage")) await unstageWorkspace(f.ctx, body);
    else await discardWorkspace(f.ctx, body);
    const selected = commands.filter((args) => ["add", "reset", "rm", "clean", "checkout", "ls-files"].some((command) => args.includes(command)));
    assert.ok(selected.length > 0);
    for (const args of selected) {
      assert.ok(args.includes("--literal-pathspecs"));
      assert.deepEqual(args.slice(args.indexOf("--") + 1), names);
    }
  });
}

test("batch index metadata preserves SHA-256 and NUL-delimited special names with literal paths", async (t) => {
  const f = await createGitFixture(t);
  const commands = mockGit(t, { status: true });
  const result = await listChanges(f.ctx, { target: { kind: "workspaceRepo", workspaceId: f.workspaceId, dirName: "repo-0" }, mode: "staged" });
  assert.deepEqual(result.files.map((file) => file.path), names);
  assert.ok(result.files.every((file) => file.indexSha === sha));
  assert.ok(commands.find((args) => args.includes("ls-files"))?.includes("--literal-pathspecs"));
});

test("stage-all retains the all-repository branch rather than converting it to item matching", async (t) => {
  const f = await createGitFixture(t);
  const commands = mockGit(t);
  await stageWorkspace(f.ctx, { target: { kind: "workspaceRepo", workspaceId: f.workspaceId, dirName: "repo-0" }, all: true });
  const add = commands.find((args) => args.includes("add"))!;
  assert.ok(add.includes("-A")); assert.ok(!add.includes("--"));
});
