import fs from "node:fs/promises";
import { ensureDir, pathExists } from "../fs/fs.js";
import { caBundlePath, caCertPath, certsRoot } from "../fs/paths.js";

const LINUX_CA_CANDIDATES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/ssl/cert.pem",
  "/etc/ssl/ca-bundle.pem"
];

const DARWIN_CA_CANDIDATES = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"];

const GENERIC_CA_CANDIDATES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/ssl/cert.pem",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/ssl/ca-bundle.pem"
];

function normalizePem(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

function sanitizeEnvPath(raw: string | undefined): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.includes("\0") || s.includes("\n") || s.includes("\r")) return null;
  return s;
}

async function detectSystemCaBundlePath(): Promise<string | null> {
  const envPath = sanitizeEnvPath(process.env.SSL_CERT_FILE);
  const candidates: string[] = [];
  if (envPath) candidates.push(envPath);

  const platformCandidates =
    process.platform === "linux"
      ? LINUX_CA_CANDIDATES
      : process.platform === "darwin"
        ? DARWIN_CA_CANDIDATES
        : GENERIC_CA_CANDIDATES;

  for (const p of [...candidates, ...platformCandidates]) {
    if (await pathExists(p)) return p;
  }
  return null;
}

async function readPemIfExists(p: string | null | undefined): Promise<string | null> {
  if (!p) return null;
  try {
    if (!(await pathExists(p))) return null;
    const raw = await fs.readFile(p, "utf-8");
    return normalizePem(raw);
  } catch {
    return null;
  }
}

function buildBundleContent(customPem: string, systemPem: string | null) {
  const parts = [customPem.trim()];
  if (systemPem) parts.push(systemPem.trim());
  return `${parts.join("\n\n")}\n`;
}

export async function ensureCaBundleFile(params: {
  dataDir: string;
  customCaPem: string | null;
  fallbackCaPath?: string | null;
  writeCustomCa?: boolean;
}): Promise<string | null> {
  const customFromParam = normalizePem(params.customCaPem);
  const customFromFile = customFromParam ? null : await readPemIfExists(params.fallbackCaPath);
  const customPem = customFromParam ?? customFromFile;
  if (!customPem) return null;

  const systemPath = await detectSystemCaBundlePath();
  const systemPem = await readPemIfExists(systemPath);

  await ensureDir(certsRoot(params.dataDir));
  if (params.writeCustomCa && customFromParam) {
    await fs.writeFile(caCertPath(params.dataDir), customFromParam, { encoding: "utf-8" });
  }
  const bundlePath = caBundlePath(params.dataDir);
  const bundleContent = buildBundleContent(customPem, systemPem);
  await fs.writeFile(bundlePath, bundleContent, { encoding: "utf-8" });
  return bundlePath;
}
