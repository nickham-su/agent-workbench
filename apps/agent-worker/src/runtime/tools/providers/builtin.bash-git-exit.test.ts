import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import type { ExecutionProfile, PromptContext, AgentApiClient } from "../../apiClient.js";
import type { ToolExecutionContext } from "../types.js";
import { BuiltinToolProvider } from "./builtin.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "awb-bash-git-exit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const forbidden = (name: string) => async () => { calls.push(name); throw new Error("Bash must not request a project Git lease"); };
  const apiClient = {
    getWorkspaceEnvironment: async (workspaceId: string) => ({ workspaceId, env: {} }),
    prepareGitEnvForBash: forbidden("legacy-prepare"),
    cleanupGitEnvLease: forbidden("legacy-cleanup"),
    prepareRepoGitEnvLease: forbidden("repo-prepare"),
    releaseRepoGitEnvLease: forbidden("repo-release"),
  } as unknown as AgentApiClient;
  const context: ToolExecutionContext = {
    profile: { agent: { tools: ["bash"] } } as ExecutionProfile,
    run: { workspaceId: "workspace-fixture", sessionId: "session-fixture", runId: "run-fixture", workspacePath: root, workspaceRepoDirNames: [] },
    pendingTool: { toolExecutionId: "tool-fixture", callPartId: "part-fixture", assistantMessageId: "message-fixture", status: "queued", toolName: "bash", toolCallId: "call-fixture", args: {} },
    signal: new AbortController().signal,
    apiClient,
    promptContext: { headMessageId: null, sessionRevision: 0, system: "", messages: [], tools: [], pendingTools: [], lastResponseTotalTokens: null, uiLocale: null, externalSkills: [], workspaceRepoNames: [] } as PromptContext,
    processNestedRun: async () => undefined,
    updateToolExecution: async () => undefined,
    nowMs: () => Date.now(),
    renderToolText: () => "rendered",
  };
  return { root, calls, context, provider: new BuiltinToolProvider() };
}

const commands = [
  "git --version",
  "git ls-remote --invalid-option",
  "printf 'fixture;'; git fetch --invalid-option",
  "bash -c 'git push --invalid-option'",
  "/usr/bin/git ls-remote --invalid-option",
  "fixture_git() { git submodule --invalid-option; }; fixture_git",
  "env git pull --invalid-option",
];

for (const command of commands) test(`AC-BASH-EXIT-COMMANDS: no project lease for ${command}`, async (t) => {
  const f = await fixture(t);
  const args = { command, timeout: 5 };
  f.context.pendingTool.args = args;
  const result = await f.provider.execute("bash", args, f.context) as { command: string; exitCode: number | null; stdout: string; stderr: string };
  assert.equal(result.command, command);
  assert.equal(typeof result.exitCode, "number");
  assert.deepEqual(f.calls, []);
  assert.equal(f.context.pendingTool.toolName, "bash");
  assert.deepEqual(f.context.pendingTool.args, args);
  assert.deepEqual(await fs.readdir(f.root), []);
});

for (const inherited of [undefined, "fixture-host-value"]) test(`AC-BASH-EXIT-PROMPT/AC-ENV-BASH: plain Bash retains ordinary host environment but excludes AWB controls (${inherited ?? "unset"})`, async (t) => {
  const f = await fixture(t);
  const before = process.env.GIT_TERMINAL_PROMPT;
  const beforeInternal = process.env.AWB_STAGE4_ENV_SENTINEL;
  if (inherited === undefined) delete process.env.GIT_TERMINAL_PROMPT;
  else process.env.GIT_TERMINAL_PROMPT = inherited;
  process.env.AWB_STAGE4_ENV_SENTINEL = "fixture-normal-bash-environment";
  try {
    const result = await f.provider.execute("bash", { command: "git --version >/dev/null; printf '%s|%s' \"${GIT_TERMINAL_PROMPT-unset}\" \"$AWB_STAGE4_ENV_SENTINEL\"", timeout: 5 }, f.context) as { stdout: string; exitCode: number };
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${inherited ?? "unset"}|`);
    assert.deepEqual(f.calls, []);
  } finally {
    if (before === undefined) delete process.env.GIT_TERMINAL_PROMPT; else process.env.GIT_TERMINAL_PROMPT = before;
    if (beforeInternal === undefined) delete process.env.AWB_STAGE4_ENV_SENTINEL; else process.env.AWB_STAGE4_ENV_SENTINEL = beforeInternal;
  }
});

test("AC-ENABLEMENT-DISABLED: a historical Git name does not grant provider execution", async (t) => {
  const f = await fixture(t);
  f.context.pendingTool.toolName = "git";
  f.context.pendingTool.args = { repo: "fixture", args: ["status"] };
  assert.equal(f.provider.isToolEnabled("git", f.context), false);
  await assert.rejects(f.provider.execute("git", f.context.pendingTool.args, f.context), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GIT_TOOL_DISABLED");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("AC-BASH-EXIT-SYSTEM: fixture credential helper may authenticate without project injection", async (t) => {
  const f = await fixture(t);
  let authenticated = 0;
  const expected = `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`;
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
      response.end(); return;
    }
    authenticated++;
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(request.url?.endsWith("/HEAD") ? "ref: refs/heads/main\n" : "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address === "object");
  // Explicit fixture helper output goes only to Git's credential protocol, not the tool result.
  const helper = path.join(f.root, "credential-helper.sh");
  await fs.writeFile(helper, "#!/bin/sh\nif [ \"$1\" = get ]; then printf '%s\\n' username=fixture-user password=fixture-password; fi\n", { mode: 0o700 });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `git -c http.proxy= -c credential.helper= -c ${quote(`credential.helper=!${quote(helper)}`)} ls-remote http://127.0.0.1:${address.port}/fixture.git`;
  const result = await f.provider.execute("bash", { command, timeout: 5 }, f.context) as { exitCode: number; stdout: string; stderr: string };
  assert.equal(result.exitCode, 0, "isolated system helper should authenticate the controlled endpoint");
  assert(authenticated > 0);
  assert.deepEqual(f.calls, []);
  assert(!result.stdout.includes("fixture-password"));
  assert(!result.stderr.includes("fixture-password"));
});
