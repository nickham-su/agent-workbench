import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { projectGitDiagnostic, projectGitDiagnosticDetail, diagnosticToolArgs, diagnosticToolRequest } from "./gitDiagnostic.js";
import { GitToolError } from "./gitErrors.js";
import { createGitFixture, successfulGitProcessResult } from "./git.testkit.js";

const secret = "fixture-argv-secret-sentinel";
const privatePath = "/fixture-private-lease/sentinel-path";
const args = { repo: "fixture-repo", args: ["status", secret, privatePath], timeout: 7, env: { PRIVATE: secret } };
const execFileAsync = promisify(execFile);

function assertSafe(value: unknown) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes(secret), "raw argv/error sentinel escaped");
  assert(!serialized.includes(privatePath), "raw path sentinel escaped");
}

test("Git's single diagnostic projection excludes argv, environment, exception and nested output", () => {
  const error = Object.assign(new GitToolError("GIT_OUTPUT_GUARD_FAILED"), { cause: args, body: args });
  assert.deepEqual(projectGitDiagnostic(args, { stage: "preflight", error }), {
    toolName: "git", repo: "fixture-repo", argsCount: 3, timeout: 7, stage: "preflight", code: "GIT_OUTPUT_GUARD_FAILED",
  });
  for (const value of [diagnosticToolArgs("git", args), diagnosticToolRequest("git", "call", args),
    projectGitDiagnosticDetail(args, { output: { request: args, env: args.env, result: args } }, "writeback")]) assertSafe(value);
  assert.equal(diagnosticToolArgs("bash", args), args);
  assert.equal(diagnosticToolRequest("bash", "call", args).args, args);
});

test("Git projection does not execute accessors or trust a schema-valid but unguarded result", () => {
  let getterCalls = 0;
  const hostile = Object.defineProperties({}, {
    repo: { get() { getterCalls++; return secret; } }, args: { get() { getterCalls++; return args.args; } },
    timeout: { get() { getterCalls++; return 7; } }, code: { get() { getterCalls++; return secret; } },
    result: { get() { getterCalls++; return args; } },
  });
  assert.deepEqual(projectGitDiagnostic(hostile), { toolName: "git", repo: null, argsCount: null, timeout: null });
  assertSafe(projectGitDiagnostic(hostile, { error: hostile, result: hostile }));
  assertSafe(projectGitDiagnosticDetail(args, hostile, "writeback"));
  assert.equal(getterCalls, 0);
  const unguarded = { ...successfulGitProcessResult, repo: args.repo, leaseDisposition: "released", warnings: [], stdout: secret };
  assert.equal(projectGitDiagnostic(args, { result: unguarded }).result, undefined);
  for (const invalid of [{ repo: "../escape", args: secret, timeout: 0 }, { repo: " repo ", args: null, timeout: 3601 }]) {
    assert.deepEqual(projectGitDiagnostic(invalid), { toolName: "git", repo: null, argsCount: null, timeout: null });
  }
});

test("Git capture reprojects all four ingress points even when nested caller data is hostile", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const captureUrl = new URL("./toolErrorCapture.ts", import.meta.url).href;
  const diagnosticUrl = new URL("./gitDiagnostic.ts", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { createToolFailureCaptureIfEnabled } from ${JSON.stringify(captureUrl)};
    import { registerGitDiagnosticResult } from ${JSON.stringify(diagnosticUrl)};
    const args = ${JSON.stringify(args)};
    const safe = registerGitDiagnosticResult(${JSON.stringify({ ...successfulGitProcessResult, repo: args.repo, leaseDisposition: "released", warnings: [] })});
    for (const stage of ['provider_execute_rejected', 'running_writeback_failed', 'completed_writeback_failed', 'tool_disabled_pending_precheck']) {
      const capture = createToolFailureCaptureIfEnabled({ workspacePath: ${JSON.stringify(fixture.workspacePath)}, workspaceId: 'ws', sessionId: 'session', runId: 'run', toolExecutionId: stage, toolCallId: stage, toolName: 'git', toolSource: 'builtin' }, args);
      assert(capture);
      const error = Object.assign(new Error(${JSON.stringify(secret)}), { cause: args, body: args, partialResult: args });
      capture.recordProviderStarted(); capture.recordProviderResult(safe);
      capture.recordPartialResult('result', { ...safe, stdout: ${JSON.stringify(secret)} });
      capture.recordEvent(stage, error, { output: { result: safe, args, env: args.env }, request: args });
      capture.recordWritebackAttempt('completed', { result: safe, args, env: args.env });
      capture.recordWritebackSuccess('completed', { request: args, result: args });
      capture.recordWritebackAttempt('failed', { request: args, output: args });
      capture.recordWritebackFailure('failed', error);
      const published = await capture.publish(); assert(published.length > 0);
    }
  `;
  await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: path.resolve("."), env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
  });
  const files = await readFixtureFiles(path.join(fixture.workspacePath, ".awb", "agent", "tool-errors"));
  assert(files.length >= 4);
  for (const text of files) assertSafe(text);
  assert(files.some(text => text.includes("argsCount")));
  assert(files.some(text => text.includes("fixture success")));
});

export async function readFixtureFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await readFixtureFiles(file));
    else if (entry.isFile()) files.push(await fs.readFile(file, "utf8"));
  }
  return files;
}
