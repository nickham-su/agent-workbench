import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createGitFixture, successfulGitProcessResult } from "./git.testkit.js";

const execFileAsync = promisify(execFile);
const sentinel = "fixture-git-raw-sentinel";
const privatePath = "/fixture-git-private/lease-path";
async function fixtureFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  const out: string[] = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await fixtureFiles(file));
    else if (entry.isFile()) out.push(await fs.readFile(file, "utf8"));
  }
  return out;
}

for (const branch of ["success", "artifact", "preflight", "repo_unavailable", "repo_empty", "running_failure", "completed_failure", "disabled_pending", "invalid_result", "writeback_retry", "recovery"] as const) {
  test(`Git runner diagnostic and single provider execution: ${branch}`, async (t) => {
    const fixture = await createGitFixture(); t.after(fixture.cleanup);
    const runnerUrl = new URL("./runner.ts", import.meta.url).href;
    const diagnosticUrl = new URL("./gitDiagnostic.ts", import.meta.url).href;
    const clientUrl = new URL("./apiClient.ts", import.meta.url).href;
    const outputUrl = new URL("./gitOutput.ts", import.meta.url).href;
    const errorUrl = new URL("./gitErrors.ts", import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import { GitOutputGuard } from ${JSON.stringify(outputUrl)};
      import { AgentRunner, executeToolSafelyForTest } from ${JSON.stringify(runnerUrl)};
      import { registerGitDiagnosticResult } from ${JSON.stringify(diagnosticUrl)};
      import { InternalRpcHttpError } from ${JSON.stringify(clientUrl)};
      import { GitToolError } from ${JSON.stringify(errorUrl)};
      const branch = ${JSON.stringify(branch)};
      const args = { repo: 'fixture-repo', args: ['status', ${JSON.stringify(sentinel)}, ${JSON.stringify(privatePath)}], timeout: 7 };
      let result = registerGitDiagnosticResult(${JSON.stringify({ ...successfulGitProcessResult, repo: "fixture-repo", leaseDisposition: "released", warnings: [] })});
      const updates = []; const warnings = []; let executions = 0; let retries = 0; let artifactWrites = 0;
      if (branch === 'artifact') {
        const guard = new GitOutputGuard([${JSON.stringify(sentinel)}, ${JSON.stringify(privatePath)}]);
        const raw = Buffer.from(${JSON.stringify(sentinel)} + ':' + ${JSON.stringify(privatePath)} + ':' + 'x'.repeat(100000));
        guard.write('stdout', raw); guard.write('stderr', raw);
        result = registerGitDiagnosticResult({ ...result, ...guard.finish() });
        const open = fs.open; const artifactDirectoryFds = new Set();
        const artifactRoot = ${JSON.stringify(path.join(fixture.workspacePath, ".awb", "agent", "artifacts"))};
        fs.open = async (...input) => {
          const handle = await open(...input); const file = String(input[0]);
          if (file === artifactRoot + '/by_tool_execution') artifactDirectoryFds.add(handle.fd);
          const ownedTemp = file.endsWith('.tmp') && [...artifactDirectoryFds].some(fd => file.startsWith('/proc/self/fd/' + fd + '/'));
          if (ownedTemp) {
            const writeFile = handle.writeFile.bind(handle);
            handle.writeFile = async (data, ...options) => {
              artifactWrites++;
              const text = String(data);
              assert(!text.includes(${JSON.stringify(sentinel)}));
              assert(!text.includes(${JSON.stringify(privatePath)}));
              assert(text.includes('[REDACTED]'));
              return writeFile(data, ...options);
            };
          }
          return handle;
        };
      }
      const api = {
        updateToolExecution: async input => {
          updates.push(input);
          if ((branch === 'running_failure' && input.status === 'running') || (branch === 'completed_failure' && input.status === 'completed')) {
            throw Object.assign(new Error(${JSON.stringify(sentinel)}), { cause: { args, env: args } });
          }
          if (branch === 'writeback_retry' && input.status === 'completed' && retries++ === 0) {
            throw new InternalRpcHttpError({ method: 'POST', endpoint: '/fixture-writeback', status: 503 });
          }
          return { result: 'updated', request: args, ...input };
        },
        updateRunNotice: async () => undefined
      };
      const logger = { info() {}, error() {}, warn(value) { warnings.push(value); } };
      const runner = new AgentRunner(api, {}, logger, 1, { controlWriteSleep: async () => true });
      runner.toolRegistry.isToolEnabled = async () => branch !== 'disabled_pending';
      runner.toolRegistry.execute = async (name, actualArgs, ctx) => {
        executions++; assert.equal(name, 'git'); assert.deepEqual(actualArgs, args); assert.deepEqual(ctx.pendingTool.args, args);
        if (branch === 'preflight') throw Object.assign(new Error(${JSON.stringify(sentinel)}), { cause: args, partialResult: args });
        if (branch === 'repo_unavailable' || branch === 'repo_empty') throw new GitToolError('REPO_NOT_AVAILABLE', branch === 'repo_empty' ? [] : ['latest-safe-name', 'quoted-"repo']);
        if (branch === 'invalid_result') return { ...result, env: args };
        return result;
      };
      const run = { workspaceId: 'ws', sessionId: 'session', runId: 'run', workspacePath: ${JSON.stringify(fixture.workspacePath)}, workspaceRepoDirNames: [] };
      const profile = { agent: { tools: ['git'], pluginTools: [] } };
      const tool = { toolExecutionId: 'execution', callPartId: 'part', assistantMessageId: 'message', status: branch === 'recovery' ? 'running' : 'queued', toolName: 'git', toolCallId: 'call', args };
      const context = { pendingTools: [tool], tools: [], headMessageId: null, sessionRevision: 0, system: '', messages: [], lastResponseTotalTokens: null, uiLocale: null, workspaceRepoNames: [], externalSkills: [] };
      const signal = new AbortController().signal;
      if (branch === 'disabled_pending' || branch === 'recovery') await runner.executePendingTools({ profile, run, context, availableToolNames: new Set(['git']), signal });
      else {
        const execute = () => executeToolSafelyForTest(runner, { profile, run, tool, parentSessionId: 'session', signal, promptContext: context });
        if (branch === 'running_failure' || branch === 'completed_failure') await assert.rejects(execute);
        else await execute();
      }
      assert.equal(executions, ['running_failure', 'disabled_pending', 'recovery'].includes(branch) ? 0 : 1);
      if (branch === 'writeback_retry') assert.equal(updates.filter(value => value.status === 'completed').length, 2);
      if (branch === 'artifact') { assert.equal(artifactWrites, 1); assert(updates.at(-1).resultArtifactPath); }
      if (branch === 'repo_unavailable' || branch === 'repo_empty') {
        const expected = branch === 'repo_empty' ? [] : ['latest-safe-name', 'quoted-"repo'];
        assert(updates.at(-1).error.includes('availableRepos: ' + JSON.stringify(expected)));
        assert(updates.at(-1).resultPreview.includes('availableRepos: ' + JSON.stringify(expected)));
      }
      const serialized = JSON.stringify({ updates, warnings });
      // The test API intentionally returns raw request echoes. Runner diagnostics
      // must drop them; only outgoing writeback requests are model-visible here.
      assert(!JSON.stringify(updates).includes(${JSON.stringify(sentinel)}));
      assert(!serialized.includes(${JSON.stringify(privatePath)}));
      assert.deepEqual(tool.args, args);
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: path.resolve("."), env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1", AWB_AGENT_DEBUG_DUMP: "1" },
    });
    const errorFiles = await fixtureFiles(path.join(fixture.workspacePath, ".awb", "agent", "tool-errors"));
    const itemFiles = await fixtureFiles(path.join(fixture.workspacePath, ".debug", "agent_message_logs", "tool"));
    for (const text of [...errorFiles, ...itemFiles]) {
      assert(!text.includes(sentinel), `${branch}: raw argv/exception escaped`);
      assert(!text.includes(privatePath), `${branch}: private path escaped`);
    }
    if (branch === "repo_unavailable" || branch === "repo_empty") {
      for (const text of [...errorFiles, ...itemFiles]) assert(!text.includes("availableRepos") && !text.includes("latest-safe-name"), "model-visible details must not expand extra diagnostic snapshots");
    }
    if (["success", "artifact", "writeback_retry", "recovery"].includes(branch)) { assert.equal(errorFiles.length, 0); assert.equal(itemFiles.length, branch === "recovery" ? 0 : 1); }
    else assert(errorFiles.length > 0, `${branch}: diagnostic evidence missing`);
    if (itemFiles.length) assert(itemFiles.every(text => text.includes('"diagnostic"') && !text.includes('"request": {\n    "args"')));
  });
}
