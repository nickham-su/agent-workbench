import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { GitToolResultSchema } from "@agent-workbench/shared/internal-contracts/agent-api";
import { executeGitTool, runGitProcess, type GitProcessOps } from "./git.js";
import { GitToolError } from "./gitErrors.js";
import { createGitFixture, successfulGitProcessResult, TEST_GIT_SECRET } from "./git.testkit.js";

const fastSettlement = { termMs: 10, killMs: 40, drainMs: 10, pollMs: 2 };
function fakeProcess() {
  const child = Object.assign(new EventEmitter(), { pid: 424242, stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  return child as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
}
function absent() { return Object.assign(new Error("fixture group absent"), { code: "ESRCH" }); }
function processParams(ops: GitProcessOps) {
  return { args: ["status"], cwd: "/fixture-repo", env: {}, timeoutMs: 10_000,
    signal: new AbortController().signal, knownOutputValues: [], ops, settlement: fastSettlement };
}

for (const parentCloseFirst of [false, true]) {
  test(`Git process normal parent exit still settles descendants (stdio close first=${parentCloseFirst})`, async () => {
    const child = fakeProcess();
    let present = true;
    const signals: Array<NodeJS.Signals | 0> = [];
    let count = 0;
    const ops: GitProcessOps = {
      spawn(command, args, options) {
        count++;
        assert.equal(command, "git");
        assert.deepEqual(args, ["status"]);
        assert.equal(options.shell, false);
        assert.equal(options.detached, true);
        assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
        queueMicrotask(() => {
          child.emit("spawn");
          child.emit("exit", 0, null);
          if (parentCloseFirst) child.emit("close", 0, null);
        });
        return child;
      },
      kill(pid, signal) {
        assert.equal(pid, -424242);
        signals.push(signal);
        if (!present) throw absent();
        if (signal === "SIGTERM") { present = false; if (!parentCloseFirst) child.emit("close", 0, null); }
      },
    };
    const result = await runGitProcess(processParams(ops));
    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    assert.equal(result.processStopConfirmed, true);
    assert.deepEqual(signals.filter((signal) => signal !== 0), ["SIGTERM"]);
    assert.equal(count, 1);
  });
}

for (const missingFrom of ["probe", "term", "kill"] as const) {
  test(`Git process ESRCH latch from ${missingFrom} prevents every later signal to a reused number`, async () => {
    const child = fakeProcess();
    let observedAbsent = false;
    const signals: Array<NodeJS.Signals | 0> = [];
    const ops: GitProcessOps = {
      spawn() { queueMicrotask(() => { child.emit("spawn"); child.emit("exit", 0, null); }); return child; },
      kill(_pid, signal) {
        if (observedAbsent) throw new Error("must not inspect or signal a reused group after first ESRCH");
        signals.push(signal);
        if ((missingFrom === "probe" && signal === 0) || (missingFrom === "term" && signal === "SIGTERM") || (missingFrom === "kill" && signal === "SIGKILL")) {
          observedAbsent = true;
          throw absent();
        }
      },
    };
    const controller = new AbortController();
    const promise = runGitProcess({ ...processParams(ops), signal: controller.signal });
    setTimeout(() => { controller.abort(); child.emit("close", 0, null); }, 1);
    const result = await promise;
    assert(result.processStopConfirmed);
    assert(observedAbsent);
    assert.equal(signals.filter((signal) => signal === "SIGTERM").length, missingFrom === "probe" ? 0 : 1);
    assert.equal(signals.filter((signal) => signal === "SIGKILL").length, missingFrom === "kill" ? 1 : 0);
  });
}

for (const reason of ["EPERM", "unexpected", "zombie"] as const) {
  test(`Git process ${reason} remains unconfirmed even after parent 0 or successful KILL`, async () => {
    const child = fakeProcess();
    const signals: Array<NodeJS.Signals | 0> = [];
    const ops: GitProcessOps = {
      spawn() { queueMicrotask(() => { child.emit("spawn"); child.emit("exit", 0, null); child.emit("close", 0, null); }); return child; },
      kill(_pid, signal) {
        signals.push(signal);
        if (reason !== "zombie") throw Object.assign(new Error("fixture unknown"), { code: reason });
      },
    };
    const result = await runGitProcess(processParams(ops));
    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, false);
    assert.equal(result.processStopConfirmed, false);
    assert.equal(result.failureCode, "GIT_PROCESS_STOP_UNCONFIRMED");
    assert.deepEqual(signals.filter((signal) => signal !== 0), reason === "zombie" ? ["SIGTERM", "SIGKILL"] : []);
  });
}

test("Git process timeout preserves a signal exit without a fabricated numeric code and starts once", async () => {
  const child = fakeProcess();
  let present = true;
  let spawned = 0;
  const ops: GitProcessOps = {
    spawn() { spawned++; queueMicrotask(() => child.emit("spawn")); return child; },
    kill(_pid, signal) {
      if (!present) throw absent();
      if (signal === "SIGTERM") { present = false; child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); }
    },
  };
  const result = await runGitProcess({ ...processParams(ops), timeoutMs: 5 });
  assert(result.timedOut);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.ok, false);
  assert(result.processStopConfirmed);
  assert.equal(spawned, 1);
});

test("Git process cancellation between native creation and spawn event waits for group establishment", async () => {
  const child = fakeProcess();
  const controller = new AbortController();
  let established = false;
  let present = true;
  const signals: Array<NodeJS.Signals | 0> = [];
  const ops: GitProcessOps = {
    spawn() {
      controller.abort();
      setTimeout(() => { established = true; child.emit("spawn"); }, 5);
      return child;
    },
    kill(_pid, signal) {
      assert(established, "no ESRCH probe may occur before the successful spawn event");
      signals.push(signal);
      if (!present) throw absent();
      if (signal === "SIGTERM") { present = false; child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); }
    },
  };
  const result = await runGitProcess({ ...processParams(ops), signal: controller.signal });
  assert(result.cancelled);
  assert(result.processStopConfirmed);
  assert.deepEqual(signals.filter((value) => value !== 0), ["SIGTERM"]);
});

test("Git process unknown startup must not fake group absence or not_started", async () => {
  const child = fakeProcess();
  const ops: GitProcessOps = {
    spawn() { queueMicrotask(() => child.emit("error", Object.assign(new Error("fixture unknown startup"), { code: "UNKNOWN" }))); return child; },
    kill() { throw new Error("an unestablished group must not be probed"); },
  };
  const result = await runGitProcess(processParams(ops));
  assert(!result.processStopConfirmed);
  assert.equal(result.failureCode, "GIT_PROCESS_STOP_UNCONFIRMED");
});

for (const code of ["ENOENT", "EACCES", "E2BIG"] as const) {
  test(`Git process safe native startup failure ${code} does not expose the original exception`, async () => {
    const child = fakeProcess();
    (child as any).pid = undefined;
    const ops: GitProcessOps = {
      spawn() { queueMicrotask(() => child.emit("error", Object.assign(new Error("fixture-private-path-and-secret"), { code }))); return child; },
      kill() { throw new Error("no process exists"); },
    };
    await assert.rejects(runGitProcess(processParams(ops)), (error: unknown) => {
      assert(error instanceof GitToolError);
      assert.equal(error.code, code === "ENOENT" ? "GIT_NOT_AVAILABLE" : "GIT_SPAWN_FAILED");
      assert(!error.message.includes("private-path"));
      return true;
    });
  });
}

test("Git process combined raw output limit settles once, drains safely, and redacts termination tail", async () => {
  const child = fakeProcess();
  let present = true;
  const signals: Array<NodeJS.Signals | 0> = [];
  const ops: GitProcessOps = {
    spawn() { queueMicrotask(() => { child.emit("spawn"); child.stdout.write(`before ${TEST_GIT_SECRET} `); child.stderr.write(`tail ${TEST_GIT_SECRET}`); }); return child; },
    kill(_pid, signal) {
      signals.push(signal);
      if (!present) throw absent();
      if (signal === "SIGTERM") { present = false; child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); }
    },
  };
  const result = await runGitProcess({ ...processParams(ops), knownOutputValues: [TEST_GIT_SECRET], maxOutputBytes: 45 });
  assert(result.outputLimitExceeded);
  assert(!`${result.stdout}${result.stderr}`.includes(TEST_GIT_SECRET));
  assert(!result.ok);
  assert(result.processStopConfirmed);
  assert.deepEqual(signals.filter((signal) => signal !== 0), ["SIGTERM"]);
});

for (const invalid of [{ repo: "fixture-repo", args: [] }, { repo: "fixture-repo", args: ["status\0"] }, { repo: "fixture-repo", args: ["status"], timeout: 3601 }, { repo: "fixture-repo", args: ["status"], env: {} }, { args: ["status"] }]) {
  test(`Git tool invalid shape is rejected before prepare: ${JSON.stringify(invalid)}`, async (t) => {
    const fixture = await createGitFixture();
    t.after(fixture.cleanup);
    await assert.rejects(executeGitTool(invalid, fixture.ctx, { dataDir: fixture.dataDir }), /GIT_INPUT_INVALID/);
    assert.equal(fixture.prepared.length, 0);
    assert.equal(fixture.released.length, 0);
  });
}

test("Git tool disabled, pre-aborted and unsupported platform paths have zero prepare/spawn", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const args = { repo: fixture.repo, args: ["status"] };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executeGitTool(args, { ...fixture.ctx, signal: controller.signal }, { dataDir: fixture.dataDir }), /GIT_CANCELLED/);
  await assert.rejects(executeGitTool(args, { ...fixture.ctx, profile: { agent: { tools: [] } } as any }, { dataDir: fixture.dataDir }), /GIT_TOOL_DISABLED/);
  await assert.rejects(executeGitTool(args, fixture.ctx, { dataDir: fixture.dataDir, platform: "win32" }), /GIT_EXECUTION_PLATFORM_UNSUPPORTED/);
  assert.equal(fixture.prepared.length, 0);
});

test("Git tool argv, env, cwd and timeout are preserved and one native call gets one prepare/release", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const args = ["-C", "elsewhere", "new-native-subcommand", "", "two words", "'quoted'", "\n中文", "&&", ";", "$(fixture)", "*.txt"];
  let nativeCalls = 0;
  const result = await executeGitTool({ repo: fixture.repo, args, timeout: 3600 }, fixture.ctx, {
    dataDir: fixture.dataDir,
    runProcess: async (params) => {
      nativeCalls++;
      assert.deepEqual(params.args, args);
      assert.equal(params.cwd, fixture.cwd);
      assert.equal(params.timeoutMs, 3_600_000);
      assert.equal(params.env.GIT_TERMINAL_PROMPT, "0");
      return successfulGitProcessResult as any;
    },
    // Fixture lease must cover the maximum timeout; no reprepare is allowed.
    now: () => Date.parse(fixture.response.expiresAt) - 3_900_000,
  });
  assert(Value.Check(GitToolResultSchema, result));
  assert.equal(result.leaseDisposition, "released");
  assert.equal(nativeCalls, 1);
  assert.equal(fixture.prepared.length, 1);
  assert.equal(fixture.released.length, 1);
  assert.equal(fixture.released[0].stopEvidence, "managed_group_absent");
  assert(!Object.hasOwn(result, "args"));
  assert(!Object.hasOwn(result, "env"));
  assert(!Object.hasOwn(result, "leaseId"));
});

for (const phase of ["cancel-after-prepare", "repo-disappeared", "expired", "malformed-response", "guard-secret-missing", "native-not-available"] as const) {
  test(`Git tool ${phase} never starts and attempts one independent not_started release`, async (t) => {
    const fixture = await createGitFixture("https");
    t.after(fixture.cleanup);
    const controller = new AbortController();
    const response: any = structuredClone(fixture.response);
    let nativeCalls = 0;
    fixture.ctx.signal = controller.signal;
    fixture.ctx.apiClient.prepareRepoGitEnvLease = async () => {
      if (phase === "cancel-after-prepare") controller.abort();
      if (phase === "repo-disappeared") await fs.rmdir(fixture.cwd);
      if (phase === "expired") response.expiresAt = new Date(Date.now() + 1000).toISOString();
      if (phase === "malformed-response") response.env.AWB_INVALID = "fixture-invalid";
      if (phase === "guard-secret-missing") await fs.unlink(response.sensitiveFilePaths[0]);
      return response;
    };
    await assert.rejects(executeGitTool({ repo: fixture.repo, args: ["status"] }, fixture.ctx, {
      dataDir: fixture.dataDir, runProcess: async () => { nativeCalls++; throw new GitToolError("GIT_NOT_AVAILABLE"); },
    }));
    assert.equal(nativeCalls, phase === "native-not-available" ? 1 : 0);
    assert.equal(fixture.released.length, 1);
    assert.equal(fixture.released[0].stopEvidence, "not_started");
  });
}

test("Git tool prepare response loss has no retry, no process, and no guessed lease cleanup", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  let attempts = 0;
  fixture.ctx.apiClient.prepareRepoGitEnvLease = async () => { attempts++; throw new Error("fixture-private-body-and-path"); };
  await assert.rejects(executeGitTool({ repo: fixture.repo, args: ["push"] }, fixture.ctx, { dataDir: fixture.dataDir }), /GIT_ENV_RPC_FAILED/);
  assert.equal(attempts, 1);
  assert.equal(fixture.released.length, 0);
});

test("Git tool a schema-rejected known lease still uses one not_started release", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  fixture.ctx.apiClient.prepareRepoGitEnvLease = async () => { throw Object.assign(new Error("fixture-private-body"), { leaseId: fixture.response.leaseId }); };
  await assert.rejects(executeGitTool({ repo: fixture.repo, args: ["status"] }, fixture.ctx, { dataDir: fixture.dataDir }), /GIT_ENV_RPC_FAILED/);
  assert.equal(fixture.released.length, 1);
  assert.equal(fixture.released[0].stopEvidence, "not_started");
});

test("Git tool stopped success plus release failure keeps success and warns without re-execution", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  let nativeCalls = 0;
  let releaseCalls = 0;
  fixture.ctx.apiClient.releaseRepoGitEnvLease = async () => { releaseCalls++; throw new Error("fixture-private-cleanup-path"); };
  const result = await executeGitTool({ repo: fixture.repo, args: ["push"] }, fixture.ctx, {
    dataDir: fixture.dataDir, runProcess: async () => { nativeCalls++; return successfulGitProcessResult as any; },
  });
  assert(result.ok);
  assert.equal(result.leaseDisposition, "release_unconfirmed");
  assert.deepEqual(result.warnings, ["LEASE_CLEANUP_FAILED"]);
  assert.equal(nativeCalls, 1);
  assert.equal(releaseCalls, 1);
  assert(!JSON.stringify(result).includes("private-cleanup"));
});

test("Git tool parent 0 but unconfirmed group retains the lease and cannot call release", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const result = await executeGitTool({ repo: fixture.repo, args: ["status"] }, fixture.ctx, {
    dataDir: fixture.dataDir, runProcess: async () => ({ ...successfulGitProcessResult, ok: false, processStopConfirmed: false, failureCode: "GIT_PROCESS_STOP_UNCONFIRMED" }) as any,
  });
  assert(!result.ok);
  assert.equal(result.exitCode, 0);
  assert.equal(result.leaseDisposition, "retained");
  assert.equal(fixture.released.length, 0);
});

test("Git tool an unforeseen executor rejection is not not_started evidence", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const result = await executeGitTool({ repo: fixture.repo, args: ["status"] }, fixture.ctx, {
    dataDir: fixture.dataDir, runProcess: async () => { throw new Error("fixture unknown executor failure"); },
  });
  assert(Value.Check(GitToolResultSchema, result));
  assert.equal(result.failureCode, "GIT_PROCESS_STOP_UNCONFIRMED");
  assert.equal(result.leaseDisposition, "retained");
  assert.equal(result.exitCode, null);
  assert.equal(fixture.released.length, 0);
});

test("Git tool cancellation during execution is retained; release does not share the run signal", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const controller = new AbortController();
  let count = 0;
  const result = await executeGitTool({ repo: fixture.repo, args: ["status"] }, { ...fixture.ctx, signal: controller.signal }, {
    dataDir: fixture.dataDir, runProcess: async () => { count++; controller.abort(); return { ...successfulGitProcessResult, ok: false, cancelled: true } as any; },
  });
  assert(result.cancelled);
  assert.equal(count, 1);
  assert.equal(fixture.released.length, 1);
  assert.equal(fixture.released[0].stopEvidence, "managed_group_absent");
});

test("Git native isolated CLI keeps unknown arguments native and allows local alias/hook behavior", { timeout: 15_000 }, async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const options = { dataDir: fixture.dataDir };
  const init = await executeGitTool({ repo: fixture.repo, args: ["init", "--quiet"] }, fixture.ctx, options);
  assert(init.ok);
  const status = await executeGitTool({ repo: fixture.repo, args: ["status", "--short"] }, fixture.ctx, options);
  assert(status.ok);
  const unknown = await executeGitTool({ repo: fixture.repo, args: ["definitely-not-a-git-subcommand"] }, fixture.ctx, options);
  assert(!unknown.ok);
  assert(unknown.exitCode !== null && unknown.exitCode !== 0);
  assert(unknown.stderr.includes("not a git command"));
  const alias = await executeGitTool({ repo: fixture.repo, args: ["-c", "alias.fixture=!printf 'native-alias-fixture'", "fixture"] }, fixture.ctx, options);
  assert(alias.ok);
  assert(alias.stdout.includes("native-alias-fixture"));
  const prefixed = await executeGitTool({ repo: fixture.repo, args: ["git", "status"] }, fixture.ctx, options);
  assert(!prefixed.ok);
  assert(prefixed.stderr.includes("not a git command"));
});

test("Git native executor creates an independent POSIX group and gracefully reaps controlled descendants", { timeout: 15_000 }, async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const bin = path.join(fixture.root, "bin");
  await fs.mkdir(bin);
  const script = [
    "#!/usr/bin/env node",
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "let stopping = false; child.once('exit', () => { if (stopping) process.exit(0); });",
    "process.on('SIGTERM', () => { stopping = true; if (child.exitCode !== null || child.signalCode !== null) process.exit(0); else child.kill('SIGTERM'); });",
    "process.stdout.write('fixture-child-started\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  await fs.writeFile(path.join(bin, "git"), script, { mode: 0o700 });
  const controller = new AbortController();
  let pgid = 0;
  let probes = 0;
  const { spawn: nativeSpawn } = await import("node:child_process");
  const ops: GitProcessOps = {
    spawn(command, args, options) {
      const child = nativeSpawn(command, args, options);
      pgid = child.pid!;
      child.stdout?.once("data", () => controller.abort());
      return child;
    },
    kill(pid, signal) {
      assert(pid < 0 && pid === -pgid);
      assert.notEqual(pid, -process.pid, "must never signal the Worker process group");
      if (signal === 0) probes++;
      process.kill(pid, signal);
    },
  };
  const result = await runGitProcess({ args: ["fixture"], cwd: fixture.cwd,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: fixture.root }, timeoutMs: 10_000,
    signal: controller.signal, knownOutputValues: [], ops });
  assert(result.cancelled);
  assert(result.processStopConfirmed);
  assert(probes > 0);
  assert.throws(() => process.kill(-pgid, 0), (error: any) => error.code === "ESRCH");
});

test("Git synchronous spawn failure has safe no-start semantics and performs no group observation", async () => {
  let probes = 0;
  const ops: GitProcessOps = { spawn() { throw new Error("fixture-private-spawn-path"); }, kill() { probes++; } };
  await assert.rejects(runGitProcess(processParams(ops)), (error: unknown) => error instanceof GitToolError && error.code === "GIT_SPAWN_FAILED" && !error.message.includes("fixture-private"));
  assert.equal(probes, 0);
});

test("Git stream errors are safe, settle the group and never turn parent-zero into business success", async () => {
  const child = fakeProcess();
  const ops: GitProcessOps = { spawn: () => child, kill: () => { throw absent(); } };
  const pending = runGitProcess(processParams(ops));
  child.emit("spawn");
  child.stdout.emit("error", new Error("fixture-private-stream-secret"));
  child.emit("exit", 0, null); child.emit("close");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 0);
  assert(result.processStopConfirmed);
  assert(!JSON.stringify(result).includes("fixture-private-stream-secret"));
});

for (const order of ["output-first", "cancel-first", "exit-first"] as const) {
  test(`Git output/cancel/parent-exit race settles once and ESRCH is latched: ${order}`, async () => {
    const child = fakeProcess(); const controller = new AbortController(); let probes = 0;
    const ops: GitProcessOps = { spawn: () => child, kill: () => { probes++; throw absent(); } };
    const pending = runGitProcess({ ...processParams(ops), signal: controller.signal, maxOutputBytes: 8 });
    child.emit("spawn");
    const events = { output: () => child.stdout.write("fixture over budget"), cancel: () => controller.abort(), exit: () => child.emit("exit", 0, null) };
    const names = order === "output-first" ? ["output", "cancel", "exit"] : order === "cancel-first" ? ["cancel", "exit", "output"] : ["exit", "output", "cancel"];
    for (const name of names) events[name as keyof typeof events]();
    child.emit("close"); const result = await pending;
    assert(result.processStopConfirmed); assert(!result.ok); assert(result.cancelled); assert(result.outputLimitExceeded);
    assert.equal(probes, 1);
  });
}

test("Git final cwd validation rejects a repository replaced by an outward symlink during prepare", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const foreign = path.join(fixture.root, "outside-workspace"); await fs.mkdir(foreign);
  fixture.ctx.apiClient.prepareRepoGitEnvLease = async () => { await fs.rmdir(fixture.cwd); await fs.symlink(foreign, fixture.cwd); return fixture.response; };
  let spawns = 0;
  await assert.rejects(executeGitTool({ repo: fixture.repo, args: ["status"] }, fixture.ctx, { dataDir: fixture.dataDir,
    runProcess: async () => { spawns++; return successfulGitProcessResult; } }), /REPO_PATH_INVALID/);
  assert.equal(spawns, 0); assert.equal(fixture.released.length, 1); assert.equal(fixture.released[0].stopEvidence, "not_started");
});

test("Git cancellation after output guard preparation prevents spawn and independently releases", async (t) => {
  const fixture = await createGitFixture("https"); t.after(fixture.cleanup);
  const controller = new AbortController(); let checks = 0; let spawns = 0;
  await assert.rejects(executeGitTool({ repo: fixture.repo, args: ["status"] }, { ...fixture.ctx, signal: controller.signal }, { dataDir: fixture.dataDir,
    now() { if (++checks === 2) controller.abort(); return Date.now(); },
    runProcess: async () => { spawns++; throw new GitToolError("GIT_CANCELLED"); } }), /GIT_CANCELLED/);
  assert.equal(checks, 2); assert.equal(spawns, 0); assert.equal(fixture.released.length, 1);
  assert.equal(fixture.released[0].stopEvidence, "not_started");
});

for (const kind of ["https", "ssh"] as const) {
  test(`Git real child output is guarded before result delivery; fixture ${kind} secrets and paths never escape`, async (t) => {
    const fixture = await createGitFixture(kind); t.after(fixture.cleanup);
    const bin = path.join(fixture.root, "bin"); await fs.mkdir(bin);
    const file = fixture.response.sensitiveFilePaths[0];
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
const secret = fs.readFileSync(${JSON.stringify(file)}, 'utf8');
const data = [secret, secret.split('\\n')[0].replace(/\\r/g, ''), ${JSON.stringify(file)}, ${JSON.stringify(fixture.leaseDir)}, ${JSON.stringify(path.join(fixture.leaseDir, "git-askpass.sh"))}, 'https://fixture-user:fixture-password@example.test/repo'].join('\\n');
process.stdout.write(data); process.stderr.write(data);
process.stdout.write('\\n' + JSON.stringify({ argv: process.argv.slice(2), hasAwb: Object.keys(process.env).some(key => key.startsWith('AWB_')), prompt: process.env.GIT_TERMINAL_PROMPT }));
`;
    await fs.writeFile(path.join(bin, "git"), script, { mode: 0o700 });
    const { spawn: nativeSpawn } = await import("node:child_process");
    let spawns = 0;
    const args = ["fixture", "two words", "\n中文", ";", "$(fixture)"];
    const result = await executeGitTool({ repo: fixture.repo, args, timeout: 5 }, fixture.ctx, { dataDir: fixture.dataDir, processOps: {
      spawn(command, argv, options) {
        spawns++; assert.equal(command, "git"); assert.deepEqual(argv, args); assert.equal(options.shell, false);
        assert(!Object.keys(options.env!).some(key => key.startsWith("AWB_")));
        return nativeSpawn(command, argv, { ...options, env: { ...options.env, PATH: `${bin}:${process.env.PATH}` } });
      }, kill(pid, signal) { process.kill(pid, signal); },
    } });
    assert(result.ok); assert(result.outputRedacted); assert(result.processStopConfirmed);
    assert.equal(spawns, 1); assert.equal(fixture.prepared.length, 1); assert.equal(fixture.released.length, 1);
    const output = `${result.stdout}${result.stderr}`;
    for (const value of [TEST_GIT_SECRET, file, fixture.leaseDir, "fixture-user", "fixture-password"]) assert(!output.includes(value), "fixture secret/path leaked");
    if (kind === "https") assert(!output.includes(path.join(fixture.leaseDir, "git-askpass.sh")));
    assert(result.stdout.includes('"hasAwb":false')); assert(result.stdout.includes('"prompt":"0"'));
    assert(result.stdout.includes(JSON.stringify(args)));
  });
}

test("Git builtin dispatch uses trusted dataDir and native executor, never a response-derived directory", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const { BuiltinToolProvider } = await import("./tools/providers/builtin.js");
  const args = { repo: fixture.repo, args: ["init", "--quiet"] };
  const missingRoot = new BuiltinToolProvider(); assert(missingRoot.canHandle("git"));
  await assert.rejects(missingRoot.execute("git", args, fixture.ctx), /RUN_CONTEXT_INVALID/);
  assert.equal(fixture.prepared.length, 0);
  const provider = new BuiltinToolProvider({ dataDir: fixture.dataDir });
  const result = await provider.execute("git", args, fixture.ctx);
  assert(Value.Check(GitToolResultSchema, result)); assert(result.ok);
  assert.equal(fixture.prepared.length, 1); assert.equal(fixture.released.length, 1);
});

for (const termination of ["cancel", "signal", "descendant-term"] as const) {
  test(`Git forced ${termination} redacts a known secret prefix even when stdio reaches EOF normally`, async () => {
    const child = fakeProcess(); const controller = new AbortController(); let present = termination === "descendant-term";
    const ops: GitProcessOps = { spawn: () => child, kill(_pid, signal) {
      if (!present) throw absent();
      if (signal === "SIGTERM") present = false;
    } };
    const pending = runGitProcess({ ...processParams(ops), signal: controller.signal, knownOutputValues: [TEST_GIT_SECRET] });
    child.emit("spawn"); child.stdout.write(`ordinary output\n${TEST_GIT_SECRET.slice(0, 12)}`);
    if (termination === "cancel") controller.abort();
    child.emit("exit", termination === "signal" ? null : 0, termination === "signal" ? "SIGTERM" : null);
    child.emit("close");
    const result = await pending;
    assert(result.processStopConfirmed);
    assert(result.outputRedacted);
    assert(!result.stdout.includes(TEST_GIT_SECRET.slice(0, 12)));
    assert(result.stdout.includes("ordinary output"));
  });
}

test("Git settlement and elapsed duration use a monotonic clock, not wall-clock steps", async (t) => {
  const child = fakeProcess(); let present = true; let wallClockReads = 0;
  t.mock.method(Date, "now", () => { wallClockReads++; return 0; });
  const ops: GitProcessOps = { spawn: () => child, kill(_pid, signal) {
    if (!present) throw absent();
    if (signal === "SIGTERM") present = false;
  } };
  const pending = runGitProcess(processParams(ops));
  child.emit("spawn"); child.emit("close"); child.emit("exit", 0, null);
  const result = await pending;
  assert(result.processStopConfirmed); assert(result.ok);
  assert(Number.isSafeInteger(result.durationMs) && result.durationMs >= 0);
  assert.equal(wallClockReads, 0);
});

for (const ancestor of ["data", "workspaces", "workspace"] as const) {
  for (const timing of ["prepare", "local-guard"] as const) {
    test(`Git rejects a ${ancestor} outward symlink replaced during ${timing}; no spawn and one independent not_started release`, async (t) => {
      const fixture = await createGitFixture("https"); t.after(fixture.cleanup);
      const controller = new AbortController(); let nativeCalls = 0; let releaseCalls = 0;
      const target = ancestor === "data" ? fixture.dataDir : ancestor === "workspaces" ? path.dirname(fixture.workspacePath) : fixture.workspacePath;
      const foreign = path.join(fixture.root, "foreign-tree");
      const foreignRepo = ancestor === "data" ? path.join(foreign, "workspaces", "workspace", fixture.repo)
        : ancestor === "workspaces" ? path.join(foreign, "workspace", fixture.repo) : path.join(foreign, fixture.repo);
      await fs.mkdir(foreignRepo, { recursive: true });
      const substitute = async () => { await fs.rename(target, path.join(fixture.root, "original-tree")); await fs.symlink(foreign, target); };
      const ctx = { ...fixture.ctx, signal: controller.signal };
      ctx.apiClient.prepareRepoGitEnvLease = async () => {
        fixture.prepared.push({ repo: fixture.repo });
        if (timing === "prepare") await substitute();
        return fixture.response;
      };
      ctx.apiClient.releaseRepoGitEnvLease = async (input) => {
        releaseCalls++; controller.abort(); fixture.released.push(input);
        return { ok: true };
      };
      let injected = false;
      const originalLstat = fs.lstat.bind(fs);
      if (timing === "local-guard") {
        // The lease secret has already been read. Substitute just before the
        // output guard's post-read path checks, not after final cwd validation.
        t.mock.method(fs, "lstat", async (...input: Parameters<typeof fs.lstat>) => {
          if (!injected && String(input[0]) === fixture.response.sensitiveFilePaths[0]) {
            injected = true; await substitute();
          }
          return originalLstat(...input);
        });
      }
      await assert.rejects(executeGitTool({ repo: fixture.repo, args: ["status"] }, ctx, { dataDir: fixture.dataDir,
        runProcess: async () => { nativeCalls++; return successfulGitProcessResult; } }), (error: unknown) => error instanceof GitToolError && error.code === "REPO_PATH_INVALID");
      if (timing === "local-guard") assert(injected);
      assert.equal(nativeCalls, 0); assert.equal(fixture.prepared.length, 1);
      assert.equal(releaseCalls, 1); assert.equal(fixture.released[0].stopEvidence, "not_started");
      assert(controller.signal.aborted, "release must complete independently of run cancellation");
      assert.deepEqual(await fs.readdir(foreignRepo), [], "foreign repository must not be entered or changed");
    });
  }
}

for (const splitStreams of [false, true]) {
  test(`Git actual 512 KiB+1 raw output triggers one bounded settlement (split streams=${splitStreams})`, async () => {
    const child = fakeProcess(); let present = true; let nativeCalls = 0;
    const signals: Array<NodeJS.Signals | 0> = [];
    const ops: GitProcessOps = {
      spawn() { nativeCalls++; return child; },
      kill(_pid, signal) {
        signals.push(signal);
        if (!present) throw absent();
        if (signal === "SIGTERM") { present = false; child.emit("exit", 0, null); child.emit("close"); }
      },
    };
    const pending = runGitProcess(processParams(ops)); child.emit("spawn");
    child.stdout.write(Buffer.alloc(splitStreams ? 256 * 1024 : 512 * 1024, 120));
    if (splitStreams) child.stderr.write(Buffer.alloc(256 * 1024, 121));
    assert.deepEqual(signals, [], "exactly 512 KiB must not trigger settlement");
    child.stderr.write("z"); child.stdout.write("ignored after overflow"); child.stderr.write("more ignored output");
    const result = await pending;
    assert(!result.ok); assert.equal(result.exitCode, 0);
    assert(result.outputLimitExceeded); assert(result.processStopConfirmed);
    assert.equal(nativeCalls, 1); assert.deepEqual(signals.filter(signal => signal !== 0), ["SIGTERM"]);
    assert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 512 * 1024);
  });
}

test("Git acknowledges the post-final-check cwd TOCTOU window without claiming atomic directory execution", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const foreignWorkspace = path.join(fixture.root, "post-check-workspace");
  const foreignRepo = path.join(foreignWorkspace, fixture.repo);
  await fs.mkdir(foreignRepo, { recursive: true });
  let nativeCalls = 0;
  const result = await executeGitTool({ repo: fixture.repo, args: ["init", "--quiet"] }, fixture.ctx, {
    dataDir: fixture.dataDir,
    runProcess: async (params) => {
      nativeCalls++; assert.equal(params.cwd, fixture.cwd);
      // This seam is entered only AFTER the final cwd check has returned.
      // All targets belong to this test's isolated, project-local fixture.
      await fs.rename(fixture.workspacePath, path.join(fixture.root, "original-checked-workspace"));
      await fs.symlink(foreignWorkspace, fixture.workspacePath);
      return runGitProcess(params);
    },
  });
  assert(result.ok); assert(result.processStopConfirmed); assert.equal(nativeCalls, 1);
  assert((await fs.stat(path.join(foreignRepo, ".git"))).isDirectory());
  await assert.rejects(fs.access(path.join(fixture.root, "original-checked-workspace", fixture.repo, ".git")));
});


for (const [index, level] of ["data", "tmp", "git-env", "v2", "lease"].entries()) {
  test(`Git output guard ${level} stat EIO retains safe failure and one not_started release`, async (t) => {
    const fixture = await createGitFixture();
    t.after(fixture.cleanup);
    const opened: Array<{ handle: fs.FileHandle; closes: number }> = [];
    t.after(async () => {
      for (const entry of opened) if (entry.closes === 0) await entry.handle.close();
    });
    let prepared = false;
    const prepare = fixture.ctx.apiClient.prepareRepoGitEnvLease;
    fixture.ctx.apiClient.prepareRepoGitEnvLease = async (input) => {
      const response = await prepare(input);
      prepared = true;
      return response;
    };
    const originalOpen = fs.open.bind(fs);
    let outputOpens = 0;
    let injected = false;
    t.mock.method(fs, "open", async (...input: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...input);
      const entry = { handle, closes: 0 };
      opened.push(entry);
      const originalClose = handle.close.bind(handle);
      t.mock.method(handle, "close", async () => { await originalClose(); entry.closes++; });
      if (prepared && ++outputOpens === index + 1) {
        t.mock.method(handle, "stat", async () => {
          injected = true;
          throw Object.assign(new Error("fixture stat failure"), { code: "EIO" });
        });
      }
      return handle;
    });
    let nativeCalls = 0;
    await assert.rejects(executeGitTool({ repo: fixture.repo, args: ["status"] }, fixture.ctx, {
      dataDir: fixture.dataDir,
      runProcess: async () => { nativeCalls++; return successfulGitProcessResult; },
    }), (error: unknown) => error instanceof GitToolError && error.code === "GIT_OUTPUT_GUARD_FAILED");
    assert(injected);
    assert.equal(nativeCalls, 0);
    assert.equal(fixture.prepared.length, 1);
    assert.equal(fixture.released.length, 1);
    assert.equal(fixture.released[0].stopEvidence, "not_started");
    assert.equal(opened.length, 3 + index + 1);
    assert(opened.every((entry) => entry.closes === 1), "all repository and output guard handles must close once");
  });
}
