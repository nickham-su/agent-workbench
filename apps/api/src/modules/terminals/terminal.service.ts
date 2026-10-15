import type { FastifyBaseLogger } from "fastify";
import type { TerminalRecord } from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "../../utils/ids.js";
import { nowMs } from "../../utils/time.js";
import { getWorkspace, listWorkspaceRepos } from "../workspaces/workspace.store.js";
import { tmuxHasSession, tmuxKillSession, tmuxNewSession } from "../../infra/tmux/session.js";
import { pathExists } from "../../infra/fs/fs.js";
import { caCertPath, sshKnownHostsPath } from "../../infra/fs/paths.js";
import { ensureCaBundleFile } from "../../infra/certs/caBundle.js";
import { decryptToUtf8 } from "../../infra/crypto/secretBox.js";
import { gitAskpassScriptV1 } from "../../infra/git/askpass.js";
import { shQuote } from "../../infra/git/shQuote.js";
import { getCredentialWithSecret } from "../credentials/credentials.store.js";
import { getSettingJson } from "../settings/settings.store.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";
import { getWorkspaceEnvironmentService } from "../workspaces/workspace-environment.service.js";
import { listWorkspaces } from "../workspaces/workspace.store.js";
import {
  insertTerminal,
  getTerminal,
  updateTerminalStatus,
  deleteTerminalRecord,
  listActiveTerminalsByWorkspace,
  listTerminalsByWorkspace
} from "./terminal.store.js";
import {
  cleanupTerminalGitAuthArtifacts,
  TerminalGitAuthCleanupPendingError,
  type TerminalGitAuthUnresolvedLocator,
  terminalAskpassPath,
  terminalAskpassTokenPath,
  terminalSshKeyPath,
  writeTerminalGitAuthArtifact,
  assertTerminalGitAuthCleanupRootAnchors,
} from "./terminal.gitAuth.js";
import {
  armTerminalAuthCleanupIntent,
  clearTerminalAuthCleanupIntent,
  getTerminalAuthCleanupIntent,
  listTerminalAuthCleanupIntents,
  updateTerminalAuthCleanupIntent,
  type TerminalAuthArtifactKind,
  type TerminalAuthCleanupPhase,
} from "./terminal-auth-cleanup-intent.store.js";
import {
  prepareTerminalEnvironmentLaunch, markTerminalEnvironmentLaunchStarting,
  waitTerminalEnvironmentLaunch, cleanupTerminalEnvironmentLaunch,
} from "./terminal-env-launch.js";
import {
  listTerminalEnvironmentLaunchAttempts, clearTerminalEnvironmentLaunchAttempt,
  updateTerminalEnvironmentLaunchAttempt,
} from "./terminal-env-launch-attempt.store.js";
import {
  TerminalEnvironmentLaunchError, copyTerminalEnvironmentLayer, assertTerminalLaunchStatus,
} from "./terminal-env-launch.protocol.js";

export type TerminalRuntimeOperations = {
  hasSession: (params: { sessionName: string; cwd: string }) => Promise<"exists" | "not_found">;
  killSession: (params: { sessionName: string; cwd: string }) => Promise<void>;
  newSession: (params: { sessionName: string; cwd: string; command: string[] }) => Promise<void>;
  cleanupAuthArtifacts: (dataDir: string, terminalId: string, intents?: import("./terminal-auth-cleanup-intent.store.js").TerminalAuthCleanupIntent[]) => Promise<void>;
  prepareEnvironmentLaunch?: typeof prepareTerminalEnvironmentLaunch;
  waitEnvironmentLaunch?: typeof waitTerminalEnvironmentLaunch;
  cleanupEnvironmentLaunch?: typeof cleanupTerminalEnvironmentLaunch;
};

type TerminalSettlementOperations = Pick<TerminalRuntimeOperations, "hasSession" | "cleanupAuthArtifacts" | "cleanupEnvironmentLaunch">;
type TerminalStopOperations = Pick<TerminalRuntimeOperations, "hasSession" | "killSession">;
export type TerminalSettlement = "closed" | "cleanup_pending" | "env_cleanup_pending" | "session_exists" | "session_unknown";

const defaultTerminalRuntimeOperations: TerminalRuntimeOperations = {
  hasSession: tmuxHasSession,
  killSession: tmuxKillSession,
  newSession: tmuxNewSession,
  cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts,
  prepareEnvironmentLaunch: prepareTerminalEnvironmentLaunch,
  waitEnvironmentLaunch: waitTerminalEnvironmentLaunch,
  cleanupEnvironmentLaunch: cleanupTerminalEnvironmentLaunch,
};

class TmuxNewSessionMayExistError extends Error {
  constructor(
    readonly presenceIndeterminate: boolean,
    options: { cause: unknown },
  ) {
    super("tmux new-session response is indeterminate", options);
  }
}

/**
 * new-session 抛错并不表示 tmux 没有执行成功。只有 has-session 明确 not_found
 * 才允许调用方尝试 fallback；exists 或检查本身不确定均须按可恢复 intent 收敛。
 */
async function newTmuxSessionWithPresence(
  runtimeOperations: TerminalRuntimeOperations,
  params: { sessionName: string; cwd: string; command: string[] },
): Promise<"created" | "not_found"> {
  try {
    await runtimeOperations.newSession(params);
    return "created";
  } catch (error) {
    try {
      const presence = await runtimeOperations.hasSession({ sessionName: params.sessionName, cwd: params.cwd });
      if (presence === "exists") throw new TmuxNewSessionMayExistError(false, { cause: error });
      return "not_found";
    } catch (presenceError) {
      if (presenceError instanceof TmuxNewSessionMayExistError) throw presenceError;
      throw new TmuxNewSessionMayExistError(true, { cause: presenceError });
    }
  }
}

function sanitizeEnvValue(raw: string) {
  const s = String(raw || "");
  if (s.includes("\0") || s.includes("\n") || s.includes("\r")) return "";
  return s;
}

function safeResolveUnderRoot(params: { root: string; rel: string }) {
  const rootAbs = path.resolve(params.root);
  const abs = path.resolve(params.root, params.rel);
  if (!abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

async function resolveTerminalCwd(ctx: AppContext, ws: { id: string; path: string }) {
  const repos = listWorkspaceRepos(ctx.db, ws.id);
  if (repos.length !== 1) return ws.path;

  const only = repos[0]!;
  // 单 repo workspace 时，默认把 terminal 直接落到 repo 目录；仍做强校验与兜底。
  const safeAbs = safeResolveUnderRoot({ root: ws.path, rel: only.dirName });
  const repoAbs = path.resolve(only.path);
  if (!safeAbs || safeAbs !== repoAbs) return ws.path;
  if (!(await pathExists(repoAbs))) return ws.path;
  return repoAbs;
}

type NetworkSettingsForTerminalV1 = {
  httpProxy: string | null;
  httpsProxy: string | null;
  noProxy: string | null;
  caCertPem: string | null;
  applyToTerminal: boolean;
};

function readNetworkSettingsForTerminal(ctx: AppContext): NetworkSettingsForTerminalV1 {
  const row = getSettingJson(ctx.db, "network");
  const v = (row?.value ?? {}) as Partial<NetworkSettingsForTerminalV1>;
  return {
    httpProxy: typeof v.httpProxy === "string" && v.httpProxy.trim() ? v.httpProxy.trim() : null,
    httpsProxy: typeof v.httpsProxy === "string" && v.httpsProxy.trim() ? v.httpsProxy.trim() : null,
    noProxy: typeof v.noProxy === "string" && v.noProxy.trim() ? v.noProxy.trim() : null,
    caCertPem: typeof v.caCertPem === "string" && v.caCertPem ? v.caCertPem : null,
    applyToTerminal: Boolean(v.applyToTerminal)
  };
}

async function buildTerminalNetworkEnvPairs(ctx: AppContext): Promise<string[]> {
  const network = readNetworkSettingsForTerminal(ctx);
  if (!network.applyToTerminal) return [];

  const pairs: string[] = [];
  const httpProxy = network.httpProxy ? sanitizeEnvValue(network.httpProxy) : "";
  const httpsProxy = network.httpsProxy ? sanitizeEnvValue(network.httpsProxy) : "";
  const noProxy = network.noProxy ? sanitizeEnvValue(network.noProxy) : "";

  if (httpProxy) {
    pairs.push(`HTTP_PROXY=${httpProxy}`, `http_proxy=${httpProxy}`);
  }
  if (httpsProxy) {
    pairs.push(`HTTPS_PROXY=${httpsProxy}`, `https_proxy=${httpsProxy}`);
  }
  if (noProxy) {
    pairs.push(`NO_PROXY=${noProxy}`, `no_proxy=${noProxy}`);
  }

  const caPem = network.caCertPem;
  const caBundle = await ensureCaBundleFile({
    dataDir: ctx.dataDir,
    customCaPem: caPem,
    fallbackCaPath: caCertPath(ctx.dataDir),
    writeCustomCa: Boolean(caPem)
  });
  if (caBundle) {
    pairs.push(`GIT_SSL_CAINFO=${caBundle}`, `SSL_CERT_FILE=${caBundle}`);
  }

  return pairs;
}

async function buildTerminalGitEnv(params: {
  ctx: AppContext;
  terminalId: string;
  workspaceId: string;
  writeAuthArtifact?: typeof writeTerminalGitAuthArtifact;
  buildNetworkEnv?: typeof buildTerminalNetworkEnvPairs;
  getCredentialWithSecret?: typeof getCredentialWithSecret;
  decryptSecret?: typeof decryptToUtf8;
  onIntentPhaseUpdateFailed?: () => void;
  onAuthArtifactWriteStarted?: () => void;
}): Promise<{ envPairs: string[] }> {
  const networkPairs = await (params.buildNetworkEnv ?? buildTerminalNetworkEnvPairs)(params.ctx);
  const ws = getWorkspace(params.ctx.db, params.workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");

  const repoCredentialId = ws.terminalCredentialId ? String(ws.terminalCredentialId || "").trim() : "";
  const cred = repoCredentialId ? (params.getCredentialWithSecret ?? getCredentialWithSecret)(params.ctx.db, repoCredentialId) : null;

  if (!cred) return { envPairs: networkPairs };

  const secret = (params.decryptSecret ?? decryptToUtf8)({ key: params.ctx.credentialMasterKey, ciphertext: cred.secretEnc });
  const writeArtifact = async (kind: Exclude<TerminalAuthArtifactKind, "legacy">, content: string, mode: number) => {
    const artifactName = kind === "ssh-key" ? terminalSshKeyPath(params.ctx.dataDir, params.terminalId).split("/").at(-1)! :
      kind === "askpass" ? terminalAskpassPath(params.ctx.dataDir, params.terminalId).split("/").at(-1)! : terminalAskpassTokenPath(params.ctx.dataDir, params.terminalId).split("/").at(-1)!;
    // 每个 artifact 在副作用前单独 arm；不得由另一个 recoverable row 掩盖它。
    const root = await fs.stat(params.ctx.dataDir);
    if (!root.isDirectory() || !Number.isSafeInteger(root.dev) || !Number.isSafeInteger(root.ino)) {
      throw new TerminalGitAuthCleanupPendingError("terminal Git auth root anchor is invalid");
    }
    armTerminalAuthCleanupIntent(params.ctx.db, {
      terminalId: params.terminalId, artifactKind: kind, artifactName,
      rootDev: root.dev, rootIno: root.ino, updatedAt: nowMs(),
    });
    const updateAuthCleanupPhase = (phase: TerminalAuthCleanupPhase) => (intent: TerminalGitAuthUnresolvedLocator) => {
    try {
      updateTerminalAuthCleanupIntent(params.ctx.db, {
        terminalId: params.terminalId,
        artifactKind: kind,
        phase,
        artifactName: intent.artifactName,
        expectedDev: intent.expectedDev ?? null,
        expectedIno: intent.expectedIno ?? null,
        rootDev: intent.rootDev,
        rootIno: intent.rootIno,
        diagnostic: intent.diagnostic,
        updatedAt: nowMs(),
      });
    } catch (error) {
      params.onIntentPhaseUpdateFailed?.();
      throw error;
    }
    };
    params.onAuthArtifactWriteStarted?.();
    await (params.writeAuthArtifact ?? writeTerminalGitAuthArtifact)({
      dataDir: params.ctx.dataDir, terminalId: params.terminalId, kind, content, mode,
      rootDev: root.dev, rootIno: root.ino,
      persistUnresolvedCleanup: updateAuthCleanupPhase("unresolved"),
      markRecoverableCleanup: updateAuthCleanupPhase("recoverable"),
    });
  };

  if (cred.record.kind === "ssh") {
    const keyPath = terminalSshKeyPath(params.ctx.dataDir, params.terminalId);
    await writeArtifact("ssh-key", secret, 0o600);
    const knownHosts = sshKnownHostsPath(params.ctx.dataDir);
    const sshCmd = [
      "ssh",
      "-i",
      shQuote(keyPath),
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      shQuote(`UserKnownHostsFile=${knownHosts}`),
      "-o",
      "StrictHostKeyChecking=accept-new"
    ].join(" ");

    return {
      envPairs: [...networkPairs, "GIT_TERMINAL_PROMPT=0", `GIT_SSH_COMMAND=${sshCmd}`]
    };
  }

  const askpassPath = terminalAskpassPath(params.ctx.dataDir, params.terminalId);
  const tokenPath = terminalAskpassTokenPath(params.ctx.dataDir, params.terminalId);
  await writeArtifact("askpass", gitAskpassScriptV1(), 0o700);
  await writeArtifact("askpass-token", secret, 0o600);
  const username = sanitizeEnvValue(cred.record.username || "oauth2");
  return {
    envPairs: [
      ...networkPairs,
      "GIT_TERMINAL_PROMPT=0",
      `GIT_ASKPASS=${askpassPath}`,
      `GIT_ASKPASS_USERNAME=${username}`,
      `GIT_ASKPASS_TOKEN_FILE=${tokenPath}`
    ]
  };
}

function terminalCreateError(error: unknown): HttpError {
  if (error instanceof HttpError && error.code !== "TERMINAL_ENV_CLEANUP_PENDING") return error;
  const code = error instanceof TerminalEnvironmentLaunchError ? error.code
    : error instanceof HttpError && error.code === "TERMINAL_ENV_CLEANUP_PENDING" ? error.code : "TERMINAL_ENV_PREPARE_FAILED";
  const messages = {
    TERMINAL_ENV_PREPARE_FAILED: "Terminal environment preparation failed.",
    TERMINAL_ENV_PROTOCOL_FAILED: "Terminal environment launch protocol failed.",
    TERMINAL_ENV_START_TIMEOUT: "Terminal environment launch timed out.",
    TERMINAL_ENV_SHELL_NOT_FOUND: "Terminal shell was not found.",
    TERMINAL_ENV_SPAWN_FAILED: "Terminal shell could not be started.",
    TERMINAL_ENV_CLEANUP_PENDING: "Terminal creation cleanup pending.",
  };
  return new HttpError(500, messages[code], code);
}

/** A successful kill response alone is not absence evidence. Must run under Workspace admission. */
export async function stopTerminalSession(
  ctx: AppContext, term: TerminalRecord, runtimeOperations: TerminalStopOperations = defaultTerminalRuntimeOperations,
): Promise<void> {
  try {
    const request = { sessionName: term.sessionName, cwd: ctx.dataDir };
    if (await runtimeOperations.hasSession(request) === "not_found") return;
    await runtimeOperations.killSession(request);
    if (await runtimeOperations.hasSession(request) === "not_found") return;
  } catch { /* Never expose tmux stderr or spawn arguments. */ }
  throw new HttpError(503, "Terminal session could not be confirmed stopped.", "TERMINAL_SESSION_STOP_UNCONFIRMED");
}

/** Returns only precisely converged IDs; caller clears them in its activation/settlement/delete transaction. */
export async function cleanupTerminalEnvironmentAttempts(
  ctx: AppContext, terminalId: string, consumption: "stopped" | "spawned",
  runtimeOperations: Pick<TerminalRuntimeOperations, "cleanupEnvironmentLaunch"> = defaultTerminalRuntimeOperations,
): Promise<string[]> {
  try {
    const clean: string[] = [];
    for (const attempt of listTerminalEnvironmentLaunchAttempts(ctx.db, terminalId)) {
      const result = await (runtimeOperations.cleanupEnvironmentLaunch ?? cleanupTerminalEnvironmentLaunch)({
        db: ctx.db, dataDir: ctx.dataDir, attemptId: attempt.id, consumption,
      });
      if (result !== "clean") throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_CLEANUP_PENDING");
      clean.push(attempt.id);
    }
    return clean;
  } catch {
    throw new HttpError(409, "Terminal environment cleanup remains pending.", "TERMINAL_ENV_CLEANUP_PENDING");
  }
}

/** Only called in this module after current absence evidence (or before any tmux side effect). */
async function settleStoppedTerminal(
  ctx: AppContext, logger: FastifyBaseLogger, terminalId: string,
  runtimeOperations: Pick<TerminalRuntimeOperations, "cleanupAuthArtifacts" | "cleanupEnvironmentLaunch">,
): Promise<"closed" | "cleanup_pending" | "env_cleanup_pending"> {
  try { updateTerminalStatus(ctx.db, terminalId, "errored", nowMs()); }
  catch { return "env_cleanup_pending"; }
  let cleanAttempts: string[];
  try {
    cleanAttempts = await cleanupTerminalEnvironmentAttempts(ctx, terminalId, "stopped", runtimeOperations);
  } catch {
    logger.warn({ terminalId, code: "TERMINAL_ENV_CLEANUP_PENDING" }, "terminal environment cleanup remains pending");
    return "env_cleanup_pending";
  }
  let gitCleanupComplete = false;
  try {
    const intents = listTerminalAuthCleanupIntents(ctx.db, terminalId);
    if (intents.some((intent) => intent.phase !== "recoverable")) {
      throw new TerminalGitAuthCleanupPendingError("terminal auth cleanup locator is not recoverable");
    }
    await assertTerminalGitAuthCleanupRootAnchors(ctx.dataDir, intents);
    await runtimeOperations.cleanupAuthArtifacts(ctx.dataDir, terminalId, intents);
    gitCleanupComplete = true;
    ctx.db.transaction(() => {
      const current = listTerminalAuthCleanupIntents(ctx.db, terminalId);
      if (current.some((intent) => intent.phase !== "recoverable")) {
        throw new TerminalGitAuthCleanupPendingError("terminal auth cleanup locator is not recoverable");
      }
      for (const id of cleanAttempts) clearTerminalEnvironmentLaunchAttempt(ctx.db, id);
      for (const intent of current) clearTerminalAuthCleanupIntent(ctx.db, terminalId, intent.artifactKind);
      updateTerminalStatus(ctx.db, terminalId, "closed", nowMs());
    })();
    return "closed";
  } catch {
    if (gitCleanupComplete) return "env_cleanup_pending";
    // Clean env resources must not turn an existing Git-only pending into a new env deletion error.
    // A failed transaction retains its durable rows, so a retry revalidates convergence again.
    try {
      ctx.db.transaction(() => {
        for (const id of cleanAttempts) clearTerminalEnvironmentLaunchAttempt(ctx.db, id);
      })();
    } catch {
      logger.warn({ terminalId, code: "TERMINAL_ENV_CLEANUP_PENDING" }, "terminal environment settlement remains pending");
      return "env_cleanup_pending";
    }
    logger.warn({ terminalId, code: "TERMINAL_AUTH_CLEANUP_PENDING" }, "terminal Git auth cleanup remains pending");
    return "cleanup_pending";
  }
}

export async function createTerminal(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  params: {
    workspaceId: string;
    shell?: string;
    runtimeOperations?: TerminalRuntimeOperations;
    writeAuthArtifactForTest?: typeof writeTerminalGitAuthArtifact;
    buildNetworkEnvForTest?: typeof buildTerminalNetworkEnvPairs;
    getCredentialWithSecretForTest?: typeof getCredentialWithSecret;
    decryptSecretForTest?: typeof decryptToUtf8;
  }
): Promise<TerminalRecord> {
  const workspaceId = params.workspaceId.trim();
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");
  return workspaceLifecycleCoordinator.withMutation(workspaceId, async () => {
    const ws = getWorkspace(ctx.db, workspaceId);
    if (!ws) throw new HttpError(404, "Workspace not found");
    // Capture both layers once, before the first asynchronous preparation; fallback reuses them.
    const workspaceEnv = getWorkspaceEnvironmentService(ctx).readEnvironment(workspaceId);
    let baseEnv: Record<string, string>;
    try { baseEnv = copyTerminalEnvironmentLayer(process.env, true); }
    catch (error) { throw terminalCreateError(error); }
    const terminalId = newId("term");
    const sessionName = `term_${terminalId}`;
    const ts = nowMs();
    const term: TerminalRecord = {
      id: terminalId, workspaceId: ws.id, sessionName, status: "creating", createdAt: ts, updatedAt: ts,
    };
    const specifiedShell = params.shell?.trim();
    const runtimeOperations = params.runtimeOperations ?? defaultTerminalRuntimeOperations;
    let intentPersisted = false;
    let authArtifactWriteStarted = false;
    let tmuxMayExist = false;
    try {
      ctx.db.transaction(() => { insertTerminal(ctx.db, term); })();
      intentPersisted = true;
      const { envPairs } = await buildTerminalGitEnv({
        ctx, terminalId, workspaceId: ws.id,
        writeAuthArtifact: params.writeAuthArtifactForTest,
        buildNetworkEnv: params.buildNetworkEnvForTest,
        getCredentialWithSecret: params.getCredentialWithSecretForTest,
        decryptSecret: params.decryptSecretForTest,
        onIntentPhaseUpdateFailed: () => { authArtifactWriteStarted = true; },
        onAuthArtifactWriteStarted: () => { authArtifactWriteStarted = true; },
      });
      const systemEnv: Record<string, string> = Object.create(null);
      for (const pair of envPairs) {
        const separator = pair.indexOf("=");
        if (separator <= 0) throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_PREPARE_FAILED");
        systemEnv[pair.slice(0, separator)] = pair.slice(separator + 1);
      }
      const cwd = await resolveTerminalCwd(ctx, ws);
      for (let index = 0; index < 2; index++) {
        const shell = index === 0 ? specifiedShell || "bash" : "sh";
        const launch = await (runtimeOperations.prepareEnvironmentLaunch ?? prepareTerminalEnvironmentLaunch)({
          db: ctx.db, dataDir: ctx.dataDir, terminalId, shell, workspaceEnv, systemEnv, baseEnv,
        });
        const attempt = markTerminalEnvironmentLaunchStarting(ctx.db, launch.attempt.id);
        // Arm before the side effect: a response loss may still have created a live launcher.
        tmuxMayExist = true;
        const result = await newTmuxSessionWithPresence(runtimeOperations, { sessionName, cwd, command: launch.command });
        if (result === "not_found") {
          tmuxMayExist = false;
          throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_SPAWN_FAILED");
        }
        const status = await (runtimeOperations.waitEnvironmentLaunch ?? waitTerminalEnvironmentLaunch)({ dataDir: ctx.dataDir, attempt });
        assertTerminalLaunchStatus(status, attempt.id);
        if (status.state === "spawn-error") {
          if (status.code === "SHELL_NOT_FOUND" && !specifiedShell && index === 0) {
            await stopTerminalSession(ctx, term, runtimeOperations);
            tmuxMayExist = false;
            const cleaned = await cleanupTerminalEnvironmentAttempts(ctx, terminalId, "stopped", runtimeOperations);
            ctx.db.transaction(() => {
              for (const id of cleaned) clearTerminalEnvironmentLaunchAttempt(ctx.db, id);
            })();
            continue;
          }
          throw new TerminalEnvironmentLaunchError(status.code === "SHELL_NOT_FOUND"
            ? "TERMINAL_ENV_SHELL_NOT_FOUND" : status.code === "SNAPSHOT_INVALID" || status.code === "STATUS_WRITE_FAILED"
              ? "TERMINAL_ENV_PROTOCOL_FAILED" : "TERMINAL_ENV_SPAWN_FAILED");
        }
        if (status.state !== "spawned") {
          throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_PROTOCOL_FAILED");
        }
        if (await runtimeOperations.hasSession({ sessionName, cwd: ctx.dataDir }) !== "exists") {
          tmuxMayExist = false;
          throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_SPAWN_FAILED");
        }
        const liveAttempts = listTerminalEnvironmentLaunchAttempts(ctx.db, terminalId);
        if (liveAttempts.length !== 1 || liveAttempts[0]!.id !== attempt.id) {
          throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_PROTOCOL_FAILED");
        }
        const cleaned = await cleanupTerminalEnvironmentAttempts(ctx, terminalId, "spawned", runtimeOperations);
        const activeRoot = await fs.lstat(ctx.dataDir);
        if (activeRoot.isSymbolicLink() || !activeRoot.isDirectory()) {
          throw new TerminalGitAuthCleanupPendingError("terminal Git auth root anchor is invalid during activation");
        }
        ctx.db.transaction(() => {
          const intents = listTerminalAuthCleanupIntents(ctx.db, terminalId);
          if (ws.terminalCredentialId) {
            const expectedKinds: TerminalAuthArtifactKind[] = getCredentialWithSecret(ctx.db, String(ws.terminalCredentialId))?.record.kind === "ssh"
              ? ["ssh-key"] : ["askpass", "askpass-token"];
            if (intents.length !== expectedKinds.length || intents.some((intent) => intent.phase !== "recoverable"
              || !expectedKinds.includes(intent.artifactKind) || intent.expectedDev === null || intent.expectedIno === null
              || intent.rootDev !== activeRoot.dev || intent.rootIno !== activeRoot.ino)) {
              throw new TerminalGitAuthCleanupPendingError("terminal auth cleanup locator is incomplete");
            }
          }
          for (const id of cleaned) clearTerminalEnvironmentLaunchAttempt(ctx.db, id);
          updateTerminalStatus(ctx.db, terminalId, "active", nowMs());
        })();
        const active = getTerminal(ctx.db, terminalId);
        if (!active || active.status !== "active") throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_PREPARE_FAILED");
        logger.info({ terminalId, workspaceId }, "terminal created");
        return active;
      }
      throw new TerminalEnvironmentLaunchError("TERMINAL_ENV_SHELL_NOT_FOUND");
    } catch (error) {
      if (!intentPersisted) throw terminalCreateError(error);
      // A failed invocation can never be resumed as a new launch, including uncertain tmux stop.
      try {
        for (const attempt of listTerminalEnvironmentLaunchAttempts(ctx.db, terminalId)) {
          updateTerminalEnvironmentLaunchAttempt(ctx.db, attempt.id, {
            phase: "cleanup_pending", errorCode: "TERMINAL_ENV_CLEANUP_PENDING",
          });
        }
      } catch { /* Original durable identity remains the authority if storage is unavailable. */ }
      let settlement: "closed" | "cleanup_pending" | "env_cleanup_pending" = "env_cleanup_pending";
      try {
        if (tmuxMayExist) await stopTerminalSession(ctx, term, runtimeOperations);
        // No writer entered means these armed rows cannot have produced auth artifacts.
        if (!authArtifactWriteStarted) {
          ctx.db.transaction(() => {
            for (const intent of listTerminalAuthCleanupIntents(ctx.db, terminalId)) {
              clearTerminalAuthCleanupIntent(ctx.db, terminalId, intent.artifactKind);
            }
          })();
        }
        settlement = await settleStoppedTerminal(ctx, logger, terminalId, runtimeOperations);
      } catch {
        try { updateTerminalStatus(ctx.db, terminalId, "errored", nowMs()); } catch { /* Retain durable authority. */ }
      }
      if (settlement !== "closed") {
        throw terminalCreateError(new TerminalEnvironmentLaunchError("TERMINAL_ENV_CLEANUP_PENDING"));
      }
      throw terminalCreateError(error instanceof TmuxNewSessionMayExistError
        ? new TerminalEnvironmentLaunchError("TERMINAL_ENV_SPAWN_FAILED") : error);
    }
  });
}

export async function getTerminalById(ctx: AppContext, terminalId: string): Promise<TerminalRecord> {
  const term = getTerminal(ctx.db, terminalId);
  if (!term) throw new HttpError(404, "Terminal not found");
  return term;
}

/** Short attach admission; no configuration read or environment reinjection on reconnect. */
export async function getTerminalForAttachment(
  ctx: AppContext, logger: FastifyBaseLogger, terminalId: string,
  runtimeOperations: TerminalSettlementOperations = defaultTerminalRuntimeOperations,
) {
  const candidate = await getTerminalById(ctx, terminalId);
  return workspaceLifecycleCoordinator.withAdmission(candidate.workspaceId, async () => {
    const term = getTerminal(ctx.db, terminalId);
    if (!term) throw new HttpError(404, "Terminal not found");
    const workspace = getWorkspace(ctx.db, term.workspaceId);
    if (!workspace) throw new HttpError(404, "Workspace not found");
    if (term.status !== "active") throw new HttpError(410, "Terminal session is not active.");
    let presence: "exists" | "not_found";
    try { presence = await runtimeOperations.hasSession({ sessionName: term.sessionName, cwd: ctx.dataDir }); }
    catch { throw new HttpError(503, "Terminal session presence could not be confirmed.", "TERMINAL_SESSION_PRESENCE_UNKNOWN"); }
    if (presence === "not_found") {
      const settlement = await settleTerminalAfterSessionStopped(ctx, logger, terminalId, runtimeOperations);
      if (settlement === "session_unknown") {
        throw new HttpError(503, "Terminal session presence could not be confirmed.", "TERMINAL_SESSION_PRESENCE_UNKNOWN");
      }
      if (settlement !== "session_exists") throw new HttpError(410, "tmux session not found (may have exited)");
    }
    return { term, workspace };
  });
}

/** Revalidates current session absence in the same gate; stale external probes never authorize cleanup. */
export async function settleTerminalAfterSessionStopped(
  ctx: AppContext, logger: FastifyBaseLogger, terminalId: string,
  runtimeOperations: TerminalSettlementOperations = defaultTerminalRuntimeOperations,
): Promise<TerminalSettlement> {
  const candidate = getTerminal(ctx.db, terminalId);
  if (!candidate) return "closed";
  return workspaceLifecycleCoordinator.withAdmission(candidate.workspaceId, async () => {
    const term = getTerminal(ctx.db, terminalId);
    if (!term) return "closed";
    try {
      if (await runtimeOperations.hasSession({ sessionName: term.sessionName, cwd: ctx.dataDir }) === "exists") return "session_exists";
    } catch {
      logger.warn({ terminalId, code: "TERMINAL_SESSION_PRESENCE_UNKNOWN" }, "terminal presence remains unknown");
      return "session_unknown";
    }
    return settleStoppedTerminal(ctx, logger, term.id, runtimeOperations);
  });
}

export async function deleteTerminal(
  ctx: AppContext, logger: FastifyBaseLogger, terminalId: string,
  runtimeOperations: Pick<TerminalRuntimeOperations, "hasSession" | "killSession" | "cleanupAuthArtifacts" | "cleanupEnvironmentLaunch"> = defaultTerminalRuntimeOperations,
) {
  const candidate = await getTerminalById(ctx, terminalId);
  return workspaceLifecycleCoordinator.withAdmission(candidate.workspaceId, async () => {
    const term = getTerminal(ctx.db, terminalId);
    if (!term) return;
    await stopTerminalSession(ctx, term, runtimeOperations);
    const settlement = await settleTerminalAfterSessionStopped(ctx, logger, term.id, runtimeOperations);
    if (settlement === "env_cleanup_pending") {
      throw new HttpError(409, "Terminal environment cleanup remains pending.", "TERMINAL_ENV_CLEANUP_PENDING");
    }
    if (settlement === "cleanup_pending") {
      logger.info({ terminalId: term.id }, "terminal logically deleted with Git auth cleanup pending");
      return;
    }
    if (settlement !== "closed") {
      throw new HttpError(503, "Terminal session could not be confirmed stopped.", "TERMINAL_SESSION_STOP_UNCONFIRMED");
    }
    ctx.db.transaction(() => { deleteTerminalRecord(ctx.db, term.id); })();
    logger.info({ terminalId: term.id }, "terminal deleted");
  });
}

/** A scan is only a set of candidate IDs, including each Worker-ready recovery pass. */
export async function reconcilePendingTerminals(ctx: AppContext, logger: FastifyBaseLogger, runtimeOperations = defaultTerminalRuntimeOperations) {
  for (const workspace of listWorkspaces(ctx.db)) {
    const candidates = listTerminalsByWorkspace(ctx.db, workspace.id).filter((term) => term.status === "creating" || term.status === "errored");
    for (const candidate of candidates) {
      await workspaceLifecycleCoordinator.withAdmission(workspace.id, async () => {
        const term = getTerminal(ctx.db, candidate.id);
        if (!term) return;
        try {
          if (term.status === "active") {
            await settleTerminalAfterSessionStopped(ctx, logger, term.id, runtimeOperations);
            return;
          }
          if (term.status !== "creating" && term.status !== "errored") return;
          await stopTerminalSession(ctx, term, runtimeOperations);
          await settleTerminalAfterSessionStopped(ctx, logger, term.id, runtimeOperations);
        } catch {
          logger.warn({ terminalId: term.id, workspaceId: workspace.id, code: "TERMINAL_CLEANUP_PENDING" }, "terminal cleanup remains pending");
        }
      });
    }
  }
}

export async function reconcileWorkspaceActiveTerminals(
  ctx: AppContext, logger: FastifyBaseLogger, workspaceId: string,
  runtimeOperations: TerminalSettlementOperations = defaultTerminalRuntimeOperations,
) {
  const candidates = listActiveTerminalsByWorkspace(ctx.db, workspaceId);
  // Sequential await also applies to the ALS-reentrant case; Promise.all would bypass exclusion.
  for (const candidate of candidates) {
    await workspaceLifecycleCoordinator.withAdmission(workspaceId, async () => {
      const term = getTerminal(ctx.db, candidate.id);
      if (!term || term.status !== "active") return;
      try { await settleTerminalAfterSessionStopped(ctx, logger, term.id, runtimeOperations); }
      catch {
        logger.warn({ terminalId: term.id, code: "TERMINAL_CLEANUP_PENDING" }, "reconcile terminal failed");
      }
    });
  }
}
