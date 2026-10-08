import type { Db } from "../infra/db/db.js";
import type { AppLogLevel } from "../config/env.js";
import type { CredentialMasterKeySource } from "../infra/crypto/credentialMasterKey.js";
import type { PreviewRuntime } from "../modules/preview/preview-runtime.js";
import type { AnalyticsWorkerFactory } from "../modules/analytics/analytics-supervisor.js";


export type AppContext = {
  db: Db;
  repoRoot: string;
  dataDir: string;
  fileMaxBytes: number;
  version: string;
  logLevel?: AppLogLevel;
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
  agentPluginHostEnabled: boolean;
  agentPluginHostSocketPath: string;
  agentPluginServicesEnabled?: boolean;
  /** Production enables Analytics explicitly; tests may inject a fake child. */
  analytics?: {
    enabled: boolean;
    workerFactory?: AnalyticsWorkerFactory;
    startupTimeoutMs?: number;
    queryTimeoutMs?: number;
    signalTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    restartLimit?: number;
    restartDelayMs?: number;
    collectorEnabled?: boolean;
    collectorIntervalMs?: number;
    collectorBatchSize?: number;
  };
  /** In-process only capability; never exposed as an HTTP producer credential. */
  analyticsDiagnostics?: {
    outboxCorrupt(input: { producerGeneration: string; recordedAt?: number }): Promise<boolean>;
    abandonLocalFallbackGeneration(input: { producerGeneration: string; recordedAt?: number }): Promise<boolean>;
  };
  preview:
    | { enabled: false; runtime: null }
    | { enabled: true; runtime: PreviewRuntime };
};
