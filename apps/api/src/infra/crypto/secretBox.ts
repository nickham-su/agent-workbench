import crypto from "node:crypto";

function toB64Url(buf: Buffer) {
  return buf.toString("base64url");
}

function fromB64Url(s: string) {
  return Buffer.from(s, "base64url");
}

export function encryptUtf8(params: { key: Buffer; plaintext: string }) {
  if (params.key.byteLength !== 32) {
    throw new Error("Invalid master key length (expected 32 bytes)");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", params.key, iv);
  const ct = Buffer.concat([cipher.update(params.plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${toB64Url(iv)}.${toB64Url(tag)}.${toB64Url(ct)}`;
}

export function decryptToUtf8(params: { key: Buffer; ciphertext: string }) {
  if (params.key.byteLength !== 32) {
    throw new Error("Invalid master key length (expected 32 bytes)");
  }
  const raw = String(params.ciphertext || "");
  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid ciphertext format");
  }
  const iv = fromB64Url(parts[1]!);
  const tag = fromB64Url(parts[2]!);
  const ct = fromB64Url(parts[3]!);
  const decipher = crypto.createDecipheriv("aes-256-gcm", params.key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf-8");
}
