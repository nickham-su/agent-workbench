#!/usr/bin/env node
/**
 * Project-local, test-only terminal environment acceptance harness.
 * Never imports main.ts, loads dotenv, uses a default tmux socket or accepts credentials.
 * Normal mode serves an isolated UI until Ctrl+C; --verify exercises the same app then exits.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
export const FAULTS = ['file-retire-crash', 'directory-retire-crash', 'status-timeout', 'kill-failed'];
export function parseArguments(args) {
  const options = { mode: 'dist', port: 0, withWorker: false, verify: false, holdLaunchMs: 0, fault: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') options.help = true;
    else if (arg === '--with-worker') options.withWorker = true;
    else if (arg === '--verify') options.verify = true;
    else if (['--mode', '--port', '--hold-launch-ms', '--fault'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('HARNESS_INVALID_ARGUMENT');
      if (arg === '--mode') { if (!['source', 'dist'].includes(value)) throw new Error('HARNESS_INVALID_MODE'); options.mode = value; }
      if (arg === '--fault') { if (!FAULTS.includes(value)) throw new Error('HARNESS_INVALID_FAULT'); options.fault = value; }
      if (arg === '--port' || arg === '--hold-launch-ms') {
        const number = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0
          || number > (arg === '--port' ? 65535 : 30_000)) throw new Error('HARNESS_INVALID_NUMBER');
        options[arg === '--port' ? 'port' : 'holdLaunchMs'] = number;
      }
    } else throw new Error('HARNESS_UNKNOWN_ARGUMENT');
  }
  return options;
}
export function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
export function assertProjectChild(filename, root = repoRoot) {
  const relative = path.relative(root, path.resolve(filename));
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('HARNESS_PATH_BOUNDARY');
  return path.resolve(filename);
}
async function availablePort(requested = 0) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requested, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: process.env, cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('HARNESS_COMMAND_TIMEOUT')); }, 20_000);
    child.on('error', () => finish(new Error('HARNESS_COMMAND_SPAWN_FAILED')));
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('HARNESS_OUTPUT_LIMIT')); } });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('HARNESS_OUTPUT_LIMIT')); } });
    child.on('close', (code) => finish(null, { code, stdout, stderr }));
    child.stdin.on('error', () => { if (options.input) finish(new Error('HARNESS_COMMAND_INPUT_FAILED')); });
    if (options.input === undefined) child.stdin.end(); else child.stdin.end(options.input);
  });
}
async function main(options) {
  if (options.mode === 'dist' && process.execArgv.some((arg) => /tsx|--import|--loader|--require|--env-file/.test(arg))) throw new Error('HARNESS_DIST_LOADER_FORBIDDEN');
  const controlledPath = [...new Set([path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'])].join(path.delimiter);
  const foundTmux = spawnSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8', env: { PATH: controlledPath } });
  const realTmux = foundTmux.stdout?.trim();
  if (foundTmux.status !== 0 || !path.isAbsolute(realTmux ?? '')) throw new Error('HARNESS_TMUX_MISSING');
  // Reject an occupied explicit port before creating an app/Worker or any test data.
  const port = await availablePort(options.port);
  let workerPort = await availablePort();
  while (workerPort === port) workerPort = await availablePort();
  const tmpParent = path.join(repoRoot, '.tmp-tests');
  await fs.mkdir(tmpParent, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(tmpParent)).isSymbolicLink()) throw new Error('HARNESS_TMP_SYMLINK');
  const root = await fs.mkdtemp(path.join(tmpParent, 'te-'));
  await fs.chmod(root, 0o700);
  assertProjectChild(root);
  const rootIdentity = await fs.lstat(root, { bigint: true });
  const home = path.join(root, 'home'), dataDir = path.join(root, 'data'), bin = path.join(root, 'bin'), tmp = path.join(root, 'tmp');
  for (const directory of [home, dataDir, bin, tmp]) await fs.mkdir(directory, { mode: 0o700 });
  const socket = assertProjectChild(path.join(root, 'tmux.sock'), root);
  if (Buffer.byteLength(socket) >= 100) throw new Error('HARNESS_SOCKET_PATH_TOO_LONG');
  const shell = path.join(bin, 'test-shell');
  const wrapper = path.join(bin, 'tmux');
  const tmuxConfig = path.join(root, 'tmux.conf');
  await fs.writeFile(tmuxConfig, '# Isolated acceptance fixture; no host tmux config.\n', { mode: 0o600, flag: 'wx' });
  const expectedWrapper = `#!/bin/sh\nexec ${shellQuote(realTmux)} -f ${shellQuote(tmuxConfig)} -S ${shellQuote(socket)} "$@"\n`;
  await fs.writeFile(wrapper, expectedWrapper, { mode: 0o700, flag: 'wx' });
  await fs.writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n', { mode: 0o700, flag: 'wx' });
  await fs.writeFile(path.join(bin, 'bash'), '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o700, flag: 'wx' });
  const wrapperIdentity = await fs.lstat(wrapper, { bigint: true });
  // Deliberately do not inherit AWB, NODE_*, npm lifecycle/dev flags, proxy or profile settings.
  const safeEnv = { PATH: `${bin}:${controlledPath}`, HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', TERM: 'xterm-256color', SHELL: shell,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    ENV_FIXTURE_VALUE: 'system-base-fixture', AWB_ENV_FIXTURE_CONTROL: 'must-be-filtered' };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, safeEnv);
  process.chdir(repoRoot);
  const source = options.mode === 'source';
  const apiBase = path.join(repoRoot, 'apps/api', source ? 'src' : 'dist');
  const workerEntry = path.join(repoRoot, 'apps/agent-worker/dist/main.js');
  for (const filename of [path.join(apiBase, `app/createApp.${source ? 'ts' : 'js'}`), path.join(repoRoot, 'apps/web/dist/index.html'),
    ...(options.withWorker ? [workerEntry] : [])]) await fs.access(filename);
  if (source) { const { register } = await import('tsx/esm/api'); register(); }
  const load = (relative) => import(pathToFileURL(path.join(apiBase, `${relative}.${source ? 'ts' : 'js'}`)).href);
  const [{ createApp }, { openDb }, workspaceStore, terminalService, tmux, launch, protocol, auth, terminalStore] = await Promise.all([
    load('app/createApp'), load('infra/db/db'), load('modules/workspaces/workspace.store'), load('modules/terminals/terminal.service'),
    load('infra/tmux/session'), load('modules/terminals/terminal-env-launch'), load('modules/terminals/terminal-env-launch.protocol'),
    load('modules/terminals/terminal.gitAuth'), load('modules/terminals/terminal.store'),
  ]);
  const db = await openDb(dataDir);
  const nonce = randomBytes(8).toString('hex');
  const marker = `fictional-not-a-real-secret-${nonce}`;
  const workspaceId = `ws_fixture_${nonce}`;
  const workspacePath = path.join(dataDir, 'workspaces', `fixture-${nonce}`);
  await fs.mkdir(workspacePath, { recursive: true, mode: 0o700 });
  const time = Date.now();
  workspaceStore.insertWorkspace(db, { id: workspaceId, dirName: `fixture-${nonce}`, title: 'Environment acceptance fixture',
    path: workspacePath, terminalCredentialId: null, createdAt: time, updatedAt: time });
  const origin = `http://127.0.0.1:${port}`;
  const ctx = { db, repoRoot, dataDir, fileMaxBytes: 1024 * 1024, version: 'terminal-env-harness', logLevel: 'silent',
    serveWeb: true, webDistDir: path.join(repoRoot, 'apps/web/dist'), credentialMasterKey: randomBytes(32),
    credentialMasterKeySource: 'file', credentialMasterKeyId: 'harness-only', credentialMasterKeyCreatedAt: null,
    authToken: null, authCookieSecure: false, agentWorkerEnabled: options.withWorker, agentWorkerHost: '127.0.0.1',
    agentWorkerPort: workerPort, agentWorkerSocketPath: path.join(root, 'worker.sock'), agentWorkerConcurrency: 1,
    agentInternalToken: randomBytes(32).toString('hex'), agentWorkerResponseValidation: 'strict', agentApiOrigin: origin,
    agentPluginHostEnabled: false, agentPluginHostSocketPath: path.join(root, 'plugin.sock'), agentPluginServicesEnabled: false,
    analytics: { enabled: false }, preview: { enabled: false, runtime: null } };
  const records = [];
  const record = (name, detail = {}) => { records.push({ name, ...detail }); process.stdout.write(`PASS ${name}\n`); };
  let app, isolated = false, socketIdentity = null, serverPid = null, closing = false, stopRequested = false;
  const interrupted = new AbortController();
  const onSignal = () => { stopRequested = true; interrupted.abort(); };
  const websockets = new Set();
  const sessionNames = new Set();
  const explicitTmux = (args) => command(realTmux, ['-S', socket, ...args]);
  const attempts = () => db.prepare('select count(*) as count from terminal_env_launch_attempts').get().count;
  async function request(method, pathname, body) {
    if (stopRequested) throw new Error('HARNESS_INTERRUPTED');
    const response = await fetch(origin + pathname, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    if (response.status === 204) return null;
    const result = await response.json();
    if (!response.ok) throw new Error(`HARNESS_API_${response.status}_${String(result.code ?? 'FAILED').replace(/[^A-Z0-9_]/g, '')}`);
    return result;
  }
  async function startApp() {
    // createApp starts and awaits its own Worker generation. All paths and origin are already fixed.
    app = await createApp(ctx);
    try { await app.listen({ port, host: '127.0.0.1' }); }
    catch { await app.close(); app = undefined; throw new Error('HARNESS_LISTEN_FAILED'); }
    if (options.withWorker) {
      const health = await new Promise((resolve, reject) => {
        const req = http.request({ socketPath: ctx.agentWorkerSocketPath, path: '/internal/health', method: 'GET',
          headers: { 'x-awb-agent-internal-token': ctx.agentInternalToken }, timeout: 5_000 }, (response) => {
          response.resume(); response.once('end', () => response.statusCode === 200 ? resolve(true) : reject(new Error('HARNESS_WORKER_NOT_READY')));
        });
        req.on('error', () => reject(new Error('HARNESS_WORKER_NOT_READY'))); req.on('timeout', () => req.destroy()); req.end();
      });
      assert(health);
      record('managed-worker-ready', { entry: 'apps/agent-worker/dist/main.js' });
    }
  }
  async function assertSocket(sessionName) {
    assert(sessionNames.has(sessionName), 'HARNESS_UNOWNED_SESSION');
    const stat = await fs.lstat(socket, { bigint: true });
    assert(stat.isSocket() && stat.uid === BigInt(process.getuid()), 'HARNESS_SOCKET_IDENTITY');
    if (socketIdentity) assert(stat.dev === socketIdentity.dev && stat.ino === socketIdentity.ino, 'HARNESS_SOCKET_REPLACED');
    const found = await explicitTmux(['display-message', '-p', '-t', sessionName, '#{socket_path}|#{pid}|#{pane_pid}']);
    assert.equal(found.code, 0, 'HARNESS_SESSION_PROBE_FAILED');
    const [actualSocket, pid, panePid] = found.stdout.trim().split('|');
    assert.equal(actualSocket, socket, 'HARNESS_WRONG_SOCKET');
    assert(/^\d+$/.test(pid) && /^\d+$/.test(panePid), 'HARNESS_SERVER_PID_INVALID');
    if (serverPid) assert.equal(pid, serverPid, 'HARNESS_SERVER_REPLACED');
    socketIdentity = stat; serverPid = pid;
    return Number(panePid);
  }
  async function verifyWrapper() {
    const stat = await fs.lstat(wrapper, { bigint: true });
    assert(stat.dev === wrapperIdentity.dev && stat.ino === wrapperIdentity.ino && stat.nlink === 1n
      && (stat.mode & 0o777n) === 0o700n && !stat.isSymbolicLink(), 'HARNESS_WRAPPER_REPLACED');
    assert.equal(await fs.readFile(wrapper, 'utf8'), expectedWrapper);
  }
  const { default: WebSocket } = await import('ws');
  async function attach(term) {
    const client = new WebSocket(`${origin.replace('http:', 'ws:')}/api/terminals/${term.id}/ws`);
    websockets.add(client);
    let output = '', error = null;
    client.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'output') output = (output + message.data).slice(-256_000);
      if (message.type === 'error') error = new Error('HARNESS_PTY_ATTACH_REJECTED');
    });
    client.on('error', () => { error = new Error('HARNESS_WEBSOCKET_FAILED'); });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('HARNESS_WEBSOCKET_TIMEOUT')), 5_000);
      client.once('open', () => { clearTimeout(timer); resolve(); }); client.once('error', () => { clearTimeout(timer); reject(new Error('HARNESS_WEBSOCKET_FAILED')); }); });
    const wait = async (text, timeout = 7_000) => {
      const until = Date.now() + timeout;
      const matches = (value) => value.replace(/\r/g, '').includes(text.replace(/\r/g, ''));
      while (true) {
        if (stopRequested) throw new Error('HARNESS_INTERRUPTED');
        if (error) throw error;
        if (matches(output)) return;
        // tmux sends screen diffs, not a line stream (resizes can split a token with cursor moves).
        // Read only this already-owned pane, never log its contents, and verify the rendered result too.
        const rendered = await explicitTmux(['capture-pane', '-p', '-t', term.sessionName]);
        if (rendered.code === 0 && matches(rendered.stdout)) return;
        if (Date.now() > until) throw new Error('HARNESS_PTY_EXPECTATION_TIMEOUT');
        await delay(40);
      }
    };
    const write = (data) => client.send(JSON.stringify({ type: 'input', data }));
    const close = async () => { if (client.readyState === WebSocket.CLOSED) return;
      await new Promise((resolve) => { const timer = setTimeout(() => { client.terminate(); resolve(); }, 2_000);
        client.once('close', () => { clearTimeout(timer); resolve(); }); client.close(); }); websockets.delete(client); };
    const attachedBy = Date.now() + 5_000;
    while (await tmux.tmuxCountClients({ sessionName: term.sessionName, cwd: dataDir }) !== 1) {
      if (error) throw error;
      if (Date.now() > attachedBy) throw new Error('HARNESS_PTY_ATTACH_TIMEOUT');
      await delay(20);
    }
    // The shell only prints this after executing real input received through the production WS/PTY route.
    const ready = `PTY_READY_${randomBytes(6).toString('hex')}`;
    write(`printf '\\n%s\\n' ${shellQuote(ready)}\r`); await wait(`\r\n${ready}\r\n`);
    await assertSocket(term.sessionName);
    assert.equal(await tmux.tmuxCountClients({ sessionName: term.sessionName, cwd: dataDir }), 1);
    return { client, wait, write, close, clear() { output = ''; } };
  }
  async function createApiTerminal() {
    await verifyWrapper();
    if (sessionNames.size === 0) { socketIdentity = null; serverPid = null; }
    const term = await request('POST', `/api/workspaces/${workspaceId}/terminals`, { shell });
    assert.equal(term.status, 'active'); sessionNames.add(term.sessionName); await assertSocket(term.sessionName);
    assert.equal(await tmux.tmuxHasSession({ sessionName: term.sessionName, cwd: dataDir }), 'exists');
    return term;
  }
  const probePath = path.join(root, 'environment-probe.mjs');
  await fs.writeFile(probePath, `import assert from 'node:assert/strict';\nconst revision = process.argv[2];\nassert.equal(process.env.ENV_FIXTURE_VALUE, revision === 'a' ? ${JSON.stringify(marker)} : 'updated-fixture');\nassert.equal(process.env.ENV_FIXTURE_LITERAL, '  $PATH\\r\\n$(echo should-not-run) 中文 😀  ');\nassert.equal(process.env.ENV_FIXTURE_EMPTY, '');\nassert.equal(process.env.HTTP_PROXY, 'upper-fixture');\nassert.equal(process.env.http_proxy, 'lower-fixture');\nassert(!Object.keys(process.env).some(k => k.startsWith('AWB_')));\nprocess.stdout.write('ENV_OK:${nonce}:' + revision + '\\n');\n`, { mode: 0o600, flag: 'wx' });
  const probeCommand = (revision) => `NODE_OPTIONS= NODE_PATH= ${shellQuote(process.execPath)} ${shellQuote(probePath)} ${shellQuote(revision)}`;
  async function probeTerminal(connection, revision) {
    connection.clear(); connection.write(probeCommand(revision) + '\r'); await connection.wait(`ENV_OK:${nonce}:${revision}`);
  }
  async function deleteApiTerminal(term, alreadyStopped = false) {
    assert(isolated, 'HARNESS_KILL_BEFORE_PREFLIGHT'); await verifyWrapper();
    if (alreadyStopped) assert.equal(await tmux.tmuxHasSession({ sessionName: term.sessionName, cwd: dataDir }), 'not_found');
    else await assertSocket(term.sessionName);
    try { await request('DELETE', `/api/terminals/${term.id}`); }
    catch (error) {
      // A last-session server shutdown can make the immediate API probe indeterminate under load.
      // Do not guess success or issue another kill: confirm certain absence, then retry convergence.
      if (error.message !== 'HARNESS_API_503_TERMINAL_SESSION_STOP_UNCONFIRMED') throw error;
      const deadline = Date.now() + 5_000;
      while (true) {
        let absent = false;
        try { absent = await tmux.tmuxHasSession({ sessionName: term.sessionName, cwd: dataDir }) === 'not_found'; } catch {}
        if (absent) break;
        if (Date.now() > deadline) throw error;
        await delay(40);
      }
      await request('DELETE', `/api/terminals/${term.id}`);
      record('uncertain-stop-confirmed-absent-then-converged');
    }
    assert.equal(await tmux.tmuxHasSession({ sessionName: term.sessionName, cwd: dataDir }), 'not_found');
    sessionNames.delete(term.sessionName);
  }
  async function assertLaunchClean() {
    assert.equal(attempts(), 0, 'HARNESS_ATTEMPT_LEAK');
    let entries = []; try { entries = await fs.readdir(path.join(dataDir, protocol.TERMINAL_ENV_LAUNCH_ROOT)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.deepEqual(entries, [], 'HARNESS_LAUNCH_FILE_LEAK');
  }
  async function observeOwnedArgv(params) {
    sessionNames.add(params.sessionName);
    const panePid = await assertSocket(params.sessionName);
    // Linux has no ps in the minimal runtime used by this harness. Inspect ONLY the PID returned
    // by this verified, harness-owned tmux pane and its direct children; never enumerate processes
    // or read /proc/*/environ. This is bounded OS process metadata, not a Workspace file operation.
    if (process.platform !== 'linux') throw new Error('HARNESS_ARGV_OBSERVATION_UNSUPPORTED');
    const paneArgs = (await fs.readFile(`/proc/${panePid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    assert(!paneArgs.some((arg) => arg.includes(marker) || arg.includes('updated-fixture')), 'HARNESS_ARGV_VALUE_LEAK');
    assert(paneArgs.some((arg) => arg.includes('terminal-env-launcher.')), 'HARNESS_WRONG_LAUNCHER_ENTRY');
    assert.equal(paneArgs.some((arg) => arg.includes('terminal-env-launcher.ts')), source, 'HARNESS_LAUNCHER_MODE_MISMATCH');
    if (!source) assert(!paneArgs.some((arg) => arg.includes('tsx')), 'HARNESS_DIST_USED_TSX');
    const children = (await fs.readFile(`/proc/${panePid}/task/${panePid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
    assert(children.length > 0 && children.every((pid) => /^[1-9]\d*$/.test(pid)), 'HARNESS_SHELL_CHILD_MISSING');
    for (const pid of children) {
      const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
      assert.equal(status.match(/^PPid:\s+(\d+)$/m)?.[1], String(panePid), 'HARNESS_PROCESS_PARENT_CHANGED');
      const args = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
      assert(!args.includes(marker) && !args.includes('updated-fixture'), 'HARNESS_CHILD_ARGV_VALUE_LEAK');
    }
    const attempt = db.prepare('select directory_name as name from terminal_env_launch_attempts').get();
    assert(attempt, 'HARNESS_HELD_ATTEMPT_MISSING');
    const privateRoot = path.join(dataDir, protocol.TERMINAL_ENV_LAUNCH_ROOT);
    for (const [filename, mode] of [[privateRoot, 0o700], [path.join(privateRoot, attempt.name), 0o700],
      [path.join(privateRoot, attempt.name, 'payload.json'), 0o600], [path.join(privateRoot, attempt.name, 'status.json'), 0o600]]) {
      const stat = await fs.lstat(filename);
      assert.equal(stat.mode & 0o7777, mode); assert.equal(stat.uid, process.getuid());
      assert(!stat.isSymbolicLink()); if (mode === 0o600) assert.equal(stat.nlink, 1);
    }
    record('trusted-launcher-argv', { mode: options.mode, panePid, heldMs: options.holdLaunchMs });
  }
  const runtime = () => ({ hasSession: tmux.tmuxHasSession, killSession: tmux.tmuxKillSession,
    newSession: tmux.tmuxNewSession, cleanupAuthArtifacts: auth.cleanupTerminalGitAuthArtifacts });
  async function exerciseInjectedLaunch() {
    let sessionName, activeFault = options.fault, retired = null, observed = false;
    const operations = runtime();
    operations.newSession = async (params) => {
      if (sessionNames.size === 0) { socketIdentity = null; serverPid = null; }
      sessionName = params.sessionName; sessionNames.add(sessionName);
      if (activeFault === 'status-timeout') {
        const deferred = path.join(root, 'deferred-launch.mjs');
        await fs.writeFile(deferred, "import {spawn} from 'node:child_process';\nsetTimeout(() => { const c = spawn(process.argv[2], process.argv.slice(3), {stdio:'inherit'}); c.on('close', n => process.exit(n ?? 1)); }, 5000);\n", { mode: 0o600, flag: 'wx' });
        await tmux.tmuxNewSession({ ...params, command: [process.execPath, deferred, ...params.command] });
      } else {
        assert(!params.command.join(' ').includes(marker), 'HARNESS_ARGV_VALUE_LEAK');
        await tmux.tmuxNewSession(params);
      }
      await assertSocket(sessionName);
    };
    operations.waitEnvironmentLaunch = async (params) => {
      if (activeFault === 'status-timeout') return launch.waitTerminalEnvironmentLaunch({ ...params, timeoutMs: 150, pollMs: 20 });
      const status = await launch.waitTerminalEnvironmentLaunch(params);
      if (status.state === 'spawned') {
        await observeOwnedArgv({ sessionName }); observed = true;
        if (options.holdLaunchMs) await delay(options.holdLaunchMs, undefined, { signal: interrupted.signal });
        if (activeFault === 'kill-failed') throw new protocol.TerminalEnvironmentLaunchError('TERMINAL_ENV_START_TIMEOUT');
      }
      return status;
    };
    if (activeFault === 'kill-failed') operations.killSession = async () => { throw new Error('TEST_KILL_FAILED'); };
    if (activeFault?.includes('retire-crash')) operations.cleanupEnvironmentLaunch = async (params) => {
      if (retired) return 'pending';
      return launch.cleanupTerminalEnvironmentLaunch({ ...params, hooks: { afterRetire(info) {
        if ((activeFault === 'file-retire-crash' && info.kind === 'file') || (activeFault === 'directory-retire-crash' && info.kind === 'directory')) {
          retired = { kind: info.kind, privateName: info.privateName }; throw new Error('TEST_RETIRE_CRASH');
        }
      } } });
    };
    let term, failed = false;
    try { term = await terminalService.createTerminal(ctx, app.log, { workspaceId, shell, runtimeOperations: operations }); }
    catch (error) { failed = true; assert.equal(error.statusCode, 500); assert(!JSON.stringify(error).includes(marker)); record('injected-launch-rejected', { code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'SAFE_ERROR' }); }
    if (!activeFault) {
      assert(!failed && observed, 'HARNESS_HELD_LAUNCH_FAILED'); await deleteApiTerminal(term); await assertLaunchClean(); return;
    }
    assert(failed && sessionName, 'HARNESS_FAULT_NOT_TRIGGERED');
    if (activeFault === 'status-timeout') {
      assert.equal(await tmux.tmuxHasSession({ sessionName, cwd: dataDir }), 'not_found');
      assert.equal(attempts(), 0); sessionNames.delete(sessionName); await assertLaunchClean();
    } else {
      assert.equal(attempts(), 1, 'HARNESS_PENDING_LOCATOR_LOST');
      if (activeFault.includes('retire-crash')) {
        assert(retired, 'HARNESS_RETIRE_WINDOW_NOT_HIT');
        const attempt = db.prepare('select directory_name as name from terminal_env_launch_attempts').get();
        const parent = path.join(dataDir, protocol.TERMINAL_ENV_LAUNCH_ROOT, ...(retired.kind === 'file' ? [attempt.name] : []));
        assert((await fs.readdir(parent)).includes(retired.privateName), 'HARNESS_RETIRE_SLOT_MISSING');
      }
      if (activeFault === 'kill-failed') assert.equal(await tmux.tmuxHasSession({ sessionName, cwd: dataDir }), 'exists');
      record('fault-pending-preserved', { fault: activeFault, retired: retired?.kind ?? null });
      // Same test DB/dataDir/socket. Reconstruction invokes the real startup recovery without injected failures.
      await app.close(); app = undefined;
      await startApp(); await assertLaunchClean();
      assert.equal(await tmux.tmuxHasSession({ sessionName, cwd: dataDir }), 'not_found');
      sessionNames.delete(sessionName);
    }
    record('fault-recovered', { fault: activeFault });
  }
  async function cleanup() {
    if (closing) return; closing = true;
    for (const client of websockets) client.terminate(); websockets.clear();
    if (app) { await app.close(); app = undefined; }
    const currentRoot = await fs.lstat(root, { bigint: true });
    assert(currentRoot.dev === rootIdentity.dev && currentRoot.ino === rootIdentity.ino && !currentRoot.isSymbolicLink(), 'HARNESS_ROOT_REPLACED');
    let clean = false;
    if (isolated) {
      await verifyWrapper();
      // Manual UI-created terminals are authorized only by this fixture Workspace's durable IDs.
      const workspace = workspaceStore.getWorkspace(db, workspaceId);
      if (workspace) {
        assertProjectChild(workspace.path, root);
        for (const term of terminalStore.listTerminalsByWorkspace(db, workspaceId)) {
          assert.equal(term.sessionName, `term_${term.id}`, 'HARNESS_INVALID_DURABLE_SESSION');
          sessionNames.add(term.sessionName);
        }
      }
      const list = await explicitTmux(['list-sessions', '-F', '#{session_name}']);
      if (list.code === 0) {
        const names = list.stdout.trim().split('\n').filter(Boolean);
        assert(names.every((name) => sessionNames.has(name)), 'HARNESS_UNKNOWN_SESSION_RETAINED');
        for (const name of names) {
          await assertSocket(name); await tmux.tmuxKillSession({ sessionName: name, cwd: dataDir });
          assert.equal(await tmux.tmuxHasSession({ sessionName: name, cwd: dataDir }), 'not_found');
        }
        sessionNames.clear();
      } else {
        assert.equal(tmux.classifyTmuxHasSessionResult({ ok: false, code: list.code, stdout: list.stdout, stderr: list.stderr, timedOut: false }), 'not_found');
      }
      // Session cleanup above used exact identities, then let the production reconcilers settle records/locators.
      await terminalService.reconcilePendingTerminals(ctx, { info() {}, warn() {}, error() {} });
      await terminalService.reconcileWorkspaceActiveTerminals(ctx, { info() {}, warn() {}, error() {} }, workspaceId);
      await assertLaunchClean();
      const live = await explicitTmux(['list-sessions', '-F', '#{session_name}']);
      assert.notEqual(live.code, 0, 'HARNESS_LIVE_SESSION_REMAINS');
      if (options.withWorker) {
        for (const filename of [ctx.agentWorkerSocketPath, path.join(dataDir, 'agent-worker.pid')]) {
          try { await fs.lstat(filename); throw new Error('HARNESS_WORKER_RESOURCE_REMAINS'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      clean = true;
    }
    const summary = { node: process.version, platform: `${process.platform}/${process.arch}`, kernel: os.release(), mode: options.mode,
      withWorker: options.withWorker, fault: options.fault, isolated, clean, verificationPassed: options.verify && completed && clean, records,
      evidenceRetained: true, pendingAttempts: attempts(),
      note: 'Only this isolated app/Worker and verified socket sessions were stopped. Project-local DB/fixtures remain as evidence; no recursive deletion.' };
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    db.close(); ctx.credentialMasterKey.fill(0); ctx.agentInternalToken = '';
    process.stdout.write(`EVIDENCE ${path.relative(repoRoot, root)}/result.json\n`);
    if (!clean) process.stderr.write('HARNESS_PREFLIGHT_INCOMPLETE_RESOURCES_RETAINED\n');
  }
  let completed = false;
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    await startApp();
    for (const [name, value] of Object.entries({ ENV_FIXTURE_VALUE: marker, ENV_FIXTURE_LITERAL: '  $PATH\r\n$(echo should-not-run) 中文 😀  ',
      ENV_FIXTURE_EMPTY: '', HTTP_PROXY: 'upper-fixture', http_proxy: 'lower-fixture', NODE_OPTIONS: '--invalid-workspace-option', NODE_PATH: '/fictional-module-path' })) {
      await request('POST', `/api/workspaces/${workspaceId}/environment-variables`, { name, value });
    }
    const first = await createApiTerminal();
    const listWrapped = await command('tmux', ['list-sessions', '-F', '#{session_name}']);
    const listExplicit = await explicitTmux(['list-sessions', '-F', '#{session_name}']);
    assert.equal(listWrapped.code, 0); assert.equal(listWrapped.stdout, listExplicit.stdout);
    const connection = await attach(first);
    await probeTerminal(connection, 'a');
    isolated = true; record('api-create-probe-count-real-ws-pty-same-socket');
    await connection.close();
    // API kill is now authorized by the completed socket/PTY preflight.
    await deleteApiTerminal(first); await assertLaunchClean(); record('api-kill-same-socket-and-launch-resources-clean');
    const hotA = await createApiTerminal(); const hotB = await createApiTerminal();
    const hot = await attach(hotA); await probeTerminal(hot, 'a');
    const rows = await request('GET', `/api/workspaces/${workspaceId}/environment-variables`);
    const variable = rows.find((row) => row.name === 'ENV_FIXTURE_VALUE');
    await request('PATCH', `/api/workspaces/${workspaceId}/environment-variables/${variable.id}`, { value: 'updated-fixture' });
    await probeTerminal(hot, 'a'); await hot.close();
    const reattached = await attach(hotA); await probeTerminal(reattached, 'a'); await reattached.close();
    const newer = await createApiTerminal(); const updated = await attach(newer); await probeTerminal(updated, 'b'); await updated.close();
    record('hot-server-new-snapshot-old-shell-reconnect-unchanged');
    const oldServer = serverPid;
    for (const term of [hotA, hotB, newer]) await deleteApiTerminal(term);
    await assertLaunchClean();
    // Cold test never targets the default server. Verify the old socket identity before stopping this one.
    // tmux normally exits after its last session, so no kill-server is necessary or desirable here.
    socketIdentity = null; serverPid = null;
    const cold = await createApiTerminal(); assert.notEqual(serverPid, oldServer, 'HARNESS_COLD_SERVER_NOT_NEW');
    const coldPty = await attach(cold); await probeTerminal(coldPty, 'b');
    coldPty.clear(); coldPty.write("printf 'TTY_%s\\n' 中文\r"); await coldPty.wait('TTY_中文'); record('real-pty-unicode');
    coldPty.client.send(JSON.stringify({ type: 'resize', cols: 96, rows: 27 }));
    const resizeBy = Date.now() + 5_000;
    while ((await explicitTmux(['display-message', '-p', '-t', cold.sessionName, '#{pane_height} #{pane_width}'])).stdout.trim() !== '27 96') {
      if (Date.now() > resizeBy) throw new Error('HARNESS_RESIZE_TIMEOUT');
      await delay(40);
    }
    await delay(200);
    coldPty.clear(); coldPty.write("printf 'SIZE_%s\\n' \"$(/bin/stty size)\"\r"); await coldPty.wait('SIZE_27 96'); record('real-pty-resize');
    coldPty.clear(); coldPty.write('/bin/sleep 20\r'); await delay(100); coldPty.write('\u0003');
    coldPty.write("printf 'INTERRUPT_%s\\n' OK\r"); await coldPty.wait('INTERRUPT_OK'); record('real-pty-ctrl-c');
    coldPty.clear(); coldPty.write('/bin/sleep 20\r'); await delay(100); coldPty.write('\u001a'); await delay(100);
    coldPty.write('jobs -l\r'); await coldPty.wait('Stopped'); record('real-pty-ctrl-z-jobs');
    coldPty.clear(); coldPty.write('fg\r'); await delay(100); coldPty.write('\u0003');
    coldPty.write("printf 'FOREGROUND_%s\\n' OK\r"); await coldPty.wait('FOREGROUND_OK');
    coldPty.clear(); coldPty.write("(/bin/sleep 0.2; printf 'BACKGROUND_%s\\n' DONE) &\r"); await coldPty.wait('BACKGROUND_DONE');
    record('real-pty-unicode-resize-ctrl-c-ctrl-z-jobs-fg-background');
    const shellClosed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HARNESS_SHELL_EXIT_TIMEOUT')), 5_000);
      coldPty.client.once('close', () => { clearTimeout(timer); resolve(); });
    });
    coldPty.write('exit\r'); await shellClosed; await coldPty.close();
    await deleteApiTerminal(cold, true); record('real-shell-exit-and-record-convergence'); await assertLaunchClean(); record('cold-new-server-snapshot-and-cleanup');
    // A new server can recreate its socket inode after the last session stopped.
    socketIdentity = null; serverPid = null;
    if (options.holdLaunchMs || options.fault) await exerciseInjectedLaunch();
    if (options.withWorker) {
      const fixture = await command(process.execPath, [path.join(repoRoot, 'apps/api/tests/manual/terminal-environment-worker-fixture.mjs')], {
        input: JSON.stringify({ apiOrigin: origin, internalToken: ctx.agentInternalToken, workspaceId, workspacePath, probePath, revision: 'b', nonce }) });
      assert.equal(fixture.code, 0, 'HARNESS_WORKER_TOOL_FIXTURE_FAILED');
      assert.equal(JSON.parse(fixture.stdout).ok, true); record('worker-runtime-fixed-bash-through-authenticated-api');
    }
    const version = await explicitTmux(['-V']);
    process.stdout.write(`HARNESS ${JSON.stringify({ node: process.version, tmux: version.stdout.trim(), platform: process.platform, mode: options.mode, withWorker: options.withWorker })}\n`);
    process.stdout.write(`UI ${origin}/workspaces/${workspaceId}\n`);
    process.stdout.write(`SCOPE ${path.relative(repoRoot, root)} (isolated DB, Worker, HOME and tmux socket)\n`);
    if (!options.verify) {
      socketIdentity = null; serverPid = null;
      await createApiTerminal();
      process.stdout.write('READY manual-ui\n');
      if (!stopRequested) await new Promise((resolve) => interrupted.signal.addEventListener('abort', resolve, { once: true }));
    }
    completed = true;
  } finally {
    try { await cleanup(); }
    catch { if (db.open) db.close(); process.stderr.write(`HARNESS_CLEANUP_PENDING ${path.relative(repoRoot, root)}\n`); completed = false; }
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
  if (stopRequested) { process.exitCode = 130; return; }
  if (!completed) throw new Error('HARNESS_VERIFICATION_FAILED');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) process.stdout.write('Usage: node terminal-environment-harness.mjs --mode source|dist [--port 0] [--with-worker] [--verify] [--hold-launch-ms 5000] [--fault file-retire-crash|directory-retire-crash|status-timeout|kill-failed]\nDefault: isolated manual UI until Ctrl+C. --verify: automatic bounded checks, then safe cleanup. Evidence stays in project .tmp-tests. No default tmux operations.\n');
    else await main(options);
  } catch (error) {
    // Do not print raw app/spawn/HTTP errors, stacks, response bodies, argv or environment.
    const code = error instanceof Error && /^HARNESS_[A-Z0-9_]+$/.test(error.message) ? error.message : 'HARNESS_CHECK_FAILED';
    process.stderr.write(code + '\n'); process.exitCode = 1;
  }
}
