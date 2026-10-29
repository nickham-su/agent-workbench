import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";
import * as pty from "node-pty";
import Fastify from "fastify";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { initSchema } from "../../infra/db/schema.js";
import { registerTerminalsRoutes } from "./terminals.routes.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";
import { registerTerminalConfigRoutes } from "./terminal-config.routes.js";
import { normalizeTerminalConfig, resolveTerminalConfigCwd, saveWorkspaceTerminalConfig, deleteWorkspaceTerminalConfig, listWorkspaceTerminalConfigs, reorderWorkspaceTerminalConfigs } from "./terminal-config.service.js";
import { runWorkspaceTerminalConfig } from "./terminal-config-run.service.js";
import { createTerminal, deleteTerminal, reconcileWorkspaceTerminals, type TerminalRuntimeOperations } from "./terminal.service.js";
import { prepareTerminalEnvironmentLaunch, cleanupTerminalEnvironmentLaunch, terminalEnvironmentLaunchLocator, markTerminalEnvironmentLaunchStarting, waitTerminalEnvironmentLaunch } from "./terminal-env-launch.js";
import { getTerminalEnvironmentLaunchAttempt, listTerminalEnvironmentLaunchAttempts } from "./terminal-env-launch-attempt.store.js";
import { closeTerminalEnvironmentDirectories, openTerminalEnvironmentDirectories, openTerminalEnvironmentFile, writeTerminalEnvironmentStatus } from "./terminal-env-launch.files.js";
import { TERMINAL_ENV_LAUNCH_ROOT, type TerminalEnvironmentLaunchLocator } from "./terminal-env-launch.protocol.js";
import { runTerminalEnvironmentLauncher } from "./terminal-env-launcher.js";
import { getTerminal, getTerminalByConfig, listVisibleTerminalsByWorkspace } from "./terminal.store.js";
import { cleanupTerminalGitAuthArtifacts, terminalSshKeyPath } from "./terminal.gitAuth.js";
import { armTerminalAuthCleanupIntent, listTerminalAuthCleanupIntents, updateTerminalAuthCleanupIntent } from "./terminal-auth-cleanup-intent.store.js";
import { openTerminalRunControl, closeTerminalRunControl, claimTerminalRunStart, stopTerminalRunControl, getTerminalRunControl } from "./terminal-run-control.js";
import { buildTerminalStartupBootstrap, TERMINAL_STARTUP_BOOTSTRAP_NAME } from "./terminal-startup-bootstrap.js";

const fixtures: Array<{ root: string; db: Database.Database }> = [];
afterEach(async () => {
  for (const { root, db } of fixtures.splice(0)) { db.close(); await fs.rm(root, { recursive: true, force: true }); }
});
async function fixture() {
  const base = path.resolve(".tmp-tests/terminal-configs"); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "case-"));
  const dataDir = path.join(root, "data"), workspace = path.join(root, "workspace");
  await fs.mkdir(dataDir, { mode: 0o700 }); await fs.mkdir(workspace);
  const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); initSchema(db);
  fixtures.push({ root, db });
  for (const id of ["ws", "other"]) db.prepare("insert into workspaces(id,dir_name,title,path,created_at,updated_at) values(?,?,?,?,1,1)").run(id, id, id, workspace);
  const ctx = { db, dataDir, repoRoot: root, credentialMasterKey: Buffer.alloc(32, 7), credentialMasterKeyId: "fixture", agentInternalToken: "fixture" } as AppContext;
  return { ctx, db, root, workspace, dataDir };
}
function runtime(status: "spawned" | "missing" | "timeout" = "spawned") {
  const bootstraps: string[] = [];
  const sessions = new Set<string>(), starts: Array<{ sessionName: string; cwd: string; command: string[] }> = [];
  const operations: TerminalRuntimeOperations = {
    readRunIdentity: async () => "11111111-2222-3333-4444-555555555555:100",
    preflightRunGuard: async () => {},
    hasSession: async ({ sessionName }) => sessions.has(sessionName) ? "exists" : "not_found",
    killSession: async ({ sessionName }) => { sessions.delete(sessionName); },
    newSession: async (params) => {
      starts.push(params); sessions.add(params.sessionName);
      const locator = JSON.parse(params.command.at(-1)!) as TerminalEnvironmentLaunchLocator;
      const dirs = await openTerminalEnvironmentDirectories(locator);
      try {
        if (locator.bootstrap) {
          const bootstrap = await openTerminalEnvironmentFile({ directory: dirs.directory, name: TERMINAL_STARTUP_BOOTSTRAP_NAME, identity: locator.bootstrap, ownerUid: locator.ownerUid });
          try { const script = await bootstrap.readFile("utf8"); assert.match(script, /builtin eval/); bootstraps.push(script); } finally { await bootstrap.close(); }
        }
        const handle = await openTerminalEnvironmentFile({ directory: dirs.directory, name: "status.json", identity: locator.status, ownerUid: locator.ownerUid, writable: true });
        try {
          if (status !== "timeout") await writeTerminalEnvironmentStatus({ dirs, locator, handle, status: status === "missing"
            ? { version: 1, attemptId: locator.attemptId, state: "spawn-error", code: "SHELL_NOT_FOUND" }
            : { version: 1, attemptId: locator.attemptId, state: "spawned" } });
        } finally { await handle.close(); }
      } finally { await closeTerminalEnvironmentDirectories(dirs); }
    },
    waitEnvironmentLaunch: (params) => waitTerminalEnvironmentLaunch({ ...params, timeoutMs: 80, pollMs: 5 }),
    // Unit fixture simulates the owned supervisor's ECHILD proof, not tmux
    // disappearance. Real process semantics live in terminal-run.integration.
    stopRunControl: async ({ db, terminalId }) => { db.prepare("update terminal_run_controls set phase = 'stopped' where terminal_id = ?").run(terminalId); },
    cleanupAuthArtifacts: async () => {}
  };
  return { operations, starts, bootstraps };
}

test("configuration HTTP CRUD validates ownership and cascades with Workspace deletion", async () => {
  const f = await fixture(), app = Fastify();
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof HttpError ? error.statusCode : 400).send({ message: error instanceof Error ? error.message : "error" }));
  await registerTerminalConfigRoutes(app, f.ctx);
  try {
    const created = await app.inject({ method: "POST", url: "/api/workspaces/ws/terminal-configs", payload: { name: " Web ", cwd: "", command: "npm run dev" } });
    assert.equal(created.statusCode, 201); const config = created.json(); assert.equal(config.cwd, "."); assert.equal(config.name, "Web");
    assert.equal((await app.inject({ method: "GET", url: "/api/workspaces/ws/terminal-configs" })).json().length, 1);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/workspaces/other/terminal-configs/${config.id}`, payload: { name: "wrong" } })).statusCode, 404);
    const updated = await app.inject({ method: "PATCH", url: `/api/workspaces/ws/terminal-configs/${config.id}`, payload: { command: "npm test" } });
    assert.equal(updated.json().command, "npm test"); assert.equal(updated.json().name, "Web");
    assert.equal((await app.inject({ method: "POST", url: "/api/workspaces/ws/terminal-configs", payload: { name: " ", cwd: ".", command: "true" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/workspaces/other/terminal-configs/${config.id}` })).statusCode, 404);
    const second = await saveWorkspaceTerminalConfig(f.ctx, "other", { name: "Other", cwd: "", command: "true" });
    f.db.prepare("delete from workspaces where id = 'other'").run();
    assert.equal(f.db.prepare("select id from workspace_terminal_configs where id = ?").get(second.id), undefined);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/workspaces/ws/terminal-configs/${config.id}` })).statusCode, 204);
  } finally { await app.close(); }
});

test("relative cwd validation rejects invalid, missing, file and escaping symlink targets", async () => {
  const f = await fixture();
  assert.equal(normalizeTerminalConfig({ name: "a", cwd: "", command: "true" }).cwd, ".");
  for (const cwd of ["/tmp", "../x", "a/../../x", "C:\\x", "bad\0dir"]) assert.throws(() => normalizeTerminalConfig({ name: "a", cwd, command: "true" }));
  await fs.mkdir(path.join(f.workspace, "repo with spaces"));
  assert.equal(await resolveTerminalConfigCwd(f.workspace, "repo with spaces"), path.join(f.workspace, "repo with spaces"));
  await fs.writeFile(path.join(f.workspace, "file"), "fixture");
  await fs.symlink(f.root, path.join(f.workspace, "escape"));
  for (const cwd of ["missing", "file", "escape", "../"]) await assert.rejects(resolveTerminalConfigCwd(f.workspace, cwd), (error: unknown) => error instanceof HttpError && error.code === "TERMINAL_CONFIG_CWD_INVALID");
});

test("reruns keep the managed terminal identity and replace its physical session; deleting config unlinks it", async () => {
  const f = await fixture(), fake = runtime(), app = Fastify();
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: "", command: "printf '中文\\n'\ncat <<'EOF'\nhello\nEOF" });
  const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  const second = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  assert.equal(first.id, second.id); assert.notEqual(first.sessionName, second.sessionName);
  assert.equal(first.createdAt, second.createdAt); assert.equal(second.configId, config.id); assert.equal(fake.starts.length, 2);
  assert.ok(fake.starts.every((start) => start.cwd === f.workspace && !start.command.join(" ").includes("printf")));
  assert.equal((f.db.prepare("select count(*) as n from terminal_env_launch_attempts").get() as { n: number }).n, 0);
  assert.equal((f.db.prepare("select count(*) as n from terminal_env_launch_bootstraps").get() as { n: number }).n, 0);
  await saveWorkspaceTerminalConfig(f.ctx, "ws", { command: "printf latest-command-marker" }, config.id);
  const edited = await runWorkspaceTerminalConfig({ ...f.ctx }, app.log, "ws", config.id, fake.operations);
  assert.equal(edited.id, first.id); assert.match(fake.bootstraps.at(-1)!, /printf latest-command-marker/);
  await deleteWorkspaceTerminalConfig(f.ctx, "ws", config.id);
  assert.equal((f.db.prepare("select count(*) as n from terminals where status = 'active'").get() as { n: number }).n, 1);
  assert.equal(getTerminal(f.db, first.id)?.configId, null);
  assert.deepEqual(Object.keys(first).sort(), ["configId", "createdAt", "id", "sessionName", "status", "updatedAt", "workspaceId"].sort());
  await app.close();
});

test("configuration failures do not fall back to sh or retry after missing Bash or timeout", async () => {
  for (const status of ["missing", "timeout"] as const) {
    const f = await fixture(), fake = runtime(status), app = Fastify();
    const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "npm run dev" });
    await assert.rejects(runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations));
    assert.equal(fake.starts.length, 1);
    assert.equal((f.db.prepare("select count(*) as n from terminals where status = 'active'").get() as { n: number }).n, 0);
    await app.close();
  }
});

test("bootstrap encoding preserves original command and is acknowledged only after material consumption", async () => {
  const command = "printf '%s' \"中文 \\\\ $HOME\"\ncat <<'EOF'\n'quoted'\nEOF";
  const script = buildTerminalStartupBootstrap(command, "te_fixture");
  const assignment = script.slice(script.indexOf("__awb_terminal_startup_command=") + "__awb_terminal_startup_command=".length, script.indexOf("\nbuiltin printf"));
  assert.equal(assignment.slice(1, -1).replaceAll("'\\''", "'"), command);
  assert.ok(script.indexOf("builtin source") < script.indexOf("__awb_terminal_startup_command="));
  assert.ok(script.indexOf("__awb_terminal_startup_command=") < script.indexOf("builtin printf"));
  assert.ok(script.indexOf("builtin printf") < script.indexOf("builtin eval"));
  assert.doesNotMatch(script, /PROMPT_COMMAND=/);
  assert.throws(() => buildTerminalStartupBootstrap("bad\0command", "te_fixture"));
});

test("bootstrap artifact has durable identity, private mode, and participates in safe cleanup", async () => {
  const f = await fixture();
  f.db.prepare("insert into terminals (id,workspace_id,session_name,status,created_at,updated_at) values('term_fixture','ws','session','creating',1,1)").run();
  const prepared = await prepareTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, terminalId: "term_fixture", shell: "bash", baseEnv: {}, systemEnv: {}, workspaceEnv: {}, startupCommand: "echo fixture" });
  const locator = terminalEnvironmentLaunchLocator(f.dataDir, prepared.attempt);
  assert.ok(locator.bootstrap); assert.ok(getTerminalEnvironmentLaunchAttempt(f.db, prepared.attempt.id)?.bootstrapArmed);
  const filename = path.join(f.dataDir, TERMINAL_ENV_LAUNCH_ROOT, prepared.attempt.directoryName, TERMINAL_STARTUP_BOOTSTRAP_NAME);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  markTerminalEnvironmentLaunchStarting(f.db, prepared.attempt.id);
  await assert.rejects(waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt: prepared.attempt, timeoutMs: 20, pollMs: 5 }));
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: prepared.attempt.id, consumption: "stopped" }), "clean");
  await assert.rejects(fs.stat(filename));
  assert.equal(listTerminalEnvironmentLaunchAttempts(f.db, "term_fixture").length, 1);
});


test("configuration launcher waits for the Bash consumption acknowledgement, not process spawn (fake Bash, no tmux)", { timeout: 8000 }, async () => {
  const f = await fixture();
  const bin = path.join(f.root, "bin"); await fs.mkdir(bin);
  f.db.prepare("insert into terminals (id,workspace_id,session_name,status,created_at,updated_at) values('term_fixture','ws','session','creating',1,1)").run();
  const prepared = await prepareTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, terminalId: "term_fixture", shell: "bash", baseEnv: { PATH: bin, HOME: f.root }, systemEnv: {}, workspaceEnv: {}, startupCommand: "never-execute-this-command" });
  const observed = path.join(f.root, "observed.json"), allow = path.join(f.root, "allow"), finish = path.join(f.root, "finish");
  await fs.writeFile(path.join(bin, "bash"), `#!${process.execPath}
import fs from 'node:fs';
const source = fs.readFileSync(3, 'utf8');
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ regular: fs.fstatSync(3).isFile(), args: process.argv.slice(2), hasEval: source.includes('builtin eval') }));
let acknowledged = false;
const timer = setInterval(() => {
  if (!acknowledged && fs.existsSync(${JSON.stringify(allow)})) { fs.writeSync(4, ${JSON.stringify(prepared.attempt.id + "\n")}); fs.closeSync(4); acknowledged = true; }
  if (fs.existsSync(${JSON.stringify(finish)})) { clearInterval(timer); process.exit(0); }
}, 5);
setTimeout(() => process.exit(2), 3000);
`, { mode: 0o700 });
  const locator = terminalEnvironmentLaunchLocator(f.dataDir, prepared.attempt);
  const running = runTerminalEnvironmentLauncher(locator);
  try {
    const deadline = Date.now() + 2000;
    while (!(await fs.stat(observed).catch(() => null)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    const record = JSON.parse(await fs.readFile(observed, "utf8"));
    assert.equal(record.regular, true); assert.equal(record.hasEval, true);
    assert.deepEqual(record.args, ["--rcfile", "/dev/fd/3", "-i"]);
    await assert.rejects(waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt: prepared.attempt, timeoutMs: 30, pollMs: 5 }));
    await fs.writeFile(allow, "");
    assert.equal((await waitTerminalEnvironmentLaunch({ dataDir: f.dataDir, attempt: prepared.attempt, timeoutMs: 1000, pollMs: 5 })).state, "spawned");
    assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: prepared.attempt.id, consumption: "spawned" }), "clean");
  } finally { await fs.writeFile(finish, ""); }
  assert.equal(await running, 0);
});


test("configuration root cwd differs from the unchanged single-repository ordinary terminal default", async () => {
  const f = await fixture(), fake = runtime(), app = Fastify();
  const repo = path.join(f.workspace, "repo"); await fs.mkdir(repo);
  f.db.prepare("insert into repos(id,url,mirror_path,created_at,updated_at) values('r','fixture','fixture',1,1)").run();
  f.db.prepare("insert into workspace_repos values('ws','r','repo',?,1,1)").run(repo);
  await createTerminal(f.ctx, app.log, { workspaceId: "ws", runtimeOperations: fake.operations });
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Root", cwd: "", command: "true" });
  await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  assert.equal(fake.starts[0]!.cwd, repo);
  assert.equal(fake.starts[1]!.cwd, f.workspace);
  assert.equal(JSON.parse(fake.starts[0]!.command.at(-1)!).bootstrap, undefined);
  assert.ok(JSON.parse(fake.starts[1]!.command.at(-1)!).bootstrap);
  await app.close();
});

test("bootstrap replacement is rejected and never authorizes deleting another file", async () => {
  const f = await fixture();
  f.db.prepare("insert into terminals (id,workspace_id,session_name,status,created_at,updated_at) values('term_fixture','ws','session','creating',1,1)").run();
  const prepared = await prepareTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, terminalId: "term_fixture", shell: "bash", baseEnv: {}, systemEnv: {}, workspaceEnv: {}, startupCommand: "echo fixture" });
  const locator = terminalEnvironmentLaunchLocator(f.dataDir, prepared.attempt);
  const directory = path.join(f.dataDir, TERMINAL_ENV_LAUNCH_ROOT, prepared.attempt.directoryName);
  const bootstrap = path.join(directory, TERMINAL_STARTUP_BOOTSTRAP_NAME), victim = path.join(f.root, "victim");
  await fs.writeFile(victim, "unchanged", { mode: 0o600 });
  await fs.rename(bootstrap, path.join(f.root, "original-bootstrap"));
  await fs.symlink(victim, bootstrap);
  const dirs = await openTerminalEnvironmentDirectories(locator);
  try { await assert.rejects(openTerminalEnvironmentFile({ directory: dirs.directory, name: TERMINAL_STARTUP_BOOTSTRAP_NAME, identity: locator.bootstrap!, ownerUid: locator.ownerUid })); }
  finally { await closeTerminalEnvironmentDirectories(dirs); }
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: prepared.attempt.id, consumption: "stopped" }), "pending");
  assert.equal(await fs.readFile(victim, "utf8"), "unchanged");
  assert.equal(getTerminalEnvironmentLaunchAttempt(f.db, prepared.attempt.id)?.phase, "cleanup_pending");
});

test("unlocated bootstrap create window stays pending without adopting or writing a replacement", async () => {
  const f = await fixture();
  f.db.prepare("insert into terminals (id,workspace_id,session_name,status,created_at,updated_at) values('term_fixture','ws','session','creating',1,1)").run();
  await assert.rejects(prepareTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, terminalId: "term_fixture", shell: "bash", baseEnv: {}, systemEnv: {}, workspaceEnv: {}, startupCommand: "do-not-write-this-fixture", hooks: { afterCreate(kind) { if (kind === "bootstrap") throw new Error("fixture crash"); } } }));
  const attempt = listTerminalEnvironmentLaunchAttempts(f.db, "term_fixture")[0]!;
  assert.equal(attempt.bootstrapArmed, true); assert.equal(attempt.bootstrap, null);
  const filename = path.join(f.dataDir, TERMINAL_ENV_LAUNCH_ROOT, attempt.directoryName, TERMINAL_STARTUP_BOOTSTRAP_NAME);
  assert.equal(await fs.readFile(filename, "utf8"), "");
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "pending");
});


test("configuration order is persisted atomically and rejects stale or foreign collections", async () => {
  const f = await fixture(), app = Fastify();
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof HttpError ? error.statusCode : 400).send({ message: error instanceof Error ? error.message : "error" }));
  await registerTerminalConfigRoutes(app, f.ctx);
  try {
    const create = (workspaceId: string, name: string) => saveWorkspaceTerminalConfig(f.ctx, workspaceId, { name, cwd: ".", command: "true" });
    const a = await create("ws", "A"), b = await create("ws", "B"), foreign = await create("other", "Other");
    const order = async () => (await listWorkspaceTerminalConfigs(f.ctx, "ws")).map((item) => item.id);
    const put = (orderedIds: string[], workspaceId = "ws") => app.inject({ method: "PUT", url: `/api/workspaces/${workspaceId}/terminal-configs/order`, payload: { orderedIds } });
    assert.equal((await put([b.id, a.id])).statusCode, 204);
    assert.deepEqual(await order(), [b.id, a.id]);
    assert.equal((await put([a.id, a.id])).statusCode, 400);
    await assert.rejects(reorderWorkspaceTerminalConfigs(f.ctx, "ws", [a.id, a.id]), (error: unknown) => error instanceof HttpError && error.statusCode === 400);
    for (const ids of [[a.id], [a.id, foreign.id], [a.id, b.id, "missing"], ["missing", b.id]]) {
      assert.equal((await put(ids)).statusCode, 409);
      assert.deepEqual(await order(), [b.id, a.id]);
    }
    assert.equal((await put([], "missing")).statusCode, 404);
    assert.equal((await put([foreign.id], "other")).statusCode, 204);
    const c = await create("ws", "C");
    assert.deepEqual(await order(), [b.id, a.id, c.id]);
    assert.equal((await put([a.id, b.id])).statusCode, 409);
    await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "renamed" }, b.id);
    assert.deepEqual(await order(), [b.id, a.id, c.id]);
    assert.equal((await put([c.id, a.id, b.id])).statusCode, 204);
    assert.equal((await put([a.id, c.id, b.id])).statusCode, 204);
    assert.deepEqual(await order(), [a.id, c.id, b.id]);
    await deleteWorkspaceTerminalConfig(f.ctx, "ws", c.id);
    assert.equal((await put([a.id, c.id, b.id])).statusCode, 409);
    assert.deepEqual(await order(), [a.id, b.id]);
    assert.equal((f.db.prepare("select count(*) as count from terminals").get() as { count: number }).count, 0);
    // A failed write must roll back earlier row updates in the same batch.
    f.db.exec(`create trigger reject_config_order before update of sort_order on workspace_terminal_configs when new.id = '${a.id}' begin select raise(abort, 'fixture rejection'); end`);
    await assert.rejects(reorderWorkspaceTerminalConfigs(f.ctx, "ws", [b.id, a.id]));
    assert.deepEqual(await order(), [a.id, b.id]);
  } finally { await app.close(); }
});

test("legacy configuration table gains ordering without changing its existing order or data", async () => {
  const f = await fixture();
  f.db.exec(`drop table workspace_terminal_configs;
    create table workspace_terminal_configs (
      id text primary key, workspace_id text not null references workspaces(id) on delete cascade,
      name text not null, cwd text not null, command text not null,
      created_at integer not null, updated_at integer not null
    );
    insert into workspace_terminal_configs values ('z', 'ws', 'Z', '.', 'true', 1, 1), ('a', 'ws', 'A', '.', 'true', 1, 1), ('b', 'ws', 'B', '.', 'true', 2, 2);`);
  initSchema(f.db);
  initSchema(f.db);
  const list = () => listWorkspaceTerminalConfigs(f.ctx, "ws");
  assert.deepEqual((await list()).map((item) => item.id), ["a", "z", "b"]);
  assert.deepEqual(f.db.prepare("select distinct sort_order from workspace_terminal_configs").all(), [{ sort_order: 0 }]);
  const added = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "New", cwd: ".", command: "true" });
  assert.deepEqual((await list()).map((item) => item.id), ["a", "z", "b", added.id]);
  assert.equal((await list())[0].command, "true");
});

test("managed terminals remain independent and concurrent reruns use one durable ID", async () => {
  const f = await fixture(), fake = runtime(), app = Fastify();
  const one = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "One", cwd: ".", command: "true" });
  const two = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Two", cwd: ".", command: "true" });
  const [first, rerun] = await Promise.all([1, 2].map(() => runWorkspaceTerminalConfig(f.ctx, app.log, "ws", one.id, fake.operations)));
  assert.equal(first!.id, rerun!.id); assert.notEqual(first!.sessionName, rerun!.sessionName);
  const other = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", two.id, fake.operations);
  const plain = await createTerminal(f.ctx, app.log, { workspaceId: "ws", runtimeOperations: fake.operations });
  assert.notEqual(other.id, first!.id); assert.notEqual(plain.id, first!.id); assert.equal(plain.configId, null);
  assert.equal(getTerminalByConfig(f.db, "ws", one.id)?.id, first!.id);
  assert.equal(getTerminalByConfig(f.db, "other", one.id), null);
  await assert.rejects(runWorkspaceTerminalConfig(f.ctx, app.log, "other", one.id, fake.operations), (e: unknown) => e instanceof HttpError && e.statusCode === 404);
  assert.equal(fake.starts.length, 4);
  await deleteTerminal(f.ctx, app.log, first!.id, fake.operations);
  const recreated = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", one.id, fake.operations);
  assert.notEqual(recreated.id, first!.id);
  await app.close();
});

test("restart preflight failure leaves the current environment untouched", async () => {
  const f = await fixture(), fake = runtime(), app = Fastify();
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "true" });
  const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  await saveWorkspaceTerminalConfig(f.ctx, "ws", { cwd: "missing-directory" }, config.id);
  let stops = 0;
  await assert.rejects(runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, { ...fake.operations, killSession: async () => { stops++; } }));
  assert.equal(stops, 0); assert.equal(fake.starts.length, 1); assert.deepEqual(getTerminal(f.db, first.id), first);
  await app.close();
});

test("failed or unconfirmed stop never starts another environment or clears old recovery intent", async () => {
  for (const mode of ["kill-failure", "still-exists", "probe-failure"] as const) {
    const f = await fixture(), fake = runtime(), app = Fastify();
    const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "true" });
    const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
    const stat = await fs.lstat(f.ctx.dataDir);
    armTerminalAuthCleanupIntent(f.db, { terminalId: first.id, rootDev: stat.dev, rootIno: stat.ino, updatedAt: 1 });
    const intent = listTerminalAuthCleanupIntents(f.db, first.id);
    const operations = { ...fake.operations,
      hasSession: mode === "probe-failure" ? async () => { throw new Error("fixture probe failure"); } : fake.operations.hasSession,
      killSession: async () => { if (mode === "kill-failure") throw new Error("fixture kill failure"); },
    };
    await assert.rejects(runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, operations), (e: unknown) => e instanceof HttpError && e.code === "TERMINAL_SESSION_STOP_UNCONFIRMED");
    assert.equal(fake.starts.length, 1); assert.deepEqual(getTerminal(f.db, first.id), first);
    assert.deepEqual(listTerminalAuthCleanupIntents(f.db, first.id), intent);
    assert.equal(listVisibleTerminalsByWorkspace(f.db, "ws")[0]?.id, first.id);
    await app.close();
  }
});

test("pending cleanup blocks restart and preserves its recovery intent and visible tab", async () => {
  const f = await fixture(), fake = runtime(), app = Fastify();
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "true" });
  const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  const stat = await fs.lstat(f.ctx.dataDir);
  armTerminalAuthCleanupIntent(f.db, { terminalId: first.id, rootDev: stat.dev, rootIno: stat.ino, updatedAt: 1 });
  const intent = listTerminalAuthCleanupIntents(f.db, first.id);
  await assert.rejects(runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations), (e: unknown) => e instanceof HttpError && e.code === "TERMINAL_RESTART_CLEANUP_PENDING");
  assert.equal(fake.starts.length, 1); assert.equal(getTerminal(f.db, first.id)?.sessionName, first.sessionName);
  assert.deepEqual(listTerminalAuthCleanupIntents(f.db, first.id), intent);
  assert.equal(listVisibleTerminalsByWorkspace(f.db, "ws")[0]?.id, first.id);
  await app.close();
});

test("failed replacement launch keeps the managed tab and a retry reuses the same ID", async () => {
  const f = await fixture(), fake = runtime(), app = Fastify();
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "true" });
  const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  await assert.rejects(runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, { ...fake.operations, newSession: async () => { throw new Error("fixture launch failure"); } }));
  const failed = getTerminalByConfig(f.db, "ws", config.id)!;
  assert.equal(failed.id, first.id); assert.equal(failed.status, "closed");
  assert.equal(listVisibleTerminalsByWorkspace(f.db, "ws")[0]?.id, first.id);
  const next = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  assert.equal(next.id, first.id); assert.notEqual(next.sessionName, first.sessionName);
  assert.equal((f.db.prepare("select count(*) as n from terminals").get() as { n: number }).n, 1);
  f.db.prepare("update terminals set status = 'closed', config_id = null where id = ?").run(next.id);
  assert.deepEqual(listVisibleTerminalsByWorkspace(f.db, "ws"), []);
  await app.close();
});

test("legacy terminal schema migrates losslessly and enforces one terminal per config", async () => {
  const f = await fixture();
  f.db.exec(`drop table terminals; create table terminals (
    id text primary key, workspace_id text not null, session_name text not null,
    status text not null, created_at integer not null, updated_at integer not null
  ); insert into terminals values ('legacy', 'ws', 'legacy-session', 'active', 1, 2);`);
  initSchema(f.db); initSchema(f.db);
  assert.deepEqual(getTerminal(f.db, "legacy"), { id: "legacy", workspaceId: "ws", configId: null, sessionName: "legacy-session", status: "active", createdAt: 1, updatedAt: 2 });
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "true" });
  f.db.prepare("update terminals set config_id = ? where id = 'legacy'").run(config.id);
  assert.throws(() => f.db.prepare("insert into terminals(id,workspace_id,config_id,session_name,status,created_at,updated_at) values('duplicate','ws',?,'second','active',1,1)").run(config.id));
  await deleteWorkspaceTerminalConfig(f.ctx, "ws", config.id); assert.equal(getTerminal(f.db, "legacy")?.configId, null);
});

async function waitFor(check: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out: ${description}`);
}

test("real Bash recalls the raw startup command on first up-arrow after completion or Ctrl+C", async () => {
  for (const { command, interrupt } of [
    { command: "printf '%s\\n' 'normal-completion'", interrupt: false },
    { command: "false", interrupt: false },
    { command: "printf '%s\\n' 'running-marker'; sleep 30", interrupt: true },
    { command: "cat <<'EOF'\n中文 'quoted' \"double\" $literal\nEOF", interrupt: false },
  ]) {
    const f = await fixture(), home = path.join(f.root, "home"); await fs.mkdir(home);
    const capture = path.join(home, "capture"), histfile = path.join(home, ".bash_history"), inputrc = path.join(home, ".inputrc");
    await fs.writeFile(histfile, "old-existing-command\n"); await fs.writeFile(inputrc, "");
    await fs.writeFile(path.join(home, ".bashrc"), `PS1='AWB_READY> '\nPS2='AWB_MORE> '\nbind -x '\"\\C-x\\C-g\":printf \"%s\" \"$READLINE_LINE\" > \"$CAPTURE\"'\n`);
    const rc = path.join(home, "startup.bash");
    await fs.writeFile(rc, `exec 4>/dev/null 3</dev/null\n${buildTerminalStartupBootstrap(command, "te_history")}`);
    const child = pty.spawn("/bin/bash", ["--noprofile", "--rcfile", rc, "-i"], {
      name: "xterm", cols: 500, rows: 30, cwd: home,
      env: { HOME: home, HISTFILE: histfile, INPUTRC: inputrc, CAPTURE: capture, PATH: "/usr/bin:/bin", TERM: "xterm" },
    });
    let output = ""; const data = child.onData((chunk) => { output += chunk; });
    const exited = new Promise<void>((resolve) => { child.onExit(() => resolve()); });
    try {
      if (interrupt) { await waitFor(() => output.includes("running-marker"), "startup command entered"); child.write("\x03"); }
      await waitFor(() => output.includes("AWB_READY> "), "interactive prompt");
      child.write("\x1b[A\x18\x07");
      await waitFor(async () => { try { return (await fs.readFile(capture, "utf8")) === command; } catch { return false; } }, "first up-arrow recalls raw command");
      assert.equal(await fs.readFile(capture, "utf8"), command);
      assert.equal(await fs.readFile(histfile, "utf8"), "old-existing-command\n");
    } finally { child.kill(); await exited; data.dispose(); }
  }
});

test("terminal listing waits for restart, cleans closed records and keeps their configuration", async () => {
  const f = await fixture(), app = Fastify(), fake = runtime();
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "true" });
  const managed = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  f.db.prepare("update terminals set status = 'creating' where id = ?").run(managed.id);
  f.db.prepare("insert into terminals(id,workspace_id,session_name,status,created_at,updated_at) values('plain','ws','plain-session','closed',1,1)").run();
  const witness = path.join(f.workspace, "preserved.txt"); await fs.writeFile(witness, "workspace file");
  let release!: () => void, entered!: () => void;
  const gateEntered = new Promise<void>((resolve) => { entered = resolve; });
  const held = workspaceLifecycleCoordinator.withMutation("ws", async () => {
    entered(); await new Promise<void>((resolve) => { release = resolve; });
    f.db.prepare("update terminals set status = 'closed' where id = ?").run(managed.id);
  });
  await gateEntered;
  await registerTerminalsRoutes(app, f.ctx, { ...fake.operations, hasSession: async () => "not_found" });
  let returned = false;
  const listing = app.inject({ method: "GET", url: "/api/workspaces/ws/terminals" }).then((response) => { returned = true; return response; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(returned, false);
    release(); await held;
    const response = await listing; assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), []);
    assert.equal(getTerminal(f.db, managed.id), null); assert.equal(getTerminal(f.db, "plain"), null);
    assert.equal(getTerminalRunControl(f.db, managed.id), null);
    assert.equal((await listWorkspaceTerminalConfigs(f.ctx, "ws"))[0]?.id, config.id);
    assert.equal(await fs.readFile(witness, "utf8"), "workspace file");
  } finally { release(); await held; await app.close(); }
});

test("unconfirmed old environment cleanup blocks replacement without dropping launch material", async () => {
  const f = await fixture(), fake = runtime(), app = Fastify();
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "true" });
  const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  const pending = await prepareTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, terminalId: first.id, shell: "bash", baseEnv: {}, systemEnv: {}, workspaceEnv: {}, startupCommand: "true" });
  const before = getTerminalEnvironmentLaunchAttempt(f.db, pending.attempt.id);
  await assert.rejects(runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, {
    ...fake.operations, cleanupEnvironmentLaunch: async () => "pending",
  }), (e: unknown) => e instanceof HttpError && e.code === "TERMINAL_RESTART_CLEANUP_PENDING");
  assert.equal(fake.starts.length, 1);
  assert.deepEqual(getTerminalEnvironmentLaunchAttempt(f.db, pending.attempt.id), before);
  assert.equal(getTerminal(f.db, first.id)?.sessionName, first.sessionName);
  assert.equal(listVisibleTerminalsByWorkspace(f.db, "ws")[0]?.id, first.id);
  await app.close();
});

async function seedRecoverableAuthArtifact(f: Awaited<ReturnType<typeof fixture>>, terminalId: string) {
  const filename = terminalSshKeyPath(f.dataDir, terminalId);
  await fs.writeFile(filename, "fixture-auth-material", { mode: 0o600 });
  const root = await fs.lstat(f.dataDir), artifact = await fs.lstat(filename);
  armTerminalAuthCleanupIntent(f.db, {
    terminalId, artifactKind: "ssh-key", artifactName: path.basename(filename), rootDev: root.dev, rootIno: root.ino, updatedAt: 1,
  });
  updateTerminalAuthCleanupIntent(f.db, {
    terminalId, artifactKind: "ssh-key", artifactName: path.basename(filename), phase: "recoverable",
    expectedDev: artifact.dev, expectedIno: artifact.ino, diagnostic: "fixture recoverable artifact", updatedAt: 2,
  });
  return { filename, intents: listTerminalAuthCleanupIntents(f.db, terminalId) };
}

test("only explicit logical close detaches a managed tab with Git-only pending cleanup; restart keeps it", async () => {
  const f = await fixture(), fake = runtime(), app = Fastify();
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "true" });
  const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  const artifact = await seedRecoverableAuthArtifact(f, first.id);
  let cleanups = 0;
  const operations = { ...fake.operations, cleanupAuthArtifacts: async () => { cleanups++; throw new Error("fixture auth cleanup pending"); } };

  await assert.rejects(runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, operations),
    (e: unknown) => e instanceof HttpError && e.code === "TERMINAL_RESTART_CLEANUP_PENDING");
  assert.equal(cleanups, 1); assert.equal(fake.starts.length, 1);
  assert.equal(getTerminalByConfig(f.db, "ws", config.id)?.id, first.id);
  assert.equal(listVisibleTerminalsByWorkspace(f.db, "ws")[0]?.id, first.id);
  assert.deepEqual(listTerminalAuthCleanupIntents(f.db, first.id), artifact.intents);

  await assert.doesNotReject(deleteTerminal(f.ctx, app.log, first.id, operations));
  assert.equal(cleanups, 2);
  const retained = getTerminal(f.db, first.id)!;
  assert.equal(retained.status, "errored"); assert.equal(retained.configId, null);
  assert.equal(retained.sessionName, first.sessionName);
  assert.equal(getTerminalByConfig(f.db, "ws", config.id), null);
  assert.deepEqual(listVisibleTerminalsByWorkspace(f.db, "ws"), []);
  assert.deepEqual(listTerminalAuthCleanupIntents(f.db, first.id), artifact.intents);
  assert.equal(await fs.readFile(artifact.filename, "utf8"), "fixture-auth-material");

  const next = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  assert.notEqual(next.id, first.id); assert.equal(next.configId, config.id);
  assert.equal(getTerminalByConfig(f.db, "ws", config.id)?.id, next.id);
  assert.deepEqual(listVisibleTerminalsByWorkspace(f.db, "ws").map((term) => term.id), [next.id]);
  assert.equal(getTerminal(f.db, first.id)?.status, "errored");
  assert.deepEqual(listTerminalAuthCleanupIntents(f.db, first.id), artifact.intents);
  assert.equal(await fs.readFile(artifact.filename, "utf8"), "fixture-auth-material");
  await app.close();
});

test("explicit close with an unconfirmed stop never detaches its managed association", async () => {
  for (const mode of ["kill-failure", "still-exists", "probe-failure"] as const) {
    const f = await fixture(), fake = runtime(), app = Fastify();
    const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "true" });
    const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
    const artifact = await seedRecoverableAuthArtifact(f, first.id);
    const operations = { ...fake.operations,
      hasSession: mode === "probe-failure" ? async () => { throw new Error("fixture probe failure"); } : fake.operations.hasSession,
      killSession: async () => { if (mode === "kill-failure") throw new Error("fixture kill failure"); },
    };
    await assert.rejects(deleteTerminal(f.ctx, app.log, first.id, operations),
      (e: unknown) => e instanceof HttpError && e.code === "TERMINAL_SESSION_STOP_UNCONFIRMED");
    assert.deepEqual(getTerminal(f.db, first.id), first);
    assert.equal(getTerminalByConfig(f.db, "ws", config.id)?.id, first.id);
    assert.equal(listVisibleTerminalsByWorkspace(f.db, "ws")[0]?.id, first.id);
    assert.deepEqual(listTerminalAuthCleanupIntents(f.db, first.id), artifact.intents);
    assert.equal(await fs.readFile(artifact.filename, "utf8"), "fixture-auth-material");
    await app.close();
  }
});

test("explicit close with environment cleanup pending keeps its managed tab and all recovery locators", async () => {
  const f = await fixture(), fake = runtime(), app = Fastify();
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "true" });
  const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  const artifact = await seedRecoverableAuthArtifact(f, first.id);
  const pending = await prepareTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, terminalId: first.id, shell: "bash", baseEnv: {}, systemEnv: {}, workspaceEnv: {}, startupCommand: "true" });
  const attempt = getTerminalEnvironmentLaunchAttempt(f.db, pending.attempt.id);
  await assert.rejects(deleteTerminal(f.ctx, app.log, first.id, { ...fake.operations, cleanupEnvironmentLaunch: async () => "pending" }),
    (e: unknown) => e instanceof HttpError && e.code === "TERMINAL_ENV_CLEANUP_PENDING");
  assert.equal(getTerminalByConfig(f.db, "ws", config.id)?.id, first.id);
  assert.equal(listVisibleTerminalsByWorkspace(f.db, "ws")[0]?.id, first.id);
  assert.deepEqual(getTerminalEnvironmentLaunchAttempt(f.db, pending.attempt.id), attempt);
  assert.deepEqual(listTerminalAuthCleanupIntents(f.db, first.id), artifact.intents);
  assert.equal(await fs.readFile(artifact.filename, "utf8"), "fixture-auth-material");
  await app.close();
});

test("rerun after runtime restart uses the shared stop recovery and persists the new identity", async () => {
  const f = await fixture(), app = Fastify(), fake = runtime();
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "recover", cwd: ".", command: "true" });
  const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  const before = getTerminalRunControl(f.db, first.id)!;
  assert.equal(before.locator?.runtimeIdentity, "11111111-2222-3333-4444-555555555555:100");
  const control = await openTerminalRunControl(before.locator!);
  try { assert.equal(await claimTerminalRunStart(control), true); } finally { await closeTerminalRunControl(control); }
  const nextIdentity = "11111111-2222-3333-4444-555555555555:200";
  const rerun = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, {
    ...fake.operations,
    readRunIdentity: async () => nextIdentity,
    hasSession: async (params) => params.sessionName === first.sessionName ? "not_found" : fake.operations.hasSession(params),
    stopRunControl: (params) => stopTerminalRunControl({ ...params, timeoutMs: 0 }),
  });
  assert.equal(rerun.id, first.id); assert.notEqual(rerun.sessionName, first.sessionName);
  assert.equal(getTerminalRunControl(f.db, first.id)?.locator?.runtimeIdentity, nextIdentity);
  assert.equal(fake.starts.length, 2);
  assert.equal(listVisibleTerminalsByWorkspace(f.db, "ws").length, 1);
  await app.close();
});

test("unavailable runtime identity never authorizes a new managed process", async () => {
  const f = await fixture(), app = Fastify(), fake = runtime();
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "no-identity", cwd: ".", command: "true" });
  await assert.rejects(runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, {
    ...fake.operations, readRunIdentity: async () => { throw new HttpError(503, "Identity unavailable.", "TERMINAL_RUN_IDENTITY_UNAVAILABLE"); },
  }), (error: unknown) => error instanceof HttpError && error.code === "TERMINAL_RUN_IDENTITY_UNAVAILABLE");
  assert.equal(fake.starts.length, 0);
  assert.equal(listVisibleTerminalsByWorkspace(f.db, "ws")[0]?.status, "closed");
  assert.deepEqual(listTerminalEnvironmentLaunchAttempts(f.db, listVisibleTerminalsByWorkspace(f.db, "ws")[0]!.id), []);
  await app.close();
});

test("listing preserves managed Git cleanup intents and retries errored records before deleting", async () => {
  const f = await fixture(), fake = runtime(), app = Fastify();
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "true" });
  const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  const artifact = await seedRecoverableAuthArtifact(f, first.id);
  const operations = { ...fake.operations, hasSession: async () => "not_found" as const };
  await reconcileWorkspaceTerminals(f.ctx, app.log, "ws", {
    ...operations, cleanupAuthArtifacts: async () => { throw new Error("fixture auth cleanup pending"); },
  });
  assert.equal(getTerminal(f.db, first.id)?.status, "errored");
  assert.equal(getTerminalByConfig(f.db, "ws", config.id)?.id, first.id);
  assert.deepEqual(listTerminalAuthCleanupIntents(f.db, first.id), artifact.intents);
  assert.equal(await fs.readFile(artifact.filename, "utf8"), "fixture-auth-material");
  await reconcileWorkspaceTerminals(f.ctx, app.log, "ws", { ...operations, cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts });
  assert.equal(getTerminal(f.db, first.id), null); assert.equal(getTerminalRunControl(f.db, first.id), null);
  assert.deepEqual(listTerminalAuthCleanupIntents(f.db, first.id), []);
  await assert.rejects(fs.access(artifact.filename), { code: "ENOENT" });
  assert.equal((await listWorkspaceTerminalConfigs(f.ctx, "ws"))[0]?.id, config.id);
  await app.close();
});

for (const firstOperation of ["listing", "rerun"] as const) {
  test(`${firstOperation} before the other operation preserves the current run across the Workspace gate`, { timeout: 30_000 }, async () => {
    const f = await fixture(), fake = runtime(), app = Fastify();
    const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: ".", command: "true" });
    const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
    let entered!: () => void, release!: () => void;
    const arrived = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const listOperations = firstOperation === "listing" ? {
      ...fake.operations, hasSession: async (params: { sessionName: string; cwd: string }) => {
        if (params.sessionName === first.sessionName) { entered(); await proceed; return "not_found" as const; }
        return fake.operations.hasSession(params);
      },
    } : fake.operations;
    const runOperations = firstOperation === "rerun" ? {
      ...fake.operations, newSession: async (params: Parameters<TerminalRuntimeOperations["newSession"]>[0]) => {
        entered(); await proceed; await fake.operations.newSession(params);
      },
    } : fake.operations;
    await registerTerminalsRoutes(app, f.ctx, listOperations);
    const list = () => app.inject({ method: "GET", url: "/api/workspaces/ws/terminals" }).then((response) => response);
    const run = () => runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, runOperations);
    const earlier = firstOperation === "listing" ? list() : run();
    await arrived;
    const later = firstOperation === "listing" ? run() : list();
    try {
      release();
      const [earlyResult, lateResult] = await Promise.all([earlier, later]);
      const response = (firstOperation === "listing" ? earlyResult : lateResult) as Awaited<ReturnType<typeof list>>;
      const current = (firstOperation === "listing" ? lateResult : earlyResult) as Awaited<ReturnType<typeof run>>;
      assert.equal(response.statusCode, 200);
      assert.notEqual(current.sessionName, first.sessionName);
      assert.equal(getTerminalByConfig(f.db, "ws", config.id)?.id, current.id);
      if (firstOperation === "listing") {
        assert.deepEqual(response.json(), []); assert.notEqual(current.id, first.id);
        assert.equal(getTerminal(f.db, first.id), null); assert.equal(getTerminalRunControl(f.db, first.id), null);
      } else {
        assert.equal(current.id, first.id);
        assert.deepEqual(response.json().map((term: { sessionName: string }) => term.sessionName), [current.sessionName]);
      }
      const refreshed = await list();
      assert.deepEqual(refreshed.json().map((term: { id: string }) => term.id), [current.id]);
      assert.equal((await listWorkspaceTerminalConfigs(f.ctx, "ws"))[0]?.id, config.id);
    } finally { release(); await Promise.allSettled([earlier, later]); await app.close(); }
  });
}
