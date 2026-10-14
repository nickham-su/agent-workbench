import fs from "node:fs/promises";
import { formatRepoGitSshCommand } from "@agent-workbench/shared/internal-contracts/agent-api";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import type { AppContext } from "../../app/context.js";
import { decryptToUtf8 } from "../crypto/secretBox.js";
import { ensureDir, rmrf } from "../fs/fs.js";
import { caCertPath, sshKnownHostsPath, sshRoot, tmpRoot } from "../fs/paths.js";
import { closeSecureDirectories, openSecureRootDirectory, type SecureDirectory } from "../fs/secure-directory.js";
import { ensureCaBundleFile } from "../certs/caBundle.js";
import { gitAskpassScriptV1 } from "./askpass.js";
import { extractGitHost, inferGitCredentialKindFromUrl } from "./gitHost.js";
import { getCredentialWithSecret, pickCredentialWithSecretForHost } from "../../modules/credentials/credentials.store.js";
import { getSettingJson } from "../../modules/settings/settings.store.js";

/**
 * The caller owns the pinned directory throughout preparation. Borrowed cleanup
 * is valid only during that handle lifetime; the builder never closes it.
 */
export type GitEnvArtifactDirectory = {
  directory: SecureDirectory;
  /** Verify the original directory and every fixed ancestor before delivery. */
  assertCurrent: () => Promise<void>;
};

type NetworkSettingsV1 = {
  httpProxy: string | null;
  httpsProxy: string | null;
  noProxy: string | null;
  caCertPem: string | null;
};

function readNetworkSettings(ctx: AppContext): NetworkSettingsV1 {
  const row = getSettingJson(ctx.db, "network");
  const v = (row?.value ?? {}) as Partial<NetworkSettingsV1>;
  return {
    httpProxy: typeof v.httpProxy === "string" && v.httpProxy.trim() ? v.httpProxy.trim() : null,
    httpsProxy: typeof v.httpsProxy === "string" && v.httpsProxy.trim() ? v.httpsProxy.trim() : null,
    noProxy: typeof v.noProxy === "string" && v.noProxy.trim() ? v.noProxy.trim() : null,
    caCertPem: typeof v.caCertPem === "string" && v.caCertPem ? v.caCertPem : null
  };
}

function sanitizeForAskpass(raw: string) {
  const s = String(raw || "");
  if (s.includes("\0") || s.includes("\n") || s.includes("\r")) return "";
  return s;
}

/** Safe codes only: callers must not publish an underlying I/O or decrypt error. */
export class GitEnvBuildError extends Error {
  constructor(readonly code: "CREDENTIAL_NOT_FOUND" | "CREDENTIAL_DECRYPT_FAILED" | "GIT_ENV_PREPARE_FAILED") {
    super(code);
  }
}

export type GitEnvResult = {
  env: NodeJS.ProcessEnv;
  kind: "https" | "ssh" | "none";
  sensitiveFilePaths: string[];
  cleanup: () => Promise<void>;
};

async function writePrivateFile(directory: SecureDirectory, name: string, content: string, mode: number, createdNames: string[]) {
  const file = await fs.open(path.join(directory.fdPath, name), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
  createdNames.push(name);
  try {
    await file.chmod(mode);
    await file.writeFile(content, "utf-8");
  } finally {
    await file.close();
  }
}

export async function buildGitEnv(params: {
  ctx: AppContext;
  repoUrl: string;
  credentialId: string | null;
  /** API-owned pinned lease capability, never a path reopened by this builder. */
  artifactDir?: GitEnvArtifactDirectory;
  /** Existing UI/terminal callers retain their unbound/missing behavior by default. */
  strictBoundCredential?: boolean;
}): Promise<GitEnvResult> {
  const { ctx } = params;
  const network = readNetworkSettings(ctx);
  const caPath = await ensureCaBundleFile({
    dataDir: ctx.dataDir,
    customCaPem: network.caCertPem,
    fallbackCaPath: caCertPath(ctx.dataDir),
    writeCustomCa: false
  });
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
  if (network.httpProxy) { env.HTTP_PROXY = network.httpProxy; env.http_proxy = network.httpProxy; }
  if (network.httpsProxy) { env.HTTPS_PROXY = network.httpsProxy; env.https_proxy = network.httpsProxy; }
  if (network.noProxy) { env.NO_PROXY = network.noProxy; env.no_proxy = network.noProxy; }
  if (caPath) { env.GIT_SSL_CAINFO = caPath; env.SSL_CERT_FILE = caPath; }

  const credentialIdRaw = params.credentialId ? params.credentialId.trim() : "";
  let cred: ReturnType<typeof getCredentialWithSecret> | null = null;
  if (credentialIdRaw) {
    // A stale explicit binding is never replaced by another identity.
    cred = getCredentialWithSecret(ctx.db, credentialIdRaw);
    if (!cred && params.strictBoundCredential) throw new GitEnvBuildError("CREDENTIAL_NOT_FOUND");
  } else {
    const host = extractGitHost(params.repoUrl);
    const preferredKind = inferGitCredentialKindFromUrl(params.repoUrl);
    if (host) cred = pickCredentialWithSecretForHost(ctx.db, { host, preferredKind });
  }
  if (!cred) return { env, kind: "none", sensitiveFilePaths: [], cleanup: async () => {} };

  let secret: string;
  try {
    secret = decryptToUtf8({ key: ctx.credentialMasterKey, ciphertext: cred.secretEnc });
  } catch {
    throw new GitEnvBuildError("CREDENTIAL_DECRYPT_FAILED");
  }

  let opTmpDir: string | undefined;
  let directory: SecureDirectory | undefined;
  const createdNames: string[] = [];
  const borrowedDirectory = params.artifactDir !== undefined;
  const cleanupBorrowedArtifacts = async () => {
    // Do not reopen logicalPath: an ancestor may now point at unrelated data.
    // A closed capability must fail rather than using a possibly recycled fdPath.
    const stat = await directory!.handle.stat();
    if (stat.dev !== directory!.stat.dev || stat.ino !== directory!.stat.ino) throw new GitEnvBuildError("GIT_ENV_PREPARE_FAILED");
    for (const name of createdNames) {
      await fs.unlink(path.join(directory!.fdPath, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
  try {
    if (borrowedDirectory) {
      directory = params.artifactDir!.directory;
      opTmpDir = directory.logicalPath;
      await params.artifactDir!.assertCurrent();
      const stat = await directory.handle.stat();
      if (!stat.isDirectory() || stat.dev !== directory.stat.dev || stat.ino !== directory.stat.ino || (stat.mode & 0o777) !== 0o700) {
        throw new GitEnvBuildError("GIT_ENV_PREPARE_FAILED");
      }
    } else {
      await ensureDir(tmpRoot(ctx.dataDir));
      opTmpDir = await fs.mkdtemp(path.join(tmpRoot(ctx.dataDir), `git-env-${cred.record.id}-`));
      await fs.chmod(opTmpDir, 0o700);
      directory = await openSecureRootDirectory(opTmpDir);
    }
    const cleanup = async () => {
      if (!borrowedDirectory) { await rmrf(opTmpDir!); return; }
      // The lease service owns meta, the directory and the handle lifetime.
      await cleanupBorrowedArtifacts();
    };
    if (cred.record.kind === "https") {
      const askpassPath = path.join(opTmpDir, "git-askpass.sh");
      const tokenPath = path.join(opTmpDir, "git-askpass-token");
      await writePrivateFile(directory, "git-askpass-token", secret, 0o600, createdNames);
      await writePrivateFile(directory, "git-askpass.sh", gitAskpassScriptV1(), 0o700, createdNames);
      await params.artifactDir?.assertCurrent();
      return {
        env: { ...env, GIT_ASKPASS: askpassPath, GIT_ASKPASS_USERNAME: sanitizeForAskpass(cred.record.username || "oauth2"), GIT_ASKPASS_TOKEN_FILE: tokenPath },
        kind: "https", sensitiveFilePaths: [tokenPath], cleanup,
      };
    }
    await ensureDir(sshRoot(ctx.dataDir));
    const keyPath = path.join(opTmpDir, "ssh-key");
    await writePrivateFile(directory, "ssh-key", secret, 0o600, createdNames);
    const sshCmd = formatRepoGitSshCommand(keyPath, sshKnownHostsPath(ctx.dataDir));
    await params.artifactDir?.assertCurrent();
    return { env: { ...env, GIT_SSH_COMMAND: sshCmd }, kind: "ssh", sensitiveFilePaths: [keyPath], cleanup };
  } catch (error) {
    // Include partially created files; no closure is required to recover a failed build.
    if (borrowedDirectory && directory) {
      await cleanupBorrowedArtifacts().catch(() => undefined);
    } else if (directory) {
      for (const name of createdNames) await fs.unlink(path.join(directory.fdPath, name)).catch(() => undefined);
    }
    if (!borrowedDirectory && opTmpDir) await rmrf(opTmpDir).catch(() => undefined);
    if (error instanceof GitEnvBuildError) throw error;
    throw new GitEnvBuildError("GIT_ENV_PREPARE_FAILED");
  } finally {
    if (!borrowedDirectory) await closeSecureDirectories(directory);
  }
}
