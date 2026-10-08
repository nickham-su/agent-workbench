import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const temporaryRoot = join(repositoryRoot, ".tmp-tests");
mkdirSync(temporaryRoot, { recursive: true });
const outputDir = mkdtempSync(join(temporaryRoot, "shared-clean-build-"));

const forbidden = [
  "internal-contracts/agent-legacy.js",
  "internal-contracts/agent-legacy.d.ts",
  "internal-contracts/agent-legacy.js.map",
];

function collectPackageTargets(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectPackageTargets);
}

try {
  execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--outDir", outputDir], {
    cwd: packageRoot,
    stdio: "inherit",
  });

  for (const relativePath of forbidden) {
    if (existsSync(join(outputDir, relativePath))) {
      throw new Error(`clean Shared build emitted removed legacy contract: ${relativePath}`);
    }
  }

  const legacyEntries = readdirSync(join(outputDir, "internal-contracts"))
    .filter((name) => name.includes("legacy"));
  if (legacyEntries.length > 0) {
    throw new Error(`clean Shared build emitted legacy entries: ${legacyEntries.join(", ")}`);
  }

  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const packageTargets = new Set([
    packageJson.main,
    packageJson.types,
    ...collectPackageTargets(packageJson.exports),
  ].filter((target) => typeof target === "string"));

  writeFileSync(join(outputDir, "package.json"), JSON.stringify({ type: "module" }));
  for (const target of packageTargets) {
    if (!target.startsWith("./dist/")) {
      throw new Error(`Shared package target must stay under dist: ${target}`);
    }
    const emittedPath = join(outputDir, target.slice("./dist/".length));
    if (!existsSync(emittedPath)) {
      throw new Error(`clean Shared build did not emit package target: ${target}`);
    }
    if (target.endsWith(".js")) {
      await import(pathToFileURL(emittedPath).href);
    }
  }
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
