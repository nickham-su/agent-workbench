import fs from "node:fs/promises";
import path from "node:path";
import type { AppContext } from "../../app/context.js";
import { decryptToUtf8 } from "../crypto/secretBox.js";
import { ensureDir, rmrf } from "../fs/fs.js";
import { caCertPath, certsRoot, sshKnownHostsPath, sshRoot, tmpRoot } from "../fs/paths.js";
import { gitAskpassScriptV1 } from "./askpass.js";
import { extractGitHost, inferGitCredentialKindFromUrl } from "./gitHost.js";
import { shQuote } from "./shQuote.js";
import { getCredentialWithSecret, pickCredentialWithSecretForHost } from "../../modules/credentials/credentials.store.js";
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

  const credentialIdRaw = params.credentialId ? params.credentialId.trim() : "";
  let cred: ReturnType<typeof getCredentialWithSecret> | null = null;
  if (credentialIdRaw) {
    // repo 已绑定 credentialId：若不存在则不回退默认凭证，避免意外使用其他身份
    cred = getCredentialWithSecret(ctx.db, credentialIdRaw);
  } else {
    // 未绑定 credentialId：允许按 host + url kind 兜底默认凭证
    const host = extractGitHost(params.repoUrl);
    const preferredKind = inferGitCredentialKindFromUrl(params.repoUrl);
    if (host) {
      cred = pickCredentialWithSecretForHost(ctx.db, { host, preferredKind });
    }
  }
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
    const id = cred.record.id;
    const askpassPath = path.join(tmpRoot(ctx.dataDir), `git-askpass-${id}.sh`);
    const tokenPath = path.join(tmpRoot(ctx.dataDir), `git-askpass-token-${id}`);
    const username = sanitizeForAskpass(cred.record.username || "oauth2");
    await fs.writeFile(tokenPath, secret, { encoding: "utf-8", mode: 0o600 });
    await fs.writeFile(askpassPath, gitAskpassScriptV1(), { encoding: "utf-8", mode: 0o700 });
    cleanupPaths.push(askpassPath);
    cleanupPaths.push(tokenPath);

    return {
      env: {
        ...env,
        GIT_ASKPASS: askpassPath,
        GIT_ASKPASS_USERNAME: username,
        GIT_ASKPASS_TOKEN_FILE: tokenPath
      },
      cleanup: async () => {
        await Promise.all(cleanupPaths.map((p) => rmrf(p)));
      }
    };
  }

  // ssh
  await ensureDir(sshRoot(ctx.dataDir));
  const keyPath = path.join(tmpRoot(ctx.dataDir), `ssh-key-${cred.record.id}`);
  await fs.writeFile(keyPath, secret, { encoding: "utf-8", mode: 0o600 });
  cleanupPaths.push(keyPath);

  const knownHosts = sshKnownHostsPath(ctx.dataDir);
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
    env: {
      ...env,
      GIT_SSH_COMMAND: sshCmd
    },
    cleanup: async () => {
      await Promise.all(cleanupPaths.map((p) => rmrf(p)));
    }
  };
}
