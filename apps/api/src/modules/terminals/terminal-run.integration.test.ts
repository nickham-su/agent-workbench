import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import type { FastifyBaseLogger } from "fastify";
import type { AppContext } from "../../app/context.js";
import { initSchema } from "../../infra/db/schema.js";
import { shQuote } from "../../infra/git/shQuote.js";
import { classifyTmuxHasSessionResult } from "../../infra/tmux/session.js";
import { saveWorkspaceTerminalConfig } from "./terminal-config.service.js";
import { runWorkspaceTerminalConfig } from "./terminal-config-run.service.js";
import { deleteTerminal, type TerminalRuntimeOperations } from "./terminal.service.js";
import { prepareTerminalEnvironmentLaunch } from "./terminal-env-launch.js";
import { getTerminalRunControl, stopTerminalRunControl, preflightTerminalRunGuard } from "./terminal-run-control.js";

const execFileAsync = promisify(execFile);
const logger = { info() {}, warn() {} } as unknown as FastifyBaseLogger;
async function until<T>(read: () => Promise<T>, valid: (value: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await read(); if (valid(value)) return value; } catch (error) { last = error; }
    await delay(35);
  }
  throw new Error(`isolated fixture did not converge${last ? " (read failed)" : ""}`);
}
async function portFree(port: number) {
  const server = net.createServer();
  return await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
async function httpGet(port: number, pathname = "/") {
  return await new Promise<string>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname, timeout: 700 }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { text += chunk; }); response.on("end", () => resolve(text));
    });
    request.on("error", reject); request.on("timeout", () => request.destroy(new Error("fixture timeout")));
  });
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function fixture() {
  await preflightTerminalRunGuard(); // Missing runtime support must fail, not silently pass.
  const base = path.resolve(".tmp-tests"); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "tr-"));
  const home = path.join(root, "home"), dataDir = path.join(root, "data"), workspace = path.join(root, "ws");
  for (const dir of [home, dataDir, workspace]) await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(home, ".bashrc"), "");
  const dbPath = path.join(root, "fixture.db");
  const db = new Database(dbPath); db.pragma("foreign_keys = ON"); initSchema(db);
  db.prepare("insert into workspaces(id,dir_name,title,path,created_at,updated_at) values('ws','ws','fixture',?,1,1)").run(workspace);
  const ctx = { db, dataDir, repoRoot: root, credentialMasterKey: Buffer.alloc(32), credentialMasterKeyId: "fixture", agentInternalToken: "fixture" } as AppContext;
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home, HISTFILE: path.join(home, ".bash_history"), TERM: "xterm-256color", LANG: "C.UTF-8" };
  const socket = path.join(root, "t.sock");
  const tmux = (args: string[]) => execFileAsync("/usr/bin/tmux", ["-S", socket, "-f", "/dev/null", ...args], { cwd: workspace, env, timeout: 5000 });
  const starts: string[] = [];
  const operations: TerminalRuntimeOperations = {
    hasSession: async ({ sessionName }) => {
      try { await tmux(["has-session", "-t", sessionName]); return "exists"; }
      catch (error) {
        const e = error as { code: number; stdout: string; stderr: string; killed: boolean };
        return classifyTmuxHasSessionResult({ ok: false, code: e.code, stdout: e.stdout, stderr: e.stderr, timedOut: e.killed });
      }
    },
    killSession: async ({ sessionName }) => { await tmux(["kill-session", "-t", sessionName]); },
    newSession: async ({ sessionName, cwd, command }) => {
      starts.push(sessionName);
      await tmux(["new-session", "-d", "-x", "100", "-y", "30", "-s", sessionName, "-c", cwd, ...command]);
    },
    cleanupAuthArtifacts: async () => {},
    prepareEnvironmentLaunch: (params) => prepareTerminalEnvironmentLaunch({ ...params, baseEnv: env }),
  };
  const info = path.join(workspace, "service.json"), events = path.join(workspace, "events.jsonl");
  await fs.writeFile(path.join(workspace, "service.cjs"), `
const fs = require('node:fs'), http = require('node:http');
const port = Number(process.argv[2]), mode = process.argv[3];
const server = http.createServer((req, res) => { res.end(String(process.pid)); if (req.url === '/fixture-stop') server.close(() => process.exit(0)); });
const event = (type) => fs.appendFileSync('events.jsonl', JSON.stringify({pid: process.pid,type})+'\\n');
if (mode === 'tree') { const cp = require('node:child_process'); cp.spawn(process.execPath, ['tree-parent.cjs'], {stdio:'ignore'}); cp.spawn(process.execPath, ['-e', 'process.exit(0)'], {stdio:'ignore'}); }
const stop = (sig) => { event(sig); if (mode === 'tree') { require('node:child_process').spawn(process.execPath, ['tree-leaf.cjs'], {stdio:'ignore'}); return; } if (mode === 'ignore') return; setTimeout(() => server.close(() => process.exit(0)), mode === 'delay' ? 350 : 0); };
process.on('SIGTERM', () => stop('TERM')); process.on('SIGINT', () => { server.close(() => process.exit(0)); });
server.listen(port, '127.0.0.1', () => { fs.writeFileSync('service.json', JSON.stringify({pid:process.pid,port:server.address().port})); event('listen'); });
setTimeout(() => process.exit(0), 25000); // safety net, even on a failed assertion
`);
  await fs.writeFile(path.join(workspace, "tree-leaf.cjs"), `
require('node:fs').appendFileSync('children.jsonl', String(process.pid)+'\\n');
process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 20000);
`);
  await fs.writeFile(path.join(workspace, "tree-parent.cjs"), `
require('node:child_process').spawn(process.execPath, ['tree-leaf.cjs'], {stdio:'ignore'});
process.exit(0);
`);
  const knownPorts = new Map<number, number>();
  const readInfo = async () => { const value = JSON.parse(await fs.readFile(info, "utf8")) as { pid: number; port: number }; knownPorts.set(value.port, value.pid); return value; };
  const close = async () => {
    for (const row of ctx.db.prepare("select id,session_name as sessionName from terminals").all() as Array<{id:string;sessionName:string}>) {
      await stopTerminalRunControl({ db: ctx.db, dataDir, terminalId: row.id, sessionName: row.sessionName }).catch(() => undefined);
    }
    await tmux(["kill-server"]).catch(() => undefined);
    for (const [port, pid] of knownPorts) {
      // Test-only service control, never infer process ownership from a port.
      try { if (await httpGet(port) === String(pid)) await httpGet(port, "/fixture-stop"); } catch { /* already stopped */ }
      await until(() => portFree(port), Boolean, 27000);
    }
    ctx.db.close();
    await fs.rm(root, { recursive: true, force: true });
  };
  return { ctx, dbPath, workspace, home, operations, starts, tmux, readInfo, events, close };
}

for (const mode of ["direct", "npm", "shells", "ignore", "delay"]) {
  test(`managed service releases the same port before repeated ${mode} restarts (actual tmux/launcher)`, { timeout: 45000 }, async () => {
    const f = await fixture();
    try {
      const command = async (port: number) => {
        const direct = `${shQuote(process.execPath)} service.cjs ${port} ${mode}`;
        if (mode === "npm") { await fs.writeFile(path.join(f.workspace, "package.json"), JSON.stringify({ scripts: { dev: direct } })); return "npm run dev"; }
        if (mode === "shells") return `sh -c ${shQuote(`sh -c ${shQuote(direct)}`)}`;
        return direct;
      };
      const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: mode, cwd: ".", command: await command(0) });
      let terminal = await runWorkspaceTerminalConfig(f.ctx, logger, "ws", config.id, f.operations);
      let service = await until(f.readInfo, (value) => alive(value.pid));
      const stableId = terminal.id, port = service.port;
      for (let iteration = 0; iteration < 2; iteration++) {
        await saveWorkspaceTerminalConfig(f.ctx, "ws", { command: await command(port) }, config.id);
        const oldPid = service.pid, oldSession = terminal.sessionName;
        terminal = await runWorkspaceTerminalConfig({ ...f.ctx }, logger, "ws", config.id, f.operations);
        assert.equal(terminal.id, stableId); assert.notEqual(terminal.sessionName, oldSession);
        assert.equal(alive(oldPid), false, "old service must be reaped BEFORE run returns");
        service = await until(f.readInfo, (value) => value.pid !== oldPid && value.port === port && alive(value.pid));
      }
      assert.equal(f.starts.length, 3);
      assert.equal(getTerminalRunControl(f.ctx.db, stableId)?.phase, "launching");
      if (mode === "delay") assert.match(await fs.readFile(f.events, "utf8"), /TERM/);
      await deleteTerminal(f.ctx, logger, stableId, f.operations);
      assert.equal(alive(service.pid), false); assert.equal(await portFree(port), true);
    } finally { await f.close(); }
  });
}

test("API/DB restart recovers live control; Ctrl+C, history, interaction and resize remain usable", { timeout: 35000 }, async () => {
  const f = await fixture();
  try {
    const command = `${shQuote(process.execPath)} service.cjs 0 direct`;
    const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "interactive", cwd: ".", command });
    const first = await runWorkspaceTerminalConfig(f.ctx, logger, "ws", config.id, f.operations);
    const service = await until(f.readInfo, (value) => alive(value.pid));
    await f.tmux(["send-keys", "-t", first.sessionName, "C-c"]);
    await until(async () => alive(service.pid), (value) => !value);
    await f.tmux(["send-keys", "-t", first.sessionName, "Up"]);
    await until(async () => (await f.tmux(["capture-pane", "-p", "-t", first.sessionName])).stdout, (value) => value.replaceAll("\n", "").includes(command));
    await f.tmux(["send-keys", "-t", first.sessionName, "C-c"]);
    await f.tmux(["resize-window", "-t", first.sessionName, "-x", "90", "-y", "31"]);
    await f.tmux(["send-keys", "-t", first.sessionName, "-l", "stty size > terminal-size"]);
    await f.tmux(["send-keys", "-t", first.sessionName, "Enter"]);
    await until(() => fs.readFile(path.join(f.workspace, "terminal-size"), "utf8"), (value) => value.trim() === "31 90");
    // New interactive jobs use a different Bash job-control PGID. The subreaper
    // must still own them, not only the bootstrap's original process group.
    await f.tmux(["send-keys", "-t", first.sessionName, "-l", command]);
    await f.tmux(["send-keys", "-t", first.sessionName, "Enter"]);
    const manual = await until(f.readInfo, (value) => value.pid !== service.pid && alive(value.pid));
    f.ctx.db.close();
    f.ctx.db = new Database(f.dbPath); f.ctx.db.pragma("foreign_keys = ON"); initSchema(f.ctx.db);
    const second = await runWorkspaceTerminalConfig({ ...f.ctx }, logger, "ws", config.id, f.operations);
    assert.equal(second.id, first.id); assert.equal(alive(manual.pid), false);
    await until(f.readInfo, (value) => value.pid !== manual.pid && alive(value.pid));
    await deleteTerminal(f.ctx, logger, second.id, f.operations);
  } finally { await f.close(); }
});


test("subreaper collects early-orphaned grandchildren and descendants forked during shutdown", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "tree", cwd: ".", command: `${shQuote(process.execPath)} service.cjs 0 tree` });
    const terminal = await runWorkspaceTerminalConfig(f.ctx, logger, "ws", config.id, f.operations);
    const service = await until(f.readInfo, (value) => alive(value.pid));
    const childFile = path.join(f.workspace, "children.jsonl");
    await until(() => fs.readFile(childFile, "utf8"), (value) => value.trim().length > 0);
    await deleteTerminal(f.ctx, logger, terminal.id, f.operations);
    const descendants = (await fs.readFile(childFile, "utf8")).trim().split("\n").map(Number);
    assert.ok(descendants.length >= 2, "one adopted child plus a new child from the TERM handler");
    for (const pid of [service.pid, ...descendants]) assert.equal(alive(pid), false, "all owned descendants must be reaped");
    assert.equal(await portFree(service.port), true);
  } finally { await f.close(); }
});

test("stopping one managed run never signals an independent service in another terminal", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const command = `${shQuote(process.execPath)} service.cjs 0 direct`;
    const a = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "A", cwd: ".", command });
    const b = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "B", cwd: ".", command });
    const first = await runWorkspaceTerminalConfig(f.ctx, logger, "ws", a.id, f.operations);
    const one = await until(f.readInfo, (value) => alive(value.pid));
    const second = await runWorkspaceTerminalConfig(f.ctx, logger, "ws", b.id, f.operations);
    const two = await until(f.readInfo, (value) => value.pid !== one.pid && alive(value.pid));
    await deleteTerminal(f.ctx, logger, first.id, f.operations);
    assert.equal(alive(one.pid), false); assert.equal(alive(two.pid), true);
    assert.equal(await httpGet(two.port), String(two.pid));
    await deleteTerminal(f.ctx, logger, second.id, f.operations);
    assert.equal(alive(two.pid), false);
  } finally { await f.close(); }
});

test("guard death is unknown, never stopped; API refuses a duplicate service", { timeout: 35000 }, async () => {
  const f = await fixture();
  try {
    const command = `${shQuote(process.execPath)} service.cjs 0 direct`;
    const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "guard-crash", cwd: ".", command });
    const first = await runWorkspaceTerminalConfig(f.ctx, logger, "ws", config.id, f.operations);
    const old = await until(f.readInfo, (value) => alive(value.pid));
    await f.tmux(["send-keys", "-t", first.sessionName, "C-c"]);
    await until(async () => alive(old.pid), (value) => !value);
    // This fixture's own Bash kills its live parent, not a persisted guessed PID.
    await f.tmux(["send-keys", "-t", first.sessionName, "-l", 'kill -KILL "$PPID"']);
    await f.tmux(["send-keys", "-t", first.sessionName, "Enter"]);
    const locator = getTerminalRunControl(f.ctx.db, first.id)!.locator!;
    await until(() => fs.readFile(path.join(f.ctx.dataDir, "terminal-runs", locator.runId, "status.json"), "utf8"), (text) => text.includes('"state":"unknown"'));
    await assert.rejects(runWorkspaceTerminalConfig(f.ctx, logger, "ws", config.id, f.operations));
    assert.equal(f.starts.length, 1); assert.equal(getTerminalRunControl(f.ctx.db, first.id)?.phase, "launching");
  } finally { await f.close(); }
});


test("launcher death retains unknown ownership even after guard cleans up its descendants", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const config = await saveWorkspaceTerminalConfig(f.ctx, "ws", { name: "launcher-crash", cwd: ".", command: `${shQuote(process.execPath)} service.cjs 0 direct` });
    const terminal = await runWorkspaceTerminalConfig(f.ctx, logger, "ws", config.id, f.operations);
    const service = await until(f.readInfo, (value) => alive(value.pid));
    const panePid = (await f.tmux(["display-message", "-p", "-t", terminal.sessionName, "#{pane_pid}"])).stdout.trim();
    assert.match(panePid, /^[1-9][0-9]*$/);
    // Target only the currently owned, isolated pane via a pidfd. This is a
    // fault injection, never the product's stop implementation.
    await execFileAsync("/usr/bin/python3", ["-I", "-S", "-c", "import os,signal,sys; fd=os.pidfd_open(int(sys.argv[1])); signal.pidfd_send_signal(fd,signal.SIGKILL); os.close(fd)", panePid], { env: {} });
    await until(async () => alive(service.pid), (value) => !value);
    await assert.rejects(runWorkspaceTerminalConfig(f.ctx, logger, "ws", config.id, { ...f.operations,
      stopRunControl: (params) => stopTerminalRunControl({ ...params, timeoutMs: 150 }),
    }));
    assert.equal(f.starts.length, 1); assert.equal(getTerminalRunControl(f.ctx.db, terminal.id)?.phase, "launching");
  } finally { await f.close(); }
});
