import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { healthBody, httpServer, repository, temporaryDirectory } from "./helpers.js";

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
  for (const args of [["--version"], ...[[], ["login"], ["workspace"], ["workspace", "list"], ["agent"], ["agent", "list"], ["session"], ...["list", "show", "status", "send", "messages", "cancel", "compact"].map((action) => ["session", action]), ["file"], ["file", "download"]].flatMap((path) => [[...path, "--help"], [...path, "-h"]])]) {
    const result = spawnSync(process.execPath, ["--require", preload, artifact, ...args], options);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    if (args[0] === "--version") assert.equal(result.stdout, `${manifest.version}\n`);
    else assert.match(result.stdout, /Usage: awb/);
  }
  // Prove the preload really prevents ancestor/global dependency fallback.
  const probe = spawnSync(process.execPath, ["--require", preload, "-e", "require('commander')"], options);
  assert.notEqual(probe.status, 0);
  assert.match(probe.stderr, /Standalone CLI attempted an external module resolution/);
  assert.deepEqual(await fs.readdir(home), []);
});


test("A-REGRESSION-BUNDLE: builtin-only artifact actually logs in, posts multipart and streams a download", async (t) => {
  const root = await temporaryDirectory("standalone-operations"); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); await fs.mkdir(home);
  const artifact = join(root, "cli.cjs"); const preload = join(root, "builtin-only.cjs");
  const image = join(root, "image.png"); const output = join(root, "download.bin");
  await Promise.all([fs.copyFile(join(repository, "packages/cli/dist/cli.cjs"), artifact), fs.writeFile(preload, builtinOnlyPreload), fs.writeFile(image, Buffer.from([137,80,78,71,13,10,26,10,0]))]);
  let multipart = 0; let downloads = 0;
  const server = await httpServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") { res.end(healthBody(false)); return; }
    if (req.url?.endsWith("/agents/available?surface=user")) { res.end(JSON.stringify({ agents: [{ id: "a", name: "a", summary: "" }] })); return; }
    if (req.url === "/api/agent/sessions") { res.end(JSON.stringify({ id: "s", workspaceId: "w", title: "fixture", kind: "primary", forkedFromSessionId: null, forkedFromMessageId: null, headMessageId: null, contextRootMessageId: null, revision: 0, createdAt: 1, updatedAt: 1 })); return; }
    if (req.url === "/api/agent/sessions/s/messages") {
      assert.match(req.headers["content-type"]!, /^multipart\/form-data; boundary=/); let body = ""; for await (const chunk of req) body += String(chunk);
      assert.match(body, /name="payload"/); assert.match(body, /name="images"; filename="image.png"/); multipart++;
      res.end(JSON.stringify({ sessionId: "s", messageId: "m", runId: "r", deduplicated: false })); return;
    }
    if (req.url === "/api/workspaces/w/files/download?path=report") { downloads++; res.setHeader("content-type", "application/octet-stream"); res.end("bundle-stream"); return; }
    res.statusCode = 404; res.end("{}");
  }); t.after(server.close);
  async function run(args: string[]) {
    const child = spawn(process.execPath, ["--require", preload, artifact, ...args, "--json"], { cwd: root, env: { HOME: home, USERPROFILE: home, TMPDIR: root, PATH: dirname(process.execPath), NODE_PATH: "" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try { const [code] = await once(child, "close"); assert.equal(code, 0, stderr); assert.equal(stderr, ""); return JSON.parse(stdout); } finally { clearTimeout(timer); }
  }
  assert.equal((await run(["login", "--url", server.origin])).command, "login");
  assert.equal((await run(["session", "send", "-w", "w", "--image", image])).data.accepted, true);
  assert.equal((await run(["file", "download", "-w", "w", "--path", "report", "--output", output])).data.published, true);
  assert.equal(await fs.readFile(output, "utf8"), "bundle-stream"); assert.equal(multipart, 1); assert.equal(downloads, 1);
});
