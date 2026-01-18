import fs from "node:fs/promises";
import path from "node:path";
import { detectRepoRoot } from "./repoRoot.js";

export async function detectAppVersion(): Promise<string> {
  const fromEnv = process.env.AWB_APP_VERSION?.trim() || process.env.npm_package_version?.trim();
  if (fromEnv) return fromEnv;

  const cwdPkgPath = path.join(process.cwd(), "package.json");
  try {
    const raw = await fs.readFile(cwdPkgPath, "utf-8");
    const pkg = JSON.parse(raw) as any;
    const v = typeof pkg?.version === "string" ? pkg.version.trim() : "";
    if (v) return v;
  } catch {
    // ignore
  }

  const repoRoot = await detectRepoRoot();
  const apiPkgPath = path.join(repoRoot, "apps", "api", "package.json");
  try {
    const raw = await fs.readFile(apiPkgPath, "utf-8");
    const pkg = JSON.parse(raw) as any;
    const v = typeof pkg?.version === "string" ? pkg.version.trim() : "";
    if (v) return v;
  } catch {
    // ignore
  }

  return "0.0.0";
}
