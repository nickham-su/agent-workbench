import type { Db } from "../infra/db/db.js";
import type { CredentialMasterKeySource } from "../infra/crypto/credentialMasterKey.js";

export type AgentTestFaults = {
  archiveWrite?: {
    failAfterChunks?: number;
  } | null;
  archiveRollback?: {
    appendBeforeRollback?: string;
  } | null;
  archiveSidecar?: {
    failWrite?: boolean;
    failRename?: boolean;
  } | null;
};

export type AppContext = {
  db: Db;
  repoRoot: string;
  dataDir: string;
  fileMaxBytes: number;
  version: string;
  logLevel?: string;
  serveWeb: boolean;
  webDistDir: string | null;
  credentialMasterKey: Buffer;
  credentialMasterKeySource: CredentialMasterKeySource;
  credentialMasterKeyId: string;
  credentialMasterKeyCreatedAt: number | null;
  authToken: string | null;
  authCookieSecure: boolean;
  agentWorkerEnabled: boolean;
  agentWorkerHost: string;
  agentWorkerPort: number;
  agentWorkerSocketPath: string;
  agentWorkerConcurrency: number;
  agentInternalToken: string;
  agentWorkerResponseValidation: "strict" | "warn";
  agentApiOrigin: string;
  agentStartupRecoveryMode: "fail" | "recover";
  agentPluginHostEnabled: boolean;
  agentPluginHostSocketPath: string;
  agentPluginServicesEnabled?: boolean;
  agentTestFaults?: AgentTestFaults;
};
