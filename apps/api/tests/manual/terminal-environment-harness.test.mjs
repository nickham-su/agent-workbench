import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { parseArguments, shellQuote, assertProjectChild, FAULTS } from './terminal-environment-harness.mjs';

test('harness defaults to dist manual UI and strictly bounded optional modes', () => {
  assert.deepEqual(parseArguments([]), { mode: 'dist', port: 0, withWorker: false, verify: false, holdLaunchMs: 0, fault: null, help: false });
  assert.deepEqual(parseArguments(['--mode', 'source', '--port', '0', '--with-worker', '--verify', '--hold-launch-ms', '5000']),
    { mode: 'source', port: 0, withWorker: true, verify: true, holdLaunchMs: 5000, fault: null, help: false });
});
test('every advertised fault is executable and unknown flags or modes are rejected', () => {
  for (const fault of FAULTS) assert.equal(parseArguments(['--fault', fault]).fault, fault);
  for (const args of [['--mode', 'production'], ['--fault', 'delete-all'], ['--socket', '/tmp/unsafe'], ['--mode'], ['--port', '--verify']]) {
    assert.throws(() => parseArguments(args), /^Error: HARNESS_/);
  }
});
test('numeric input cannot overflow or bypass integer limits', () => {
  for (const value of ['-1', '1e2', '1.1', '65536', '99999999999999999999999999']) assert.throws(() => parseArguments(['--port', value]));
  for (const value of ['-1', '30001', 'NaN']) assert.throws(() => parseArguments(['--hold-launch-ms', value]));
  assert.equal(parseArguments(['--port', '65535']).port, 65535);
  assert.equal(parseArguments(['--hold-launch-ms', '30000']).holdLaunchMs, 30000);
});
test('wrapper quoting handles spaces and single quotes without command interpolation', () => {
  assert.equal(shellQuote("/project/a'b c/$(never)/tmux"), "'/project/a'\\''b c/$(never)/tmux'");
});
test('project-child boundaries reject parent/root/prefix collisions', () => {
  const root = path.resolve('project-fixture');
  assert.equal(assertProjectChild(path.join(root, '.tmp-tests', 'te-fixture'), root), path.join(root, '.tmp-tests', 'te-fixture'));
  for (const candidate of [root, path.dirname(root), root + '-other/file', path.join(root, '..', 'outside')]) assert.throws(() => assertProjectChild(candidate, root));
});
