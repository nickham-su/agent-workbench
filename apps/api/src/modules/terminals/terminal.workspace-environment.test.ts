import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { openDb } from "../../infra/db/db.js";
import { workspaceRoot } from "../../infra/fs/paths.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";
import { insertWorkspace, getWorkspace } from "../workspaces/workspace.store.js";
import { deleteWorkspace } from "../workspaces/workspace.service.js";
import { getWorkspaceEnvironmentService } from "../workspaces/workspace-environment.service.js";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { createTerminal, deleteTerminal, reconcilePendingTerminals, reconcileWorkspaceActiveTerminals,
  settleTerminalAfterSessionStopped, getTerminalForAttachment, type TerminalRuntimeOperations } from "./terminal.service.js";
import { insertTerminal, getTerminal, listTerminalsByWorkspace, deleteTerminalRecord, updateTerminalStatus } from "./terminal.store.js";
import { prepareTerminalEnvironmentLaunch, cleanupTerminalEnvironmentLaunch } from "./terminal-env-launch.js";
import { listTerminalEnvironmentLaunchAttempts } from "./terminal-env-launch-attempt.store.js";
import { TerminalEnvironmentLaunchError, buildTerminalEnvironment, TERMINAL_ENV_LAUNCH_ROOT, TERMINAL_ENV_STATUS_NAME,
  type TerminalEnvironmentPayload, type TerminalEnvironmentLaunchLocator, type TerminalLaunchStatus } from "./terminal-env-launch.protocol.js";
import { openTerminalEnvironmentDirectories, closeTerminalEnvironmentDirectories,
  openTerminalEnvironmentFile, writeTerminalEnvironmentStatus } from "./terminal-env-launch.files.js";

const fixtures: Array<{ ctx: AppContext; workspaceId: string }> = [];
function logger() {
  const entries: unknown[] = [];
  const write = (...args: unknown[]) => { entries.push(args); };
  return { entries, log: { info: write, warn: write, error: write, debug: write, trace: write, fatal: write,
    child: () => logger().log } as unknown as FastifyBaseLogger };
}
async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "c2-"));
  const db = await openDb(dataDir);
  const now = Date.now();
  const workspaceId = `ws_c2_${path.basename(dataDir)}`;
  const dirName = `w_${path.basename(dataDir)}`;
  const workspacePath = workspaceRoot(dataDir, dirName);
  await fs.mkdir(workspacePath, { recursive: true });
  insertWorkspace(db, { id: workspaceId, dirName, path: workspacePath, title: "fixture", terminalCredentialId: null, createdAt: now, updatedAt: now });
  const ctx: AppContext = {
    db, dataDir, repoRoot: process.cwd(), fileMaxBytes: 1024 * 1024, version: "test", logLevel: "error", serveWeb: false, webDistDir: null,
    preview: { enabled: false, runtime: null }, credentialMasterKey: Buffer.alloc(32, 7), credentialMasterKeySource: "generated",
    credentialMasterKeyId: "fixture", credentialMasterKeyCreatedAt: now, authToken: null, authCookieSecure: false,
    agentWorkerEnabled: false, agentWorkerHost: "127.0.0.1", agentWorkerPort: 0, agentWorkerSocketPath: path.join(dataDir, "worker.sock"),
    agentWorkerConcurrency: 1, agentInternalToken: "fixture-control-token", agentWorkerResponseValidation: "strict",
    agentApiOrigin: "http://127.0.0.1:0", agentPluginHostEnabled: false, agentPluginHostSocketPath: path.join(dataDir, "plugin.sock"),
    agentPluginServicesEnabled: false,
  };
  const result = { ctx, workspaceId };
  fixtures.push(result);
  return result;
}
afterEach(async () => {
  for (const { ctx, workspaceId } of fixtures.splice(0)) {
    workspaceDeletingFence.end(workspaceId);
    ctx.db.close();
    await fs.rm(ctx.dataDir, { recursive: true, force: true });
  }
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function hasCode(code: string, status?: number) {
  return (error: unknown) => error instanceof HttpError && error.code === code && (status === undefined || error.statusCode === status);
}
async function publish(command: string[], state: "spawned" | "spawn-error" = "spawned", code?: "SHELL_NOT_FOUND" | "SHELL_SPAWN_FAILED" | "ENV_TOO_LARGE") {
  const locator = JSON.parse(command.at(-1)!) as TerminalEnvironmentLaunchLocator;
  const dirs = await openTerminalEnvironmentDirectories(locator);
  try {
    const handle = await openTerminalEnvironmentFile({ directory: dirs.directory, name: TERMINAL_ENV_STATUS_NAME,
      identity: locator.status, ownerUid: locator.ownerUid, writable: true });
    try {
      const status: TerminalLaunchStatus = state === "spawned" ? { version: 1, attemptId: locator.attemptId, state }
        : { version: 1, attemptId: locator.attemptId, state, code: code! };
      await writeTerminalEnvironmentStatus({ dirs, locator, handle, status });
    } finally { await handle.close(); }
  } finally { await closeTerminalEnvironmentDirectories(dirs); }
}
/** Explicit fake shell publisher, not an empty tmux call interpreted as a successful shell. */
function spawnedRuntime(options: {
  beforePublish?: (command: string[], index: number) => Promise<void>;
  status?: (index: number) => { state: "spawned" } | { state: "spawn-error"; code: "SHELL_NOT_FOUND" | "SHELL_SPAWN_FAILED" | "ENV_TOO_LARGE" };
} = {}) {
  const sessions = new Set<string>();
  const commands: string[][] = [], payloads: TerminalEnvironmentPayload[] = [], killed: string[] = [];
  const operations: TerminalRuntimeOperations = {
    hasSession: async ({ sessionName }) => sessions.has(sessionName) ? "exists" : "not_found",
    killSession: async ({ sessionName }) => { killed.push(sessionName); sessions.delete(sessionName); },
    prepareEnvironmentLaunch: async (params) => {
      const prepared = await prepareTerminalEnvironmentLaunch(params);
      payloads.push(JSON.parse(await fs.readFile(path.join(params.dataDir, TERMINAL_ENV_LAUNCH_ROOT, prepared.attempt.directoryName, "payload.json"), "utf8")));
      return prepared;
    },
    newSession: async ({ sessionName, command }) => {
      sessions.add(sessionName); commands.push(command);
      await options.beforePublish?.(command, commands.length - 1);
      const status = options.status?.(commands.length - 1) ?? { state: "spawned" };
      await publish(command, status.state, status.state === "spawn-error" ? status.code : undefined);
    },
    cleanupAuthArtifacts: async () => {},
  };
  return { operations, sessions, commands, payloads, killed };
}
async function pendingAttempt(f: Awaited<ReturnType<typeof fixture>>, id = "term_c2_pending") {
  const now = Date.now();
  insertTerminal(f.ctx.db, { id, workspaceId: f.workspaceId, sessionName: `tmux_${id}`, status: "errored", createdAt: now, updatedAt: now });
  return prepareTerminalEnvironmentLaunch({ db: f.ctx.db, dataDir: f.ctx.dataDir, terminalId: id, shell: "sh",
    workspaceEnv: { FIXTURE: "not-a-real-secret" }, systemEnv: {}, baseEnv: { PATH: "/usr/bin:/bin" } });
}

test("create injects literal Workspace snapshot via fixed argv, clears files and attempt before active", { timeout: 30_000 }, async () => {
  const f = await fixture(), runtime = spawnedRuntime(), log = logger();
  const inherited = { ...process.env };
  const service = getWorkspaceEnvironmentService(f.ctx);
  for (const [name, value] of Object.entries({ FIXTURE_VALUE: " ' $PATH $(never-run)\r\n ", HTTP_PROXY: "workspace-proxy", EMPTY: "", __fixture_unused: "ordinary" })) {
    await service.create(f.workspaceId, { name, value });
  }
  await service.create(f.workspaceId, { name: "__proto__", value: "own-property" });
  await service.create(f.workspaceId, { name: "DISABLED", value: "not-applied", enabled: false });
  const term = await createTerminal(f.ctx, log.log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations,
    buildNetworkEnvForTest: async () => ["HTTP_PROXY=system-proxy", "http_proxy=system-lower-proxy"] });
  assert.equal(term.status, "active");
  const payload = runtime.payloads[0]!;
  const env = buildTerminalEnvironment(payload, { TERM: "runtime-term", TMUX: "runtime-socket", TMUX_PANE: "%0", SERVER_ONLY: "stale" });
  assert.equal(env.FIXTURE_VALUE, " ' $PATH $(never-run)\r\n "); assert.equal(env.EMPTY, "");
  assert.equal(env.HTTP_PROXY, "workspace-proxy"); assert.equal(env.http_proxy, "system-lower-proxy");
  assert.equal(env.__proto__, "own-property"); assert.equal(Object.getPrototypeOf(env), null);
  assert.equal(env.DISABLED, undefined); assert.equal(env.SERVER_ONLY, undefined);
  assert.equal(env.TMUX, "runtime-socket");
  assert.ok(!Object.keys(env).some((key) => key.startsWith("AWB_")));
  assert.ok(!JSON.stringify(payload).includes(f.ctx.agentInternalToken));
  assert.ok(!JSON.stringify(runtime.commands).includes("workspace-proxy"));
  assert.ok(!JSON.stringify(runtime.commands).includes("never-run"));
  assert.equal(runtime.commands[0]?.[0], "/usr/bin/env");
  assert.ok(!runtime.commands[0]?.some((arg) => arg.startsWith("HTTP_PROXY=")));
  assert.deepEqual(listTerminalEnvironmentLaunchAttempts(f.ctx.db, term.id), []);
  assert.deepEqual(await fs.readdir(path.join(f.ctx.dataDir, TERMINAL_ENV_LAUNCH_ROOT)), []);
  assert.ok(!JSON.stringify(log.entries).includes("workspace-proxy"));
  assert.ok(Object.entries(inherited).every(([name, value]) => process.env[name] === value)
    && Object.keys(inherited).length === Object.keys(process.env).length, "API global environment was not modified");
});

test("default bash ENOENT falls back once with new attempt, old resources clean and original snapshots", { timeout: 30_000 }, async () => {
  const f = await fixture(), service = getWorkspaceEnvironmentService(f.ctx);
  const variable = await service.create(f.workspaceId, { name: "FIXTURE_VALUE", value: "before" });
  const runtime = spawnedRuntime({ status: (index) => index === 0 ? { state: "spawn-error", code: "SHELL_NOT_FOUND" } : { state: "spawned" } });
  const originalKill = runtime.operations.killSession;
  runtime.operations.killSession = async (request) => {
    await originalKill(request);
    // ALS-reentrant fixture callback commits through the real authority after the snapshot.
    await service.update(f.workspaceId, variable.id, { value: "after" });
  };
  const terminal = await createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations });
  assert.equal(terminal.status, "active"); assert.equal(runtime.commands.length, 2); assert.equal(runtime.killed.length, 1);
  assert.deepEqual(runtime.payloads.map((p) => p.shell), ["bash", "sh"]);
  assert.notEqual(runtime.payloads[0]?.attemptId, runtime.payloads[1]?.attemptId);
  assert.deepEqual(runtime.payloads.map((p) => p.workspaceEnv.FIXTURE_VALUE), ["before", "before"]);
  assert.deepEqual(runtime.payloads.map((p) => p.baseEnv), [runtime.payloads[0]?.baseEnv, runtime.payloads[0]?.baseEnv]);
  assert.deepEqual(listTerminalEnvironmentLaunchAttempts(f.ctx.db, terminal.id), []);
  await createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations });
  assert.equal(runtime.payloads[2]?.workspaceEnv.FIXTURE_VALUE, "after", "the next creation sees the committed value");
  assert.equal(runtime.payloads[0]?.workspaceEnv.FIXTURE_VALUE, "before", "existing snapshot stays unchanged");
});

for (const entry of [
  { title: "explicit shell ENOENT", shell: "bash", code: "SHELL_NOT_FOUND" as const, expected: "TERMINAL_ENV_SHELL_NOT_FOUND" },
  { title: "other spawn failure", code: "SHELL_SPAWN_FAILED" as const, expected: "TERMINAL_ENV_SPAWN_FAILED" },
  { title: "E2BIG", code: "ENV_TOO_LARGE" as const, expected: "TERMINAL_ENV_SPAWN_FAILED" },
  { title: "fallback ENOENT", code: "SHELL_NOT_FOUND" as const, expected: "TERMINAL_ENV_SHELL_NOT_FOUND", count: 2 },
]) {
  test(`${entry.title} fails safely without unbounded fallback`, { timeout: 30_000 }, async () => {
    const f = await fixture(), runtime = spawnedRuntime({ status: () => ({ state: "spawn-error", code: entry.code }) });
    await assert.rejects(() => createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, shell: entry.shell, runtimeOperations: runtime.operations }), hasCode(entry.expected, 500));
    assert.equal(runtime.commands.length, entry.count ?? 1);
    const term = listTerminalsByWorkspace(f.ctx.db, f.workspaceId)[0]!;
    assert.equal(term.status, "closed"); assert.deepEqual(listTerminalEnvironmentLaunchAttempts(f.ctx.db, term.id), []);
  });
}

test("new-session error with confirmed absence never guesses shell ENOENT or retries", { timeout: 30_000 }, async () => {
  const f = await fixture(), runtime = spawnedRuntime();
  runtime.operations.newSession = async ({ command }) => { runtime.commands.push(command); throw new Error("raw-argv-marker-not-for-client"); };
  await assert.rejects(() => createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations }), hasCode("TERMINAL_ENV_SPAWN_FAILED", 500));
  assert.equal(runtime.commands.length, 1);
  assert.equal(listTerminalsByWorkspace(f.ctx.db, f.workspaceId)[0]?.status, "closed");
});

test("spawned then exited is failure, not shell ENOENT fallback", { timeout: 30_000 }, async () => {
  const f = await fixture(), runtime = spawnedRuntime();
  const originalNew = runtime.operations.newSession;
  runtime.operations.newSession = async (request) => { await originalNew(request); runtime.sessions.delete(request.sessionName); };
  await assert.rejects(() => createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations }), hasCode("TERMINAL_ENV_SPAWN_FAILED", 500));
  assert.equal(runtime.commands.length, 1);
});

for (const mode of ["timeout", "protocol", "wrong-attempt", "pending"] as const) {
  test(`${mode} cannot activate or fall back; session is stopped before exact cleanup`, { timeout: 30_000 }, async () => {
    const f = await fixture(), runtime = spawnedRuntime();
    runtime.operations.waitEnvironmentLaunch = async ({ attempt }) => {
      if (mode === "wrong-attempt") return { version: 1, attemptId: "different-attempt", state: "spawned" };
      if (mode === "pending") return { version: 1, attemptId: attempt.id, state: "pending" } as never;
      throw new TerminalEnvironmentLaunchError(mode === "timeout" ? "TERMINAL_ENV_START_TIMEOUT" : "TERMINAL_ENV_PROTOCOL_FAILED");
    };
    await assert.rejects(() => createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations }), hasCode(mode === "timeout" ? "TERMINAL_ENV_START_TIMEOUT" : "TERMINAL_ENV_PROTOCOL_FAILED", 500));
    assert.equal(runtime.commands.length, 1); assert.equal(runtime.killed.length, 1);
    const term = listTerminalsByWorkspace(f.ctx.db, f.workspaceId)[0]!;
    assert.equal(term.status, "closed"); assert.equal(listTerminalEnvironmentLaunchAttempts(f.ctx.db, term.id).length, 0);
  });
}

for (const mode of ["kill-error", "kill-still-present", "probe-error"] as const) {
  test(`${mode} preserves files and durable attempt, no false active/closed or fallback`, { timeout: 30_000 }, async () => {
    const f = await fixture(), runtime = spawnedRuntime(), log = logger();
    runtime.operations.waitEnvironmentLaunch = async () => { throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_START_TIMEOUT"); };
    if (mode === "kill-error") runtime.operations.killSession = async () => { throw new Error("private-env-marker"); };
    if (mode === "kill-still-present") runtime.operations.killSession = async () => {};
    if (mode === "probe-error") runtime.operations.hasSession = async () => { throw new Error("private-env-marker"); };
    await assert.rejects(() => createTerminal(f.ctx, log.log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations }), hasCode("TERMINAL_ENV_CLEANUP_PENDING", 500));
    const term = listTerminalsByWorkspace(f.ctx.db, f.workspaceId)[0]!;
    assert.equal(term.status, "errored"); assert.equal(runtime.commands.length, 1);
    const attempt = listTerminalEnvironmentLaunchAttempts(f.ctx.db, term.id)[0]!;
    assert.ok(attempt); assert.equal(attempt.phase, "cleanup_pending"); assert.ok((await fs.stat(path.join(f.ctx.dataDir, TERMINAL_ENV_LAUNCH_ROOT, attempt.directoryName, "payload.json"))).size > 0);
    assert.ok(!JSON.stringify(log.entries).includes("private-env-marker"));
    await reconcilePendingTerminals(f.ctx, log.log, { ...runtime.operations, hasSession: async () => "not_found" });
    assert.equal(getTerminal(f.ctx.db, term.id)?.status, "closed");
    assert.deepEqual(listTerminalEnvironmentLaunchAttempts(f.ctx.db, term.id), []);
  });
}

test("activation failure after files consumed stops session, rolls back clear and settles", { timeout: 30_000 }, async () => {
  const f = await fixture(), runtime = spawnedRuntime();
  f.ctx.db.exec("create trigger reject_active before update of status on terminals when new.status='active' begin select raise(abort, 'raw-marker'); end");
  await assert.rejects(() => createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations }), hasCode("TERMINAL_ENV_PREPARE_FAILED", 500));
  const term = listTerminalsByWorkspace(f.ctx.db, f.workspaceId)[0]!;
  assert.equal(term.status, "closed"); assert.equal(runtime.killed.length, 1);
  assert.deepEqual(listTerminalEnvironmentLaunchAttempts(f.ctx.db, term.id), []);
});

test("prepare armed unknown-identity object cannot be claimed; terminal and Workspace deletion are blocked", { timeout: 30_000 }, async () => {
  const f = await fixture(), runtime = spawnedRuntime();
  runtime.operations.prepareEnvironmentLaunch = (params) => prepareTerminalEnvironmentLaunch({ ...params, hooks: { afterCreate: (kind) => { if (kind === "payload") throw new Error("crash before identity"); } } });
  await assert.rejects(() => createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations }), hasCode("TERMINAL_ENV_CLEANUP_PENDING", 500));
  assert.equal(runtime.commands.length, 0);
  const term = listTerminalsByWorkspace(f.ctx.db, f.workspaceId)[0]!;
  const attempt = listTerminalEnvironmentLaunchAttempts(f.ctx.db, term.id)[0]!;
  assert.equal(attempt.payload, null); assert.ok(attempt.payloadArmed);
  assert.equal((await fs.stat(path.join(f.ctx.dataDir, TERMINAL_ENV_LAUNCH_ROOT, attempt.directoryName, "payload.json"))).size, 0);
  await assert.rejects(() => deleteTerminal(f.ctx, logger().log, term.id, runtime.operations), hasCode("TERMINAL_ENV_CLEANUP_PENDING", 409));
  assert.throws(() => deleteTerminalRecord(f.ctx.db, term.id), /FOREIGN KEY/);
  await assert.rejects(() => deleteWorkspace(f.ctx, logger().log, f.workspaceId, runtime.operations), hasCode("TERMINAL_ENV_CLEANUP_PENDING", 409));
  assert.ok(getWorkspace(f.ctx.db, f.workspaceId)); assert.ok(workspaceDeletingFence.isDeleting(f.workspaceId));
});

for (const fault of ["arm", "identity", "launching", "clear"] as const) {
  test(`durable ${fault} write ignored by SQLite cannot authorize next side effect or false active`, { timeout: 30_000 }, async () => {
    const f = await fixture(), runtime = spawnedRuntime();
    const trigger = fault === "arm" ? "before insert on terminal_env_launch_attempts"
      : fault === "identity" ? "before update of payload_ino on terminal_env_launch_attempts when new.payload_ino is not null"
      : fault === "launching" ? "before update of phase on terminal_env_launch_attempts when new.phase='launching'"
      : "before delete on terminal_env_launch_attempts";
    f.ctx.db.exec(`create trigger ignore_env_write ${trigger} begin select raise(ignore); end`);
    await assert.rejects(() => createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations }));
    const term = listTerminalsByWorkspace(f.ctx.db, f.workspaceId)[0]!;
    assert.notEqual(term.status, "active");
    assert.equal(runtime.commands.length, fault === "clear" ? 1 : 0);
    if (fault === "identity") {
      const attempt = listTerminalEnvironmentLaunchAttempts(f.ctx.db, term.id)[0]!;
      assert.equal(attempt.payload, null);
      assert.equal((await fs.stat(path.join(f.ctx.dataDir, TERMINAL_ENV_LAUNCH_ROOT, attempt.directoryName, "payload.json"))).size, 0);
    }
    if (fault === "clear") {
      assert.equal(term.status, "errored"); assert.equal(listTerminalEnvironmentLaunchAttempts(f.ctx.db, term.id).length, 1);
      assert.equal(runtime.killed.length, 1);
    }
  });
}

test("Worker-ready pending scan during create waits whole gate, re-reads active and never kills it", { timeout: 30_000 }, async () => {
  const f = await fixture(), arrived = barrier(), proceed = barrier();
  const runtime = spawnedRuntime({ beforePublish: async () => { arrived.release(); await proceed.promise; } });
  const creating = createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations });
  await arrived.promise;
  let reconciled = false;
  const recovery = reconcilePendingTerminals(f.ctx, logger().log, runtime.operations).then(() => { reconciled = true; });
  await turn(); assert.equal(reconciled, false); assert.deepEqual(runtime.killed, []);
  proceed.release(); const active = await creating; await recovery;
  assert.equal(getTerminal(f.ctx.db, active.id)?.status, "active"); assert.deepEqual(runtime.killed, []);
});

test("delete overlaps create only after activation and holds same Workspace gate", { timeout: 30_000 }, async () => {
  const f = await fixture(), arrived = barrier(), proceed = barrier();
  const runtime = spawnedRuntime({ beforePublish: async () => { arrived.release(); await proceed.promise; } });
  const creating = createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations });
  await arrived.promise;
  const candidate = listTerminalsByWorkspace(f.ctx.db, f.workspaceId)[0]!;
  let deleted = false;
  const deleting = deleteTerminal(f.ctx, logger().log, candidate.id, runtime.operations).then(() => { deleted = true; });
  await turn(); assert.equal(deleted, false); assert.deepEqual(runtime.killed, []);
  proceed.release(); await creating; await deleting;
  assert.equal(getTerminal(f.ctx.db, candidate.id), null); assert.equal(runtime.killed.length, 1);
});

test("Workspace deletion cannot establish fence in creating handshake; then cleans under fence", { timeout: 30_000 }, async () => {
  const f = await fixture(), arrived = barrier(), proceed = barrier();
  const runtime = spawnedRuntime({ beforePublish: async () => { arrived.release(); await proceed.promise; } });
  const creating = createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations });
  await arrived.promise;
  const deleting = deleteWorkspace(f.ctx, logger().log, f.workspaceId, runtime.operations);
  await turn(); assert.equal(workspaceDeletingFence.isDeleting(f.workspaceId), false); assert.deepEqual(runtime.killed, []);
  proceed.release(); await creating; await deleting;
  assert.equal(getWorkspace(f.ctx.db, f.workspaceId), null); assert.equal(runtime.killed.length, 1);
});

test("pending reconcile, settle and delete remain admitted under deletion fence", { timeout: 30_000 }, async () => {
  const f = await fixture(), runtime = spawnedRuntime();
  const prepared = await pendingAttempt(f);
  workspaceDeletingFence.begin(f.workspaceId);
  await assert.rejects(() => createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations }), hasCode("WORKSPACE_DELETING", 409));
  await reconcilePendingTerminals(f.ctx, logger().log, runtime.operations);
  assert.equal(getTerminal(f.ctx.db, prepared.attempt.terminalId)?.status, "closed");
  await deleteTerminal(f.ctx, logger().log, prepared.attempt.terminalId, runtime.operations);
  assert.equal(getTerminal(f.ctx.db, prepared.attempt.terminalId), null);
  assert.ok(workspaceDeletingFence.isDeleting(f.workspaceId));
});

test("stale not_found from WS or old caller cannot settle an existing session", { timeout: 30_000 }, async () => {
  const f = await fixture(), runtime = spawnedRuntime();
  const term = await createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations });
  let probes = 0, cleanup = 0;
  const operations = { ...runtime.operations, hasSession: async () => ++probes === 1 ? "not_found" as const : "exists" as const,
    cleanupAuthArtifacts: async () => { cleanup++; } };
  const attached = await getTerminalForAttachment(f.ctx, logger().log, term.id, operations);
  assert.equal(attached.term.id, term.id); assert.equal(probes, 2); assert.equal(cleanup, 0);
  assert.equal(await settleTerminalAfterSessionStopped(f.ctx, logger().log, term.id, runtime.operations), "session_exists");
  assert.equal(getTerminal(f.ctx.db, term.id)?.status, "active");
});

test("WS candidate queued behind same gate re-reads status, and reconnect never reads config", { timeout: 30_000 }, async () => {
  const f = await fixture(), runtime = spawnedRuntime(), entered = barrier(), release = barrier();
  const term = await createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations });
  const hold = workspaceLifecycleCoordinator.withAdmission(f.workspaceId, async () => { entered.release(); await release.promise; updateTerminalStatus(f.ctx.db, term.id, "errored", Date.now()); });
  await entered.promise;
  const attaching = getTerminalForAttachment(f.ctx, logger().log, term.id, runtime.operations);
  const rejected = assert.rejects(attaching, (error: unknown) => error instanceof HttpError && error.statusCode === 410);
  release.release(); await hold; await rejected;
  updateTerminalStatus(f.ctx.db, term.id, "active", Date.now());
  const service = getWorkspaceEnvironmentService(f.ctx);
  service.readEnvironment = () => { throw new Error("must not reinject on reconnect"); };
  await getTerminalForAttachment(f.ctx, logger().log, term.id, runtime.operations);
});

test("ALS reentrant active reconcile processes same Workspace sequentially", { timeout: 30_000 }, async () => {
  const f = await fixture(), runtime = spawnedRuntime();
  await createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations });
  await createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations });
  let concurrent = 0, maximum = 0;
  const operations = { ...runtime.operations, hasSession: async () => {
    concurrent++; maximum = Math.max(maximum, concurrent); await turn(); concurrent--; return "not_found" as const;
  } };
  await workspaceLifecycleCoordinator.withAdmission(f.workspaceId, () => reconcileWorkspaceActiveTerminals(f.ctx, logger().log, f.workspaceId, operations));
  assert.equal(maximum, 1);
  assert.ok(listTerminalsByWorkspace(f.ctx.db, f.workspaceId).every((term) => term.status === "closed"));
});

test("different Workspace creation can progress while first holds handshake gate", { timeout: 30_000 }, async () => {
  const one = await fixture(), two = await fixture(), arrived = barrier(), proceed = barrier();
  const runtimeOne = spawnedRuntime({ beforePublish: async () => { arrived.release(); await proceed.promise; } });
  const creating = createTerminal(one.ctx, logger().log, { workspaceId: one.workspaceId, runtimeOperations: runtimeOne.operations });
  await arrived.promise;
  const activeTwo = await createTerminal(two.ctx, logger().log, { workspaceId: two.workspaceId, runtimeOperations: spawnedRuntime().operations });
  assert.equal(activeTwo.status, "active"); assert.equal(listTerminalsByWorkspace(one.ctx.db, one.workspaceId)[0]?.status, "creating");
  proceed.release(); await creating;
});

for (const kind of ["file", "directory"] as const) {
  test(`restart reconcile recovers ${kind} retired slot with business path missing`, { timeout: 30_000 }, async () => {
    const f = await fixture(), runtime = spawnedRuntime();
    const prepared = await pendingAttempt(f);
    const result = await cleanupTerminalEnvironmentLaunch({ db: f.ctx.db, dataDir: f.ctx.dataDir, attemptId: prepared.attempt.id, consumption: "stopped",
      hooks: { afterRetire: (entry) => { if (entry.kind === kind) throw new Error("simulated crash after rename"); } } });
    assert.equal(result, "pending");
    f.ctx.db.close(); f.ctx.db = await openDb(f.ctx.dataDir);
    await reconcilePendingTerminals(f.ctx, logger().log, runtime.operations);
    assert.equal(getTerminal(f.ctx.db, prepared.attempt.terminalId)?.status, "closed");
    assert.deepEqual(listTerminalEnvironmentLaunchAttempts(f.ctx.db, prepared.attempt.terminalId), []);
    assert.deepEqual(await fs.readdir(path.join(f.ctx.dataDir, TERMINAL_ENV_LAUNCH_ROOT)), []);
  });
}

test("Workspace aggregate delete converges env attempts before final FK transaction", { timeout: 30_000 }, async () => {
  const f = await fixture(), runtime = spawnedRuntime();
  const prepared = await pendingAttempt(f);
  await deleteWorkspace(f.ctx, logger().log, f.workspaceId, runtime.operations);
  assert.equal(getWorkspace(f.ctx.db, f.workspaceId), null);
  assert.equal(getTerminal(f.ctx.db, prepared.attempt.terminalId), null);
  assert.deepEqual(listTerminalEnvironmentLaunchAttempts(f.ctx.db, prepared.attempt.terminalId), []);
  assert.deepEqual(await fs.readdir(path.join(f.ctx.dataDir, TERMINAL_ENV_LAUNCH_ROOT)), []);
});

test("configuration read failure occurs before terminal record, Git prep or tmux", { timeout: 30_000 }, async () => {
  const f = await fixture(), runtime = spawnedRuntime();
  getWorkspaceEnvironmentService(f.ctx).readEnvironment = () => { throw new HttpError(503, "Unavailable", "WORKSPACE_ENV_UNAVAILABLE"); };
  let gitPrepared = false;
  await assert.rejects(() => createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations,
    buildNetworkEnvForTest: async () => { gitPrepared = true; return []; } }), hasCode("WORKSPACE_ENV_UNAVAILABLE", 503));
  assert.equal(gitPrepared, false); assert.equal(runtime.commands.length, 0); assert.deepEqual(listTerminalsByWorkspace(f.ctx.db, f.workspaceId), []);
});

for (const finalStatus of ["spawned", "SHELL_NOT_FOUND"] as const) {
  test(`${finalStatus} with unknown descendant stops session, never activates or falls back`, { timeout: 30_000 }, async () => {
    const f = await fixture();
    let witness = "";
    const runtime = spawnedRuntime({
      status: () => finalStatus === "spawned" ? { state: "spawned" } : { state: "spawn-error", code: "SHELL_NOT_FOUND" },
      beforePublish: async (command) => {
        const locator = JSON.parse(command.at(-1)!) as TerminalEnvironmentLaunchLocator;
        witness = path.join(locator.dataDir, TERMINAL_ENV_LAUNCH_ROOT, locator.directoryName, "unknown-fixture-child");
        await fs.writeFile(witness, "known-test-witness");
      },
    });
    await assert.rejects(() => createTerminal(f.ctx, logger().log, { workspaceId: f.workspaceId, runtimeOperations: runtime.operations }), hasCode("TERMINAL_ENV_CLEANUP_PENDING", 500));
    const term = listTerminalsByWorkspace(f.ctx.db, f.workspaceId)[0]!;
    assert.equal(term.status, "errored"); assert.equal(runtime.commands.length, 1); assert.equal(runtime.killed.length, 1);
    assert.equal(await fs.readFile(witness, "utf8"), "known-test-witness");
    assert.equal(listTerminalEnvironmentLaunchAttempts(f.ctx.db, term.id).length, 1);
    await assert.rejects(() => deleteTerminal(f.ctx, logger().log, term.id, runtime.operations), hasCode("TERMINAL_ENV_CLEANUP_PENDING", 409));
    // The fixture created this exact witness; production recovery must never claim/remove it.
    await fs.unlink(witness);
    await reconcilePendingTerminals(f.ctx, logger().log, runtime.operations);
    assert.equal(getTerminal(f.ctx.db, term.id)?.status, "closed");
    assert.deepEqual(listTerminalEnvironmentLaunchAttempts(f.ctx.db, term.id), []);
  });
}

test("active session absence also converges a residual env attempt before closed", { timeout: 30_000 }, async () => {
  const f = await fixture(), runtime = spawnedRuntime();
  const prepared = await pendingAttempt(f);
  updateTerminalStatus(f.ctx.db, prepared.attempt.terminalId, "active", Date.now());
  await reconcileWorkspaceActiveTerminals(f.ctx, logger().log, f.workspaceId, runtime.operations);
  assert.equal(getTerminal(f.ctx.db, prepared.attempt.terminalId)?.status, "closed");
  assert.deepEqual(listTerminalEnvironmentLaunchAttempts(f.ctx.db, prepared.attempt.terminalId), []);
});
