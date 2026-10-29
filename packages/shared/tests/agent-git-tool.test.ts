import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  AgentApiEndpoints,
  formatRepoGitSshCommand,
  AgentApiPromptContextResponseSchema,
  AgentGitToolEndpoints,
  GitRepoNameSchema,
  GitToolInputSchema,
  GitToolResultSchema,
  PrepareRepoGitEnvRequestSchema,
  PrepareRepoGitEnvResponseSchema,
  ReleaseRepoGitEnvRequestSchema,
  ReleaseRepoGitEnvResponseSchema,
} from "../src/internal-contracts/agent-api.js";
import { AgentCallableContextToolNameSchema, AgentContextToolNameSchema } from "../src/contracts/agent-primitives.js";
import { AgentToolNameSchema } from "../src/contracts/settings.js";

const owner = { workspaceId: "ws-a", sessionId: "session-a", runId: "run-a", toolExecutionId: "execution-a" };
const leaseId = "lease_00000000000000000000000000";
const prepared = { ok: true, repo: "repo-a", leaseId, expiresAt: "2026-10-14T14:00:00.000Z" };
const result = {
  repo: "repo-a", ok: true, exitCode: 0, signal: null,
  timedOut: false, cancelled: false, outputLimitExceeded: false,
  processStopConfirmed: true, failureCode: null, leaseDisposition: "released",
  outputRedacted: false, stdout: "", stderr: "", durationMs: 1, warnings: [],
};

test("Git input preserves native argv, accepts empty elements and limits integer seconds", () => {
  const input = { repo: "repo-a", args: ["", " ", "a\nb", "引号\"", "&&", "$(pwd)"] };
  assert.equal(Value.Check(GitToolInputSchema, input), true);
  assert.deepEqual(input.args, ["", " ", "a\nb", "引号\"", "&&", "$(pwd)"]);
  assert.equal(GitToolInputSchema.properties.timeout.default, 120);
  for (const timeout of [1, 120, 3600]) assert.equal(Value.Check(GitToolInputSchema, { ...input, timeout }), true);
  for (const timeout of [null, "1", 0, -1, 1.5, 3601]) assert.equal(Value.Check(GitToolInputSchema, { ...input, timeout }), false);
  for (const args of [[], "status", [1], ["stat\0us"]]) assert.equal(Value.Check(GitToolInputSchema, { ...input, args }), false);
  for (const name of ["workspaceId", "cwd", "env", "credentialId", "command", "action"]) {
    assert.equal(Value.Check(GitToolInputSchema, { ...input, [name]: "untrusted" }), false);
  }
  assert.equal(Value.Check(GitToolInputSchema, { repo: "repo-a", args: ["git", "status"] }), true);
  assert.equal(Value.Check(GitToolInputSchema, { args: ["status"] }), false);
});

test("repo names remain exact and reject unsafe names without normalizing them", () => {
  for (const repo of ["repo-a", "Repo A", "仓库", 'repo"quoted', "a", "...", "repo:a"]) {
    assert.equal(Value.Check(GitRepoNameSchema, repo), true);
  }
  for (const repo of ["", ".", "..", " repo", "repo ", "/repo", "repo/a", "repo\\a", "C:\\repo", "https://example.test/repo", "repo\n", "re\tpo", "re\u007fpo", "re\0po"]) {
    assert.equal(Value.Check(GitRepoNameSchema, repo), false);
  }
});

test("Git is callable, historical and configurable, with only prepare/release endpoints", () => {
  for (const schema of [AgentCallableContextToolNameSchema, AgentContextToolNameSchema, AgentToolNameSchema]) {
    assert.equal(Value.Check(schema, "git"), true);
  }
  assert.deepEqual(Object.keys(AgentGitToolEndpoints), ["prepareRepoGitEnvLease", "releaseRepoGitEnvLease"]);
  assert.equal(AgentApiEndpoints.prepareRepoGitEnvLease.path, "/api/internal/agent/git-env/prepare");
  assert.equal(AgentApiEndpoints.releaseRepoGitEnvLease.path, "/api/internal/agent/git-env/release");
});

test("lease requests require trusted owner and reject argv, paths, PGIDs and maintenance fields", () => {
  const input = { ...owner, repo: "repo-a", timeoutMs: 120000 };
  assert.equal(Value.Check(PrepareRepoGitEnvRequestSchema, input), true);
  for (const timeoutMs of [1000, 3600000]) assert.equal(Value.Check(PrepareRepoGitEnvRequestSchema, { ...input, timeoutMs }), true);
  for (const timeoutMs of [999, 1001, 3600001]) assert.equal(Value.Check(PrepareRepoGitEnvRequestSchema, { ...input, timeoutMs }), false);
  for (const key of ["cwd", "purpose", "env", "args", "credentialId"]) {
    assert.equal(Value.Check(PrepareRepoGitEnvRequestSchema, { ...input, [key]: "untrusted" }), false);
  }
  for (const key of Object.keys(owner)) {
    const missing = { ...input } as Record<string, unknown>;
    delete missing[key];
    assert.equal(Value.Check(PrepareRepoGitEnvRequestSchema, missing), false);
  }
  const release = { ...owner, leaseId, stopEvidence: "managed_group_absent" };
  assert.equal(Value.Check(ReleaseRepoGitEnvRequestSchema, release), true);
  assert.equal(Value.Check(ReleaseRepoGitEnvRequestSchema, { ...release, stopEvidence: "not_started" }), true);
  for (const key of ["pgid", "mode", "expectedOwner", "maintenance"]) {
    assert.equal(Value.Check(ReleaseRepoGitEnvRequestSchema, { ...release, [key]: "untrusted" }), false);
  }
  for (const id of ["..", "lease_a/b", "", "v2", "lease_bad"]) assert.equal(Value.Check(ReleaseRepoGitEnvRequestSchema, { ...release, leaseId: id }), false);
  assert.equal(Value.Check(ReleaseRepoGitEnvResponseSchema, { ok: true }), true);
  assert.equal(Value.Check(ReleaseRepoGitEnvResponseSchema, { ok: true, env: {} }), false);
});

test("prepare response strictly binds kind to whitelisted environment and sensitive-file count", () => {
  const none = { ...prepared, kind: "none", env: { GIT_TERMINAL_PROMPT: "0" }, sensitiveFilePaths: [] };
  const https = {
    ...prepared, kind: "https", env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/test/askpass", GIT_ASKPASS_USERNAME: "oauth2", GIT_ASKPASS_TOKEN_FILE: "/test/token" },
    sensitiveFilePaths: ["/test/token"],
  };
  const ssh = { ...prepared, kind: "ssh", env: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -i /test/key" }, sensitiveFilePaths: ["/test/key"] };
  for (const response of [none, https, ssh]) assert.equal(Value.Check(PrepareRepoGitEnvResponseSchema, response), true);
  for (const key of ["AWB_AGENT_INTERNAL_TOKEN", "PATH", "GIT_ASKPASS_TOKEN", "GIT_SSH"]) {
    assert.equal(Value.Check(PrepareRepoGitEnvResponseSchema, { ...none, env: { ...none.env, [key]: "sentinel" } }), false);
  }
  assert.equal(Value.Check(PrepareRepoGitEnvResponseSchema, { ...none, sensitiveFilePaths: ["/test/token"] }), false);
  assert.equal(Value.Check(PrepareRepoGitEnvResponseSchema, { ...https, kind: "none" }), false);
  assert.equal(Value.Check(PrepareRepoGitEnvResponseSchema, { ...https, sensitiveFilePaths: [] }), false);
  assert.equal(Value.Check(PrepareRepoGitEnvResponseSchema, { ...ssh, env: https.env }), false);
  assert.equal(Value.Check(PrepareRepoGitEnvResponseSchema, { ...none, env: { GIT_TERMINAL_PROMPT: 0 } }), false);
  assert.equal(Value.Check(PrepareRepoGitEnvResponseSchema, { ...none, env: { GIT_TERMINAL_PROMPT: "0", HTTP_PROXY: "bad\0proxy" } }), false);
  assert.equal(Value.Check(PrepareRepoGitEnvResponseSchema, { ...none, leaseId: null }), false);
  assert.equal(Value.Check(PrepareRepoGitEnvResponseSchema, { ok: false, errorCode: "REPO_NOT_AVAILABLE", error: "Repository unavailable", availableRepos: [] }), true);
});

test("structured results separate parent exit, stop confirmation and cleanup outcome", () => {
  assert.equal(Value.Check(GitToolResultSchema, result), true);
  assert.equal(Value.Check(GitToolResultSchema, { ...result, leaseDisposition: "release_unconfirmed", warnings: ["LEASE_CLEANUP_FAILED"] }), true);
  assert.equal(Value.Check(GitToolResultSchema, { ...result, ok: false, exitCode: 1 }), true);
  assert.equal(Value.Check(GitToolResultSchema, { ...result, ok: false, exitCode: null, signal: "SIGTERM", cancelled: true }), true);
  const retained = { ...result, ok: false, processStopConfirmed: false, failureCode: "GIT_PROCESS_STOP_UNCONFIRMED", leaseDisposition: "retained" };
  assert.equal(Value.Check(GitToolResultSchema, retained), true);
  for (const extra of [{ args: ["status"] }, { env: {} }, { leaseId }, { cwd: "/test" }, { timedOut: true }, { processStopConfirmed: false }, { exitCode: 1 }]) {
    assert.equal(Value.Check(GitToolResultSchema, { ...result, ...extra }), false);
  }
  assert.equal(Value.Check(GitToolResultSchema, { ...retained, ok: true }), false);
  assert.equal(Value.Check(GitToolResultSchema, { ...retained, leaseDisposition: "released" }), false);
});

test("prompt context requires the fresh registered-name field, including empty and >100 lists", () => {
  const prompt = { headMessageId: null, sessionRevision: 0, system: "", messages: [], tools: [], pendingTools: [], lastResponseTotalTokens: null, uiLocale: null, externalSkills: [] };
  assert.equal(Value.Check(AgentApiPromptContextResponseSchema, prompt), false);
  for (const workspaceRepoNames of [[], Array.from({ length: 101 }, (_, i) => `repo-${i}`)]) {
    assert.equal(Value.Check(AgentApiPromptContextResponseSchema, { ...prompt, workspaceRepoNames }), true);
  }
  assert.equal(Value.Check(AgentApiPromptContextResponseSchema, { ...prompt, workspaceRepoNames: ["bad\tname"] }), false);
});

test("Git SSH formatter preserves fixed transport flags and safely quotes paths", () => {
  assert.equal(formatRepoGitSshCommand("/fixture/key", "/fixture/known_hosts"), "ssh -i '/fixture/key' -o IdentitiesOnly=yes -o BatchMode=yes -o 'UserKnownHostsFile=/fixture/known_hosts' -o StrictHostKeyChecking=accept-new");
  const quoted = formatRepoGitSshCommand("/fixture/a' ; echo fixture", "/fixture/host' names");
  assert.equal(quoted, `ssh -i '/fixture/a'"'"' ; echo fixture' -o IdentitiesOnly=yes -o BatchMode=yes -o 'UserKnownHostsFile=/fixture/host'"'"' names' -o StrictHostKeyChecking=accept-new`);
});
