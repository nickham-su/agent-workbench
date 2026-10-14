import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { createAgentTestFixture, createTestWorkspace, createTestRepository } from "../agent/testkit/agent-testkit.js";
import { appendMessage, createMessageSession, createMessageRunRecord, getMessageSession, startMessageRun } from "../agent/agent-message.store.js";
import { setSettingJson } from "../settings/settings.store.js";
import { insertCredential } from "../credentials/credentials.store.js";
import { encryptUtf8 } from "../../infra/crypto/secretBox.js";
import { newSortableId } from "../../utils/ids.js";
import type { RepoGitEnvLeaseMeta } from "./git-env.lease.js";

export async function createGitLeaseFixture(t: TestContext, options: { repoName?: string } = {}) {
  const repoRoot = path.resolve(process.cwd(), "../..");
  await fs.mkdir(path.join(repoRoot, ".tmp-tests", "0032-stage2"), { recursive: true });
  const base = await createAgentTestFixture({ repoRoot, dataDirPrefix: "0032-stage2/lease-" });
  t.after(() => base.dispose());
  const workspace = await createTestWorkspace(base);
  const repository = await createTestRepository(base, { workspace, dirName: options.repoName ?? "测试 repo" });
  setSettingJson(base.db, "agent_providers_v1", {
    default: { providerId: "test", modelId: "test-model" },
    providers: [{ id: "test", name: "test", npm: "@ai-sdk/openai", options: { baseURL: "https://provider.example.test/v1", apiKey: "fixture-provider" }, models: [{ id: "test-model", name: "test-model", contextWindowTokens: 128000 }] }],
  }, Date.now());
  setSettingJson(base.db, "agent_agents_v1", { agents: [{ id: "test", name: "test", tools: ["git"], defaultModel: { providerId: "test", modelId: "test-model" }, scope: "both" }] }, Date.now());
  const owner = { workspaceId: workspace.id, sessionId: newSortableId("sess"), runId: newSortableId("run"), toolExecutionId: newSortableId("exec") };
  const now = Date.now();
  createMessageSession(base.db, { id: owner.sessionId, workspaceId: workspace.id, title: "Git lease fixture", kind: "primary", createdAt: now });
  let head = getMessageSession(base.db, workspace.id, owner.sessionId)!;
  const triggerMessageId = newSortableId("msg");
  appendMessage(base.db, { id: triggerMessageId, workspaceId: workspace.id, sessionId: owner.sessionId, expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision, type: "user", status: "completed", originRunId: null, parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "fixture" }], createdAt: now });
  createMessageRunRecord(base.db, { ...owner, triggerMessageId, agentId: "test", providerId: "test", modelId: "test-model", status: "running", createdAt: now });
  startMessageRun(base.db, { ...owner, updatedAt: now });
  head = getMessageSession(base.db, workspace.id, owner.sessionId)!;
  const callPartId = newSortableId("part");
  appendMessage(base.db, { id: newSortableId("msg"), workspaceId: workspace.id, sessionId: owner.sessionId, expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision, type: "assistant", status: "completed", originRunId: owner.runId,
    parts: [{ id: callPartId, position: 0, type: "tool_call", toolName: "git", input: { repo: repository.workspaceRepo.dirName, args: ["status"] } }], createdAt: now });
  base.db.prepare(`insert into agent_tool_execution (id,call_part_id,origin_session_id,origin_run_id,status,updated_revision,created_at,updated_at,started_at) values (?, ?, ?, ?, 'running', 0, ?, ?, ?)`)
    .run(owner.toolExecutionId, callPartId, owner.sessionId, owner.runId, now, now, now);
  const request = { ...owner, repo: repository.workspaceRepo.dirName, timeoutMs: 120_000 };
  const systemCa = path.join(base.dataDir, "test-system-ca.pem");
  await fs.writeFile(systemCa, "fixture CA\n");
  const previousCa = process.env.SSL_CERT_FILE;
  process.env.SSL_CERT_FILE = systemCa; // prevents CA builder reading a host system certificate.
  t.after(() => { if (previousCa === undefined) delete process.env.SSL_CERT_FILE; else process.env.SSL_CERT_FILE = previousCa; });
  return { ...base, workspace, repository, owner, request, callPartId };
}
export type GitLeaseFixture = Awaited<ReturnType<typeof createGitLeaseFixture>>;

export function addFixtureCredential(f: GitLeaseFixture, options: { kind?: "https" | "ssh"; secret?: string; isDefault?: boolean; host?: string; updatedAt?: number; invalidCipher?: boolean } = {}) {
  const id = newSortableId("cred");
  insertCredential(f.db, { id, host: options.host ?? "example.test", kind: options.kind ?? "https", label: "fixture", username: "fixture-user", isDefault: options.isDefault ?? true, createdAt: 1, updatedAt: options.updatedAt ?? 1,
    secretEnc: options.invalidCipher ? "invalid-fixture-cipher" : encryptUtf8({ key: f.ctx.credentialMasterKey, plaintext: options.secret ?? "fixture-secret-marker" }) });
  return id;
}

export function leaseMeta(f: GitLeaseFixture, options: Partial<RepoGitEnvLeaseMeta> = {}): RepoGitEnvLeaseMeta {
  const timeoutMs = options.timeoutMs ?? 120_000, now = options.createdAt ? Date.parse(options.createdAt) : Date.now();
  return { ...f.owner, schemaVersion: 2, purpose: "git", leaseId: newSortableId("lease"), repo: f.request.repo, repoId: f.repository.repo.id, kind: "none", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + Math.max(15 * 60_000, timeoutMs + 5 * 60_000)).toISOString(), timeoutMs, stopState: "unconfirmed", ...options };
}

export function assertCode(expectedCode: string) {
  return (error: unknown) => { assert.equal((error as { code?: string }).code, expectedCode); return true; };
}
