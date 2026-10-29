import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { runTerminalEnvironmentLauncher } from "./terminal-env-launcher.js";
import { openTerminalEnvironmentDirectories, openTerminalEnvironmentFile, closeTerminalEnvironmentDirectories,
  writeTerminalEnvironmentStatus } from "./terminal-env-launch.files.js";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";
import { initSchema } from "../../infra/db/schema.js";
import { openSecureRootDirectory, openExistingSecureChildDirectory, closeSecureDirectories, securePrivateDeleteName,
  securePrivateSlotIdentity, retireSecureEntry, removeRetiredEmptySecureDirectory } from "../../infra/fs/secure-directory.js";
import { shQuote } from "../../infra/git/shQuote.js";
import {
  clearTerminalEnvironmentLaunchAttempt, getTerminalEnvironmentLaunchAttempt, insertTerminalEnvironmentLaunchAttempt,
  listTerminalEnvironmentLaunchAttempts, updateTerminalEnvironmentLaunchAttempt, type TerminalEnvironmentLaunchAttempt
} from "./terminal-env-launch-attempt.store.js";
import {
  cleanupTerminalEnvironmentLaunch, markTerminalEnvironmentLaunchStarting, prepareTerminalEnvironmentLaunch,
  resolveTerminalEnvironmentLauncherCommand, terminalEnvironmentLaunchLocator, waitTerminalEnvironmentLaunch,
  type TerminalEnvironmentLaunchTestHooks
} from "./terminal-env-launch.js";
import { terminalEnvironmentIdentity, terminalEnvironmentInode, terminalEnvironmentScopes, TERMINAL_ENV_LAUNCH_ROOT,
  TerminalEnvironmentLaunchError, type TerminalEnvironmentLaunchLocator } from "./terminal-env-launch.protocol.js";

const ownedRoots: string[] = [];
const dbs: Database.Database[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL"); await closed;
    }
  }
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of ownedRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function fixture() {
  // New fixtures stay inside the project even when a caller forgot to isolate TMPDIR.
  const projectTmp = fileURLToPath(new URL("../../../../../.tmp-tests/", import.meta.url));
  await fs.mkdir(projectTmp, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(projectTmp, "tc1-")); ownedRoots.push(root);
  const dataDir = path.join(root, "data"); await fs.mkdir(dataDir, { mode: 0o700 });
  const db = new Database(":memory:"); dbs.push(db); db.pragma("foreign_keys = ON"); initSchema(db);
  db.prepare("insert into workspaces(id,dir_name,title,path,created_at,updated_at) values('ws','ws','fixture',?,1,1)").run(root);
  db.prepare("insert into terminals(id,workspace_id,session_name,status,created_at,updated_at) values('t-one','ws','fixture','creating',1,1)").run();
  const prepare = (options: { shell?: string; hooks?: TerminalEnvironmentLaunchTestHooks; workspaceEnv?: Record<string, string> } = {}) => prepareTerminalEnvironmentLaunch({
    db, dataDir, terminalId: "t-one", shell: options.shell ?? "/bin/sh",
    baseEnv: { PATH: "/usr/bin:/bin", HOME: root, AWB_FIXTURE: "must-be-filtered", TMUX: "stale-server" },
    systemEnv: { GIT_ASKPASS: "/fixture/system-askpass" }, workspaceEnv: options.workspaceEnv ?? { VALUE: "fictional-fixture" }, hooks: options.hooks
  });
  return { db, dataDir, root, prepare };
}
function paths(dataDir: string, attempt: TerminalEnvironmentLaunchAttempt) {
  const root = path.join(dataDir, TERMINAL_ENV_LAUNCH_ROOT), directory = path.join(root, attempt.directoryName);
  return { root, directory, payload: path.join(directory, "payload.json"), status: path.join(directory, "status.json") };
}
const expectCode = (code: string) => (error: unknown) => error instanceof TerminalEnvironmentLaunchError && error.code === code;
async function writeStatus(dataDir: string, attempt: TerminalEnvironmentLaunchAttempt, status: unknown) {
  await fs.writeFile(paths(dataDir, attempt).status, typeof status === "string" ? status : JSON.stringify(status));
}
async function fakeShell(root: string, body: string) {
  const filename = path.join(root, "fixture-shell");
  await fs.writeFile(filename, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return filename;
}
function startLauncher(command: string[], cwd: string): { child: ChildProcess; exited: Promise<number | null>; stderr: () => string } {
  const child = spawn(command[0]!, command.slice(1), { cwd, stdio: ["ignore", "ignore", "pipe"], env: {
    PATH: "/cannot-resolve-node", NODE_OPTIONS: "--not-a-real-launcher-option", NODE_PATH: "/bad-loader",
    HOME: cwd, TMPDIR: process.env.TMPDIR, TERM: "fixture-term", TMUX: "fixture-tmux", TMUX_PANE: "%77"
  } });
  children.push(child);
  let error = ""; child.stderr!.on("data", (part) => { error += part.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
  return { child, exited, stderr: () => error };
}

test("prepare arms before side effects, persists complete private identities, and never places values in argv", async () => {
  const f = await fixture();
  const observed: string[] = [];
  const prepared = await f.prepare({ hooks: { afterCreate(kind) {
    const attempt = listTerminalEnvironmentLaunchAttempts(f.db, "t-one")[0]!;
    assert.equal(attempt[`${kind === "directory" ? "directory" : kind}Armed` as "directoryArmed" | "payloadArmed" | "statusArmed"], true);
    assert.equal(kind === "directory" ? attempt.attemptDirectory : attempt[kind], null);
    observed.push(kind);
  } } });
  assert.deepEqual(observed, ["directory", "payload", "status"]);
  assert.equal(prepared.attempt.phase, "prepared");
  const p = paths(f.dataDir, prepared.attempt);
  assert.equal((await fs.stat(p.root)).mode & 0o7777, 0o700);
  assert.equal((await fs.stat(p.directory)).mode & 0o7777, 0o700);
  for (const name of [p.payload, p.status]) { const stat = await fs.stat(name); assert.equal(stat.mode & 0o7777, 0o600); assert.equal(stat.nlink, 1); }
  const payload = JSON.parse(await fs.readFile(p.payload, "utf8"));
  assert.equal(payload.baseEnv.AWB_FIXTURE, undefined); assert.equal(payload.baseEnv.TMUX, undefined);
  assert.equal(payload.workspaceEnv.VALUE, "fictional-fixture");
  assert.equal(prepared.command.join(" ").includes("fictional-fixture"), false);
  assert.deepEqual(prepared.command.slice(0, 6), ["/usr/bin/env", "-u", "NODE_OPTIONS", "-u", "NODE_PATH", process.execPath]);
  assert.equal(prepared.command[6], "--import"); assert.match(prepared.command[7]!, /^file:\/\/.*tsx/);
  assert.equal(markTerminalEnvironmentLaunchStarting(f.db, prepared.attempt.id).phase, "launching");
  assert.throws(() => markTerminalEnvironmentLaunchStarting(f.db, prepared.attempt.id), expectCode("TERMINAL_ENV_PROTOCOL_FAILED"));
  assert.throws(() => updateTerminalEnvironmentLaunchAttempt(f.db, prepared.attempt.id, { phase: "prepared" }), expectCode("TERMINAL_ENV_PROTOCOL_FAILED"));
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: prepared.attempt.id, consumption: "stopped" }), "clean");
  assert.ok(getTerminalEnvironmentLaunchAttempt(f.db, prepared.attempt.id), "cleanup leaves row for final activation transaction");
  clearTerminalEnvironmentLaunchAttempt(f.db, prepared.attempt.id);
  assert.equal(getTerminalEnvironmentLaunchAttempt(f.db, prepared.attempt.id), null);
  assert.deepEqual(await fs.readdir(p.root), []);
});

test("attempt FK restricts terminal deletion, identities and arms cannot be rewritten, init preserves history", async () => {
  const f = await fixture(); const { attempt } = await f.prepare();
  assert.throws(() => f.db.prepare("delete from terminals where id='t-one'").run(), /FOREIGN KEY/);
  assert.throws(() => updateTerminalEnvironmentLaunchAttempt(f.db, attempt.id, { payloadArmed: false }), expectCode("TERMINAL_ENV_PROTOCOL_FAILED"));
  assert.throws(() => updateTerminalEnvironmentLaunchAttempt(f.db, attempt.id, { payload: { dev: "1", ino: "1" } }), expectCode("TERMINAL_ENV_PROTOCOL_FAILED"));
  assert.throws(() => f.db.prepare("update terminal_env_launch_attempts set payload_dev=null where id=?").run(attempt.id), /CHECK/);
  const version = f.db.prepare("select version from agent_schema_meta where id=1").get();
  initSchema(f.db); initSchema(f.db);
  assert.deepEqual(f.db.prepare("select version from agent_schema_meta where id=1").get(), version);
  assert.equal(getTerminalEnvironmentLaunchAttempt(f.db, attempt.id)?.payload?.ino, attempt.payload?.ino);
  assert.equal((f.db.prepare("select count(*) as n from terminals").get() as { n: number }).n, 1);
});
test("unknown existing attempt schema fails closed rather than dropping locator authority", async () => {
  const f = await fixture();
  f.db.exec("drop table terminal_env_launch_attempts; create table terminal_env_launch_attempts(id text primary key, secret_locator text); insert into terminal_env_launch_attempts values('unknown','fixture-authority')");
  assert.throws(() => initSchema(f.db), /Unsupported terminal environment launch attempt schema/);
  assert.deepEqual(f.db.prepare("select * from terminal_env_launch_attempts").get(), { id: "unknown", secret_locator: "fixture-authority" });
});
test("fixed source launcher works despite hostile PATH/Node loading settings; literal values only reach target shell", async () => {
  const f = await fixture(), output = path.join(f.root, "output");
  const value = " \r\n$PATH $(touch not-executed) 😀é ";
  const shell = await fakeShell(f.root, `printf '%s' "$VALUE" > ${shQuote(output)}\nprintf '%s' "$NODE_OPTIONS" > ${shQuote(`${output}-node`)}\nprintf '%s' "$TMUX" > ${shQuote(`${output}-tmux`)}\nif [ "\${AWB_FIXTURE+x}" = x ]; then exit 23; fi\nexit 7`);
  const prepared = await f.prepare({ shell, workspaceEnv: { VALUE: value, NODE_OPTIONS: "--late-to-shell", PATH: "/workspace-path-not-launcher" } });
  const originalStatus = await fs.stat(paths(f.dataDir, prepared.attempt).status);
  const launch = startLauncher(prepared.command, f.root);
  const status = await waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt: prepared.attempt, timeoutMs: 4000, pollMs: 5 });
  assert.equal(status.state, "spawned"); assert.equal(await launch.exited, 7);
  assert.equal(launch.stderr(), "");
  assert.equal(await fs.readFile(output, "utf8"), value);
  assert.equal(await fs.readFile(`${output}-node`, "utf8"), "--late-to-shell");
  assert.equal(await fs.readFile(`${output}-tmux`, "utf8"), "fixture-tmux");
  assert.equal((await fs.stat(paths(f.dataDir, prepared.attempt).status)).ino, originalStatus.ino);
  assert.equal(await fs.stat(path.join(f.root, "not-executed")).then(() => true, () => false), false);
});
test("shell ENOENT and OS E2BIG publish bounded fixed errors, not raw argv or environment", async () => {
  for (const tooLarge of [false, true]) {
    const f = await fixture();
    const prepared = tooLarge
      ? await prepareTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, terminalId: "t-one", shell: "/bin/sh", baseEnv: { BIG: "x".repeat(800_000) }, systemEnv: {}, workspaceEnv: {} })
      : await f.prepare({ shell: path.join(f.root, "missing-shell") });
    const launch = startLauncher(prepared.command, f.root);
    const status = await waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt: prepared.attempt, timeoutMs: 4000, pollMs: 5 });
    assert.equal(status.state, "spawn-error");
    if (status.state === "spawn-error") assert.equal(status.code, tooLarge ? "ENV_TOO_LARGE" : "SHELL_NOT_FOUND");
    assert.equal(await launch.exited, 1); assert.equal(launch.stderr(), "");
    assert.ok((await fs.stat(paths(f.dataDir, prepared.attempt).status)).size < 4096);
  }
});

test("consumed spawn handshake allows one-shot file cleanup while the owned shell remains running", async () => {
  const factories = [resolveTerminalEnvironmentLauncherCommand];
  const distModule = fileURLToPath(new URL("../../../dist/modules/terminals/terminal-env-launch.js", import.meta.url));
  if (await fs.stat(distModule).then(() => true, () => false)) factories.push((await import(distModule)).resolveTerminalEnvironmentLauncherCommand);
  for (const commandFor of factories) {
    const f = await fixture(); const shell = await fakeShell(f.root, "exec /bin/sleep 30");
    const prepared = await f.prepare({ shell }); const launch = startLauncher(commandFor(terminalEnvironmentLaunchLocator(f.dataDir, prepared.attempt)), f.root);
    assert.equal((await waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt: prepared.attempt, timeoutMs: 10_000, pollMs: 5 })).state, "spawned");
    assert.equal(launch.child.exitCode, null);
    assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: prepared.attempt.id, consumption: "spawned" }), "clean");
    assert.deepEqual(await fs.readdir(paths(f.dataDir, prepared.attempt).root), []);
    assert.ok(getTerminalEnvironmentLaunchAttempt(f.db, prepared.attempt.id));
    launch.child.kill("SIGTERM"); assert.equal(await launch.exited, 143);
    assert.equal(launch.stderr(), "");
  }
});
test("valid final status is the commit boundary: no post-publication stat, sync or truncate may race API cleanup", async () => {
  const f = await fixture(); const { attempt } = await f.prepare();
  const locator = terminalEnvironmentLaunchLocator(f.dataDir, attempt);
  const dirs = await openTerminalEnvironmentDirectories(locator);
  const handle = await openTerminalEnvironmentFile({ directory: dirs.directory, name: "status.json", identity: locator.status, ownerUid: locator.ownerUid, writable: true });
  const originalWrite = handle.write, originalStat = handle.stat, originalTruncate = handle.truncate, originalSync = handle.sync;
  let published = false;
  handle.write = (async (...args: Parameters<typeof handle.write>) => {
    const result = await Reflect.apply(originalWrite, handle, args);
    published = true;
    return result;
  }) as typeof handle.write;
  handle.stat = (async (...args: Parameters<typeof handle.stat>) => {
    assert.equal(published, false, "late stat would race consumed-file cleanup");
    return Reflect.apply(originalStat, handle, args);
  }) as typeof handle.stat;
  handle.truncate = async (length) => { assert.equal(published, false, "late truncate would race consumed-file cleanup"); await originalTruncate.call(handle, length); };
  handle.sync = async () => { assert.equal(published, false, "late sync would race consumed-file cleanup"); await originalSync.call(handle); };
  try {
    await writeTerminalEnvironmentStatus({ dirs, locator, handle, status: { version: 1, attemptId: attempt.id, state: "spawned" } });
    assert.equal(published, true);
    assert.equal((await waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt, timeoutMs: 1000, pollMs: 2 })).state, "spawned");
  } finally {
    handle.write = originalWrite; handle.stat = originalStat; handle.truncate = originalTruncate; handle.sync = originalSync;
    await handle.close(); await closeTerminalEnvironmentDirectories(dirs);
  }
});
test("corrupt payload never starts a shell and protocol diagnostics do not contain contents", async () => {
  const f = await fixture(), marker = path.join(f.root, "spawned-marker");
  const shell = await fakeShell(f.root, `printf yes > ${shQuote(marker)}`);
  const prepared = await f.prepare({ shell });
  await fs.writeFile(paths(f.dataDir, prepared.attempt).payload, JSON.stringify({ version: 1, secret: "fixture-do-not-leak" }));
  const launch = startLauncher(prepared.command, f.root);
  const status = await waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt: prepared.attempt, timeoutMs: 4000, pollMs: 5 });
  assert.equal(status.state, "spawn-error");
  if (status.state === "spawn-error") assert.equal(status.code, "SNAPSHOT_INVALID");
  assert.equal(await launch.exited, 1); assert.equal(launch.stderr().includes("fixture-do-not-leak"), false);
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
});
test("launcher TERM forwards only to the owned child and maps signal exit code", async () => {
  const f = await fixture(); const shell = await fakeShell(f.root, "exec /bin/sleep 30");
  const prepared = await f.prepare({ shell }); const launch = startLauncher(prepared.command, f.root);
  assert.equal((await waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt: prepared.attempt, timeoutMs: 4000, pollMs: 5 })).state, "spawned");
  launch.child.kill("SIGTERM"); assert.equal(await launch.exited, 143);
  assert.equal(launch.stderr(), "");
});
test("pending and partial same-inode status are bounded waits, complete wrong status fails immediately", async () => {
  const f = await fixture(); const { attempt } = await f.prepare();
  await assert.rejects(waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt, timeoutMs: 25, pollMs: 2 }), expectCode("TERMINAL_ENV_START_TIMEOUT"));
  await writeStatus(f.dataDir, attempt, '{"version":1');
  await assert.rejects(waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt, timeoutMs: 25, pollMs: 2 }), expectCode("TERMINAL_ENV_START_TIMEOUT"));
  const completed = waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt, timeoutMs: 1000, pollMs: 2 });
  await delay(20);
  await writeStatus(f.dataDir, attempt, { version: 1, attemptId: attempt.id, state: "spawned" });
  assert.equal((await completed).state, "spawned");
  for (const invalid of [
    { version: 2, attemptId: attempt.id, state: "spawned" }, { version: 1, attemptId: "other", state: "spawned" },
    { version: 1, attemptId: attempt.id, state: "spawned", code: "SHELL_NOT_FOUND" },
    { version: 1, attemptId: attempt.id, state: "spawn-error", code: "raw-error" }
  ]) {
    await writeStatus(f.dataDir, attempt, invalid);
    await assert.rejects(waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt, timeoutMs: 100, pollMs: 2 }), expectCode("TERMINAL_ENV_PROTOCOL_FAILED"));
  }
  await writeStatus(f.dataDir, attempt, "x".repeat(4097));
  await assert.rejects(waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt, timeoutMs: 100 }), expectCode("TERMINAL_ENV_PROTOCOL_FAILED"));
});
test("status inode replacement is not reauthorized and causes protocol failure", async () => {
  const f = await fixture(); const { attempt } = await f.prepare(), p = paths(f.dataDir, attempt);
  await fs.rename(p.status, `${p.status}-original`);
  await fs.writeFile(p.status, JSON.stringify({ version: 1, attemptId: attempt.id, state: "spawned" }), { mode: 0o600 });
  await assert.rejects(waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt, timeoutMs: 100 }), expectCode("TERMINAL_ENV_PROTOCOL_FAILED"));
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "pending");
  assert.ok(await fs.stat(p.status));
});

test("file rename/unlink crash recovers exact stable scope while business name is missing", async () => {
  const f = await fixture(); const { attempt } = await f.prepare(), p = paths(f.dataDir, attempt);
  const result = await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped", hooks: {
    afterRetire({ kind }) { if (kind === "file") throw new Error("fixture-crash"); }
  } });
  assert.equal(result, "pending");
  assert.equal(await fs.stat(p.payload).then(() => true, () => false), false);
  const names = await fs.readdir(p.directory);
  assert.ok(names.some((name) => securePrivateSlotIdentity(name)?.scope === terminalEnvironmentScopes(attempt.id).payload));
  assert.ok(getTerminalEnvironmentLaunchAttempt(f.db, attempt.id));
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "clean");
  assert.deepEqual(await fs.readdir(p.root), []);
});
test("directory rename/rmdir crash recovers from exact ed slot with original directory missing", async () => {
  const f = await fixture(); const { attempt } = await f.prepare(), p = paths(f.dataDir, attempt);
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped", hooks: {
    afterRetire({ kind }) { if (kind === "directory") throw new Error("fixture-crash"); }
  } }), "pending");
  assert.equal(await fs.stat(p.directory).then(() => true, () => false), false);
  const retired = (await fs.readdir(p.root)).find((name) => securePrivateSlotIdentity(name)?.scope === terminalEnvironmentScopes(attempt.id).directory)!;
  assert.ok(retired);
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "clean");
  assert.deepEqual(await fs.readdir(p.root), []);
});
test("retired directory containing an unknown descendant remains pending; cleanup never recurses", async () => {
  const f = await fixture(); const { attempt } = await f.prepare(), p = paths(f.dataDir, attempt);
  await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped", hooks: {
    afterRetire({ kind }) { if (kind === "directory") throw new Error("fixture-crash"); }
  } });
  const slot = (await fs.readdir(p.root))[0]!; const unknown = path.join(p.root, slot, "unknown-victim");
  await fs.writeFile(unknown, "must-stay", { mode: 0o600 });
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "pending");
  assert.equal(await fs.readFile(unknown, "utf8"), "must-stay");
});
test("file slot replacement, marker, unknown scope format and duplicate candidates are retained", async () => {
  for (const kind of ["replacement", "marker", "malformed", "duplicate"] as const) {
    const f = await fixture(); const { attempt } = await f.prepare(), p = paths(f.dataDir, attempt);
    await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped", hooks: {
      afterRetire({ kind }) { if (kind === "file") throw new Error("fixture-crash"); }
    } });
    const slot = (await fs.readdir(p.directory)).find((name) => securePrivateSlotIdentity(name)?.scope === terminalEnvironmentScopes(attempt.id).payload)!;
    let retainedPath = path.join(p.directory, slot);
    if (kind === "replacement") {
      await fs.rename(retainedPath, path.join(f.root, "original-payload"));
      await fs.writeFile(retainedPath, "replacement-victim", { mode: 0o600 });
    } else if (kind === "marker") {
      retainedPath = path.join(p.directory, `.delete-replacement-pending-${slot}`);
      await fs.rename(path.join(p.directory, slot), retainedPath);
    } else if (kind === "malformed") {
      retainedPath = path.join(p.directory, `.delete-v1-${terminalEnvironmentScopes(attempt.id).payload}-bad-format`);
      await fs.writeFile(retainedPath, "unknown-victim", { mode: 0o600 });
    } else {
      retainedPath = path.join(p.directory, securePrivateDeleteName({ ...terminalEnvironmentInode(attempt.payload!), scope: terminalEnvironmentScopes(attempt.id).payload, kind: "file" }));
      await fs.copyFile(path.join(p.directory, slot), retainedPath);
    }
    assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "pending", kind);
    assert.ok(await fs.lstat(retainedPath), kind);
    assert.ok(getTerminalEnvironmentLaunchAttempt(f.db, attempt.id));
  }
});
test("unrelated root scopes and markers neither get removed nor globally block this attempt", async () => {
  const f = await fixture(); const { attempt } = await f.prepare(), p = paths(f.dataDir, attempt);
  const unrelated = path.join(p.root, `.delete-replacement-pending-.delete-v1-${terminalEnvironmentScopes("different-attempt").directory}-bad`);
  await fs.writeFile(unrelated, "other-attempt", { mode: 0o600 });
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "clean");
  assert.equal(await fs.readFile(unrelated, "utf8"), "other-attempt");
  assert.deepEqual(await fs.readdir(p.root), [path.basename(unrelated)]);
});
test("unlocated armed directory/file crash windows cannot adopt current identity even when empty", async () => {
  for (const kind of ["directory", "payload", "status"] as const) {
    const f = await fixture();
    await assert.rejects(f.prepare({ hooks: { afterCreate(actual) { if (actual === kind) throw new Error("fixture-crash"); } } }), expectCode("TERMINAL_ENV_PREPARE_FAILED"));
    const attempt = listTerminalEnvironmentLaunchAttempts(f.db, "t-one")[0]!;
    assert.equal(kind === "directory" ? attempt.attemptDirectory : attempt[kind], null);
    assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "pending");
    const p = paths(f.dataDir, attempt);
    assert.ok(await fs.lstat(kind === "directory" ? p.directory : p[kind]));
    assert.equal(getTerminalEnvironmentLaunchAttempt(f.db, attempt.id)?.phase, "cleanup_pending");
  }
});
test("armed-before-create with certain absence can converge; unknown matching slot still blocks", async () => {
  const f = await fixture(); const launchRoot = path.join(f.dataDir, TERMINAL_ENV_LAUNCH_ROOT);
  await fs.mkdir(launchRoot, { mode: 0o700 });
  const attempt: TerminalEnvironmentLaunchAttempt = { id: "te-armed", terminalId: "t-one", directoryName: "t-one-te-armed", phase: "armed", ownerUid: process.getuid!(),
    dataRoot: terminalEnvironmentIdentity(await fs.stat(f.dataDir)), launchRoot: terminalEnvironmentIdentity(await fs.stat(launchRoot)),
    attemptDirectory: null, payload: null, status: null, directoryArmed: true, payloadArmed: false, statusArmed: false,
    errorCode: null, createdAt: 1, updatedAt: 1 };
  insertTerminalEnvironmentLaunchAttempt(f.db, attempt);
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "clean");
  const unknown = path.join(launchRoot, `.delete-v1-${terminalEnvironmentScopes(attempt.id).directory}-unknown`);
  await fs.writeFile(unknown, "unknown-victim", { mode: 0o600 });
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "pending");
  assert.equal(await fs.readFile(unknown, "utf8"), "unknown-victim");
});
test("payload symlink, hardlink and create-time inode replacement fail closed without changing victims", async () => {
  for (const kind of ["symlink", "hardlink", "replacement"] as const) {
    const f = await fixture(), victim = path.join(f.root, "victim");
    if (kind === "symlink") await fs.writeFile(victim, "victim-stays", { mode: 0o600 });
    await assert.rejects(f.prepare({ hooks: { async afterCreate(actual) {
      const attempt = listTerminalEnvironmentLaunchAttempts(f.db, "t-one")[0]!, p = paths(f.dataDir, attempt);
      if (kind === "symlink" && actual === "directory") await fs.symlink(victim, p.payload);
      if (kind === "hardlink" && actual === "payload") await fs.link(p.payload, victim);
      if (kind === "replacement" && actual === "payload") {
        await fs.rename(p.payload, `${p.payload}-original`); await fs.writeFile(p.payload, "replacement-stays", { mode: 0o600 });
      }
    } } }));
    const attempt = listTerminalEnvironmentLaunchAttempts(f.db, "t-one")[0]!, p = paths(f.dataDir, attempt);
    assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "pending");
    if (kind === "symlink") assert.equal(await fs.readFile(victim, "utf8"), "victim-stays");
    if (kind === "hardlink") assert.equal(await fs.readFile(victim, "utf8"), "", "plaintext write never happened before durable identity");
    if (kind === "replacement") assert.equal(await fs.readFile(p.payload, "utf8"), "replacement-stays");
  }
});
test("permissions are checked, never repaired by chmod of an unknown root", async () => {
  const f = await fixture(), launchRoot = path.join(f.dataDir, TERMINAL_ENV_LAUNCH_ROOT);
  await fs.mkdir(launchRoot, { mode: 0o700 }); await fs.chmod(launchRoot, 0o777);
  await assert.rejects(f.prepare(), expectCode("TERMINAL_ENV_PROTOCOL_FAILED"));
  assert.equal((await fs.stat(launchRoot)).mode & 0o7777, 0o777);
  const attempt = listTerminalEnvironmentLaunchAttempts(f.db, "t-one")[0]!;
  assert.equal(attempt.directoryArmed, false); assert.equal(attempt.launchRoot, null);
});
test("data root/launch root replacements and parent symlinks stay pending, never delete relocated secrets", async () => {
  for (const kind of ["data", "root", "directory-symlink"] as const) {
    const f = await fixture(); const { attempt } = await f.prepare(), p = paths(f.dataDir, attempt);
    let retainedPayload = p.payload;
    if (kind === "data") {
      await fs.rename(f.dataDir, `${f.dataDir}-original`); await fs.mkdir(f.dataDir, { mode: 0o700 });
      retainedPayload = path.join(`${f.dataDir}-original`, TERMINAL_ENV_LAUNCH_ROOT, attempt.directoryName, "payload.json");
    } else if (kind === "root") {
      await fs.rename(p.root, `${p.root}-original`); await fs.mkdir(p.root, { mode: 0o700 });
      retainedPayload = path.join(`${p.root}-original`, attempt.directoryName, "payload.json");
    } else {
      await fs.rename(p.directory, `${p.directory}-original`); await fs.symlink(`${p.directory}-original`, p.directory);
      retainedPayload = path.join(`${p.directory}-original`, "payload.json");
    }
    assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "pending");
    assert.ok(await fs.stat(retainedPayload));
  }
});
test("mode, owner and hardlink changes after prepare invalidate handshake and cleanup authority", async () => {
  for (const kind of ["mode", "owner", "hardlink"] as const) {
    const f = await fixture(); const { attempt } = await f.prepare(), p = paths(f.dataDir, attempt);
    if (kind === "mode") await fs.chmod(p.status, 0o644);
    else if (kind === "owner") f.db.prepare("update terminal_env_launch_attempts set owner_uid=owner_uid+1 where id=?").run(attempt.id);
    else await fs.link(p.status, path.join(f.root, "status-hardlink"));
    const current = getTerminalEnvironmentLaunchAttempt(f.db, attempt.id)!;
    await assert.rejects(waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt: current, timeoutMs: 100 }), expectCode("TERMINAL_ENV_PROTOCOL_FAILED"));
    assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "pending");
    assert.ok(await fs.stat(p.status));
  }
});
test("narrow empty-directory helper requires exact scope/owner and does not delete descendants", async () => {
  const f = await fixture(); const parent = await openSecureRootDirectory(f.dataDir);
  try {
    await fs.mkdir(path.join(f.dataDir, "child"), { mode: 0o700 });
    const child = await openExistingSecureChildDirectory(parent, "child");
    const stat = await child.handle.stat(); await closeSecureDirectories(child);
    const retired = await retireSecureEntry({ parent, name: "child", expected: stat, kind: "directory", privateSlotScope: "ed-fixture" });
    assert.ok(retired);
    assert.equal(await removeRetiredEmptySecureDirectory(parent, retired, { scope: "wrong", ownerUid: process.getuid!() }), false);
    const victim = path.join(f.dataDir, retired.privateName, "victim"); await fs.writeFile(victim, "keep");
    assert.equal(await removeRetiredEmptySecureDirectory(parent, retired, { scope: "ed-fixture", ownerUid: process.getuid!() }), false);
    assert.equal(await fs.readFile(victim, "utf8"), "keep");
    await fs.unlink(victim);
    assert.equal(await removeRetiredEmptySecureDirectory(parent, retired, { scope: "ed-fixture", ownerUid: process.getuid!() }), true);
  } finally { await closeSecureDirectories(parent); }
});

test("compiled launcher uses dist JS with no tsx and still writes the same protocol", async (t) => {
  const distModule = fileURLToPath(new URL("../../../dist/modules/terminals/terminal-env-launch.js", import.meta.url));
  // Unit-only source runs need not build first. C1 verification separately builds and runs this test.
  if (!await fs.stat(distModule).then(() => true, () => false)) { t.skip("API dist not built"); return; }
  const compiled = await import(distModule) as { resolveTerminalEnvironmentLauncherCommand: (locator: TerminalEnvironmentLaunchLocator) => string[] };
  const f = await fixture(); const shell = await fakeShell(f.root, "exit 0"); const { attempt } = await f.prepare({ shell });
  const command = compiled.resolveTerminalEnvironmentLauncherCommand(terminalEnvironmentLaunchLocator(f.dataDir, attempt));
  assert.equal(command.includes("--import"), false); assert.equal(command.join(" ").includes("tsx"), false);
  assert.match(command[6]!, /terminal-env-launcher\.js$/);
  const launched = startLauncher(command, f.root);
  assert.equal((await waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt, timeoutMs: 4000, pollMs: 5 })).state, "spawned");
  assert.equal(await launched.exited, 0); assert.equal(launched.stderr(), "");
});

test("stop received while opening the snapshot prevents shell creation and a late success status", async () => {
  const f = await fixture(), marker = path.join(f.root, "must-not-spawn");
  const shell = await fakeShell(f.root, `printf yes > ${shQuote(marker)}`);
  const { attempt } = await f.prepare({ shell });
  const running = runTerminalEnvironmentLauncher(terminalEnvironmentLaunchLocator(f.dataDir, attempt));
  // Emit to this invocation's installed handler, not an OS signal to the test runner.
  process.emit("SIGTERM");
  assert.equal(await running, 143);
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
  assert.equal(JSON.parse(await fs.readFile(paths(f.dataDir, attempt).status, "utf8")).state, "pending");
});
test("a status write failure stops the owned shell and emits only a fixed diagnostic", async () => {
  const f = await fixture(); const shell = await fakeShell(f.root, "exec /bin/sleep 30");
  const { attempt } = await f.prepare({ shell });
  const originalOpen = fs.open, originalStderr = process.stderr.write;
  const messages: string[] = [];
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith("/status.json")) {
      handle.write = (async () => { throw new Error("fictional-private-error-argv-env"); }) as typeof handle.write;
    }
    return handle;
  }) as typeof fs.open;
  process.stderr.write = ((chunk: unknown) => { messages.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    assert.notEqual(await runTerminalEnvironmentLauncher(terminalEnvironmentLaunchLocator(f.dataDir, attempt)), 0);
    assert.deepEqual(messages, ["STATUS_WRITE_FAILED\n"]);
    await assert.rejects(waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt, timeoutMs: 25, pollMs: 2 }),
      expectCode("TERMINAL_ENV_START_TIMEOUT"));
  } finally { fs.open = originalOpen; process.stderr.write = originalStderr; }
});
test("stop has a five-second bound even when the owned target ignores HUP", async () => {
  const f = await fixture(), ready = path.join(f.root, "ready");
  const shell = await fakeShell(f.root, `trap '' HUP\nprintf ready > ${shQuote(ready)}\nwhile :; do :; done`);
  const prepared = await f.prepare({ shell }); const launch = startLauncher(prepared.command, f.root);
  await waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt: prepared.attempt, timeoutMs: 10_000, pollMs: 5 });
  const readyDeadline = Date.now() + 4000;
  while (!await fs.stat(ready).then(() => true, () => false) && Date.now() < readyDeadline) await delay(5);
  assert.ok(await fs.stat(ready));
  const started = Date.now(); launch.child.kill("SIGHUP");
  assert.equal(await launch.exited, 129);
  assert.ok(Date.now() - started >= 4500); assert.ok(Date.now() - started < 9000);
  assert.equal(launch.stderr(), "");
});
test("a FIFO status replacement fails promptly instead of blocking before regular-file validation", async () => {
  const f = await fixture(); const { attempt } = await f.prepare(), p = paths(f.dataDir, attempt);
  await fs.rename(p.status, path.join(f.root, "original-status"));
  execFileSync("/usr/bin/mkfifo", [p.status], { stdio: "ignore" });
  const started = Date.now();
  await assert.rejects(waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt, timeoutMs: 100 }), expectCode("TERMINAL_ENV_PROTOCOL_FAILED"));
  assert.ok(Date.now() - started < 1000);
  assert.ok((await fs.lstat(p.status)).isFIFO());
});
test("parent relocation in the create-before-locator window does not write plaintext outside its anchor", async () => {
  const f = await fixture(); let displacedPayload = "";
  await assert.rejects(f.prepare({ hooks: { async afterCreate(kind) {
    if (kind !== "payload") return;
    const attempt = listTerminalEnvironmentLaunchAttempts(f.db, "t-one")[0]!, p = paths(f.dataDir, attempt);
    const displaced = path.join(f.root, "displaced-launch-root");
    await fs.rename(p.root, displaced); await fs.mkdir(p.root, { mode: 0o700 });
    displacedPayload = path.join(displaced, attempt.directoryName, "payload.json");
  } } }), expectCode("TERMINAL_ENV_PREPARE_FAILED"));
  const attempt = listTerminalEnvironmentLaunchAttempts(f.db, "t-one")[0]!;
  assert.equal(await fs.readFile(displacedPayload, "utf8"), "");
  assert.equal(attempt.payload, null);
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "pending");
});
test("exact-scope truncated or legacy-format markers cannot be ignored when the original directory is missing", async () => {
  for (const format of [".delete-v1-", ".terminal-auth-cleanup-v1-"]) {
    const f = await fixture(); const { attempt } = await f.prepare(), p = paths(f.dataDir, attempt);
    await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped", hooks: {
      afterRetire({ kind }) { if (kind === "directory") throw new Error("fixture-crash"); }
    } });
    const originalSlot = (await fs.readdir(p.root))[0]!;
    const marker = `.delete-replacement-pending-${format}${terminalEnvironmentScopes(attempt.id).directory}`;
    await fs.rename(path.join(p.root, originalSlot), path.join(p.root, marker));
    assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "pending");
    assert.ok(await fs.stat(path.join(p.root, marker)));
  }
});
