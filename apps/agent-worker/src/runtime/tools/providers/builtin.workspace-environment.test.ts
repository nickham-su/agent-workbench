import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentApiClient, ExecutionProfile, PromptContext } from "../../apiClient.js";
import type { ToolExecutionContext } from "../types.js";
import { BuiltinToolProvider } from "./builtin.js";

type ReadEnvironment = AgentApiClient["getWorkspaceEnvironment"];

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bash-env-"));
  const workspacePath = path.join(root, "workspace");
  const external = path.join(root, "external");
  await fs.mkdir(workspacePath); await fs.mkdir(external);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const calls: Array<{ workspaceId: string; signal: AbortSignal | undefined }> = [];
  let values: Record<string, string> = { ENV_FIXTURE_VALUE: "initial" };
  let read: ReadEnvironment = async (workspaceId) => ({ workspaceId, env: Object.freeze({ ...values }) });
  const apiClient = {
    getWorkspaceEnvironment: async (workspaceId: string, options?: { abortSignal?: AbortSignal }) => {
      calls.push({ workspaceId, signal: options?.abortSignal });
      return read(workspaceId, options);
    },
    prepareRepoGitEnvLease: async () => { throw new Error("bash must not request Git authentication"); },
    releaseRepoGitEnvLease: async () => { throw new Error("bash must not release Git authentication"); },
  } as unknown as AgentApiClient;
  const context: ToolExecutionContext = {
    profile: { agent: { tools: ["bash"] } } as ExecutionProfile,
    run: { workspaceId: "workspace-fixture", sessionId: "session-fixture", runId: "run-fixture", workspacePath, workspaceRepoDirNames: [] },
    pendingTool: { toolExecutionId: "tool-fixture", callPartId: "part-fixture", assistantMessageId: "message-fixture", status: "queued", toolName: "bash", toolCallId: "call-fixture", args: {} },
    signal: controller.signal, apiClient,
    promptContext: {} as PromptContext,
    processNestedRun: async () => undefined, updateToolExecution: async () => undefined,
    nowMs: Date.now, renderToolText: () => "rendered"
  };
  const provider = new BuiltinToolProvider();
  const execute = (command: string, workdir?: string) => provider.execute("bash", { command, timeout: 5, ...(workdir ? { workdir } : {}) }, context) as Promise<{ stdout: string; exitCode: number }>;
  return { root, external, context, controller, calls, execute, setValues: (env: Record<string, string>) => { values = env; }, setRead: (reader: ReadEnvironment) => { read = reader; } };
}

test("bash reads run Workspace each call, with external cwd and exact literal overrides", async (t) => {
  const f = await fixture(t);
  f.setValues({ ENV_FIXTURE_VALUE: "  $PATH\r\n$(printf expanded)  ", ENV_FIXTURE_EMPTY: "", HTTP_PROXY: "upper", http_proxy: "lower" });
  const result = await f.execute("printf '%s|%s|%s|%s|%s' \"$ENV_FIXTURE_VALUE\" \"${ENV_FIXTURE_EMPTY-unset}\" \"$HTTP_PROXY\" \"$http_proxy\" \"$PWD\"", f.external);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `  $PATH\r\n$(printf expanded)  ||upper|lower|${f.external}`);
  assert.deepEqual(f.calls, [{ workspaceId: "workspace-fixture", signal: f.controller.signal }]);
  f.setValues({ ENV_FIXTURE_VALUE: "next" });
  assert.equal((await f.execute("printf '%s' \"$ENV_FIXTURE_VALUE\"")).stdout, "next");
  assert.equal(f.calls.length, 2);
  assert.equal(process.env.ENV_FIXTURE_VALUE, undefined);
});

test("two Workspace bash calls do not share mutable snapshots", async (t) => {
  const a = await fixture(t); const b = await fixture(t);
  b.context.run.workspaceId = "workspace-b";
  a.setValues({ ENV_FIXTURE_VALUE: "workspace-a" });
  b.setValues({ ENV_FIXTURE_VALUE: "workspace-b" });
  const [first, second] = await Promise.all([a.execute("sleep 0.05; printf '%s' \"$ENV_FIXTURE_VALUE\""), b.execute("printf '%s' \"$ENV_FIXTURE_VALUE\"")]);
  assert.equal(first.stdout, "workspace-a"); assert.equal(second.stdout, "workspace-b");
  assert.equal(a.calls[0]?.workspaceId, "workspace-fixture"); assert.equal(b.calls[0]?.workspaceId, "workspace-b");
});

test("configuration changes do not alter an already captured bash environment", async (t) => {
  const f = await fixture(t);
  let captured!: () => void;
  const capture = new Promise<void>((resolve) => { captured = resolve; });
  f.setRead(async (workspaceId) => { captured(); return { workspaceId, env: { ENV_FIXTURE_VALUE: "old" } }; });
  const running = f.execute("sleep 0.05; printf '%s' \"$ENV_FIXTURE_VALUE\"");
  await capture;
  f.setRead(async (workspaceId) => ({ workspaceId, env: { ENV_FIXTURE_VALUE: "new" } }));
  assert.equal((await f.execute("printf '%s' \"$ENV_FIXTURE_VALUE\"")).stdout, "new");
  assert.equal((await running).stdout, "old");
});

test("environment read failures block bash and expose only a fixed error", async (t) => {
  const f = await fixture(t);
  f.setRead(async () => { throw new Error("private-config-value response-body-marker"); });
  await assert.rejects(f.execute("printf started > marker"), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.message, "Workspace environment configuration is unavailable.");
    assert.equal((error as NodeJS.ErrnoException).code, "WORKSPACE_ENV_UNAVAILABLE");
    assert(!JSON.stringify(error).includes("private-config-value"));
    return true;
  });
  assert.deepEqual(await fs.readdir(f.context.run.workspacePath), []);
});

for (const point of ["before-read", "during-read", "after-read"] as const) test(`cancellation ${point} blocks bash child creation`, async (t) => {
  const f = await fixture(t);
  if (point === "before-read") f.controller.abort();
  if (point === "during-read") {
    f.setRead(async (_workspaceId, options) => await new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener("abort", () => reject(new Error("private-abort-reason")), { once: true });
      queueMicrotask(() => f.controller.abort());
    }));
  }
  if (point === "after-read") f.setRead(async (workspaceId) => { f.controller.abort(); return { workspaceId, env: {} }; });
  await assert.rejects(f.execute("printf started > marker"), /^Error: aborted$/);
  assert.equal(f.calls.length, point === "before-read" ? 0 : 1);
  assert.deepEqual(await fs.readdir(f.context.run.workspacePath), []);
});

test("bash public schema retains command/workdir/timeout only", async () => {
  const source = await fs.readFile(new URL("../../../../../api/src/modules/agent/agent.composition.ts", import.meta.url), "utf8");
  const bash = source.slice(source.indexOf('if (toolName === "bash")'), source.indexOf('if (toolName === "read")'));
  assert(bash.includes('required: ["command"]'));
  assert(bash.includes("additionalProperties: false"));
  assert(bash.includes("command:")); assert(bash.includes("workdir:")); assert(bash.includes("timeout:"));
  assert(!/\benv\s*:/.test(bash));
});
