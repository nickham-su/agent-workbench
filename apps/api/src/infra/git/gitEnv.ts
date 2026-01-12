import fs from "node:fs/promises";
import path from "node:path";
import type { AppContext } from "../../app/context.js";
import { decryptToUtf8 } from "../crypto/secretBox.js";
import { ensureDir, rmrf } from "../fs/fs.js";
import { caCertPath, certsRoot, sshKnownHostsPath, sshRoot, tmpRoot } from "../fs/paths.js";
import { getCredentialWithSecret } from "../../modules/credentials/credentials.store.js";
import { getSettingJson } from "../../modules/settings/settings.store.js";

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

async function ensureCaCertFile(ctx: AppContext, caPem: string | null) {
  if (!caPem) return null;
  await ensureDir(certsRoot(ctx.dataDir));
  const p = caCertPath(ctx.dataDir);
  await fs.writeFile(p, caPem, { encoding: "utf-8" });
  return p;
}

function sanitizeForAskpass(raw: string) {
  const s = String(raw || "");
  if (s.includes("\0") || s.includes("\n") || s.includes("\r")) return "";
  return s;
}

export type GitEnvResult = {
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
};

export async function buildGitEnv(params: {
  ctx: AppContext;
  repoUrl: string;
  credentialId: string | null;
}): Promise<GitEnvResult> {
  const { ctx } = params;

  const network = readNetworkSettings(ctx);
  const caPath = await ensureCaCertFile(ctx, network.caCertPem);

  const cleanupPaths: string[] = [];
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0"
  };

  if (network.httpProxy) {
    env.HTTP_PROXY = network.httpProxy;
    env.http_proxy = network.httpProxy;
  }
  if (network.httpsProxy) {
    env.HTTPS_PROXY = network.httpsProxy;
    env.https_proxy = network.httpsProxy;
  }
  if (network.noProxy) {
    env.NO_PROXY = network.noProxy;
    env.no_proxy = network.noProxy;
  }
  if (caPath) {
    env.GIT_SSL_CAINFO = caPath;
    env.SSL_CERT_FILE = caPath;
  }

  const credentialId = params.credentialId ? params.credentialId.trim() : "";
  if (!credentialId) {
    return {
      env,
      cleanup: async () => {
        // no-op
      }
    };
  }

  const cred = getCredentialWithSecret(ctx.db, credentialId);
  if (!cred) {
    return {
      env,
      cleanup: async () => {
        // no-op
      }
    };
  }

  const secret = decryptToUtf8({ key: ctx.credentialMasterKey, ciphertext: cred.secretEnc });

  await ensureDir(tmpRoot(ctx.dataDir));
  if (cred.record.kind === "https") {
    const askpassPath = path.join(tmpRoot(ctx.dataDir), `git-askpass-${credentialId}.sh`);
    const username = sanitizeForAskpass(cred.record.username || "oauth2");
    const token = sanitizeForAskpass(secret);

    const script = `#!/bin/sh
prompt="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
case "$prompt" in
  *username*) printf '%s' "$GIT_ASKPASS_USERNAME" ;;
  *) printf '%s' "$GIT_ASKPASS_TOKEN" ;;
esac
`;
    await fs.writeFile(askpassPath, script, { encoding: "utf-8", mode: 0o700 });
    cleanupPaths.push(askpassPath);

    return {
      env: {
        ...env,
        GIT_ASKPASS: askpassPath,
        GIT_ASKPASS_USERNAME: username,
        GIT_ASKPASS_TOKEN: token
      },
      cleanup: async () => {
        await Promise.all(cleanupPaths.map((p) => rmrf(p)));
      }
    };
  }

  // ssh
  await ensureDir(sshRoot(ctx.dataDir));
  const keyPath = path.join(tmpRoot(ctx.dataDir), `ssh-key-${credentialId}`);
  await fs.writeFile(keyPath, secret, { encoding: "utf-8", mode: 0o600 });
  cleanupPaths.push(keyPath);

  const knownHosts = sshKnownHostsPath(ctx.dataDir);
  const sshCmd = [
    "ssh",
    "-i",
    keyPath,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    "StrictHostKeyChecking=accept-new"
  ].join(" ");

  return {
    env: {
      ...env,
      GIT_SSH_COMMAND: sshCmd
    },
    cleanup: async () => {
      await Promise.all(cleanupPaths.map((p) => rmrf(p)));
    }
  };
}

