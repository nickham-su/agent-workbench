// Explicitly run after builds; these tests exercise real isolated processes, not the default tmux server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = path.join(root, 'apps/api/tests/manual/terminal-environment-harness.mjs');
function start(args, prefix = []) {
  const child = spawn(process.execPath, [...prefix, entry, ...args], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code)); });
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}
test('dist mode refuses dev loaders before any app or Worker is constructed', { timeout: 15_000 }, async () => {
  const run = start(['--mode', 'dist', '--verify'], ['--import', 'tsx']);
  assert.equal(await run.exited, 1); assert.equal(run.stderr().trim(), 'HARNESS_DIST_LOADER_FORBIDDEN');
  assert.equal(run.stdout(), '');
});
test('occupied explicit port is rejected without connecting to its owner or starting Worker', { timeout: 15_000 }, async () => {
  let calls = 0;
  const server = http.createServer((_req, res) => { calls++; res.end('unrelated-loopback-owner'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const run = start(['--mode', 'dist', '--with-worker', '--verify', '--port', String(server.address().port)]);
    assert.equal(await run.exited, 1); assert.equal(run.stdout(), ''); assert.equal(calls, 0);
    assert.match(run.stderr(), /^HARNESS_[A-Z_]+\n$/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
test('manual UI SIGINT stops only its Worker and verified sessions and retains bounded evidence', { timeout: 60_000 }, async () => {
  const run = start(['--mode', 'dist', '--with-worker']);
  let ready = false;
  try {
    const by = Date.now() + 40_000;
    while (!run.stdout().includes('READY manual-ui')) {
      if (run.child.exitCode !== null || Date.now() > by) throw new Error('MANUAL_HARNESS_NOT_READY');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    ready = true; run.child.kill('SIGINT'); assert.equal(await run.exited, 130);
    assert.equal(run.stderr(), '');
    const evidence = run.stdout().match(/EVIDENCE ([^\r\n]+)\/result\.json/);
    assert(evidence); const directory = path.resolve(root, evidence[1]);
    assert(directory.startsWith(path.join(root, '.tmp-tests', 'te-')));
    const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
    assert.equal(result.isolated, true); assert.equal(result.clean, true); assert.equal(result.pendingAttempts, 0);
    assert.equal(result.verificationPassed, false); // Manual UI is not a claimed full browser acceptance.
    for (const filename of ['worker.sock', 'data/agent-worker.pid']) await assert.rejects(fs.lstat(path.join(directory, filename)), { code: 'ENOENT' });
    const wrapper = await fs.readFile(path.join(directory, 'bin/tmux'), 'utf8');
    assert(wrapper.includes(`-S '${path.join(directory, 'tmux.sock')}'`));
    const list = spawnSync(path.join(directory, 'bin/tmux'), ['list-sessions'], { encoding: 'utf8', env: process.env });
    assert.notEqual(list.status, 0); assert.match(list.stderr, /no server running|no sessions|No such file or directory/);
    assert.deepEqual(await fs.readdir(path.join(directory, 'data/terminal-env-launch')), []);
  } finally {
    // SIGINT uses the harness's own identity-aware cleanup; never kill a default tmux server.
    if (run.child.exitCode === null) { run.child.kill('SIGINT'); await run.exited; }
    assert(ready, 'manual harness must reach the real WS/PTY preflight');
  }
});
