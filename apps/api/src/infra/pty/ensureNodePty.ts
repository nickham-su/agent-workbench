import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

async function ensureExecutable(filePath: string) {
  try {
    await fs.access(filePath, 0);
  } catch {
    return;
  }

  try {
    await fs.access(filePath, fsConstants.X_OK);
    return;
  } catch {
    // not executable, continue
  }

  try {
    await fs.chmod(filePath, 0o755);
  } catch {
    // best-effort: don't crash server for this
  }
}

export async function ensureNodePtyReady() {
  // 在 macOS 上，node-pty 依赖的 spawn-helper 需要可执行权限；某些环境下 npm 解包后会丢失 x 位
  const require = createRequire(import.meta.url);
  let entry: string;
  try {
    entry = require.resolve("node-pty");
  } catch {
    return;
  }

  const pkgRoot = path.resolve(path.dirname(entry), "..");
  const helper = path.join(pkgRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  await ensureExecutable(helper);
}
