import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConcurrency } from "./run-component-tests.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(webRoot, "src");
const require = createRequire(import.meta.url);
const concurrency = parseConcurrency(process.argv.slice(2));

function collectTests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectTests(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") && !entry.name.endsWith(".component.test.ts") ? [path] : [];
  });
}

if (!existsSync(sourceRoot)) throw new Error("Web test source directory is missing: src");
const tests = collectTests(sourceRoot).sort();
if (tests.length === 0) throw new Error("Web test gate found zero src/**/*.test.ts files");

execFileSync(process.execPath, ["--test", "scripts/run-component-tests.test.mjs"], { cwd: webRoot, stdio: "inherit" });
execFileSync(process.execPath, [require.resolve("tsx/cli"), "--test", ...tests.map((file) => relative(webRoot, file))], {
  cwd: webRoot,
  stdio: "inherit"
});
execFileSync(process.execPath, ["scripts/run-component-tests.mjs", `--concurrency=${concurrency}`], { cwd: webRoot, stdio: "inherit" });
