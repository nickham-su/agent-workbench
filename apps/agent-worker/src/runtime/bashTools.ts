import fs from "node:fs/promises";
import os from "node:os";
import { runBashCommand } from "./bash.js";

type ProbeItem = {
  name: string;
  commands: string[];
};

const PROBE_ITEMS: ProbeItem[] = [
  { name: "git", commands: ["git --version"] },
  { name: "node", commands: ["node --version"] },
  { name: "npm", commands: ["npm --version"] },
  { name: "pnpm", commands: ["pnpm --version"] },
  { name: "yarn", commands: ["yarn --version"] },
  { name: "bun", commands: ["bun --version"] },
  { name: "python", commands: ["python3 --version", "python --version"] },
  { name: "pip", commands: ["python3 -m pip --version", "pip --version"] },
  { name: "rg", commands: ["rg --version"] },
  { name: "fd", commands: ["fd --version"] },
  { name: "jq", commands: ["jq --version"] },
  { name: "make", commands: ["make --version"] },
  { name: "cmake", commands: ["cmake --version"] },
  { name: "go", commands: ["go version"] },
  { name: "rustc", commands: ["rustc --version"] },
  { name: "cargo", commands: ["cargo --version"] },
  { name: "docker", commands: ["docker --version"] },
  { name: "docker-compose", commands: ["docker compose version", "docker-compose --version"] }
];

const TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 2000;
const PROBE_MAX_OUTPUT_BYTES = 8 * 1024;

type ProbeCache = {
  tools: string[];
  environment: string | null;
  updatedAt: number;
  inFlight: Promise<void> | null;
  timer: NodeJS.Timeout | null;
};

const cache: ProbeCache = {
  tools: [],
  environment: null,
  updatedAt: 0,
  inFlight: null,
  timer: null
};

function pickFirstLine(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function formatEntry(name: string, line: string) {
  const normalized = line.toLowerCase();
  const normalizedName = name.toLowerCase();
  if (normalizedName === "pip") {
    const match = line.match(/\b\d+(?:\.\d+){1,3}\b/);
    if (match) return `pip ${match[0]}`;
  }
  if (normalized.includes(normalizedName)) return line;
  if (normalizedName === "docker-compose" && normalized.includes("docker compose")) return line;
  return `${name} ${line}`;
}

async function probeCommand(command: string) {
  const result = await runBashCommand({
    command,
    cwd: process.cwd(),
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: PROBE_MAX_OUTPUT_BYTES
  });
  if (!result.ok) return null;
  const combined = [result.stdout, result.stderr].filter((item) => item && item.trim()).join("\n");
  return pickFirstLine(combined) ?? null;
}

async function probeItem(item: ProbeItem) {
  for (const command of item.commands) {
    const line = await probeCommand(command);
    if (line) return formatEntry(item.name, line);
  }
  return null;
}

async function refresh(logger: Pick<Console, "warn">, reason: string) {
  if (cache.inFlight) return cache.inFlight;
  const run = (async () => {
    const tools: string[] = [];
    for (const item of PROBE_ITEMS) {
      const line = await probeItem(item);
      if (line) tools.push(line);
    }
    cache.tools = tools;
    cache.environment = await readEnvironmentInfo(logger);
    cache.updatedAt = Date.now();
  })();
  cache.inFlight = run;
  run.catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[agent-worker] bash tool probe failed(${reason}): ${message}`);
  }).finally(() => {
    cache.inFlight = null;
  });
  return run;
}

export function startBashToolProbe(logger: Pick<Console, "warn">) {
  if (cache.timer) return;
  void refresh(logger, "startup");
  cache.timer = setInterval(() => {
    void refresh(logger, "interval");
  }, TTL_MS);
  cache.timer.unref?.();
}

export function getBashToolAppendix() {
  const lines: string[] = [];
  if (cache.environment) lines.push(cache.environment);
  if (cache.tools.length > 0) lines.push(`已知可用工具: ${cache.tools.join(", ")}`);
  return lines.join("\n");
}

async function readEnvironmentInfo(logger: Pick<Console, "warn">) {
  const platform = os.platform();
  const arch = os.arch();
  const kernel = os.release();
  const distro = await readOsRelease(logger);
  const parts = [`${platform} ${arch}`, `kernel ${kernel}`];
  if (distro) parts.push(distro);
  return `运行环境: ${parts.join(", ")}`;
}

async function readOsRelease(logger: Pick<Console, "warn">) {
  try {
    const content = await fs.readFile("/etc/os-release", "utf8");
    const line = content
      .split("\n")
      .find((item) => item.startsWith("PRETTY_NAME="));
    if (!line) return null;
    const value = line.split("=").slice(1).join("=").trim();
    return value.replace(/^"|"$/g, "");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[agent-worker] read os-release failed: ${message}`);
    return null;
  }
}
