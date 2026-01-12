import crypto from "node:crypto";
import fs from "node:fs/promises";
import { ensureDir, pathExists } from "../fs/fs.js";
import { credentialMasterKeyJsonPath, keysRoot } from "../fs/paths.js";

export type CredentialMasterKeySource = "env" | "file" | "generated";

type StoredKeyFile = {
  keyB64: string;
  createdAt: number;
};

function shaKeyId(key: Buffer) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function parseKeyFromEnv(raw: string): Buffer {
  const s = raw.trim();
  if (!s) throw new Error("CREDENTIAL_MASTER_KEY is empty");

  const hexRe = /^[0-9a-fA-F]+$/;
  if (hexRe.test(s) && s.length === 64) {
    return Buffer.from(s, "hex");
  }

  // 允许 base64/base64url
  try {
    const b = Buffer.from(s, "base64");
    if (b.byteLength === 32) return b;
  } catch {
    // ignore
  }
  try {
    const b = Buffer.from(s, "base64url");
    if (b.byteLength === 32) return b;
  } catch {
    // ignore
  }

  throw new Error("Invalid CREDENTIAL_MASTER_KEY format (expected 32-byte hex/base64/base64url)");
}

export async function loadCredentialMasterKey(params: {
  dataDir: string;
  processEnv: NodeJS.ProcessEnv;
}): Promise<{ key: Buffer; source: CredentialMasterKeySource; keyId: string; createdAt: number | null }> {
  const envRaw = params.processEnv.CREDENTIAL_MASTER_KEY?.trim() || "";
  if (envRaw) {
    const key = parseKeyFromEnv(envRaw);
    return { key, source: "env", keyId: shaKeyId(key), createdAt: null };
  }

  await ensureDir(keysRoot(params.dataDir));
  const keyPath = credentialMasterKeyJsonPath(params.dataDir);
  if (await pathExists(keyPath)) {
    const raw = await fs.readFile(keyPath, "utf-8");
    const parsed = JSON.parse(raw) as StoredKeyFile;
    const key = Buffer.from(String(parsed.keyB64 || ""), "base64");
    if (key.byteLength !== 32) throw new Error("Invalid credential-master-key.json content");
    const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : null;
    return { key, source: "file", keyId: shaKeyId(key), createdAt };
  }

  const key = crypto.randomBytes(32);
  const createdAt = Date.now();
  const toWrite: StoredKeyFile = { keyB64: key.toString("base64"), createdAt };
  await fs.writeFile(keyPath, JSON.stringify(toWrite, null, 2), { encoding: "utf-8", mode: 0o600 });
  return { key, source: "generated", keyId: shaKeyId(key), createdAt };
}
