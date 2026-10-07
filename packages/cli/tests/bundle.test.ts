import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { repository, temporaryDirectory } from "./helpers.js";

// A project-local directory alone is not isolation: Node could walk up to the
// checkout's node_modules. Deny every non-builtin resolution in a fresh process.
const builtinOnlyPreload = `
const Module = require("node:module");
const path = require("node:path");
const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
const resolveFilename = Module._resolveFilename;
Module.globalPaths.length = 0;
Module._resolveFilename = function(request, ...args) {
  if (!Module.isBuiltin(request) && request !== entry) {
    throw new Error("Standalone CLI attempted an external module resolution");
  }
  return resolveFilename.call(this, request, ...args);
};
`;

test("single CJS artifact runs help/version with builtin-only module resolution and an empty HOME", async (t) => {
  const root = await temporaryDirectory("standalone-bundle");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const isolated = join(root, "artifact");
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  await Promise.all([isolated, home, temporary].map((directory) => fs.mkdir(directory)));
  const artifact = join(isolated, "cli.cjs");
  const preload = join(root, "builtin-only.cjs");
  await Promise.all([
    fs.copyFile(join(repository, "packages/cli/dist/cli.cjs"), artifact),
    fs.writeFile(preload, builtinOnlyPreload)
  ]);
  assert.deepEqual(await fs.readdir(isolated), ["cli.cjs"]);
  const source = await fs.readFile(artifact, "utf8");
  assert.equal(source.startsWith("#!/usr/bin/env node\n"), true);
  assert.equal((source.match(/^#!/gm) ?? []).length, 1);
  const manifest = JSON.parse(await fs.readFile(join(repository, "packages/cli/package.json"), "utf8")) as { version: string };
  const options = {
    cwd: isolated,
    // Do not inherit NODE_OPTIONS, NODE_PATH, CLI/Worker configuration, or a real HOME.
    env: { HOME: home, USERPROFILE: home, TMPDIR: temporary, PATH: dirname(process.execPath), NODE_PATH: "" },
    encoding: "utf8" as const,
    timeout: 10_000
  };
  for (const argument of ["--help", "--version"]) {
    const result = spawnSync(process.execPath, ["--require", preload, artifact, argument], options);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    if (argument === "--version") assert.equal(result.stdout, `${manifest.version}\n`);
    else assert.match(result.stdout, /Usage: awb/);
  }
  // Prove the preload really prevents ancestor/global dependency fallback.
  const probe = spawnSync(process.execPath, ["--require", preload, "-e", "require('commander')"], options);
  assert.notEqual(probe.status, 0);
  assert.match(probe.stderr, /Standalone CLI attempted an external module resolution/);
  assert.deepEqual(await fs.readdir(home), []);
});
