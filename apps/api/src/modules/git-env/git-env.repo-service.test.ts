import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { Value } from "@sinclair/typebox/value";
import { AgentGitToolEndpoints, PrepareRepoGitEnvResponseSchema } from "@agent-workbench/shared/internal-contracts/agent-api";
import { prepareRepoGitEnvLease } from "./git-env.repo-service.js";
import { registerGitEnvRoutes } from "./git-env.routes.js";
import { assertNoRepoGitEnvLeaseHold, inspectRepoGitEnvLease, listRepoGitEnvLeaseIds, releaseRepoGitEnvLease } from "./git-env.lease.js";
import { cleanupExpiredGitEnvLeases } from "./git-env.janitor.js";
import { createGitLeaseFixture, addFixtureCredential, assertCode } from "./git-env.testkit.js";
import { setSettingJson } from "../settings/settings.store.js";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { createTestRepository } from "../agent/testkit/agent-testkit.js";

for (const kind of ["none", "https", "ssh"] as const) test(`AC-AUTH-BOUND/NONE/LEASE-DEFAULT-HOLD: registered repository produces a complete ${kind} lease`, async (t) => {
  const f = await createGitLeaseFixture(t);
  const terminalId = addFixtureCredential(f, { kind: "https", secret: "fixture-terminal-identity", host: "terminal.test", isDefault: false });
  f.db.prepare("update workspaces set terminal_credential_id=? where id=?").run(terminalId, f.workspace.id);
  if (kind !== "none") {
    const id = addFixtureCredential(f, { kind, secret: "fixture-repository-identity" });
    f.db.prepare("update repos set credential_id=? where id=?").run(id, f.repository.repo.id);
  }
  const result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request });
  assert(result.ok); assert(Value.Check(PrepareRepoGitEnvResponseSchema, result));
  assert.equal(result.kind, kind); assert.equal(result.repo, f.request.repo); assert(result.leaseId);
  assert.equal(result.sensitiveFilePaths.length, kind === "none" ? 0 : 1);
  if (kind !== "none") assert.equal(await fs.readFile(result.sensitiveFilePaths[0], "utf-8"), "fixture-repository-identity");
  const current = await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: result.leaseId });
  assert.equal(current?.meta?.kind, kind); assert.equal(current?.state, "unconfirmed");
  assert.deepEqual(current?.meta && { workspaceId: current.meta.workspaceId, sessionId: current.meta.sessionId, runId: current.meta.runId, toolExecutionId: current.meta.toolExecutionId }, f.owner);
  await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id }), assertCode("REPO_GIT_BUSY"));
  await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: result.leaseId, stopEvidence: "not_started" } });
});

for (const field of ["workspaceId", "sessionId", "runId", "toolExecutionId"] as const) test(`AC-REPO-FOREIGN/TOOL-OWNER: ${field} mismatch fails before list/credentials`, async (t) => {
  const f = await createGitLeaseFixture(t); addFixtureCredential(f);
  const result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: { ...f.request, [field]: "foreign" } });
  assert(!result.ok); assert.equal(result.errorCode, "RUN_CONTEXT_INVALID"); assert(!("availableRepos" in result));
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
});

test("AC-REPO-TOOL-OWNER: non-git, copied origin, queued and finished tool executions cannot prepare", async (t) => {
  const f = await createGitLeaseFixture(t);
  f.db.prepare("update agent_message_part set tool_name='bash' where id=?").run(f.callPartId);
  let result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(!result.ok); assert.equal(result.errorCode, "RUN_CONTEXT_INVALID");
  f.db.prepare("update agent_message_part set tool_name='git' where id=?").run(f.callPartId);
  for (const status of ["queued", "completed", "failed", "unknown"]) {
    f.db.prepare("update agent_tool_execution set status=? where id=?").run(status, f.owner.toolExecutionId);
    result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(!result.ok); assert.equal(result.errorCode, "RUN_NOT_EXECUTABLE");
  }
  f.db.prepare("update agent_tool_execution set status='running', origin_run_id=null where id=?").run(f.owner.toolExecutionId);
  result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(!result.ok); assert.equal(result.errorCode, "RUN_CONTEXT_INVALID");
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
});

test("AC-ENABLEMENT-DISABLED: live profile and Workspace enablement are enforced before admission", async (t) => {
  const f = await createGitLeaseFixture(t);
  setSettingJson(f.db, "agent_agents_v1", { agents: [{ id: "test", name: "test", tools: ["bash"], defaultModel: { providerId: "test", modelId: "test-model" } }] }, Date.now());
  let result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(!result.ok); assert.equal(result.errorCode, "GIT_TOOL_DISABLED");
  setSettingJson(f.db, "agent_agents_v1", { agents: [{ id: "test", name: "test", tools: ["git"], defaultModel: { providerId: "test", modelId: "test-model" } }] }, Date.now());
  setSettingJson(f.db, "workspace_agent_enablement_v1", { workspaces: { [f.workspace.id]: { mode: "subset", enabledAgentIds: [] } } }, Date.now());
  result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(!result.ok); assert.equal(result.errorCode, "GIT_TOOL_DISABLED");
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
});

test("AC-REPO-EXACT/REMOVED: admission uses the latest exact registered name", async (t) => {
  const f = await createGitLeaseFixture(t);
  for (const repo of ["测试", "测试 repo ", "测试 REPO", "other"]) {
    const result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: { ...f.request, repo } });
    assert(!result.ok);
    assert.equal(result.errorCode, repo.trim() !== repo ? "GIT_INPUT_INVALID" : "REPO_NOT_AVAILABLE");
  }
  f.db.prepare("delete from workspace_repos where workspace_id=?").run(f.workspace.id);
  const result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(!result.ok); assert.equal(result.errorCode, "REPO_NOT_AVAILABLE"); assert.deepEqual(result.availableRepos, []);
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
});

test("AC-REPO-LARGE: prepare accepts the 101st registered repository and reports the full list", async (t) => {
  const f = await createGitLeaseFixture(t);
  for (let index = 0; index < 100; index++) await createTestRepository(f, { workspace: f.workspace, dirName: `repo-${String(index).padStart(3, "0")}` });
  const unavailable = await prepareRepoGitEnvLease({ ctx: f.ctx, request: { ...f.request, repo: "not-registered" } });
  assert(!unavailable.ok); assert.equal(unavailable.availableRepos?.length, 101);
  const last = unavailable.availableRepos![100];
  const prepared = await prepareRepoGitEnvLease({ ctx: f.ctx, request: { ...f.request, repo: last } });
  assert(prepared.ok); assert.equal(prepared.repo, last);
  await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: prepared.leaseId, stopEvidence: "not_started" } });
});

for (const pathProblem of ["missing", "file", "mismatched", "outside-symlink", "workspace-symlink"] as const) test(`AC-REPO-INITIAL-PATH/SYMLINK: ${pathProblem} cannot create a lease`, async (t) => {
  const f = await createGitLeaseFixture(t), dir = f.repository.workspaceRepo.path;
  if (pathProblem === "mismatched") f.db.prepare("update workspace_repos set path=? where workspace_id=?").run(path.join(f.workspace.path, "wrong"), f.workspace.id);
  else if (pathProblem === "workspace-symlink") {
    const moved = `${f.workspace.path}-moved`; await fs.rename(f.workspace.path, moved); await fs.symlink(moved, f.workspace.path);
  } else {
    await fs.rmdir(dir);
    if (pathProblem === "file") await fs.writeFile(dir, "fixture");
    if (pathProblem === "outside-symlink") { const outside = path.join(f.dataDir, "outside-fixture"); await fs.mkdir(outside); await fs.symlink(outside, dir); }
  }
  const result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(!result.ok); assert.equal(result.errorCode, "REPO_PATH_INVALID");
  assert(!JSON.stringify(result).includes(f.dataDir)); assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
});

for (const mode of ["missing", "decrypt"] as const) test(`AC-AUTH-MISSING/DECRYPT: ${mode} binding does not switch to host default or leak a failure path`, async (t) => {
  const f = await createGitLeaseFixture(t); addFixtureCredential(f);
  const id = mode === "missing" ? "missing-bound-fixture" : addFixtureCredential(f, { invalidCipher: true, isDefault: false });
  f.db.pragma("foreign_keys = OFF"); f.db.prepare("update repos set credential_id=? where id=?").run(id, f.repository.repo.id); f.db.pragma("foreign_keys = ON");
  const result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(!result.ok);
  assert.equal(result.errorCode, mode === "missing" ? "CREDENTIAL_NOT_FOUND" : "CREDENTIAL_DECRYPT_FAILED");
  assert(!JSON.stringify(result).includes(f.dataDir)); assert(!JSON.stringify(result).includes("fixture-secret-marker"));
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
});

test("AC-REPO-ADMISSION/RPC-CANCEL: run terminal transition during build prevents delivery and cleans known unstarted lease", async (t) => {
  const f = await createGitLeaseFixture(t); addFixtureCredential(f);
  const original = fs.open; let cancelled = false;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await original(...args);
    if (String(args[0]).endsWith("/git-askpass-token") && !cancelled) {
      cancelled = true;
      f.db.prepare("update agent_run set status='cancelled', execution_phase='terminal', terminal_result_code='run_cancelled' where run_id=?").run(f.owner.runId);
      f.db.prepare("update session_run_state set status='idle', active_run_id=null where session_id=?").run(f.owner.sessionId);
    }
    return file;
  });
  try {
    const result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(!result.ok); assert.equal(result.errorCode, "RUN_NOT_EXECUTABLE");
  } finally { mock.mock.restore(); }
  assert(cancelled); assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
});

for (const removeFails of [false, true]) test(`AC-LEASE-HOLD-WRITE-FAIL/PARTIAL: no auth files created, cleanup failure=${removeFails} stays unknown`, async (t) => {
  const f = await createGitLeaseFixture(t); addFixtureCredential(f);
  const originalOpen = fs.open, originalRename = fs.rename, originalRmdir = fs.rmdir;
  let authWrites = 0;
  const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => { if (String(args[0]).includes("git-askpass")) authWrites++; return originalOpen(...args); });
  const renameMock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { if (String(args[1]).endsWith("/meta.json")) throw new Error("fixture initial meta failure"); return originalRename(...args); });
  const rmdirMock = t.mock.method(fs, "rmdir", async (...args: Parameters<typeof fs.rmdir>) => { if (removeFails && String(args[0]).includes("lease_")) throw new Error("fixture cleanup failure"); return originalRmdir(...args); });
  try {
    const result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(!result.ok); assert.equal(result.errorCode, "GIT_ENV_PREPARE_FAILED"); assert.equal(authWrites, 0);
  } finally { openMock.mock.restore(); renameMock.mock.restore(); rmdirMock.mock.restore(); }
  const ids = await listRepoGitEnvLeaseIds(f.dataDir); assert.equal(ids.length, removeFails ? 1 : 0);
  if (removeFails) await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: "unrelated" }), assertCode("GIT_LEASE_STATE_UNAVAILABLE"));
});

test("AC-RPC-RESPONSE-LOSS/LEASE-HOLD-EXPIRED: completed prepare without received response remains held beyond 65 minutes", async (t) => {
  const f = await createGitLeaseFixture(t), result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(result.ok);
  // Simulate response discard: no Worker receives/calls release. TTL is not evidence.
  const nowMs = Date.parse(result.expiresAt) + 24 * 60 * 60_000;
  await cleanupExpiredGitEnvLeases({ dataDir: f.dataDir, nowMs });
  assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: result.leaseId }))?.state, "unconfirmed");
  await assert.rejects(assertNoRepoGitEnvLeaseHold({ dataDir: f.dataDir, workspaceId: f.workspace.id, nowMs }), assertCode("REPO_GIT_BUSY"));
});

test("AC-RPC-AUTH/SCHEMA/SURFACE: both endpoints reject invalid token, unknown fields, coercion, PGID and maintenance authority", async (t) => {
  const f = await createGitLeaseFixture(t), app = Fastify({ logger: false }); t.after(() => app.close());
  app.setErrorHandler((error, _req, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ message: error instanceof Error ? error.message : "Request failed", code: (error as { code?: string }).code }));
  await registerGitEnvRoutes(app, f.ctx); await app.ready();
  const prepareUrl = AgentGitToolEndpoints.prepareRepoGitEnvLease.path, releaseUrl = AgentGitToolEndpoints.releaseRepoGitEnvLease.path;
  for (const token of [undefined, "wrong"]) for (const url of [prepareUrl, releaseUrl]) {
    const response = await app.inject({ method: "POST", url, payload: f.request, headers: token ? { "x-awb-agent-internal-token": token } : {} }); assert.equal(response.statusCode, 401);
  }
  const headers = { "x-awb-agent-internal-token": f.internalToken };
  for (const extra of [{ cwd: f.workspace.path }, { args: ["status"] }, { credentialId: "fake" }, { env: {} }, { purpose: "bash" }, { timeoutMs: "120000" }, { repo: 1 }, { mode: "maintenance" }]) {
    const response = await app.inject({ method: "POST", url: prepareUrl, payload: { ...f.request, ...extra }, headers }); assert.equal(response.statusCode, 400);
  }
  const prepared = await app.inject({ method: "POST", url: prepareUrl, payload: f.request, headers }); assert.equal(prepared.statusCode, 200);
  const result = prepared.json(); assert(result.ok);
  const release = { ...f.owner, leaseId: result.leaseId, stopEvidence: "not_started" };
  for (const extra of [{ pgid: 42 }, { mode: "maintenance" }, { expectedState: "unreadable" }, { stopEvidence: "worker_exited" }, { env: {} }]) {
    const response = await app.inject({ method: "POST", url: releaseUrl, payload: { ...release, ...extra }, headers }); assert.equal(response.statusCode, 400);
  }
  const foreign = await app.inject({ method: "POST", url: releaseUrl, payload: { ...release, runId: "foreign" }, headers }); assert.equal(foreign.statusCode, 403);
  const done = await app.inject({ method: "POST", url: releaseUrl, payload: release, headers }); assert.equal(done.statusCode, 200); assert.deepEqual(done.json(), { ok: true });
  const repeated = await app.inject({ method: "POST", url: releaseUrl, payload: release, headers }); assert.equal(repeated.statusCode, 200);
});

test("AC-CONCURRENCY-DELETE: deletion fence rejects prepare before allocation", async (t) => {
  const f = await createGitLeaseFixture(t); workspaceDeletingFence.begin(f.workspace.id);
  try {
    const result = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(!result.ok); assert.equal(result.errorCode, "WORKSPACE_DELETING");
    assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
  } finally { workspaceDeletingFence.end(f.workspace.id); }
});

test("AC-AUTH-ROTATE: delivered lease retains its credential snapshot and the next prepare uses the new binding", async (t) => {
  const f = await createGitLeaseFixture(t);
  const oldId = addFixtureCredential(f, { secret: "fixture-old-identity" });
  f.db.prepare("update repos set credential_id=? where id=?").run(oldId, f.repository.repo.id);
  const first = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(first.ok);
  const newId = addFixtureCredential(f, { secret: "fixture-new-identity", isDefault: false });
  f.db.prepare("update repos set credential_id=? where id=?").run(newId, f.repository.repo.id);
  const second = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(second.ok);
  assert.notEqual(first.leaseId, second.leaseId);
  assert.equal(await fs.readFile(first.sensitiveFilePaths[0], "utf-8"), "fixture-old-identity");
  assert.equal(await fs.readFile(second.sensitiveFilePaths[0], "utf-8"), "fixture-new-identity");
  for (const result of [first, second]) await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: result.leaseId, stopEvidence: "not_started" } });
});

test("AC-BASH-EXIT-ENDPOINTS: retired Bash RPCs are 404 and cannot create or delete a v2 lease", async (t) => {
  const f = await createGitLeaseFixture(t);
  const app = Fastify();
  t.after(() => app.close());
  await registerGitEnvRoutes(app, f.ctx);
  const prepared = await prepareRepoGitEnvLease({ ctx: f.ctx, request: f.request }); assert(prepared.ok);
  const headers = { "x-awb-agent-internal-token": f.ctx.agentInternalToken };
  const retiredEndpoints: Array<{ url: string; payload: Record<string, string> }> = [
    { url: "/api/internal/git-env/prepare", payload: { workspaceId: f.workspace.id, cwd: f.workspace.path, purpose: "bash" } },
    { url: "/api/internal/git-env/cleanup", payload: { leaseId: prepared.leaseId } },
  ];
  for (const auth of [{}, headers]) {
    for (const endpoint of retiredEndpoints) {
      const response = await app.inject({ method: "POST", ...endpoint, headers: auth });
      assert.equal(response.statusCode, 404);
    }
  }
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), [prepared.leaseId]);
  assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: prepared.leaseId }))?.state, "unconfirmed");
  await releaseRepoGitEnvLease({ dataDir: f.dataDir, request: { ...f.owner, leaseId: prepared.leaseId, stopEvidence: "not_started" } });
});
