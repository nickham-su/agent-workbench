import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import { AgentApiEndpoints, AgentApiFencedWriteResponseSchema, AgentApiUpdateToolExecutionRequestSchema, AgentGitToolEndpoints, GitToolResultSchema, type AgentApiUpdateToolExecutionRequest, type GitToolResult } from "@agent-workbench/shared/internal-contracts/agent-api";
import { Value } from "@sinclair/typebox/value";
import { registerGitEnvRoutes } from "./git-env.routes.js";
import { createGitLeaseFixture, addFixtureCredential, assertCode } from "./git-env.testkit.js";
import { inspectRepoGitEnvLease, listRepoGitEnvLeaseIds, assertNoRepoGitEnvLeaseHold } from "./git-env.lease.js";
import { runGitLeaseRecoveryCli } from "../../maintenance/git-lease-recovery.js";
import { cleanupExpiredGitEnvLeases } from "./git-env.janitor.js";
import { createTestRepository } from "../agent/testkit/agent-testkit.js";

const workerGit = await import(new URL("../../../../agent-worker/src/runtime/git.ts", import.meta.url).href);
const workerClient = await import(new URL("../../../../agent-worker/src/runtime/apiClient.ts", import.meta.url).href);
const workerRunner = await import(new URL("../../../../agent-worker/src/runtime/runner.ts", import.meta.url).href);
const workerErrors = await import(new URL("../../../../agent-worker/src/runtime/gitErrors.ts", import.meta.url).href);
async function fixture(t: TestContext) {
  const f = await createGitLeaseFixture(t, { repoName: "integration-repo" });
  execFileSync("git", ["init", "--quiet"], { cwd: f.repository.workspaceRepo.path, stdio: "pipe" });
  const app = Fastify({ logger: false });
  let prepareCount = 0, releaseCount = 0, losePrepareResponse = false, refuseRelease = false;
  let prepareResponseOverride: unknown;
  const writebacks: AgentApiUpdateToolExecutionRequest[] = [];
  app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ message: "Fixture request refused", code: (error as { code?: string }).code }));
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === AgentGitToolEndpoints.prepareRepoGitEnvLease.path) prepareCount++;
    if (request.url === AgentGitToolEndpoints.releaseRepoGitEnvLease.path) {
      releaseCount++;
      if (refuseRelease) reply.code(503).send({ message: "fixture unavailable" });
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (losePrepareResponse && request.url === AgentGitToolEndpoints.prepareRepoGitEnvLease.path) reply.raw.destroy();
    if (prepareResponseOverride !== undefined && request.url === AgentGitToolEndpoints.prepareRepoGitEnvLease.path) return JSON.stringify(prepareResponseOverride);
    return payload;
  });
  await registerGitEnvRoutes(app, f.ctx);
  // Observe the real client HTTP writeback boundary with the shared schemas.
  // Persistence/history behavior is covered by the separate result integration.
  app.post(AgentApiEndpoints.updateToolExecution.path, {
    schema: { body: AgentApiUpdateToolExecutionRequestSchema, response: { 200: AgentApiFencedWriteResponseSchema } },
  }, async (request) => {
    assert.equal(request.headers["x-awb-agent-internal-token"], f.internalToken);
    writebacks.push(request.body as AgentApiUpdateToolExecutionRequest);
    return { result: "updated" as const };
  });
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  t.after(() => app.close());
  const client = new workerClient.AgentApiClient({ apiOrigin: origin, internalToken: f.internalToken, internalRpcTimeoutMs: 2000, responseValidation: "strict", logger: { warn() {} } });
  const context = {
    profile: { agent: { tools: ["git"] } },
    run: { ...f.owner, workspacePath: f.workspace.path, workspaceRepoDirNames: ["obsolete-snapshot"] },
    pendingTool: { toolName: "git", toolExecutionId: f.owner.toolExecutionId, args: {}, status: "running" },
    apiClient: client, signal: new AbortController().signal,
    promptContext: { workspaceRepoNames: [f.request.repo] },
  };
  return { ...f, app, client, context, writebacks, execute: (args: string[], options: Record<string, unknown> = {}) => workerGit.executeGitTool({ repo: f.request.repo, args }, context, { dataDir: f.dataDir, ...options }) as Promise<GitToolResult>,
    get counts() { return { prepare: prepareCount, release: releaseCount }; },
    dropPrepare() { losePrepareResponse = true; }, failRelease() { refuseRelease = true; },
    replacePrepareResponse(response: unknown) { prepareResponseOverride = response; },
  };
}
async function recover(f: Awaited<ReturnType<typeof fixture>>, leaseId: string) {
  await f.app.close(); // Preserve the CLI's exclusive, no-main-service precondition.
  let output = "", error = "";
  const io = { input: Readable.from([`RELEASE ${leaseId}\n`]), output: new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } }), error: new Writable({ write(chunk, _encoding, done) { error += String(chunk); done(); } }) };
  // Mechanical fixture confirmation only: this does not prove a real reboot or
  // deployed supervisor quiescence. No API/runtime startup happens in the CLI.
  const code = await runGitLeaseRecoveryCli(["release", "--data-dir", f.dataDir, "--lease-id", leaseId, "--expected-state", "unconfirmed", "--expected-owner", JSON.stringify(f.owner), "--window", "reboot_before_services", "--evidence-ref", "isolated-mechanical-fixture", "--confirm-services-stopped", "--confirm-startup-disabled", "--confirm-exclusive-window", "--confirm-coverage"], { io });
  assert.equal(code, 0, error); assert.match(output, /"operatorAssertionsOnly":true/);
  assert.equal(await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId }), null);
}

test("AC-INTEGRATION: real API prepare -> native Worker Git -> guarded result -> owner release", async (t) => {
  const f = await fixture(t);
  execFileSync("git", ["init", "--quiet"], { cwd: f.repository.workspaceRepo.path, stdio: "pipe" });
  const result = await f.execute(["status", "--short"]);
  assert(Value.Check(GitToolResultSchema, result));
  assert.equal(result.ok, true); assert.equal(result.leaseDisposition, "released");
  assert.deepEqual(f.counts, { prepare: 1, release: 1 });
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
  assert(!JSON.stringify(result).includes(f.dataDir));
});

test("AC-INTEGRATION/RETRY-NATIVE/INPUT-GIT-PREFIX/CONCURRENCY-NATIVE: native errors stay unchanged without Bash fallback or retry", async (t) => {
  const f = await fixture(t), result = await f.execute(["--fixture-unknown-option"]);
  assert.equal(result.ok, false); assert.notEqual(result.exitCode, 0);
  assert.equal(result.processStopConfirmed, true); assert.equal(result.leaseDisposition, "released");
  assert.deepEqual(f.counts, { prepare: 1, release: 1 });
  assert.match(result.stderr, /unknown option/);
  const prefixed = await f.execute(["git", "status"]);
  assert.equal(prefixed.ok, false); assert.notEqual(prefixed.exitCode, 0);
  assert.match(prefixed.stderr, /not a git command/);
  assert.deepEqual(f.counts, { prepare: 2, release: 2 });
  const lock = path.join(f.repository.workspaceRepo.path, ".git/index.lock");
  await fs.writeFile(lock, "fixture native lock conflict");
  const conflict = await f.execute(["add", "--all"]);
  assert.equal(conflict.ok, false); assert.notEqual(conflict.exitCode, 0);
  assert.match(conflict.stderr, /index\.lock/);
  assert.equal(await fs.readFile(lock, "utf8"), "fixture native lock conflict");
  assert.deepEqual(f.counts, { prepare: 3, release: 3 });
});

test("AC-RPC-RESPONSE-LOSS/RECOVERY-VERIFY: real lost prepare response never spawns; TTL keeps hold until direct CLI recovery", async (t) => {
  const f = await fixture(t); f.dropPrepare();
  let spawns = 0;
  await assert.rejects(f.execute(["--version"], { runProcess: async () => { spawns++; throw new Error("must-not-start"); } }), assertCode("GIT_ENV_RPC_FAILED"));
  assert.equal(spawns, 0); assert.deepEqual(f.counts, { prepare: 1, release: 0 });
  const ids = await listRepoGitEnvLeaseIds(f.dataDir); assert.equal(ids.length, 1);
  await cleanupExpiredGitEnvLeases({ dataDir: f.dataDir, nowMs: Date.now() + 24 * 60 * 60_000 });
  await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id }), assertCode("REPO_GIT_BUSY"));
  await recover(f, ids[0]!);
  await assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id });
});

test("AC-RESULT-CLEANUP/RETRY-NATIVE: real Git side effect is not repeated when release RPC fails", async (t) => {
  const f = await fixture(t); f.failRelease();
  const marker = path.join(f.repository.workspaceRepo.path, "once.txt");
  const result = await f.execute(["-c", "alias.fixture-once=!printf fixture-once\\n >> once.txt", "fixture-once"]);
  assert.equal(result.ok, true); assert.equal(result.exitCode, 0);
  assert.equal(result.leaseDisposition, "release_unconfirmed"); assert.deepEqual(result.warnings, ["LEASE_CLEANUP_FAILED"]);
  assert.equal((await fs.readFile(marker, "utf8")).split("fixture-once").length - 1, 1);
  assert.deepEqual(f.counts, { prepare: 1, release: 1 });
  const ids = await listRepoGitEnvLeaseIds(f.dataDir); assert.equal(ids.length, 1);
  await recover(f, ids[0]!);
});

test("AC-RESULT-STOP-FAIL/CONCURRENCY-IDLE-HOLD: parent zero but unknown settlement retains real API lease through terminal run and CLI", async (t) => {
  const f = await fixture(t);
  const result = await f.execute(["--version"], { runProcess: async () => ({ ok: false, exitCode: 0, signal: null, timedOut: false, cancelled: false, outputLimitExceeded: false, processStopConfirmed: false, failureCode: "GIT_PROCESS_STOP_UNCONFIRMED", outputRedacted: false, stdout: "", stderr: "", durationMs: 1 }) });
  assert.equal(result.ok, false); assert.equal(result.exitCode, 0); assert.equal(result.leaseDisposition, "retained");
  assert.deepEqual(f.counts, { prepare: 1, release: 0 });
  f.db.prepare("update agent_run set status='completed', execution_phase='terminal', terminal_result_code='run_completed' where run_id=?").run(f.owner.runId);
  const ids = await listRepoGitEnvLeaseIds(f.dataDir); assert.equal(ids.length, 1);
  await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id }), assertCode("REPO_GIT_BUSY"));
  await recover(f, ids[0]!);
});

test("AC-RETRY-FALLBACK/REPO-REMOVED: failed binding or changed member does not spawn, change identity or prepare again", async (t) => {
  const f = await fixture(t), credentialId = addFixtureCredential(f);
  f.db.prepare("update repos set credential_id=? where id=?").run("missing-bound-credential", f.repository.repo.id);
  let spawns = 0;
  await assert.rejects(f.execute(["--version"], { runProcess: async () => { spawns++; } }), assertCode("CREDENTIAL_NOT_FOUND"));
  assert.equal(spawns, 0); assert.deepEqual(f.counts, { prepare: 1, release: 0 });
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
  f.db.prepare("update repos set credential_id=? where id=?").run(credentialId, f.repository.repo.id);
  f.db.prepare("delete from workspace_repos where workspace_id=?").run(f.workspace.id);
  await assert.rejects(f.execute(["--version"], { runProcess: async () => { spawns++; } }), (error: unknown) => {
    assertCode("REPO_NOT_AVAILABLE")(error);
    assert.match(workerErrors.gitSafeErrorText(error), /availableRepos: \[\]/);
    return true;
  });
  assert.equal(spawns, 0);
  assert.deepEqual(f.counts, { prepare: 2, release: 0 });
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
});

function repositoryList(text: string) {
  const line = text.split("\n").find((value) => value.startsWith("availableRepos: "));
  assert(line, "the model-visible error must include the latest repository array");
  return JSON.parse(line.slice("availableRepos: ".length));
}

async function writeUnavailableResult(f: Awaited<ReturnType<typeof fixture>>) {
  const args = { repo: f.request.repo, args: ["status", "fixture-private-argv"] };
  let providerCalls = 0, spawns = 0;
  const warnings: unknown[] = [];
  const runner = new workerRunner.AgentRunner(f.client, {}, { info() {}, error() {}, warn(value: unknown) { warnings.push(value); } }, 1, { dataDir: f.dataDir });
  runner.toolRegistry.execute = async (name: string, input: Record<string, unknown>, context: unknown) => {
    providerCalls++;
    assert.equal(name, "git");
    assert.deepEqual(input, args, "diagnostic handling cannot rewrite native arguments");
    return workerGit.executeGitTool(input, context, { dataDir: f.dataDir, runProcess: async () => { spawns++; throw new Error("fixture-must-not-start"); } });
  };
  const tool = { ...f.context.pendingTool, args, status: "queued", callPartId: f.callPartId, assistantMessageId: "fixture-message", toolCallId: "fixture-call" };
  await workerRunner.executeToolSafelyForTest(runner, { profile: f.context.profile, run: f.context.run, tool, parentSessionId: f.owner.sessionId, signal: f.context.signal, promptContext: f.context.promptContext });
  assert.equal(providerCalls, 1);
  assert.equal(spawns, 0);
  assert.deepEqual(f.counts, { prepare: 1, release: 0 }, "failed prepare must not retry or allocate a lease");
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
  assert.deepEqual(f.writebacks.map((value) => value.status), ["running", "failed"]);
  assert(!JSON.stringify({ writebacks: f.writebacks, warnings }).includes("fixture-private-argv"));
  assert.deepEqual(tool.args, args);
  return f.writebacks.at(-1)!;
}

test("AC-REPO-FOREIGN: real API owner rejection cannot expose registered names in Runner writeback", async (t) => {
  const f = await fixture(t);
  await createTestRepository(f, { workspace: f.workspace, dirName: "foreign-owner-private-repo" });
  f.context.run.sessionId = "not-the-owning-session";
  const failed = await writeUnavailableResult(f);
  assert.match(failed.error!, /^RUN_CONTEXT_INVALID:/);
  assert(!JSON.stringify(failed).includes("availableRepos"));
  assert(!JSON.stringify(failed).includes("foreign-owner-private-repo"));
  assert(!JSON.stringify(failed).includes(f.request.repo));
});

for (const mode of ["latest", "empty", "large", "quoted"] as const) {
  test(`AC-CONTEXT-EMPTY/REPO-REMOVED: real API and Runner error writeback include the latest safe repositories (${mode})`, async (t) => {
    const f = await fixture(t);
    // The queued call and prompt contain the old name; execute must read current DB members.
    f.db.prepare("delete from workspace_repos where workspace_id=?").run(f.workspace.id);
    const names = mode === "empty" ? [] : mode === "large"
      ? [...Array.from({ length: 100 }, (_, index) => `current-${String(index).padStart(3, "0")}`), 'last-"repo']
      : mode === "quoted" ? ['中文 "repo', "another repo"] : ["current-repo"];
    for (const dirName of names) await createTestRepository(f, { workspace: f.workspace, dirName });
    const failed = await writeUnavailableResult(f);
    assert.match(failed.error!, /^REPO_NOT_AVAILABLE:/);
    assert.deepEqual(repositoryList(failed.error!), names);
    assert.deepEqual(repositoryList(failed.resultPreview!), names, "final model tool result must preserve the list");
    if (mode === "large") assert.equal(repositoryList(failed.error!)[100], 'last-"repo');
    if (mode === "quoted") assert(failed.error!.includes(JSON.stringify('中文 "repo')));
    assert(!failed.error!.includes("obsolete-snapshot"));
  });
}

for (const [name, response, code] of [
  ["unknown error body", { ok: false, errorCode: "FIXTURE_UNKNOWN_FAILURE", error: "fixture-private-body", availableRepos: ["foreign-safe-repo"] }, "GIT_ENV_PREPARE_FAILED"],
  ["foreign owner error", { ok: false, errorCode: "RUN_CONTEXT_INVALID", error: "fixture-private-body", availableRepos: ["foreign-safe-repo"] }, "RUN_CONTEXT_INVALID"],
  ["unsafe list", { ok: false, errorCode: "REPO_NOT_AVAILABLE", error: "fixture-private-body", availableRepos: ["../fixture-private-body"] }, "GIT_ENV_RPC_FAILED"],
  ["unknown response field", { ok: false, errorCode: "REPO_NOT_AVAILABLE", error: "fixture-private-body", availableRepos: ["foreign-safe-repo"], credential: "fixture-private-body" }, "GIT_ENV_RPC_FAILED"],
] as const) {
  test(`Git API client and Runner reject repository details from ${name} without retry or leakage`, async (t) => {
    const f = await fixture(t);
    f.db.prepare("delete from workspace_repos where workspace_id=?").run(f.workspace.id);
    f.replacePrepareResponse(response);
    const failed = await writeUnavailableResult(f);
    assert(failed.error!.startsWith(`${code}:`));
    assert(!JSON.stringify(failed).includes("fixture-private-body"));
    assert(!JSON.stringify(failed).includes("foreign-safe-repo"));
    assert(!JSON.stringify(failed).includes("availableRepos"));
  });
}
