import type { FastifyBaseLogger } from "fastify";
import fs from "node:fs/promises";
import type {
  ClearAllGitIdentityResponse,
  GitGlobalIdentity,
  NetworkSettings,
  ResetKnownHostRequest,
  SecurityStatus,
  UpdateGitGlobalIdentityRequest,
  UpdateNetworkSettingsRequest
} from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { ensureDir, pathExists } from "../../infra/fs/fs.js";
import { caCertPath, certsRoot, sshKnownHostsPath, sshRoot } from "../../infra/fs/paths.js";
import { nowMs } from "../../utils/time.js";
import { getSettingJson, setSettingJson } from "./settings.store.js";
import { gitConfigGet, gitConfigSet, gitConfigUnsetAll, validateAndNormalizeGitIdentity } from "../../infra/git/gitIdentity.js";
import { listWorkspaces } from "../workspaces/workspace.store.js";

type NetworkSettingsV1 = Omit<NetworkSettings, "updatedAt">;

const NETWORK_SETTINGS_KEY = "network";

function defaultNetworkSettings(): NetworkSettingsV1 {
  return { httpProxy: null, httpsProxy: null, noProxy: null, caCertPem: null, applyToTerminal: false };
}

export function getNetworkSettings(ctx: AppContext): NetworkSettings {
  const row = getSettingJson(ctx.db, NETWORK_SETTINGS_KEY);
  const base = defaultNetworkSettings();
  const value = row?.value as Partial<NetworkSettingsV1> | undefined;
  return {
    httpProxy: typeof value?.httpProxy === "string" ? value.httpProxy : null,
    httpsProxy: typeof value?.httpsProxy === "string" ? value.httpsProxy : null,
    noProxy: typeof value?.noProxy === "string" ? value.noProxy : null,
    caCertPem: typeof value?.caCertPem === "string" ? value.caCertPem : null,
    applyToTerminal: typeof value?.applyToTerminal === "boolean" ? value.applyToTerminal : base.applyToTerminal,
    updatedAt: row?.updatedAt ?? 0
  };
}

export async function updateNetworkSettings(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  bodyRaw: unknown
): Promise<NetworkSettings> {
  const body = (bodyRaw ?? {}) as UpdateNetworkSettingsRequest;
  const current = getNetworkSettings(ctx);
  const next: NetworkSettingsV1 = {
    httpProxy: body.httpProxy !== undefined ? (body.httpProxy ? String(body.httpProxy).trim() : null) : current.httpProxy,
    httpsProxy: body.httpsProxy !== undefined ? (body.httpsProxy ? String(body.httpsProxy).trim() : null) : current.httpsProxy,
    noProxy: body.noProxy !== undefined ? (body.noProxy ? String(body.noProxy).trim() : null) : current.noProxy,
    caCertPem: body.caCertPem !== undefined ? (body.caCertPem ? String(body.caCertPem) : null) : current.caCertPem,
    applyToTerminal: body.applyToTerminal !== undefined ? Boolean(body.applyToTerminal) : current.applyToTerminal
  };

  const updatedAt = nowMs();
  setSettingJson(ctx.db, NETWORK_SETTINGS_KEY, next, updatedAt);

  await ensureDir(certsRoot(ctx.dataDir));
  const caPath = caCertPath(ctx.dataDir);
  if (next.caCertPem) {
    await fs.writeFile(caPath, next.caCertPem, { encoding: "utf-8" });
  } else if (await pathExists(caPath)) {
    await fs.rm(caPath, { force: true });
  }

  logger.info({ updatedAt }, "network settings updated");
  return { ...next, updatedAt };
}

export function getSecurityStatus(ctx: AppContext): SecurityStatus {
  return {
    credentialMasterKey: {
      source: ctx.credentialMasterKeySource,
      keyId: ctx.credentialMasterKeyId,
      createdAt: ctx.credentialMasterKeyCreatedAt
    },
    sshKnownHostsPath: sshKnownHostsPath(ctx.dataDir)
  };
}

function hostToKnownHostsNeedle(hostRaw: string) {
  const host = String(hostRaw || "").trim();
  if (!host) return "";
  if (host.includes("\n") || host.includes("\r") || host.includes("\0")) return "";
  return host;
}

export async function resetKnownHost(ctx: AppContext, logger: FastifyBaseLogger, bodyRaw: unknown) {
  const body = (bodyRaw ?? {}) as ResetKnownHostRequest;
  const host = hostToKnownHostsNeedle((body as any).host);
  if (!host) throw new HttpError(400, "Invalid host");

  await ensureDir(sshRoot(ctx.dataDir));
  const p = sshKnownHostsPath(ctx.dataDir);
  if (!(await pathExists(p))) return;

  const raw = await fs.readFile(p, "utf-8");
  const lines = raw.split("\n");
  const nextLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return true;
    // known_hosts 第一列可能包含多个 host，以逗号分隔
    const first = trimmed.split(" ")[0] || "";
    const hosts = first.split(",").map((x) => x.trim());
    return !hosts.includes(host);
  });
  await fs.writeFile(p, nextLines.join("\n"), { encoding: "utf-8" });
  logger.info({ host }, "known_hosts entry removed");
}

export async function getGitGlobalIdentity(ctx: AppContext): Promise<GitGlobalIdentity> {
  const [name, email] = await Promise.all([
    gitConfigGet({ cwd: ctx.dataDir, global: true, key: "user.name" }),
    gitConfigGet({ cwd: ctx.dataDir, global: true, key: "user.email" })
  ]);
  return { name, email };
}

export async function updateGitGlobalIdentity(ctx: AppContext, logger: FastifyBaseLogger, bodyRaw: unknown): Promise<GitGlobalIdentity> {
  const v = validateAndNormalizeGitIdentity(bodyRaw as UpdateGitGlobalIdentityRequest);
  if (!v) throw new HttpError(400, "Invalid identity. Expected {name,email}.", "GIT_IDENTITY_INVALID");

  const okName = await gitConfigSet({ cwd: ctx.dataDir, global: true, key: "user.name", value: v.name });
  const okEmail = await gitConfigSet({ cwd: ctx.dataDir, global: true, key: "user.email", value: v.email });
  if (!okName || !okEmail) throw new HttpError(409, "Failed to set global git identity.", "GIT_IDENTITY_SET_FAILED");

  logger.info({ scope: "global" }, "git identity updated");
  return getGitGlobalIdentity(ctx);
}

export async function clearAllGitIdentity(ctx: AppContext, logger: FastifyBaseLogger): Promise<ClearAllGitIdentityResponse> {
  const before = await getGitGlobalIdentity(ctx);
  const hadGlobal = Boolean(before.name || before.email);

  // 全局清理
  const okGlobalName = await gitConfigUnsetAll({ cwd: ctx.dataDir, global: true, key: "user.name" });
  const okGlobalEmail = await gitConfigUnsetAll({ cwd: ctx.dataDir, global: true, key: "user.email" });
  const clearedGlobal = hadGlobal && okGlobalName && okGlobalEmail;

  // 遍历所有 workspace repo 目录清理（best-effort）
  const workspaces = listWorkspaces(ctx.db);
  const errors: ClearAllGitIdentityResponse["errors"] = [];

  const results = await Promise.all(
    workspaces.map(async (ws) => {
      try {
        if (!ws.path) return;
        if (!(await pathExists(ws.path))) return;
        const okName = await gitConfigUnsetAll({ cwd: ctx.dataDir, repoPath: ws.path, key: "user.name" });
        const okEmail = await gitConfigUnsetAll({ cwd: ctx.dataDir, repoPath: ws.path, key: "user.email" });
        return okName && okEmail ? 1 : 0;
      } catch (err) {
        errors.push({ workspaceId: ws.id, path: ws.path, error: err instanceof Error ? err.message : String(err) });
        return 0;
      }
    })
  );
  const clearedRepos = results.reduce<number>((sum, v) => sum + (v ?? 0), 0);

  logger.info({ clearedGlobal, clearedRepos, errors: errors.length }, "git identity cleared");
  return { ok: errors.length === 0, clearedGlobal, clearedRepos, errors };
}
