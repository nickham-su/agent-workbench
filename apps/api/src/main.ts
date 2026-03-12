import { loadEnv } from "./config/env.js";
import { loadRootEnvLocalIntoProcessEnv } from "./config/dotenv.js";
import { detectAppVersion } from "./config/version.js";
import { detectRepoRoot } from "./config/repoRoot.js";
import { ensureDir } from "./infra/fs/fs.js";
import { pluginsRoot, reposRoot, workspacesRoot } from "./infra/fs/paths.js";
import { openDb } from "./infra/db/db.js";
import { createApp } from "./app/createApp.js";
import { ensureNodePtyReady } from "./infra/pty/ensureNodePty.js";
import { loadCredentialMasterKey } from "./infra/crypto/credentialMasterKey.js";

await loadRootEnvLocalIntoProcessEnv();
const env = loadEnv(process.env);
const version = await detectAppVersion();
const repoRoot = await detectRepoRoot();

await ensureDir(env.dataDir);
await ensureDir(reposRoot(env.dataDir));
await ensureDir(workspacesRoot(env.dataDir));
await ensureDir(pluginsRoot(env.dataDir));
await ensureNodePtyReady();

const credentialMasterKey = await loadCredentialMasterKey({ dataDir: env.dataDir, processEnv: process.env });

const db = await openDb(env.dataDir);
const app = await createApp({
  db,
  repoRoot,
  dataDir: env.dataDir,
  fileMaxBytes: env.fileMaxBytes,
  version,
  logLevel: process.env.AWB_LOG_LEVEL?.trim() || "info",
  serveWeb: env.serveWeb,
  webDistDir: env.webDistDir,
  credentialMasterKey: credentialMasterKey.key,
  credentialMasterKeySource: credentialMasterKey.source,
  credentialMasterKeyId: credentialMasterKey.keyId,
  credentialMasterKeyCreatedAt: credentialMasterKey.createdAt,
  authToken: env.authToken,
  authCookieSecure: env.authCookieSecure,
  agentWorkerEnabled: env.agentWorkerEnabled,
  agentWorkerHost: env.agentWorkerHost,
  agentWorkerPort: env.agentWorkerPort,
  agentWorkerSocketPath: env.agentWorkerSocketPath,
  agentWorkerConcurrency: env.agentWorkerConcurrency,
  agentInternalToken: env.agentInternalToken,
  agentApiOrigin: env.agentApiOrigin,
  agentStartupRecoveryMode: env.agentStartupRecoveryMode,
  agentPluginHostEnabled: env.agentPluginHostEnabled,
  agentPluginHostSocketPath: env.agentPluginHostSocketPath,
  agentPluginServicesEnabled: env.agentPluginServicesEnabled
});

await app.listen({ host: env.host, port: env.port });
