import fs from "node:fs/promises";
import path from "node:path";
import { formatRepoGitSshCommand, type PrepareRepoGitEnvResponse, type ReleaseRepoGitEnvRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { ToolExecutionContext } from "./tools/types.js";

export const TEST_GIT_LEASE_ID = `lease_${"0".repeat(14)}123456abcdef`;
export const TEST_GIT_SECRET = "stage-three-fixture-secret";
export async function createGitFixture(kind: "none" | "https" | "ssh" = "none") {
  const temporaryRoot = path.resolve(".tmp-tests/0032-stage3/fixtures");
  await fs.mkdir(temporaryRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporaryRoot, "git-"));
  const dataDir = path.join(root, "data");
  const workspacePath = path.join(dataDir, "workspaces", "workspace");
  const repo = "fixture-repo";
  const leaseDir = path.join(dataDir, "tmp/git-env/v2", TEST_GIT_LEASE_ID);
  await fs.mkdir(leaseDir, { recursive: true, mode: 0o700 });
  await fs.chmod(leaseDir, 0o700);
  await fs.mkdir(path.join(workspacePath, repo), { recursive: true });
  let response: PrepareRepoGitEnvResponse = {
    ok: true, repo, kind: "none", leaseId: TEST_GIT_LEASE_ID,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    env: { GIT_TERMINAL_PROMPT: "0" }, sensitiveFilePaths: [],
  };
  if (kind === "https") {
    const tokenPath = path.join(leaseDir, "git-askpass-token");
    const askpassPath = path.join(leaseDir, "git-askpass.sh");
    await fs.writeFile(tokenPath, `${TEST_GIT_SECRET}\r\nsecond-fixture-line\n`, { mode: 0o600 });
    await fs.writeFile(askpassPath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    response = { ...response, kind, env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpassPath, GIT_ASKPASS_USERNAME: "fixture", GIT_ASKPASS_TOKEN_FILE: tokenPath }, sensitiveFilePaths: [tokenPath] };
  } else if (kind === "ssh") {
    const keyPath = path.join(leaseDir, "ssh-key");
    await fs.writeFile(keyPath, `fixture-private-key:${TEST_GIT_SECRET}\n`, { mode: 0o600 });
    response = { ...response, kind, env: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: formatRepoGitSshCommand(keyPath, path.join(dataDir, "ssh/known_hosts")) }, sensitiveFilePaths: [keyPath] };
  }
  const prepared: unknown[] = [];
  const released: ReleaseRepoGitEnvRequest[] = [];
  const ctx = {
    profile: { agent: { tools: ["git"] } },
    run: { workspaceId: "workspace", sessionId: "session", runId: "run", workspacePath, workspaceRepoDirNames: ["stale-snapshot"] },
    pendingTool: { toolName: "git", toolExecutionId: "execution", callPartId: "part", assistantMessageId: "message", status: "queued", toolCallId: "call", args: {} },
    signal: new AbortController().signal,
    apiClient: {
      prepareRepoGitEnvLease: async (input: unknown) => { prepared.push(input); return response; },
      releaseRepoGitEnvLease: async (input: ReleaseRepoGitEnvRequest) => { released.push(input); return { ok: true }; },
    },
    promptContext: { workspaceRepoNames: [repo] },
  } as unknown as ToolExecutionContext;
  return {
    root, dataDir, workspacePath, cwd: path.join(workspacePath, repo), repo, leaseDir,
    response: response as Extract<PrepareRepoGitEnvResponse, { ok: true }>, ctx, prepared, released,
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }); },
  };
}

export const successfulGitProcessResult = {
  ok: true as const, exitCode: 0, signal: null, timedOut: false, cancelled: false,
  outputLimitExceeded: false, processStopConfirmed: true, failureCode: null,
  outputRedacted: false, stdout: "fixture success\n", stderr: "", durationMs: 1,
} as const;
