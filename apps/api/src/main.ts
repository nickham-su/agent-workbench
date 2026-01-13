import { loadEnv } from "./config/env.js";
import { loadRootEnvLocalIntoProcessEnv } from "./config/dotenv.js";
import { detectAppVersion } from "./config/version.js";
import { ensureDir } from "./infra/fs/fs.js";
import { reposRoot, workspacesRoot } from "./infra/fs/paths.js";
import { openDb } from "./infra/db/db.js";
import { createApp } from "./app/createApp.js";
import { ensureNodePtyReady } from "./infra/pty/ensureNodePty.js";
import { loadCredentialMasterKey } from "./infra/crypto/credentialMasterKey.js";

await loadRootEnvLocalIntoProcessEnv();
const env = loadEnv(process.env);
const version = await detectAppVersion();

await ensureDir(env.dataDir);
await ensureDir(reposRoot(env.dataDir));
await ensureDir(workspacesRoot(env.dataDir));
await ensureNodePtyReady();

const credentialMasterKey = await loadCredentialMasterKey({ dataDir: env.dataDir, processEnv: process.env });

const db = await openDb(env.dataDir);
const app = await createApp({
  db,
  dataDir: env.dataDir,
  fileMaxBytes: env.fileMaxBytes,
  version,
  serveWeb: env.serveWeb,
  webDistDir: env.webDistDir,
  credentialMasterKey: credentialMasterKey.key,
  credentialMasterKeySource: credentialMasterKey.source,
  credentialMasterKeyId: credentialMasterKey.keyId,
  credentialMasterKeyCreatedAt: credentialMasterKey.createdAt,
  authToken: env.authToken,
  authCookieSecure: env.authCookieSecure
});

await app.listen({ host: env.host, port: env.port });
