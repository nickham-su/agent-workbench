import { deleteTerminal, settleTerminalAfterSessionStopped, reconcileWorkspaceActiveTerminals } from "./terminal.service.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { AppContext } from "../../app/context.js";
import type { FastifyBaseLogger } from "fastify";
import { initSchema } from "../../infra/db/schema.js";
import { HttpError } from "../../app/errors.js";
import {
  armTerminalRunControl, prepareTerminalRunControl, openTerminalRunControl, closeTerminalRunControl,
  claimTerminalRunStart, stopTerminalRunControl, getTerminalRunControl, markTerminalRunLaunching,
  cleanupTerminalRunControl, clearTerminalRunControl, writeTerminalRunStatus,
} from "./terminal-run-control.js";
import { TERMINAL_RUN_ROOT, assertTerminalRunLocator, assertTerminalRunMessage } from "./terminal-run-control.protocol.js";
import { runWorkspaceTerminalConfig } from "./terminal-config-run.service.js";
import { saveWorkspaceTerminalConfig } from "./terminal-config.service.js";
import { prepareTerminalEnvironmentLaunch } from "./terminal-env-launch.js";
import { listTerminalEnvironmentLaunchAttempts } from "./terminal-env-launch-attempt.store.js";
import { listVisibleTerminalsByWorkspace } from "./terminal.store.js";

const identity = "11111111-2222-3333-4444-555555555555:100";
const nextIdentity = "11111111-2222-3333-4444-555555555555:200";
const readIdentity = async () => identity;
const logger = { info() {}, warn() {} } as unknown as FastifyBaseLogger;
async function fixture() {
  const base = path.resolve(".tmp-tests"); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "run-control-"));
  const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); initSchema(db);
  db.prepare("insert into workspaces(id,dir_name,title,path,created_at,updated_at) values('ws','ws','fixture',?,1,1)").run(root);
  db.prepare("insert into terminals(id,workspace_id,session_name,status,created_at,updated_at) values('term_fixture','ws','term_fixture','active',1,1)").run();
  const ctx = { db, dataDir: root, repoRoot: root, credentialMasterKey: Buffer.alloc(32), credentialMasterKeyId: "fixture", agentInternalToken: "fixture" } as AppContext;
  const prepare = async (sessionName = "term_fixture") => {
    armTerminalRunControl(db, "term_fixture", sessionName);
    return prepareTerminalRunControl({ db, dataDir: root, terminalId: "term_fixture", sessionName, readIdentity });
  };
  const stop = (sessionName = "term_fixture") => stopTerminalRunControl({ db, dataDir: root, terminalId: "term_fixture", sessionName, timeoutMs: 45, readIdentity, hasSession: async () => "not_found" });
  return { ctx, db, root, prepare, stop, close: async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test("private non-secret run control is durable and pre-launch cancellation forbids a late spawn", async () => {
  const f = await fixture();
  try {
    const locator = await f.prepare(); assertTerminalRunLocator(locator);
    const dir = path.join(f.root, TERMINAL_RUN_ROOT, locator.runId);
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(dir, "request.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(dir, "status.json"))).mode & 0o777, 0o600);
    await f.stop(); assert.equal(getTerminalRunControl(f.db, "term_fixture")?.phase, "stopped");
    const control = await openTerminalRunControl(locator);
    try { assert.equal(await claimTerminalRunStart(control), false); } finally { await closeTerminalRunControl(control); }
    await cleanupTerminalRunControl(f.db, "term_fixture");
    await cleanupTerminalRunControl(f.db, "term_fixture");
    await f.stop(); // durable DB proof is still valid after files are gone
    clearTerminalRunControl(f.db, "term_fixture"); assert.equal(getTerminalRunControl(f.db, "term_fixture"), null);
  } finally { await f.close(); }
});

test("concurrent start-claim competitors still have exactly one winner", async () => {
  const f = await fixture();
  try {
    const locator = await f.prepare(), control = await openTerminalRunControl(locator);
    try {
      const winners = await Promise.all([claimTerminalRunStart(control), claimTerminalRunStart(control)]);
      assert.deepEqual(winners.sort(), [false, true]);
      assert.equal(await claimTerminalRunStart(control), false);
    } finally { await closeTerminalRunControl(control); }
  } finally { await f.close(); }
});

test("preparation failure is provably not launched without guessing process IDs", async () => {
  const f = await fixture();
  try {
    armTerminalRunControl(f.db, "term_fixture", "term_fixture");
    await f.stop();
    assert.equal(getTerminalRunControl(f.db, "term_fixture")?.phase, "stopped");
    await cleanupTerminalRunControl(f.db, "term_fixture");
  } finally { await f.close(); }
});

test("status creation EIO reclaims only this preparation's pinned directory and request", async (t) => {
  const f = await fixture(), open = fs.open.bind(fs);
  try {
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (path.basename(String(args[0])) === "status.json") throw Object.assign(new Error("injected status create failure"), { code: "EIO" });
      return open(...args);
    });
    await assert.rejects(f.prepare(), { code: "EIO" });
    assert.deepEqual(await fs.readdir(path.join(f.root, TERMINAL_RUN_ROOT)), []);
    const record = getTerminalRunControl(f.db, "term_fixture");
    assert.equal(record?.phase, "preparing"); assert.equal(record?.locator, null); assert.equal(record?.preparation, undefined);
    assert.throws(() => markTerminalRunLaunching(f.db, "term_fixture"));
    await f.stop(); await cleanupTerminalRunControl(f.db, "term_fixture");
    clearTerminalRunControl(f.db, "term_fixture");
    assert.equal(getTerminalRunControl(f.db, "term_fixture"), null);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("failed partial cleanup retains non-launchable identity authority and retries retired files", async (t) => {
  const f = await fixture(), open = fs.open.bind(fs), unlink = fs.unlink.bind(fs);
  try {
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (path.basename(String(args[0])) === "status.json") throw Object.assign(new Error("injected status create failure"), { code: "EIO" });
      return open(...args);
    });
    t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
      if (path.basename(String(args[0])).startsWith(".delete-v1-run-files-")) throw Object.assign(new Error("injected cleanup failure"), { code: "EIO" });
      return unlink(...args);
    });
    await assert.rejects(f.prepare(), { code: "TERMINAL_RUN_PREPARE_CLEANUP_PENDING" });
    const record = getTerminalRunControl(f.db, "term_fixture");
    assert.equal(record?.phase, "preparing"); assert.equal(record?.locator, null);
    assert.ok(record?.preparation?.request); assert.equal(record.preparation.status, null);
    assert.throws(() => assertTerminalRunLocator(record.preparation));
    const dir = path.join(f.root, TERMINAL_RUN_ROOT, record.preparation.runId);
    assert.match((await fs.readdir(dir))[0]!, /^\.delete-v1-run-files-/);
    assert.throws(() => markTerminalRunLaunching(f.db, "term_fixture"));
    await assert.rejects(f.stop(), { code: "TERMINAL_RUN_PREPARE_CLEANUP_PENDING" });
    clearTerminalRunControl(f.db, "term_fixture");
    assert.deepEqual(getTerminalRunControl(f.db, "term_fixture"), record);
    t.mock.restoreAll();
    await f.stop(); await cleanupTerminalRunControl(f.db, "term_fixture");
    assert.equal(getTerminalRunControl(f.db, "term_fixture")?.phase, "stopped");
    assert.deepEqual(await fs.readdir(path.join(f.root, TERMINAL_RUN_ROOT)), []);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("pre-existing request is not adopted, deleted, or authorized during preparation rollback", async (t) => {
  const f = await fixture(), open = fs.open.bind(fs);
  let request = "";
  try {
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (path.basename(String(args[0])) === "request.json") {
        request = path.join(await fs.realpath(path.dirname(String(args[0]))), "request.json");
        await fs.writeFile(request, "unknown request", { mode: 0o600, flag: "wx" });
      }
      return open(...args);
    });
    await assert.rejects(f.prepare(), { code: "TERMINAL_RUN_PREPARE_CLEANUP_PENDING" });
    t.mock.restoreAll();
    assert.equal(await fs.readFile(request, "utf8"), "unknown request");
    assert.equal(getTerminalRunControl(f.db, "term_fixture")?.preparation?.request, null);
    assert.throws(() => markTerminalRunLaunching(f.db, "term_fixture"));
    await assert.rejects(f.stop(), { code: "TERMINAL_RUN_PREPARE_CLEANUP_PENDING" });
    assert.equal(await fs.readFile(request, "utf8"), "unknown request");
    await fs.unlink(request); // Only the fixture removes its injected unknown object.
    await f.stop();
    assert.deepEqual(await fs.readdir(path.join(f.root, TERMINAL_RUN_ROOT)), []);
  } finally { t.mock.restoreAll(); await f.close(); }
});

for (const replacement of ["file", "symlink", "directory"] as const) {
  test(`status EIO with ${replacement} replacement preserves unknown objects and denies launch`, async (t) => {
    const f = await fixture(), open = fs.open.bind(fs);
    const sentinel = path.join(f.root, "sentinel"), original = path.join(f.root, "original");
    let directory = "";
    try {
      await fs.writeFile(sentinel, "preserve target", { mode: 0o600 });
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        if (path.basename(String(args[0])) === "status.json") {
          directory = await fs.realpath(path.dirname(String(args[0])));
          const request = path.join(directory, "request.json");
          if (replacement === "directory") {
            await fs.rename(directory, original);
            await fs.mkdir(directory, { mode: 0o700 });
            await fs.writeFile(path.join(directory, "unknown"), "preserve directory", { mode: 0o600 });
          } else {
            await fs.rename(request, original);
            if (replacement === "symlink") await fs.symlink(sentinel, request);
            else await fs.writeFile(request, "preserve replacement", { mode: 0o600 });
          }
          throw Object.assign(new Error("injected status create failure"), { code: "EIO" });
        }
        return open(...args);
      });
      await assert.rejects(f.prepare(), { code: "TERMINAL_RUN_PREPARE_CLEANUP_PENDING" });
      t.mock.restoreAll();
      const record = getTerminalRunControl(f.db, "term_fixture");
      assert.equal(record?.phase, "preparing"); assert.equal(record?.locator, null); assert.ok(record?.preparation?.request);
      assert.throws(() => markTerminalRunLaunching(f.db, "term_fixture"));
      await assert.rejects(f.stop(), { code: "TERMINAL_RUN_PREPARE_CLEANUP_PENDING" });
      assert.deepEqual(getTerminalRunControl(f.db, "term_fixture"), record);
      assert.equal(await fs.readFile(sentinel, "utf8"), "preserve target");
      if (replacement === "directory") {
        assert.equal(await fs.readFile(path.join(directory, "unknown"), "utf8"), "preserve directory");
        assert.ok((await fs.lstat(path.join(original, "request.json"))).isFile());
        await fs.unlink(path.join(directory, "unknown")); await fs.rmdir(directory);
        await fs.rename(original, directory);
      } else {
        const request = path.join(directory, "request.json");
        if (replacement === "symlink") assert.ok((await fs.lstat(request)).isSymbolicLink());
        else assert.equal(await fs.readFile(request, "utf8"), "preserve replacement");
        await fs.unlink(request); await fs.rename(original, request);
      }
      await f.stop();
      assert.deepEqual(await fs.readdir(path.join(f.root, TERMINAL_RUN_ROOT)), []);
    } finally { t.mock.restoreAll(); await f.close(); }
  });
}

test("missing launcher acknowledgement is unknown even if tmux is absent; no restart or cleanup", async () => {
  const f = await fixture();
  try {
    const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "fixture", cwd: ".", command: "node server.js" });
    f.db.prepare("update terminals set config_id = ? where id = 'term_fixture'").run(config.id);
    const locator = await f.prepare(), control = await openTerminalRunControl(locator);
    try { assert.equal(await claimTerminalRunStart(control), true); } finally { await closeTerminalRunControl(control); }
    markTerminalRunLaunching(f.db, "term_fixture");
    await prepareTerminalEnvironmentLaunch({ db: f.db, dataDir: f.root, terminalId: "term_fixture", shell: "bash", baseEnv: {}, systemEnv: {}, workspaceEnv: {}, startupCommand: "true" });
    let starts = 0, cleanups = 0;
    await assert.rejects(runWorkspaceTerminalConfig(f.ctx, logger, "ws", config.id, {
      readRunIdentity: readIdentity, preflightRunGuard: async () => {}, hasSession: async () => "not_found", killSession: async () => {}, newSession: async () => { starts++; }, cleanupAuthArtifacts: async () => { cleanups++; },
      stopRunControl: (params) => stopTerminalRunControl({ ...params, timeoutMs: 45 }),
    }), (error: unknown) => error instanceof HttpError && error.code === "TERMINAL_SESSION_STOP_UNCONFIRMED");
    assert.equal(starts, 0); assert.equal(cleanups, 0);
    assert.equal(listTerminalEnvironmentLaunchAttempts(f.db, "term_fixture").length, 1);
    assert.equal(listVisibleTerminalsByWorkspace(f.db, "ws")[0]?.id, "term_fixture");
    assert.equal(getTerminalRunControl(f.db, "term_fixture")?.phase, "launching");
    const operations = { readRunIdentity: readIdentity, hasSession: async () => "not_found" as const, killSession: async () => {}, cleanupAuthArtifacts: async () => { cleanups++; },
      stopRunControl: (params: Parameters<typeof stopTerminalRunControl>[0]) => stopTerminalRunControl({ ...params, timeoutMs: 45 }) };
    await assert.rejects(deleteTerminal(f.ctx, logger, "term_fixture", operations));
    assert.equal(await settleTerminalAfterSessionStopped(f.ctx, logger, "term_fixture", operations), "run_unknown");
    assert.equal(cleanups, 0); assert.equal(listTerminalEnvironmentLaunchAttempts(f.db, "term_fixture").length, 1);
  } finally { await f.close(); }
});

test("old generation stop and mismatched stopped responses cannot authorize the current generation", async () => {
  const f = await fixture();
  try {
    const locator = await f.prepare(), control = await openTerminalRunControl(locator);
    try {
      assert.equal(await claimTerminalRunStart(control), true);
      await assert.rejects(writeTerminalRunStatus(control, { version: 1, runId: "other", requestId: "old", state: "stopped" }));
    } finally { await closeTerminalRunControl(control); }
    await assert.rejects(f.stop("term_different"));
    await assert.rejects(f.stop());
    assert.equal(getTerminalRunControl(f.db, "term_fixture")?.phase, "prepared");
    assert.throws(() => assertTerminalRunMessage({ version: 1, runId: locator.runId, requestId: "x", action: "kill", pid: 1 }, locator.runId));
  } finally { await f.close(); }
});

test("run-control symlink/replacement is rejected without touching the target", async () => {
  const f = await fixture();
  try {
    const locator = await f.prepare();
    const sentinel = path.join(f.root, "sentinel"); await fs.writeFile(sentinel, "preserve", { mode: 0o600 });
    const status = path.join(f.root, TERMINAL_RUN_ROOT, locator.runId, "status.json");
    await fs.rename(status, `${status}.original`); await fs.symlink(sentinel, status);
    await assert.rejects(f.stop());
    assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
    assert.equal(getTerminalRunControl(f.db, "term_fixture")?.phase, "prepared");
  } finally { await f.close(); }
});

test("legacy configuration terminals reject automatic rerun rather than killing by guessed ownership", async () => {
  const f = await fixture();
  try {
    const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "legacy", cwd: ".", command: "true" });
    f.db.prepare("update terminals set config_id = ? where id = 'term_fixture'").run(config.id);
    let kills = 0, starts = 0;
    await assert.rejects(runWorkspaceTerminalConfig(f.ctx, logger, "ws", config.id, { preflightRunGuard: async () => {}, readRunIdentity: readIdentity, hasSession: async () => "exists", killSession: async () => { kills++; }, newSession: async () => { starts++; }, cleanupAuthArtifacts: async () => {} }),
      (error: unknown) => error instanceof HttpError && error.code === "TERMINAL_RUN_LEGACY");
    assert.equal(kills, 0); assert.equal(starts, 0);
    let present = true;
    await deleteTerminal(f.ctx, logger, "term_fixture", { hasSession: async () => present ? "exists" : "not_found", killSession: async () => { present = false; }, cleanupAuthArtifacts: async () => {} });
    assert.equal(listVisibleTerminalsByWorkspace(f.db, "ws").length, 0);
  } finally { await f.close(); }
});

async function launched(f: Awaited<ReturnType<typeof fixture>>, storedIdentity: string | null = identity) {
  const locator = await f.prepare(), control = await openTerminalRunControl(locator);
  try {
    assert.equal(await claimTerminalRunStart(control), true);
    await writeTerminalRunStatus(control, { version: 1, runId: locator.runId, requestId: "started", state: "running" });
  } finally { await closeTerminalRunControl(control); }
  markTerminalRunLaunching(f.db, "term_fixture");
  const stored = { ...locator };
  if (storedIdentity === null) delete stored.runtimeIdentity;
  else stored.runtimeIdentity = storedIdentity;
  f.db.prepare("update terminal_run_controls set locator_json = ? where terminal_id = 'term_fixture'").run(JSON.stringify(stored));
  return stored;
}

for (const legacy of [false, true]) {
  test(`${legacy ? "unidentified legacy" : "previous runtime"} run with absent tmux needs no launcher acknowledgement`, async () => {
    const f = await fixture();
    try {
      const locator = await launched(f, legacy ? null : nextIdentity);
      let probes = 0;
      await stopTerminalRunControl({ db: f.db, dataDir: f.root, terminalId: "term_fixture", sessionName: "term_fixture",
        readIdentity, hasSession: async () => { probes++; return "not_found"; }, timeoutMs: 0 });
      assert.equal(probes, 1);
      assert.equal(getTerminalRunControl(f.db, "term_fixture")?.phase, "stopped");
      // No stop request was sent to a launcher that cannot exist in this runtime.
      assert.equal(JSON.parse(await fs.readFile(path.join(f.root, TERMINAL_RUN_ROOT, locator.runId, "request.json"), "utf8")).action, "status");
      await cleanupTerminalRunControl(f.db, "term_fixture");
      assert.deepEqual(await fs.readdir(path.join(f.root, TERMINAL_RUN_ROOT)), []);
    } finally { await f.close(); }
  });
}

for (const scenario of ["same runtime", "session exists", "presence unknown", "identity unavailable", "legacy identity unavailable", "identity invalid"] as const) {
  test(`${scenario} never grants restart cleanup without a stopped proof`, async () => {
    const f = await fixture();
    try {
      await launched(f, scenario === "legacy identity unavailable" ? null : scenario === "same runtime" ? identity : nextIdentity);
      let probes = 0;
      await assert.rejects(stopTerminalRunControl({ db: f.db, dataDir: f.root, terminalId: "term_fixture", sessionName: "term_fixture", timeoutMs: 0,
        readIdentity: async () => {
          if (scenario.includes("identity unavailable")) throw new Error("unavailable");
          return scenario === "identity invalid" ? "invalid" : identity;
        },
        hasSession: async () => {
          probes++;
          if (scenario === "presence unknown") throw new Error("unknown");
          return "exists";
        },
      }), { code: "TERMINAL_SESSION_STOP_UNCONFIRMED" });
      assert.equal(probes, ["same runtime", "identity unavailable", "legacy identity unavailable", "identity invalid"].includes(scenario) ? 0 : 1);
      assert.equal(getTerminalRunControl(f.db, "term_fixture")?.phase, "launching");
      assert.equal((await fs.readdir(path.join(f.root, TERMINAL_RUN_ROOT))).length, 1);
    } finally { await f.close(); }
  });
}

test("new runs persist runtime identity and identity failure leaves only a non-launchable preparation", async () => {
  const f = await fixture();
  try {
    const locator = await f.prepare();
    assert.equal(locator.runtimeIdentity, identity);
    assert.equal(getTerminalRunControl(f.db, "term_fixture")?.locator?.runtimeIdentity, identity);
    await f.stop(); await cleanupTerminalRunControl(f.db, "term_fixture"); clearTerminalRunControl(f.db, "term_fixture");
    for (const read of [async () => { throw new Error("injected unavailable"); }, async () => "invalid"]) {
      armTerminalRunControl(f.db, "term_fixture", "term_fixture");
      await assert.rejects(prepareTerminalRunControl({ db: f.db, dataDir: f.root, terminalId: "term_fixture", sessionName: "term_fixture", readIdentity: read }));
      assert.equal(getTerminalRunControl(f.db, "term_fixture")?.locator, null);
      assert.throws(() => markTerminalRunLaunching(f.db, "term_fixture"));
      await stopTerminalRunControl({ db: f.db, dataDir: f.root, terminalId: "term_fixture", sessionName: "term_fixture", readIdentity: read });
      clearTerminalRunControl(f.db, "term_fixture");
    }
  } finally { await f.close(); }
});

test("DELETE recovers a previous runtime before its usual tmux probe and preserves the configuration", async () => {
  const f = await fixture();
  try {
    const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "fixture", cwd: ".", command: "true" });
    f.db.prepare("update terminals set config_id = ? where id = 'term_fixture'").run(config.id);
    await launched(f, nextIdentity);
    let probes = 0, kills = 0;
    await deleteTerminal(f.ctx, logger, "term_fixture", {
      readRunIdentity: readIdentity, hasSession: async () => { probes++; return "not_found"; },
      killSession: async () => { kills++; }, cleanupAuthArtifacts: async () => {},
      stopRunControl: (params) => stopTerminalRunControl({ ...params, timeoutMs: 0 }),
    });
    assert.ok(probes >= 2); assert.equal(kills, 0);
    assert.equal(listVisibleTerminalsByWorkspace(f.db, "ws").length, 0);
    assert.equal(f.db.prepare("select id from workspace_terminal_configs where id = ?").get(config.id) !== undefined, true);
  } finally { await f.close(); }
});

test("restart-authorized cleanup failure keeps durable stop authority and retries without another handshake", async () => {
  const f = await fixture();
  try {
    await launched(f, nextIdentity);
    let fail = true;
    const operations = {
      readRunIdentity: readIdentity, hasSession: async () => "not_found" as const,
      stopRunControl: (params: Parameters<typeof stopTerminalRunControl>[0]) => stopTerminalRunControl({ ...params, timeoutMs: 0 }),
      cleanupAuthArtifacts: async () => { if (fail) throw new Error("injected cleanup failure"); },
    };
    assert.equal(await settleTerminalAfterSessionStopped(f.ctx, logger, "term_fixture", operations), "cleanup_pending");
    assert.equal(getTerminalRunControl(f.db, "term_fixture")?.phase, "stopped");
    assert.equal((f.db.prepare("select status from terminals where id = 'term_fixture'").get() as { status: string }).status, "errored");
    fail = false;
    assert.equal(await settleTerminalAfterSessionStopped(f.ctx, logger, "term_fixture", operations), "closed");
  } finally { await f.close(); }
});

test("six missing sessions reconcile without six launcher timeout loops", async () => {
  const f = await fixture();
  try {
    await launched(f);
    for (let i = 1; i < 6; i++) {
      const id = `term_fixture_${i}`;
      f.db.prepare("insert into terminals(id,workspace_id,session_name,status,created_at,updated_at) values(?,'ws',?,'active',1,1)").run(id, id);
      armTerminalRunControl(f.db, id, id);
      const locator = await prepareTerminalRunControl({ db: f.db, dataDir: f.root, terminalId: id, sessionName: id, readIdentity });
      const control = await openTerminalRunControl(locator);
      try { assert.equal(await claimTerminalRunStart(control), true); } finally { await closeTerminalRunControl(control); }
      markTerminalRunLaunching(f.db, id);
    }
    await reconcileWorkspaceActiveTerminals(f.ctx, logger, "ws", {
      readRunIdentity: async () => nextIdentity, hasSession: async () => "not_found", cleanupAuthArtifacts: async () => {},
      // A zero polling budget makes this test fail if it falls back to awaiting the dead launcher.
      stopRunControl: (params) => stopTerminalRunControl({ ...params, timeoutMs: 0 }),
    });
    assert.deepEqual(f.db.prepare("select distinct status from terminals").all(), [{ status: "closed" }]);
    assert.deepEqual(f.db.prepare("select distinct phase from terminal_run_controls").all(), [{ phase: "stopped" }]);
    assert.deepEqual(await fs.readdir(path.join(f.root, TERMINAL_RUN_ROOT)), []);
  } finally { await f.close(); }
});

test("restart recovery uses a fresh probe instead of trusting GET's earlier absence", async () => {
  const f = await fixture();
  try {
    await launched(f, nextIdentity);
    let probes = 0, cleanups = 0;
    assert.equal(await settleTerminalAfterSessionStopped(f.ctx, logger, "term_fixture", {
      readRunIdentity: readIdentity,
      hasSession: async () => { if (++probes === 1) return "not_found"; throw new Error("presence changed to unknown"); },
      cleanupAuthArtifacts: async () => { cleanups++; },
      stopRunControl: (params) => stopTerminalRunControl({ ...params, timeoutMs: 0 }),
    }), "run_unknown");
    assert.equal(probes, 2); assert.equal(cleanups, 0);
    assert.equal(getTerminalRunControl(f.db, "term_fixture")?.phase, "launching");
  } finally { await f.close(); }
});

test("restart stop proof cannot overwrite a changed durable locator", async () => {
  const f = await fixture();
  try {
    const locator = await launched(f, nextIdentity);
    await assert.rejects(stopTerminalRunControl({ db: f.db, dataDir: f.root, terminalId: "term_fixture", sessionName: "term_fixture", readIdentity, timeoutMs: 0,
      hasSession: async () => {
        f.db.prepare("update terminal_run_controls set locator_json = ? where terminal_id = 'term_fixture'").run(JSON.stringify({ ...locator, runtimeIdentity: identity }));
        return "not_found";
      },
    }), { code: "TERMINAL_SESSION_STOP_UNCONFIRMED" });
    assert.equal(getTerminalRunControl(f.db, "term_fixture")?.phase, "launching");
  } finally { await f.close(); }
});

test("runtime identity is optional only for legacy locators and malformed values fail closed", async () => {
  const f = await fixture();
  try {
    const locator = await f.prepare();
    const { runtimeIdentity, ...legacy } = locator;
    assertTerminalRunLocator(legacy);
    for (const value of [undefined, null, "", "invalid", 123]) assert.throws(() => assertTerminalRunLocator({ ...legacy, runtimeIdentity: value }));
    assert.throws(() => assertTerminalRunLocator({ ...locator, extra: true }));
  } finally { await f.close(); }
});
