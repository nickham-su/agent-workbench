import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { runGit, runGitBuffer } from "./gitExec.js";

function fakeProcess(t: TestContext, opts: { closeOnKill?: boolean; pid?: number } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), pid: opts.pid,
    kill() { if (opts.closeOnKill !== false) setImmediate(() => child.emit("close", null)); return true; }
  });
  t.mock.method(childProcess, "spawn", (() => child) as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return child;
}

test("Git execution enforces a timeout without launching a process", async (t) => {
  fakeProcess(t);
  const result = await runGitBuffer(["status"], { cwd: process.cwd(), timeoutMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "timeout");
});

test("Git execution bounds stdout and stderr together and rejects truncated results", async (t) => {
  const child = fakeProcess(t);
  const resultPromise = runGitBuffer(["status"], { cwd: process.cwd(), maxOutputBytes: 8 });
  child.stdout.write(Buffer.from("12345"));
  child.stderr.write(Buffer.from("67890"));
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.failure, "output-limit");
  assert.ok(result.stdout.byteLength + Buffer.byteLength(result.stderr) <= 8);
});

test("Git string output decodes UTF-8 after joining chunks", async (t) => {
  const child = fakeProcess(t);
  const resultPromise = runGit(["status"], { cwd: process.cwd() });
  const text = Buffer.from("中文");
  child.stdout.write(text.subarray(0, 1));
  child.stdout.write(text.subarray(1));
  child.emit("close", 0);
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "中文");
});


for (const reason of ["timeout", "output-limit"] as const) {
  test(`Git ${reason} terminates its owned group and settles even when exit never leads to close`, { skip: process.platform === "win32" }, async (t) => {
    const child = fakeProcess(t, { closeOnKill: false, pid: 123456 });
    const killed: Array<[number, string | number | undefined]> = [];
    t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => { killed.push([pid, signal]); return true; });
    const resultPromise = runGitBuffer(["status"], { cwd: process.cwd(), timeoutMs: 10, maxOutputBytes: 4 });
    child.emit("exit", 0); // Git parent is gone, but an inherited helper pipe is still open.
    if (reason === "output-limit") child.stdout.write("too-large");
    const result = await Promise.race([resultPromise, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Git termination was not bounded")), 500);
      t.after(() => clearTimeout(timer));
    })]);
    assert.equal(result.ok, false); assert.equal(result.failure, reason);
    assert.deepEqual(killed, [[-123456, "SIGKILL"]]);
    assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  });
}
