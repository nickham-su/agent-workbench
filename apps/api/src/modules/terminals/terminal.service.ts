import type { FastifyBaseLogger } from "fastify";
import type { TerminalRecord } from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import fs from "node:fs/promises";
import { newId } from "../../utils/ids.js";
import { nowMs } from "../../utils/time.js";
import { getWorkspace } from "../workspaces/workspace.store.js";
import { tmuxHasSession, tmuxKillSession, tmuxNewSession } from "../../infra/tmux/session.js";
import { ensureDir } from "../../infra/fs/fs.js";
import { sshKnownHostsPath, sshRoot, tmpRoot } from "../../infra/fs/paths.js";
import { decryptToUtf8 } from "../../infra/crypto/secretBox.js";
import { getRepo } from "../repos/repo.store.js";
import { extractGitHost, inferGitCredentialKindFromUrl } from "../../infra/git/gitHost.js";
import { gitAskpassScriptV1 } from "../../infra/git/askpass.js";
import { shQuote } from "../../infra/git/shQuote.js";
import { getCredentialWithSecret, pickCredentialWithSecretForHost } from "../credentials/credentials.store.js";
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

async function buildTerminalGitEnv(params: {
  ctx: AppContext;
  terminalId: string;
  workspaceId: string;
}): Promise<{ envPairs: string[] }> {
  const ws = getWorkspace(params.ctx.db, params.workspaceId);
  if (!ws) throw new HttpError(404, "Workspace not found");

  const repo = getRepo(params.ctx.db, ws.repoId);
  if (!repo) return { envPairs: [] };

  const repoCredentialId = repo.credentialId ? String(repo.credentialId || "").trim() : "";
  let cred: ReturnType<typeof getCredentialWithSecret> | null = null;

  if (repoCredentialId) {
    cred = getCredentialWithSecret(params.ctx.db, repoCredentialId);
  } else {
    const host = extractGitHost(repo.url);
    if (host) {
      const preferredKind = inferGitCredentialKindFromUrl(repo.url);
      cred = pickCredentialWithSecretForHost(params.ctx.db, { host, preferredKind });
    }
  }

  if (!cred) return { envPairs: [] };

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
      envPairs: ["GIT_TERMINAL_PROMPT=0", `GIT_SSH_COMMAND=${sshCmd}`]
    };
  }

  const askpassPath = terminalAskpassPath(params.ctx.dataDir, params.terminalId);
  const tokenPath = terminalAskpassTokenPath(params.ctx.dataDir, params.terminalId);
  await fs.writeFile(askpassPath, gitAskpassScriptV1(), { encoding: "utf-8", mode: 0o700 });
  await fs.writeFile(tokenPath, secret, { encoding: "utf-8", mode: 0o600 });
  const username = sanitizeEnvValue(cred.record.username || "oauth2");
  return {
    envPairs: [
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
    try {
      await tmuxNewSession({ sessionName, cwd: ws.path, command });
    } catch (err) {
      if (!params.shell) {
        // 默认 shell 失败时降级到 sh
        const fallback = envPairs.length > 0 ? ["env", ...envPairs, "sh"] : ["sh"];
        await tmuxNewSession({ sessionName, cwd: ws.path, command: fallback });
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
