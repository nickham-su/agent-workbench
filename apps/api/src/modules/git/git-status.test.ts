import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGitProcessEnv } from "../../infra/git/gitExec.js";
import { parseRepositoryStatus, readRepositoryStatus, readUpstreamStatus, statusChanges, STATUS_TIMEOUT_MS } from "./git-status.js";

const sha = "a".repeat(40);
const clean = `# branch.oid ${sha}\0# branch.head feature/中文\0`;
const ordinary = (xy: string, name: string, sub = "N...") => `1 ${xy} ${sub} 100644 100644 100644 ${sha} ${sha} ${name}\0`;
const rename = (xy: string, name: string, old: string) => `2 ${xy} N... 100644 100644 100644 ${sha} ${sha} R100 ${name}\0${old}\0`;

test("porcelain summary: clean, unborn, detached, upstream and unknown headers", () => {
  assert.deepEqual(parseRepositoryStatus(clean).head, { branch: "feature/中文", detached: false, sha });
  assert.equal(parseRepositoryStatus(clean + "# branch.future whatever\0").hasChanges, false);
  assert.deepEqual(parseRepositoryStatus("# branch.oid (initial)\0# branch.head main\0").head, { branch: "main", detached: false, sha: "" });
  assert.deepEqual(parseRepositoryStatus(`# branch.oid ${sha}\0# branch.head (detached)\0`).head, { branch: null, detached: true, sha });
  const status = parseRepositoryStatus(clean + "# branch.upstream origin/main\0# branch.ab +3 -2\0");
  assert.equal(status.upstream, "origin/main");
  assert.equal(status.hasChanges, false, "ahead/behind alone is not dirty");
});

test("staged, unstaged, both, untracked and ignored records", () => {
  const status = parseRepositoryStatus(clean + ordinary("M.", "staged") + ordinary(".M", "unstaged") + ordinary("MM", "both") + "? new dir/\0! ignored\0");
  assert.deepEqual(status.dirty, { staged: 2, unstaged: 2, untracked: 1 });
  assert.equal(status.hasChanges, true);
  assert.deepEqual(statusChanges(status, "unstaged").at(-1), { path: "new dir", status: "??", kind: "directory" });
  assert.equal(statusChanges(status, "staged").length, 2);
});

test("rename consumes original path even if it resembles a header or status record", () => {
  for (const old of ["# branch.head fake", "? fake", " old\n\t中文 "]) {
    const status = parseRepositoryStatus(clean + rename("R.", "new\n\t中文 name", old));
    assert.equal(status.head.branch, "feature/中文");
    assert.deepEqual(status.dirty, { staged: 1, unstaged: 0, untracked: 0 });
    assert.deepEqual(statusChanges(status, "staged"), [{ path: "new\n\t中文 name", oldPath: old, status: "R" }]);
  }
  const status = parseRepositoryStatus(clean + rename("RM", "new", "old"));
  assert.equal(statusChanges(status, "unstaged")[0]?.oldPath, undefined, "worktree modification uses its current index path");
});

test("conflicts and submodule worktree changes are visible in detail and summary", () => {
  const conflict = `u UU N... 100644 100644 100644 100644 ${sha} ${sha} ${sha} conflict\0`;
  const status = parseRepositoryStatus(clean + conflict + ordinary(".M", "module", "S..U"));
  assert.deepEqual(status.dirty, { staged: 1, unstaged: 2, untracked: 0 });
  assert.deepEqual(statusChanges(status, "unstaged"), [{ path: "conflict", status: "U" }, { path: "module", status: "M", kind: "submodule" }]);
});

test("malformed/truncated output fails rather than looking clean", () => {
  for (const output of ["", clean.slice(0, -1), "# branch.head main\0", clean + "invalid\0", clean + rename("R.", "new", "").replace(/\0$/, ""), clean + "1 .M\0"]) {
    assert.throws(() => parseRepositoryStatus(output), /Invalid Git status output/);
  }
});

test("light status uses one bounded, non-writing command and preserves valid empty repositories", async () => {
  let calls = 0;
  const status = await readRepositoryStatus({ repoPath: "/owned/workspaces/ws/repo", cwd: "/owned" }, async (args, opts) => {
    calls++;
    assert.ok(args.includes("--no-optional-locks"));
    assert.ok(args.includes("core.fsmonitor=false"));
    assert.ok(args.includes("--branch"));
    assert.ok(args.includes("--no-ahead-behind"));
    assert.ok(args.includes("--untracked-files=normal"));
    assert.ok(args.includes("--work-tree=/owned/workspaces/ws/repo"));
    assert.equal(opts?.timeoutMs, STATUS_TIMEOUT_MS);
    assert.ok((opts?.maxOutputBytes ?? 0) > 0);
    assert.ok(!args.includes("fetch"));
    return { ok: true, code: 0, stdout: Buffer.from("# branch.oid (initial)\0# branch.head main\0"), stderr: "" };
  });
  assert.equal(calls, 1);
  assert.equal(status.hasChanges, false);
});

test("status failures are bounded and never expose Git output", async () => {
  for (const failure of ["timeout", "output-limit", "spawn"] as const) {
    await assert.rejects(() => readRepositoryStatus({ repoPath: "/owned/repo", cwd: "/owned" }, async () => ({ ok: false, code: null, stdout: Buffer.from("private-path"), stderr: "secret-material", failure })), (error: Error) => {
      assert.ok(!error.message.includes("private-path"));
      assert.ok(!error.message.includes("secret-material"));
      assert.match(error.message, failure === "timeout" ? /timed out/ : failure === "output-limit" ? /too large/ : /failed/);
      return true;
    });
  }
});

test("ambient Git location/config overrides are removed, explicit application identity is retained", () => {
  const inherited = { PATH: "synthetic-path", GIT_DIR: "wrong", GIT_WORK_TREE: "wrong", GIT_INDEX_FILE: "wrong", GIT_OBJECT_DIRECTORY: "wrong", GIT_CONFIG_PARAMETERS: "wrong", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: "wrong" };
  const env = buildGitProcessEnv({ GIT_AUTHOR_NAME: "Test" }, inherited);
  assert.deepEqual(env, { PATH: "synthetic-path", GIT_AUTHOR_NAME: "Test" });
  assert.equal(inherited.GIT_DIR, "wrong", "does not mutate process environment");
});


test("legacy status omits a configured but pruned upstream, without inventing zero counts", async () => {
  const status = { ...parseRepositoryStatus(clean), upstream: "origin/main" };
  const commands: string[][] = [];
  const upstream = await readUpstreamStatus({ repoPath: "/owned/repo", cwd: "/owned", status }, async (args) => {
    commands.push(args);
    if (args.includes("for-each-ref")) return { ok: true, code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
    assert.ok(args.includes("show-ref"));
    return { ok: false, code: 1, stdout: "", stderr: "" };
  });
  assert.equal(upstream, undefined);
  assert.equal(commands.length, 2);
  assert.ok(!commands.some((args) => args.includes("rev-list")));
});

test("unborn repositories with an upstream configuration need no upstream commands", async () => {
  const status = { ...parseRepositoryStatus("# branch.oid (initial)\0# branch.head main\0"), upstream: "origin/main" };
  assert.equal(await readUpstreamStatus({ repoPath: "/owned/repo", cwd: "/owned", status }, async () => { throw new Error("must not execute"); }), undefined);
});

test("valid upstream counts remain available, and execution errors are not absence", async () => {
  const status = { ...parseRepositoryStatus(clean), upstream: "origin/main" };
  for (const failAt of [undefined, "for-each-ref", "show-ref", "rev-list"] as const) {
    const request = () => readUpstreamStatus({ repoPath: "/owned/repo", cwd: "/owned", status }, async (args) => {
      if (failAt && args.includes(failAt)) return { ok: false, code: 128, stdout: "", stderr: "private-error" };
      if (args.includes("for-each-ref")) return { ok: true, code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
      if (args.includes("show-ref")) return { ok: true, code: 0, stdout: "", stderr: "" };
      assert.ok(args.includes(`refs/remotes/origin/main...${sha}`));
      return { ok: true, code: 0, stdout: "2\t3\n", stderr: "" };
    });
    if (failAt) await assert.rejects(request, /^Error: Failed to read upstream status$/);
    else assert.deepEqual(await request(), { name: "origin/main", ahead: 3, behind: 2 });
  }
});

test("upstream verification timeouts are failures even if a mock supplies exit code 1", async () => {
  const status = { ...parseRepositoryStatus(clean), upstream: "origin/main" };
  await assert.rejects(() => readUpstreamStatus({ repoPath: "/owned/repo", cwd: "/owned", status }, async (args) => {
    if (args.includes("for-each-ref")) return { ok: true, code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
    return { ok: false, code: 1, failure: "timeout", stdout: "", stderr: "" };
  }), /Failed to read upstream status/);
});
