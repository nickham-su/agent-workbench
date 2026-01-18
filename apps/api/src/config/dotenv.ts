import fs from "node:fs/promises";
import path from "node:path";
import { detectRepoRoot } from "./repoRoot.js";

function parseDotEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }
  return out;
}

async function readDotEnvIfExists(filePath: string): Promise<Record<string, string> | null> {
  try {
    const txt = await fs.readFile(filePath, "utf-8");
    return parseDotEnvFile(txt);
  } catch {
    return null;
  }
}

export async function loadRootEnvLocalIntoProcessEnv() {
  const repoRoot = await detectRepoRoot();
  const envPath = path.join(repoRoot, ".env.local");
  const parsed = await readDotEnvIfExists(envPath);
  if (!parsed) return;

  // 只将 AWB_* 注入到后端进程环境变量中:
  // - 避免把 DEV_* 等前端/其他用途的变量也注入到后端,再通过 tmux 继承进入用户终端
  // - 与“AWB_* 为保留前缀”的约定保持一致
  //
  // 开发期更符合直觉的行为:允许 .env.local 覆盖宿主环境里“意外继承”的变量(例如容器里默认带的 AWB_PORT=4310)。
  // 非开发期仍保持“进程环境变量优先”的原则，避免误覆盖部署环境注入的配置。
  const isDev =
    process.env.AWB_DOTENV_OVERRIDE === "1" ||
    process.env.NODE_ENV === "development" ||
    process.env.npm_lifecycle_event === "dev";

  for (const [k, v] of Object.entries(parsed)) {
    if (!k.startsWith("AWB_")) continue;
    if (isDev || process.env[k] == null) {
      process.env[k] = v;
    }
  }
}
