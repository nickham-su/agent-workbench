import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { FileConfigStore } from "../src/config.js";
import { httpServer, repository, temporaryDirectory } from "./helpers.js";

async function finish(child: ChildProcessWithoutNullStreams) {
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try { return await once(child, "close"); } finally { clearTimeout(timer); }
}
async function waitForTemp(root: string) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { const names = (await fs.readdir(root)).filter((name) => name.startsWith(".awb-download-")); if (names.length) return names; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("fixture never created temp");
}
function launch(home: string, output: string) {
  return spawn(process.execPath, [join(repository, "packages/cli/dist/cli.cjs"), "file", "download", "-w", "w", "--path", "report", "--output", output, "--json"], { cwd: home, env: { HOME: home, USERPROFILE: home, TMPDIR: home, PATH: dirname(process.execPath), NODE_PATH: "" }, stdio: ["pipe", "pipe", "pipe"] });
}

test("A-DOWNLOAD-INTERRUPT: real SIGINT/SIGTERM clean only owned temp and SIGKILL leftovers are never auto-scanned", async (t) => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
    const root = await temporaryDirectory(`download-${signal}`); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = join(root, "home"); await fs.mkdir(home); const output = join(root, "output");
    const sentinel = join(root, ".awb-download-other.tmp"); let complete = false; const methods: string[] = [];
    const server = await httpServer((req, res) => { methods.push(req.method!); res.writeHead(200, { "content-type": "application/octet-stream" }); if (complete) res.end("complete"); else res.write("partial"); }); t.after(server.close);
    await new FileConfigStore(home).save({ version: 1, apiOrigin: server.origin, cookie: null });
    const child = launch(home, output); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.stdin.end();
    await waitForTemp(root); await fs.writeFile(sentinel, "other process"); child.kill(signal);
    const [code, terminatedBy] = await finish(child);
    assert.equal(stdout, ""); await assert.rejects(fs.lstat(output), { code: "ENOENT" });
    assert.equal(await fs.readFile(sentinel, "utf8"), "other process");
    if (signal === "SIGKILL") {
      assert.equal(terminatedBy, "SIGKILL"); const leftovers = (await fs.readdir(root)).filter((name) => name.startsWith(".awb-download-")); assert.equal(leftovers.length, 2);
      complete = true; const next = launch(home, join(root, "next-output")); next.stdout.resume(); next.stderr.resume(); next.stdin.end(); assert.equal((await finish(next))[0], 0);
      assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith(".awb-download-")), leftovers);
    }
    else {
      assert.equal(code, signal === "SIGINT" ? 130 : 143); const error = JSON.parse(stderr).error;
      assert.equal(error.category, "INTERRUPTED"); assert.equal(error.code, "INTERRUPTED");
      assert.equal(error.phase, "download"); assert.equal(error.effect, "not_applicable"); assert.deepEqual(error.context, { workspaceId: "w", published: false });
      assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith(".awb-download-")), [".awb-download-other.tmp"]);
    }
    assert.deepEqual(methods, signal === "SIGKILL" ? ["GET", "GET"] : ["GET"], "local interruption must never POST a remote cancel");
  }
});

test("A-DOWNLOAD-INTERRUPT: real EPIPE during summary retains a complete published target", async (t) => {
  const root = await temporaryDirectory("download-EPIPE"); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); await fs.mkdir(home); const output = join(root, "output");
  let release!: () => void; const ready = new Promise<void>((resolve) => { release = resolve; }); let finishResponse!: () => void;
  const server = await httpServer((_req, res) => { finishResponse = () => { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end("complete"); }; release(); }); t.after(server.close);
  await new FileConfigStore(home).save({ version: 1, apiOrigin: server.origin, cookie: null });
  const child = launch(home, output); let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; }); child.stdin.end();
  await ready; child.stdout.destroy(); finishResponse(); const [code] = await finish(child);
  assert.equal(code, 141); const error = JSON.parse(stderr).error;
  assert.equal(error.category, "OUTPUT"); assert.equal(error.code, "OUTPUT_CLOSED"); assert.equal(error.phase, "publish");
  assert.equal(error.effect, "not_applicable"); assert.deepEqual(error.context, { workspaceId: "w", published: true }); assert.equal(await fs.readFile(output, "utf8"), "complete");
});
