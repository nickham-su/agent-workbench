import { loadEnv } from "./config/env.js";
import { loadRootEnvLocalIntoProcessEnv } from "./config/dotenv.js";
import { detectAppVersion } from "./config/version.js";
import { detectRepoRoot } from "./config/repoRoot.js";
import { ensureDir } from "./infra/fs/fs.js";
import { pluginsRoot, reposRoot, workspacesRoot } from "./infra/fs/paths.js";
import { openDb } from "./infra/db/db.js";
import { createApp } from "./app/createApp.js";
import { createPreviewApp } from "./modules/preview/preview-app.js";
import { createWorkspacePreviewFileService } from "./modules/preview/preview-file.service.js";
import { startPreviewListenerLifecycle } from "./modules/preview/preview-lifecycle.js";
import { createPreviewRuntime } from "./modules/preview/preview-runtime.js";
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
if (env.preview.enabled) {
  const runtime = createPreviewRuntime({ publicOrigin: env.preview.origin, sessionTtlMs: env.preview.sessionTtlMs });
  let previewApp: Awaited<ReturnType<typeof createPreviewApp>> | null = null;
  let listenerLifecycleAttempted = false;
  try {
    previewApp = await createPreviewApp({ runtime, fileService: createWorkspacePreviewFileService({ db }) });
    const app = await createApp({
      db, repoRoot, dataDir: env.dataDir, fileMaxBytes: env.fileMaxBytes, version,
      logLevel: env.logLevel, serveWeb: env.serveWeb, webDistDir: env.webDistDir,
      credentialMasterKey: credentialMasterKey.key, credentialMasterKeySource: credentialMasterKey.source,
      credentialMasterKeyId: credentialMasterKey.keyId, credentialMasterKeyCreatedAt: credentialMasterKey.createdAt,
      authToken: env.authToken, authCookieSecure: env.authCookieSecure,
      agentWorkerEnabled: env.agentWorkerEnabled, agentWorkerHost: env.agentWorkerHost, agentWorkerPort: env.agentWorkerPort,
      agentWorkerSocketPath: env.agentWorkerSocketPath, agentWorkerConcurrency: env.agentWorkerConcurrency,
      agentInternalToken: env.agentInternalToken, agentWorkerResponseValidation: env.agentWorkerResponseValidation,
      agentApiOrigin: env.agentApiOrigin, agentStartupRecoveryMode: env.agentStartupRecoveryMode,
      agentPluginHostEnabled: env.agentPluginHostEnabled, agentPluginHostSocketPath: env.agentPluginHostSocketPath,
      agentPluginServicesEnabled: env.agentPluginServicesEnabled, preview: { enabled: true, runtime }
    });
    listenerLifecycleAttempted = true;
    const lifecycle = await startPreviewListenerLifecycle({
      previewApp, mainApp: app, runtime,
      previewListen: { host: env.preview.host, port: env.preview.port },
      mainListen: { host: env.host, port: env.port }
    });
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void lifecycle.close();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    if (!listenerLifecycleAttempted) {
      await previewApp?.close().catch(() => undefined);
      runtime.close();
    }
    throw error;
  }
} else {
  const app = await createApp({
    db,
    repoRoot,
    dataDir: env.dataDir,
    fileMaxBytes: env.fileMaxBytes,
    version,
    logLevel: env.logLevel,
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
    agentWorkerResponseValidation: env.agentWorkerResponseValidation,
    agentApiOrigin: env.agentApiOrigin,
    agentStartupRecoveryMode: env.agentStartupRecoveryMode,
    agentPluginHostEnabled: env.agentPluginHostEnabled,
    agentPluginHostSocketPath: env.agentPluginHostSocketPath,
    agentPluginServicesEnabled: env.agentPluginServicesEnabled,
    preview: { enabled: false, runtime: null }
  });

  await app.listen({ host: env.host, port: env.port });
}
