import type { Db } from "../infra/db/db.js";
import type { CredentialMasterKeySource } from "../infra/crypto/credentialMasterKey.js";

export type AppContext = {
  db: Db;
  dataDir: string;
  fileMaxBytes: number;
  version: string;
  serveWeb: boolean;
  webDistDir: string | null;
  credentialMasterKey: Buffer;
  credentialMasterKeySource: CredentialMasterKeySource;
  credentialMasterKeyId: string;
  credentialMasterKeyCreatedAt: number | null;
};
