import fs from "node:fs/promises";
import path from "node:path";

async function readJsonFileIfExists(filePath: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as any;
  } catch {
    return null;
  }
}

export async function detectRepoRoot(): Promise<string> {
  let dir = path.resolve(process.cwd());
  for (let depth = 0; depth < 10; depth++) {
    const pkgPath = path.join(dir, "package.json");
    const pkg = await readJsonFileIfExists(pkgPath);
    if (pkg && pkg.workspaces) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd());
}

