import fs from "node:fs/promises";
import path from "node:path";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { decryptToUtf8 } from "../../infra/crypto/secretBox.js";
import { ensureDir, rmrf } from "../../infra/fs/fs.js";
import { sshKnownHostsPath, sshRoot, tmpRoot } from "../../infra/fs/paths.js";
import { gitAskpassScriptV1 } from "../../infra/git/askpass.js";
import { shQuote } from "../../infra/git/shQuote.js";
import { newSortableId } from "../../utils/ids.js";
import { getCredentialWithSecret } from "../credentials/credentials.store.js";
import { getWorkspace } from "../workspaces/workspace.store.js";
import { gitEnvLeaseRoot } from "./git-env.janitor.js";

type PrepareOk = {
  ok: true;
  kind: "https" | "ssh" | "none";
  env: Record<string, string>;
  leaseId: string | null;
  expiresAt: string | null;
};

type PrepareFail = {
  ok: false;
  errorCode: string;
  error: string;
};

export type GitEnvPrepareResponse = PrepareOk | PrepareFail;

function sanitizeEnvValue(raw: string) {
  const s = String(raw || "");
  if (s.includes("\0") || s.includes("\n") || s.includes("\r")) return "";
  return s;
}

function isUnderRoot(root: string, target: string) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  return targetAbs === rootAbs || targetAbs.startsWith(rootAbs + path.sep);
}

async function writeJsonAtomic(filePath: string, json: unknown) {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(json, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

async function ensureLeaseDir(leaseDir: string) {
  await fs.mkdir(leaseDir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(leaseDir, 0o700);
  } catch {
    // ignore
  }
}

export async function prepareGitEnvLeaseForBash(params: {
  ctx: AppContext;
  workspaceId: string;
  cwd: string;
  purpose?: string;
  timeoutMs?: number;
}): Promise<GitEnvPrepareResponse> {
  const { ctx } = params;
  const workspaceId = String(params.workspaceId || "").trim();
  const cwd = String(params.cwd || "").trim();
  if (!workspaceId) return { ok: false, errorCode: "WORKSPACE_ID_REQUIRED", error: "workspaceId is required" };
  if (!cwd) return { ok: false, errorCode: "CWD_REQUIRED", error: "cwd is required" };

  const ws = getWorkspace(ctx.db, workspaceId);
  if (!ws) {
    return { ok: false, errorCode: "WORKSPACE_NOT_FOUND", error: "workspace not found" };
  }

  const workspacePathAbs = path.resolve(ws.path);
  const cwdAbs = path.resolve(cwd);
  if (!isUnderRoot(workspacePathAbs, cwdAbs)) {
    return { ok: false, errorCode: "CWD_OUTSIDE_WORKSPACE", error: "cwd must be under workspace root" };
  }

  // Adjusted strategy: ONLY use workspace.terminal_credential_id.
  // `cwd` is used only as a security boundary check.
  const pickedCredentialId = ws.terminalCredentialId ? String(ws.terminalCredentialId || "").trim() : "";

  const baseEnv: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0"
  };

  if (!pickedCredentialId) {
    return { ok: true, kind: "none", env: baseEnv, leaseId: null, expiresAt: null };
  }

  const cred = getCredentialWithSecret(ctx.db, pickedCredentialId);
  if (!cred) {
    return { ok: false, errorCode: "CREDENTIAL_NOT_FOUND", error: "credential not found" };
  }

  let secret: string;
  try {
    secret = decryptToUtf8({ key: ctx.credentialMasterKey, ciphertext: cred.secretEnc });
  } catch {
    return { ok: false, errorCode: "CREDENTIAL_DECRYPT_FAILED", error: "credential decrypt failed" };
  }
  const leaseId = newSortableId("lease");
  const leaseRoot = gitEnvLeaseRoot(ctx.dataDir);
  const leaseDir = path.join(leaseRoot, leaseId);

  const now = Date.now();
  const minTtlMs = 15 * 60 * 1000;
  const bufferMs = 5 * 60 * 1000;
  const requestedMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) ? Math.max(0, params.timeoutMs) : 0;
  const maxTtlMs = 6 * 60 * 60 * 1000;
  const ttlMs = Math.min(maxTtlMs, Math.max(minTtlMs, requestedMs + bufferMs));
  const expiresAtMs = now + ttlMs;
  const expiresAtIso = new Date(expiresAtMs).toISOString();

  try {
    await ensureDir(tmpRoot(ctx.dataDir));
    await ensureDir(leaseRoot);
    await ensureLeaseDir(leaseDir);

    const meta = {
      schemaVersion: 1,
      leaseId,
      workspaceId,
      kind: cred.record.kind,
      tempDir: leaseDir,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAtIso,
      status: "active",
      purpose: params.purpose ?? "bash"
    };

    if (cred.record.kind === "https") {
      const askpassPath = path.join(leaseDir, "askpass.sh");
      const tokenPath = path.join(leaseDir, "token");
      const username = sanitizeEnvValue(cred.record.username || "oauth2") || "oauth2";
      await fs.writeFile(tokenPath, secret, { encoding: "utf-8", mode: 0o600 });
      await fs.writeFile(askpassPath, gitAskpassScriptV1(), { encoding: "utf-8", mode: 0o700 });
      await writeJsonAtomic(path.join(leaseDir, "meta.json"), meta);
      return {
        ok: true,
        kind: "https",
        env: {
          ...baseEnv,
          GIT_ASKPASS: askpassPath,
          GIT_ASKPASS_USERNAME: username,
          GIT_ASKPASS_TOKEN_FILE: tokenPath
        },
        leaseId,
        expiresAt: expiresAtIso
      };
    }

    // ssh
    await ensureDir(sshRoot(ctx.dataDir));
    const keyPath = path.join(leaseDir, "id_ed25519");
    await fs.writeFile(keyPath, secret, { encoding: "utf-8", mode: 0o600 });
    const knownHosts = sshKnownHostsPath(ctx.dataDir);
    // Ensure known_hosts exists (may be empty).
    try {
      await fs.writeFile(knownHosts, "", { encoding: "utf-8", flag: "a", mode: 0o600 });
      try {
        await fs.chmod(knownHosts, 0o600);
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
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
    await writeJsonAtomic(path.join(leaseDir, "meta.json"), meta);
    return {
      ok: true,
      kind: "ssh",
      env: {
        ...baseEnv,
        GIT_SSH_COMMAND: sshCmd
      },
      leaseId,
      expiresAt: expiresAtIso
    };
  } catch (err) {
    try {
      await rmrf(leaseDir);
    } catch {
      // ignore
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errorCode: "TEMP_FILE_WRITE_FAILED", error: message };
  }
}

export async function cleanupGitEnvLease(params: { ctx: AppContext; leaseId: string }) {
  const { ctx } = params;
  const leaseId = String(params.leaseId || "").trim();
  if (!leaseId) throw new HttpError(400, "leaseId is required", "LEASE_ID_REQUIRED");

  const root = gitEnvLeaseRoot(ctx.dataDir);
  const leaseDir = path.resolve(path.join(root, leaseId));
  if (!isUnderRoot(root, leaseDir)) {
    throw new HttpError(400, "invalid leaseId", "LEASE_ID_INVALID");
  }

  // best-effort idempotent cleanup
  await rmrf(leaseDir);
}
