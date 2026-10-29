// Test-only fixed tool invocation. Credentials arrive over stdin, never argv or a file.
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { shellQuote as shQuote } from './terminal-environment-harness.mjs';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
let input = '';
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16_384) throw new Error('INPUT_LIMIT');
  }
  const request = JSON.parse(input);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(request.apiOrigin)
    || typeof request.internalToken !== 'string' || !request.internalToken
    || !path.resolve(request.workspacePath).startsWith(path.join(repoRoot, '.tmp-tests') + path.sep)
    || !path.resolve(request.probePath).startsWith(path.join(repoRoot, '.tmp-tests') + path.sep)) throw new Error('INPUT_INVALID');
  const { AgentApiClient } = await import(pathToFileURL(path.join(repoRoot, 'apps/agent-worker/dist/runtime/apiClient.js')).href);
  const { BuiltinToolProvider } = await import(pathToFileURL(path.join(repoRoot, 'apps/agent-worker/dist/runtime/tools/providers/builtin.js')).href);
  const apiClient = new AgentApiClient({ apiOrigin: request.apiOrigin, internalToken: request.internalToken,
    internalRpcTimeoutMs: 5_000, responseValidation: 'strict', logger: { warn() {} } });
  const context = {
    profile: { agent: { tools: ['bash'] } },
    run: { workspaceId: request.workspaceId, sessionId: 'fixture-session', runId: 'fixture-run',
      workspacePath: request.workspacePath, workspaceRepoDirNames: [] },
    pendingTool: { toolExecutionId: 'fixture-tool', callPartId: 'fixture-part', assistantMessageId: 'fixture-message',
      status: 'queued', toolName: 'bash', toolCallId: 'fixture-call', args: {} },
    signal: new AbortController().signal, apiClient, promptContext: {}, processNestedRun: async () => undefined,
    updateToolExecution: async () => undefined, nowMs: Date.now, renderToolText: () => 'fixture',
  };
  // NODE_OPTIONS is intentionally invalid in the shell. Clear it only for this observation program.
  const command = `NODE_OPTIONS= NODE_PATH= ${shQuote(process.execPath)} ${shQuote(request.probePath)} ${shQuote(request.revision)}`;
  const result = await new BuiltinToolProvider().execute('bash', { command, timeout: 10 }, context);
  if (result.exitCode !== 0 || !result.stdout.includes(`ENV_OK:${request.nonce}:${request.revision}`)) throw new Error('BASH_PROBE_FAILED');
  process.stdout.write(JSON.stringify({ ok: true, tool: 'bash', runtime: 'built-worker-fixture' }) + '\n');
} catch {
  process.stderr.write('TERMINAL_ENV_WORKER_FIXTURE_FAILED\n');
  process.exitCode = 1;
}
