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
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";
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

export type TerminalRuntimeOperations = {
  hasSession: (params: { sessionName: string; cwd: string }) => Promise<"exists" | "not_found">;
  killSession: (params: { sessionName: string; cwd: string }) => Promise<void>;
  newSession: (params: { sessionName: string; cwd: string; command: string[] }) => Promise<void>;
  cleanupAuthArtifacts: (dataDir: string, terminalId: string, intents?: import("./terminal-auth-cleanup-intent.store.js").TerminalAuthCleanupIntent[]) => Promise<void>;
};

const defaultTerminalRuntimeOperations: TerminalRuntimeOperations = {
  hasSession: tmuxHasSession,
  killSession: tmuxKillSession,
  newSession: tmuxNewSession,
  cleanupAuthArtifacts: cleanupTerminalGitAuthArtifacts,
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

    const terminalId = newId("term");
    const sessionName = `term_${terminalId}`;
    const ts = nowMs();
    const term: TerminalRecord = {
      id: terminalId,
      workspaceId: ws.id,
      sessionName,
      status: "creating",
      createdAt: ts,
      updatedAt: ts
    };

    const shell = params.shell?.trim() || "bash";
    let tmuxCreated = false;
    let intentPersisted = false;
    let authArtifactWriteStarted = false;
    let tmuxStateIndeterminate = false;
    const runtimeOperations = params.runtimeOperations ?? defaultTerminalRuntimeOperations;
    try {
      // terminal record 必须先于逐 artifact latch 存在；每一行会在其 writer 前单独 arm。
      ctx.db.transaction(() => {
        insertTerminal(ctx.db, term);
      })();
      intentPersisted = true;
      const { envPairs } = await buildTerminalGitEnv({
        ctx,
        terminalId,
        workspaceId: ws.id,
        writeAuthArtifact: params.writeAuthArtifactForTest,
        buildNetworkEnv: params.buildNetworkEnvForTest,
        getCredentialWithSecret: params.getCredentialWithSecretForTest,
        decryptSecret: params.decryptSecretForTest,
        onIntentPhaseUpdateFailed: () => { authArtifactWriteStarted = true; },
        onAuthArtifactWriteStarted: () => { authArtifactWriteStarted = true; },
      });
      const command = envPairs.length > 0 ? ["env", ...envPairs, shell] : [shell];
      const cwd = await resolveTerminalCwd(ctx, ws);
      try {
        const firstAttempt = await newTmuxSessionWithPresence(runtimeOperations, { sessionName, cwd, command });
        if (firstAttempt === "created") tmuxCreated = true;
        else if (!params.shell) {
          // 仅首次请求被明确证实未创建时，才可尝试默认 shell 的 sh fallback。
          const fallback = envPairs.length > 0 ? ["env", ...envPairs, "sh"] : ["sh"];
          const fallbackAttempt = await newTmuxSessionWithPresence(runtimeOperations, { sessionName, cwd, command: fallback });
          if (fallbackAttempt !== "created") throw new Error("tmux fallback session was not created");
          tmuxCreated = true;
        } else throw new Error("tmux session was not created");
      } catch (err) {
        if (err instanceof TmuxNewSessionMayExistError) {
          tmuxCreated = true;
          tmuxStateIndeterminate = err.presenceIndeterminate;
          throw err;
        }
        if (!params.shell) {
          // firstAttempt 已明确 not_found 后的 fallback 错误直接进入补偿，不可再盲试。
          throw err;
        } else {
          throw err;
        }
      }
      const activeRoot = await fs.lstat(ctx.dataDir);
      if (activeRoot.isSymbolicLink() || !activeRoot.isDirectory()) throw new TerminalGitAuthCleanupPendingError("terminal Git auth root anchor is invalid during activation");
      // active Terminal 保留逐 artifact recoverable locator，供重启后的删除/清理使用。
      ctx.db.transaction(() => {
        const intents = listTerminalAuthCleanupIntents(ctx.db, terminalId);
        if (ws.terminalCredentialId) {
          const expectedKinds: TerminalAuthArtifactKind[] = getCredentialWithSecret(ctx.db, String(ws.terminalCredentialId))?.record.kind === "ssh"
            ? ["ssh-key"] : ["askpass", "askpass-token"];
          if (intents.length !== expectedKinds.length || intents.some((intent) => intent.phase !== "recoverable" || !expectedKinds.includes(intent.artifactKind) || intent.expectedDev === null || intent.expectedIno === null || intent.rootDev !== activeRoot.dev || intent.rootIno !== activeRoot.ino)) {
            throw new TerminalGitAuthCleanupPendingError("terminal auth cleanup locator is incomplete");
          }
        }
        updateTerminalStatus(ctx.db, terminalId, "active", nowMs());
      })();
      const active = getTerminal(ctx.db, terminalId);
      if (!active || active.status !== "active") throw new Error("terminal activation was not persisted");
      logger.info({ terminalId, workspaceId }, "terminal created");
      return active;
    } catch (err) {
      let cleanupError: unknown = null;
      const initialIntents = intentPersisted ? listTerminalAuthCleanupIntents(ctx.db, terminalId) : [];
      // writer 尚未进入时没有 secret；已 arm 的行可能是 arm 后、writer 前失败，必须清除。
      if (intentPersisted && !authArtifactWriteStarted && !tmuxCreated && !tmuxStateIndeterminate) {
        try {
          ctx.db.transaction(() => {
            for (const intent of listTerminalAuthCleanupIntents(ctx.db, terminalId)) clearTerminalAuthCleanupIntent(ctx.db, terminalId, intent.artifactKind);
            updateTerminalStatus(ctx.db, terminalId, "closed", nowMs());
          })();
          throw err;
        } catch (settleError) {
          // 上面的 throw err 也会进入此处；它是预期的原始业务错误，不能包装。
          if (settleError === err) throw err;
          cleanupError = settleError;
        }
      }
      if (tmuxCreated) {
        try {
          await runtimeOperations.killSession({ sessionName, cwd: ctx.dataDir });
        } catch (error) {
          cleanupError = error;
        }
      }
      if (initialIntents.length > 0 && !(err instanceof TerminalGitAuthCleanupPendingError)) {
        try {
          await runtimeOperations.cleanupAuthArtifacts(ctx.dataDir, terminalId, initialIntents);
        } catch (error) {
          cleanupError ??= error;
        }
      }
      const cleanupIntents = intentPersisted ? listTerminalAuthCleanupIntents(ctx.db, terminalId) : [];
      if (cleanupIntents.some((intent) => intent.phase !== "recoverable") || cleanupError) {
        cleanupError ??= new TerminalGitAuthCleanupPendingError("terminal auth cleanup remains pending");
      }
      if (err instanceof TerminalGitAuthCleanupPendingError) cleanupError ??= err;
      // presence probe 不确定时，即使 kill 表面成功也不能证明没有 orphan；保持 intent。
      if (tmuxStateIndeterminate) cleanupError ??= err;
      // 只有 intent 已成功落库才更新状态；insert 失败不得以不存在的 record 掩盖原始错误。
      if (intentPersisted) {
        try {
          if (cleanupError) {
            updateTerminalStatus(ctx.db, terminalId, "errored", nowMs());
          } else {
            ctx.db.transaction(() => {
              const current = listTerminalAuthCleanupIntents(ctx.db, terminalId);
              for (const intent of current) clearTerminalAuthCleanupIntent(ctx.db, terminalId, intent.artifactKind);
              updateTerminalStatus(ctx.db, terminalId, "closed", nowMs());
            })();
          }
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (cleanupError) throw new Error("terminal creation cleanup pending", { cause: cleanupError });
      throw err;
    }
  });
}

export async function getTerminalById(ctx: AppContext, terminalId: string): Promise<TerminalRecord> {
  const term = getTerminal(ctx.db, terminalId);
  if (!term) throw new HttpError(404, "Terminal not found");
  return term;
}

export async function deleteTerminal(ctx: AppContext, logger: FastifyBaseLogger, terminalId: string, runtimeOperations: Pick<TerminalRuntimeOperations, "hasSession" | "killSession" | "cleanupAuthArtifacts"> = defaultTerminalRuntimeOperations) {
  const term = await getTerminalById(ctx, terminalId);
  return workspaceLifecycleCoordinator.withMutation(term.workspaceId, async () => {
    try {
      const presence = await runtimeOperations.hasSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
      if (presence === "exists") {
        await runtimeOperations.killSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
      }
    } finally {
      const intents = listTerminalAuthCleanupIntents(ctx.db, term.id);
      if (intents.some((intent) => intent.phase !== "recoverable")) {
        throw new TerminalGitAuthCleanupPendingError("terminal auth cleanup locator is not recoverable");
      }
      await assertTerminalGitAuthCleanupRootAnchors(ctx.dataDir, intents);
      await runtimeOperations.cleanupAuthArtifacts(ctx.dataDir, term.id, intents);
    }
    ctx.db.transaction(() => {
      const intents = listTerminalAuthCleanupIntents(ctx.db, term.id);
      if (intents.some((intent) => intent.phase !== "recoverable")) throw new TerminalGitAuthCleanupPendingError("terminal auth cleanup locator is not recoverable");
      for (const intent of intents) clearTerminalAuthCleanupIntent(ctx.db, term.id, intent.artifactKind);
      deleteTerminalRecord(ctx.db, term.id);
    })();
    logger.info({ terminalId: term.id }, "terminal deleted");
  });
}

/** 恢复创建/清理失败的 terminal intent；未知 tmux 错误保留记录等待下次重试。 */
export async function reconcilePendingTerminals(ctx: AppContext, logger: FastifyBaseLogger, runtimeOperations = defaultTerminalRuntimeOperations) {
  for (const workspace of listWorkspaces(ctx.db)) {
    const terminals = listTerminalsByWorkspace(ctx.db, workspace.id).filter((term) => term.status === "creating" || term.status === "errored");
    for (const term of terminals) {
      try {
        const intents = listTerminalAuthCleanupIntents(ctx.db, term.id);
        // armed/unresolved 都不能跨进程根据当前路径猜测安全；只有 root locator 已证明
        // recoverable 时，才允许调用 cleanup 并尝试同事务 clear + closed。
        if (intents.some((intent) => intent.phase !== "recoverable")) {
          throw new TerminalGitAuthCleanupPendingError("terminal auth cleanup locator is not recoverable");
        }
        await assertTerminalGitAuthCleanupRootAnchors(ctx.dataDir, intents);
        const presence = await runtimeOperations.hasSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
        if (presence === "exists") await runtimeOperations.killSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
        await runtimeOperations.cleanupAuthArtifacts(ctx.dataDir, term.id, intents);
        ctx.db.transaction(() => {
          const current = listTerminalAuthCleanupIntents(ctx.db, term.id);
          if (current.some((intent) => intent.phase !== "recoverable")) throw new TerminalGitAuthCleanupPendingError("terminal auth cleanup locator is not recoverable");
          for (const intent of current) clearTerminalAuthCleanupIntent(ctx.db, term.id, intent.artifactKind);
          updateTerminalStatus(ctx.db, term.id, "closed", nowMs());
        })();
      } catch (error) {
        logger.warn({ terminalId: term.id, workspaceId: term.workspaceId, err: error }, "terminal cleanup remains pending");
      }
    }
  }
}

export async function reconcileWorkspaceActiveTerminals(ctx: AppContext, logger: FastifyBaseLogger, workspaceId: string) {
  const active = listActiveTerminalsByWorkspace(ctx.db, workspaceId);
  if (active.length === 0) return;

  await Promise.all(
    active.map(async (t) => {
      try {
        const presence = await tmuxHasSession({ sessionName: t.sessionName, cwd: ctx.dataDir });
        if (presence === "exists") return;
        const intents = listTerminalAuthCleanupIntents(ctx.db, t.id);
        if (intents.some((intent) => intent.phase !== "recoverable")) throw new TerminalGitAuthCleanupPendingError("terminal auth cleanup locator is not recoverable");
        await assertTerminalGitAuthCleanupRootAnchors(ctx.dataDir, intents);
        await cleanupTerminalGitAuthArtifacts(ctx.dataDir, t.id, intents);
        ctx.db.transaction(() => {
          for (const intent of listTerminalAuthCleanupIntents(ctx.db, t.id)) clearTerminalAuthCleanupIntent(ctx.db, t.id, intent.artifactKind);
          updateTerminalStatus(ctx.db, t.id, "closed", nowMs());
        })();
      } catch (err) {
        logger.warn({ terminalId: t.id, err }, "reconcile terminal failed");
      }
    })
  );
}
