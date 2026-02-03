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
import { ensureDir, pathExists } from "../../infra/fs/fs.js";
import { caCertPath, sshKnownHostsPath, sshRoot, tmpRoot } from "../../infra/fs/paths.js";
import { ensureCaBundleFile } from "../../infra/certs/caBundle.js";
import { decryptToUtf8 } from "../../infra/crypto/secretBox.js";
import { gitAskpassScriptV1 } from "../../infra/git/askpass.js";
import { shQuote } from "../../infra/git/shQuote.js";
import { getCredentialWithSecret } from "../credentials/credentials.store.js";
import { getSettingJson } from "../settings/settings.store.js";
import {
  insertTerminal,
  getTerminal,
  updateTerminalStatus,
  deleteTerminalRecord,
  listActiveTerminalsByWorkspace
} from "./terminal.store.js";
import {
  cleanupTerminalGitAuthArtifacts,
  terminalAskpassPath,
  terminalAskpassTokenPath,
  terminalSshKeyPath
} from "./terminal.gitAuth.js";

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
}): Promise<{ envPairs: string[] }> {
  const networkPairs = await buildTerminalNetworkEnvPairs(params.ctx);
  const ws = getWorkspace(params.ctx.db, params.workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");

  const repoCredentialId = ws.terminalCredentialId ? String(ws.terminalCredentialId || "").trim() : "";
  const cred = repoCredentialId ? getCredentialWithSecret(params.ctx.db, repoCredentialId) : null;

  if (!cred) return { envPairs: networkPairs };

  const secret = decryptToUtf8({ key: params.ctx.credentialMasterKey, ciphertext: cred.secretEnc });
  await ensureDir(tmpRoot(params.ctx.dataDir));

  if (cred.record.kind === "ssh") {
    await ensureDir(sshRoot(params.ctx.dataDir));
    const keyPath = terminalSshKeyPath(params.ctx.dataDir, params.terminalId);
    await fs.writeFile(keyPath, secret, { encoding: "utf-8", mode: 0o600 });
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
  await fs.writeFile(askpassPath, gitAskpassScriptV1(), { encoding: "utf-8", mode: 0o700 });
  await fs.writeFile(tokenPath, secret, { encoding: "utf-8", mode: 0o600 });
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
  params: { workspaceId: string; shell?: string }
): Promise<TerminalRecord> {
  const workspaceId = params.workspaceId.trim();
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");
  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");

  const terminalId = newId("term");
  const sessionName = `term_${terminalId}`;
  const ts = nowMs();
  const term: TerminalRecord = {
    id: terminalId,
    workspaceId: ws.id,
    sessionName,
    status: "active",
    createdAt: ts,
    updatedAt: ts
  };

  const shell = params.shell?.trim() || "bash";
  try {
    const { envPairs } = await buildTerminalGitEnv({ ctx, terminalId, workspaceId: ws.id });
    const command = envPairs.length > 0 ? ["env", ...envPairs, shell] : [shell];
    const cwd = await resolveTerminalCwd(ctx, ws);
    try {
      await tmuxNewSession({ sessionName, cwd, command });
    } catch (err) {
      if (!params.shell) {
        // 默认 shell 失败时降级到 sh
        const fallback = envPairs.length > 0 ? ["env", ...envPairs, "sh"] : ["sh"];
        await tmuxNewSession({ sessionName, cwd, command: fallback });
      } else {
        throw err;
      }
    }
  } catch (err) {
    await cleanupTerminalGitAuthArtifacts(ctx.dataDir, terminalId);
    throw err;
  }

  insertTerminal(ctx.db, term);
  logger.info({ terminalId, workspaceId }, "terminal created");
  return term;
}

export async function getTerminalById(ctx: AppContext, terminalId: string): Promise<TerminalRecord> {
  const term = getTerminal(ctx.db, terminalId);
  if (!term) throw new HttpError(404, "Terminal not found");
  return term;
}

export async function deleteTerminal(ctx: AppContext, logger: FastifyBaseLogger, terminalId: string) {
  const term = await getTerminalById(ctx, terminalId);
  try {
    await safeKillTerminalSession(ctx, term);
  } finally {
    await cleanupTerminalGitAuthArtifacts(ctx.dataDir, term.id);
  }
  deleteTerminalRecord(ctx.db, term.id);
  logger.info({ terminalId: term.id }, "terminal deleted");
}

export async function safeKillTerminalSession(ctx: AppContext, term: TerminalRecord) {
  const exists = await tmuxHasSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
  if (!exists) return;
  await tmuxKillSession({ sessionName: term.sessionName, cwd: ctx.dataDir });
  updateTerminalStatus(ctx.db, term.id, "closed", nowMs());
}

export async function reconcileWorkspaceActiveTerminals(ctx: AppContext, logger: FastifyBaseLogger, workspaceId: string) {
  const active = listActiveTerminalsByWorkspace(ctx.db, workspaceId);
  if (active.length === 0) return;

  await Promise.all(
    active.map(async (t) => {
      try {
        const exists = await tmuxHasSession({ sessionName: t.sessionName, cwd: ctx.dataDir });
        if (exists) return;
        updateTerminalStatus(ctx.db, t.id, "closed", nowMs());
        await cleanupTerminalGitAuthArtifacts(ctx.dataDir, t.id);
      } catch (err) {
        logger.warn({ terminalId: t.id, err }, "reconcile terminal failed");
      }
    })
  );
}
