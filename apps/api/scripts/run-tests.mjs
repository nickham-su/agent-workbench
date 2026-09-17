import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(apiRoot, "../..");
const group = process.argv[2];

if (!new Set(["unit", "integration", "worker"]).has(group)) {
  throw new Error("Usage: node scripts/run-tests.mjs <unit|integration|worker>");
}

const repositoryRootTests = new Set([join(apiRoot, "src/modules/plugins/plugin.service.test.ts")]);

function collectTests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectTests(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const workerTest = join(apiRoot, "src/modules/agent/agent.worker.integration.test.ts");
const tests = group === "worker"
  ? [workerTest]
  : collectTests(join(apiRoot, "src")).filter((file) => {
    const isIntegration = file.endsWith(".integration.test.ts");
    return group === "unit"
      ? !isIntegration
      : isIntegration && file !== workerTest;
  });

if (tests.length === 0) throw new Error(`No ${group} tests found`);
const apiCwdTests = tests.filter((file) => !repositoryRootTests.has(file));
const rootCwdTests = tests.filter((file) => repositoryRootTests.has(file));

if (apiCwdTests.length > 0) {
  execFileSync("npx", ["tsx", "--test", ...apiCwdTests.map((file) => relative(apiRoot, file))], {
    cwd: apiRoot,
    stdio: "inherit"
  });
}
if (rootCwdTests.length > 0) {
  execFileSync("npx", ["tsx", "--test", ...rootCwdTests.map((file) => relative(repoRoot, file))], {
    cwd: repoRoot,
    stdio: "inherit"
  });
}
