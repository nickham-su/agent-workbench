import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const packageRoot = new URL("..", import.meta.url);
const distDir = new URL("../dist", import.meta.url);
rmSync(distDir, { recursive: true, force: true });
execFileSync("npx", ["tsc", "-p", "tsconfig.json"], {
  cwd: packageRoot,
  stdio: "inherit",
});

const forbidden = [
  "internal-contracts/agent-legacy.js",
  "internal-contracts/agent-legacy.d.ts",
  "internal-contracts/agent-legacy.js.map",
];
for (const relativePath of forbidden) {
  if (existsSync(new URL(`../dist/${relativePath}`, import.meta.url))) {
    throw new Error(`clean Shared build emitted removed legacy contract: ${relativePath}`);
  }
}

const legacyEntries = readdirSync(new URL("../dist/internal-contracts", import.meta.url))
  .filter((name) => name.includes("legacy"));
if (legacyEntries.length > 0) {
  throw new Error(`clean Shared build emitted legacy entries: ${legacyEntries.join(", ")}`);
}
