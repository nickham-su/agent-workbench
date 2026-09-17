import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(webRoot, "src");

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

execFileSync("npx", ["tsx", "--test", ...tests.map((file) => relative(webRoot, file))], {
  cwd: webRoot,
  stdio: "inherit"
});
execFileSync("node", ["scripts/run-component-tests.mjs"], { cwd: webRoot, stdio: "inherit" });
