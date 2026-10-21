import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { initSchema } from "../../infra/db/schema.js";
import { registerTerminalConfigRoutes } from "./terminal-config.routes.js";
import { normalizeTerminalConfig, resolveTerminalConfigCwd, saveWorkspaceTerminalConfig, deleteWorkspaceTerminalConfig } from "./terminal-config.service.js";
import { runWorkspaceTerminalConfig } from "./terminal-config-run.service.js";
import { createTerminal, type TerminalRuntimeOperations } from "./terminal.service.js";
import { prepareTerminalEnvironmentLaunch, cleanupTerminalEnvironmentLaunch, terminalEnvironmentLaunchLocator, markTerminalEnvironmentLaunchStarting, waitTerminalEnvironmentLaunch } from "./terminal-env-launch.js";
import { getTerminalEnvironmentLaunchAttempt, listTerminalEnvironmentLaunchAttempts } from "./terminal-env-launch-attempt.store.js";
import { closeTerminalEnvironmentDirectories, openTerminalEnvironmentDirectories, openTerminalEnvironmentFile, writeTerminalEnvironmentStatus } from "./terminal-env-launch.files.js";
import { TERMINAL_ENV_LAUNCH_ROOT, type TerminalEnvironmentLaunchLocator } from "./terminal-env-launch.protocol.js";
import { runTerminalEnvironmentLauncher } from "./terminal-env-launcher.js";
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
  const sessions = new Set<string>(), starts: Array<{ sessionName: string; cwd: string; command: string[] }> = [];
  const operations: TerminalRuntimeOperations = {
    hasSession: async ({ sessionName }) => sessions.has(sessionName) ? "exists" : "not_found",
    killSession: async ({ sessionName }) => { sessions.delete(sessionName); },
    newSession: async (params) => {
      starts.push(params); sessions.add(params.sessionName);
      const locator = JSON.parse(params.command.at(-1)!) as TerminalEnvironmentLaunchLocator;
      const dirs = await openTerminalEnvironmentDirectories(locator);
      try {
        if (locator.bootstrap) {
          const bootstrap = await openTerminalEnvironmentFile({ directory: dirs.directory, name: TERMINAL_STARTUP_BOOTSTRAP_NAME, identity: locator.bootstrap, ownerUid: locator.ownerUid });
          try { assert.match(await bootstrap.readFile("utf8"), /builtin eval/); } finally { await bootstrap.close(); }
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
    cleanupAuthArtifacts: async () => {}
  };
  return { operations, starts };
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

test("every run creates a new independent terminal; edits/deletes never mutate existing terminals", async () => {
  const f = await fixture(), fake = runtime(), app = Fastify();
  const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "Dev", cwd: "", command: "printf '中文\\n'\ncat <<'EOF'\nhello\nEOF" });
  const first = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  const second = await runWorkspaceTerminalConfig(f.ctx, app.log, "ws", config.id, fake.operations);
  assert.notEqual(first.id, second.id); assert.equal(fake.starts.length, 2);
  assert.ok(fake.starts.every((start) => start.cwd === f.workspace && !start.command.join(" ").includes("printf")));
  assert.equal((f.db.prepare("select count(*) as n from terminal_env_launch_attempts").get() as { n: number }).n, 0);
  assert.equal((f.db.prepare("select count(*) as n from terminal_env_launch_bootstraps").get() as { n: number }).n, 0);
  await saveWorkspaceTerminalConfig(f.ctx, "ws", { command: "false" }, config.id);
  await deleteWorkspaceTerminalConfig(f.ctx, "ws", config.id);
  assert.equal((f.db.prepare("select count(*) as n from terminals where status = 'active'").get() as { n: number }).n, 2);
  assert.deepEqual(Object.keys(first).sort(), ["createdAt", "id", "sessionName", "status", "updatedAt", "workspaceId"].sort());
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
  f.db.prepare("insert into terminals values('term_fixture','ws','session','creating',1,1)").run();
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
  f.db.prepare("insert into terminals values('term_fixture','ws','session','creating',1,1)").run();
  const prepared = await prepareTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, terminalId: "term_fixture", shell: "bash", baseEnv: { PATH: bin, HOME: f.root }, systemEnv: {}, workspaceEnv: {}, startupCommand: "never-execute-this-command" });
  const observed = path.join(f.root, "observed.json"), allow = path.join(f.root, "allow"), finish = path.join(f.root, "finish");
  await fs.writeFile(path.join(bin, "bash"), `#!${process.execPath}
const fs = require('node:fs');
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
  f.db.prepare("insert into terminals values('term_fixture','ws','session','creating',1,1)").run();
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
  f.db.prepare("insert into terminals values('term_fixture','ws','session','creating',1,1)").run();
  await assert.rejects(prepareTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, terminalId: "term_fixture", shell: "bash", baseEnv: {}, systemEnv: {}, workspaceEnv: {}, startupCommand: "do-not-write-this-fixture", hooks: { afterCreate(kind) { if (kind === "bootstrap") throw new Error("fixture crash"); } } }));
  const attempt = listTerminalEnvironmentLaunchAttempts(f.db, "term_fixture")[0]!;
  assert.equal(attempt.bootstrapArmed, true); assert.equal(attempt.bootstrap, null);
  const filename = path.join(f.dataDir, TERMINAL_ENV_LAUNCH_ROOT, attempt.directoryName, TERMINAL_STARTUP_BOOTSTRAP_NAME);
  assert.equal(await fs.readFile(filename, "utf8"), "");
  assert.equal(await cleanupTerminalEnvironmentLaunch({ db: f.db, dataDir: f.dataDir, attemptId: attempt.id, consumption: "stopped" }), "pending");
});
